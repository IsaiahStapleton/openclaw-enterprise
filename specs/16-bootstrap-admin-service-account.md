# Feature Design: Bootstrap administrator service account

**Date:** 2026-08-31  
**Status:** Proposed; specification complete, implementation not started  
**Owner:** OCC bootstrap, authentication, and native IAM  
**Source baseline:** `openclaw/openclaw-enterprise` `main` at `b43cc49c45fa6275e79985be0eabb517743c6a23`  
**Affected references:** [Authentication](../docs/reference/authentication.md), [Authorization](../docs/reference/authorization.md), [Settings](../docs/reference/settings.md)

## Goal and scope

Fresh bootstrap creates the human administrator and one Installation-scoped service administrator. Extend the existing native IAM seed and issue a 30-day service API key through existing authentication code. Deliver it in a **private JSON file** on the production password PVC or a controller-only development volume.

The service identity is a non-Agent IAM `ServicePrincipal`, with no human login, email, password, session, Namespace, or Agent owner. Namespace [ServiceAccount resources](../docs/reference/service-accounts.md) instead supply upstream workload credentials. The operator owns the delivered credential; native IAM owns identity and permissions; Better Auth owns key generation, hashing, expiry, and revocation.

This is a proposed implementation under [the platform design](../docs/design.md). It retains current startup entry points and native IAM provisioning. A shared transaction coordinator, auth/OCC atomicity, receipt table or migration, recovery endpoint, startup rewrite, external-IAM bootstrap, extra startup-YAML mounting, automatic rotation, and existing-installation backfill are out of scope. No feature or live credential is created by this specification.

## Current state and evidence

| Area | Baseline behavior and source |
| --- | --- |
| Production | [Bootstrap script](../scripts/bootstrap-production.mjs#L154) creates the human and exclusive `0600` password file before committing Installation/IAM/audit; existing installations validate the configured human. Its unconditional compensation can delete credentials after an uncertain commit. |
| Development | [PostgreSQL composition](../apps/controller/src/composition/development-postgres.ts#L140) creates the human and IAM seed, then internally signs in and calls [HTTP bootstrap](../apps/controller/src/index.ts#L1065). Its [internal caller](../apps/controller/src/composition/development-postgres.ts#L71) currently treats `409` as success. |
| Policy | [Native IAM seed](../packages/iam/src/index.ts#L54) creates the human, admin Role, and broad binding. [Authorization](../packages/iam/src/index.ts#L470) enforces explicit permissions and deny Restrictions; an Installation-resource-only binding excludes descendant Namespace operations. |
| Keys | [Issuance API](../apps/controller/src/index.ts#L1689) requires an existing service principal and Installation administration. The [auth wrapper](../apps/controller/src/auth/index.ts#L247) uses pinned Better Auth `1.6.11`, hashed storage, `occ_` keys, 30-day defaults, `x-api-key` verification, and deletion for revocation. |
| Persistence and delivery | [PostgreSQL transactions](../packages/occ/src/state/postgres-state.ts#L758) distinguish unknown COMMIT outcomes. The [Helm Job](../deploy/helm/openclaw-enterprise/templates/jobs.yaml#L8) already mounts a protected password PVC; [Compose](../compose.yaml#L28) has no key-output mount. No login UI exists. |

## Requirements -> Design Mapping

| Requirement | Selected mechanism |
| --- | --- |
| Both administrator identities with exact authority | Extend the fresh native IAM seed; share the human administrator Role. |
| Private initial delivery | Existing auth helper, exclusive owner-only JSON, existing PVC or dedicated development volume. |
| Reruns and concurrency | Existing singleton constraints; close/fail losing startup, then reload on a whole-startup retry. |
| Failure recovery | Attempt-owned best-effort cleanup for known failures; preserve uncertain outcomes for operator verification. |
| Lifecycle and existing installations | Existing issue/revoke APIs; no backfill, regeneration, or resurrection. |

## Proposed design

### Identity and permission scope

Add one random stable `spn_<uuid>` with `kind: service_principal` to the fresh bootstrap seed only. Omit `namespaceId` and `agentId`. Give it a separate binding to the **same Role ID** as the human administrator, omitting binding `namespaceId`, `resourceKind`, and `resourceId`. IAM records inherit the singleton Installation; no new ownership fields are needed.

Reuse the IAM-owned permission definition exactly:

| Resource kind | Allowed actions |
| --- | --- |
| `installation` | `administer`, `read` |
| `namespace` | `create`, `read`, `delete` |
| `configuration`, `service_account`, `secret` | `create`, `read`, `update`, `delete` |
| `secret` additionally | `operate` |
| `agent` | `create`, `read`, `update`, `deploy`, `operate` |
| `agent_revision` | `read` |

These grants cover current and future Namespaces in this Installation, subject to Restrictions and exact request authorization. They confer no provider/Kubernetes privileges, wildcard bypass, or Agent-delete permission. The credential name is `bootstrap-admin`; it is a label, never an identity lookup key.

Installation administrators manage credentials through existing APIs, including service administrators rotating their own keys. The identity survives removal of its original human administrator. Revocation/expiry rejects later authentication; removal of identity/binding/Role or a matching Restriction denies later authorization. Already authorized work may finish. Human-account creation and HTTP bootstrap remain human-only. There is no new principal-management API.

### Bootstrap sequence and failure behavior

1. Load persisted Installation state as today. If already bootstrapped, retain existing administrator verification and return without issuing keys or touching output, including installations predating this feature. Missing files, expired/revoked keys, or removed identities/grants never trigger regeneration or repair.
2. For fresh native-IAM bootstrap, validate private absolute output paths, create the human as today, and extend its seed with the service identity/binding. Call existing `auth.createServiceKey` for that identity with Installation scope, `bootstrap-admin`, and a 30-day lifetime.
3. Write and fsync the private key file before the existing Installation/IAM/audit commit; production also retains its password-file write. Better Auth persists independently: the key may authenticate before OCC commits, but cannot authorize normal OCC operations without its committed identity/binding. Do not start serving until confirmed bootstrap success.
4. Production uses its existing controller transaction. Development keeps internal sign-in and `/installation/bootstrap`; only `201` completes fresh startup. On `409`, close the application and pool and fail the whole startup. A later whole-startup retry reloads the winner's persisted Installation/IAM instead of serving with the loser's generated IDs.
5. Existing singleton database constraints select at most one committed Installation/IAM seed. Concurrent attempts can temporarily create independent auth records and files. After a known losing commit, best-effort cleanup removes only that attempt's recorded user/key IDs and files it exclusively created; never the winner's or preexisting resources.

Ordinary failures before OCC commit use the same scoped cleanup and return failure. Retain handles/identity checks sufficient to avoid deleting replaced files. Report cleanup failures with safe IDs and paths so an operator can repair them; do not retry issuance over existing output or adopt users by email/name.

An **unknown commit outcome** preserves all accounts, keys, and output and stops for operator verification. Production preserves `PostgresCommitOutcomeUnknownError`; development conservatively treats bootstrap `5xx` or a missing response as uncertain because HTTP currently collapses the underlying error. Existence of any Installation is not proof that this attempt committed. Compare the recorded attempt Installation/principal IDs with authoritative Installation/IAM/key state, and confirm the original transaction has finished before deciding cleanup. Database unavailability remains unresolved; no destructive compensation or automatic retry runs.

Abrupt termination can leave auth accounts, key hashes, or partial output without a committed IAM seed. Operator repair is an accepted tradeoff: establish the transaction outcome, identify this attempt's orphan IDs, remove only proven orphans, quarantine stale output privately, then rerun. When the matching seed committed, retain its credentials and use normal recovery if output was lost. File existence alone never proves bootstrap success.

### Private delivery and recovery

Use path-only `OCC_BOOTSTRAP_SERVICE_KEY_FILE`, required on fresh direct startup. Production requires a distinct sibling of `OCC_BOOTSTRAP_PASSWORD_FILE`. A small shared file helper can reuse the script's exclusive-create pattern: reject unsafe parents/symlinks and existing destinations, open with `O_EXCL`, enforce `0600`, write complete JSON, and fsync file and parent directory before OCC commit. The protected directory is writable only by the runtime identity and trusted storage administrators. Never overwrite output.

Use the existing response-compatible shape so [service-key client examples](../docs/guides/deploy.md#use-a-service-key) can consume `data.key`:

```json
{"data":{"id":"<key-id>","servicePrincipalId":"<spn_uuid>","name":"bootstrap-admin","expiresAt":"<UTC-expiry>","key":"<generated-occ-key>"},"meta":{"installationId":"<installation-id>"}}
```

| Entry point | Delivery and user experience |
| --- | --- |
| Production/Helm | Add `bootstrap.serviceKey.fileName`, default `initial-admin-service-key.json`, under the existing password mount; validate a distinct simple basename and pass the full path. Only bootstrap mounts the PVC. Retrieve via approved PVC/storage access after Job success; a completed container is not an exec endpoint. |
| Development Compose | Add controller-only named volume `occ_bootstrap_data` at `/var/lib/openclaw/bootstrap`, set the key path there, and initialize/chown the mount directory to UID/GID 1000 with mode `0700` in the development image. After successful startup, copy the file with `docker compose cp` to an operator-owned `0700` directory under `umask 077`, then enforce local `0600`. |
| Direct development | Require an explicit private absolute key-file path on fresh startup; keep configured human password behavior. |
| Unattended installer | Wait for confirmed script/Job/startup success, import the file into existing credential storage, retain key/principal IDs, then remove delivery copies according to policy. Import failures retry the same file without issuing another key. |

“One-time disclosure” means one generated output and no server-side plaintext retrieval; the file remains readable until removed. Bootstrap emits safe outcome/Installation/principal/key IDs, expiry and path only. Never place secrets in stdout/stderr, process arguments, HTTP bootstrap responses, audit, manifests, or image layers. Redact `x-api-key` in request logs and exclude output from diagnostics. Operators own protection of copied files, backups, snapshots, and crash dumps. First-use proof is a key-authenticated Installation read and Namespace create/read.

Lost or exposed token with retained IDs: sign in as the human, revoke the old ID with `DELETE /api/auth/service-keys/:keyId`, then issue a replacement for the recorded principal using `POST /api/auth/service-keys`, omitting Namespace, and save its one-time response privately. Lost file **and IDs** require operator database inspection of existing IAM and key metadata; there is no discovery endpoint. Missing IAM authority is not restored by key issuance. Planned rotation is issue → switch clients → check a real request → revoke old ID. Compromise may require revoking additional keys issued by that administrator; revocation does not cascade. Loss of all admin access requires existing operator recovery, never rerunning bootstrap as a reset.

## Delivery alternatives, tradeoffs, and open questions

Protected files fit both existing entry points and unattended import. Stdout/Job logs expose retained plaintext; an HTTP/UI channel misses production's script path. A Kubernetes Secret or external vault integration adds credentials, permissions and another failure boundary. Existing issue/revoke APIs suffice after setup. The selected file design accepts operator-managed retention and occasional orphan repair in exchange for avoiding a coordinator, recovery schema, and new API.

Selected defaults are no existing-installation backfill and the existing 30-day key lifetime. Whether a later opt-in provisioning tool, different lifetime, or named vault integration is needed remains separate product work; none blocks this design.

## Detailed File Plan

All entries describe future implementation; current references remain unchanged until behavior ships.

| File | Expected change |
| --- | --- |
| `packages/iam/src/index.ts` | Extend fresh bootstrap seed with the service identity and same-Role broad binding; leave additional human-account provisioning unchanged. |
| `apps/controller/src/composition/bootstrap-output.ts` (new) | Small protected JSON file writer and attempt-owned file cleanup shared by the two entry points; no coordinator or credential issuance logic. |
| `scripts/bootstrap-production.mjs` | Extend seed, call existing key helper, write sibling output, record safe attempt IDs, and scope compensation to known failures. |
| `apps/controller/src/composition/development-postgres.ts`, `apps/controller/src/server.mjs` | Pass output path; extend fresh seed/key/output; preserve internal sign-in/bootstrap, close/fail on `409`, and preserve uncertain outcomes. |
| `compose.yaml`, `Dockerfile`, `.env.example` | Controller-only output volume/path, development image directory ownership/mode, and direct-startup path documentation. |
| `deploy/helm/openclaw-enterprise/values.yaml`, `templates/jobs.yaml`, `templates/_helpers.tpl` | Key basename/path setting and validation using the existing PVC; no extra mounts, API credentials, or RBAC. |
| `docs/reference/{authentication,authorization,settings}.md`, `docs/guides/{quickstart,deploy}.md` | Publish bootstrap identity, output retrieval, permissions, rerun, and manual recovery contracts. |
| `docs/flows/{local-password-authentication,service-api-keys,development-startup,production-startup,platform-startup}.md`, `docs/ARCHITECTURE.md` | Explain the retained entry points, added seed/key/file steps, independent auth persistence, and failure boundaries. |
| `tests/integration/{postgres-production-wireup,postgres-auth-accounts,postgres-service-api-keys,service-api-keys,production-kubernetes-packaging}.test.mjs`, focused bootstrap/file-helper tests | Verify the acceptance criteria below using real storage and entry points where relevant. |

## Planning & Milestones

### Milestone 1: Fresh bootstrap with privately delivered administrator key

**Shipped functionality:** Both supported fresh startup paths provision both administrators and a usable private credential, with rerun and manual recovery behavior documented.
**Tasks:** Extend seed; wire existing auth issuance and private output into both paths; correct loser/uncertain cleanup; configure volume/PVC output; update owning docs.
**Verification:** Complete the unit, integration, and manual criteria below before shipping code, chart, and docs together.

## Rollout Plan

Validate first on disposable PostgreSQL/Compose, then a selected disposable Helm Job/PVC, then ship the complete change. No feature gate or schema migration is needed. Existing installations receive no new identity, grant, key, or output. Fresh bootstrap fails if required output cannot be created.

**Rollback:** Stop an unfinished attempt and resolve uncertain commit state before downgrading. Retain database and credential storage when reverting binaries/chart; the identity and key use existing models. Explicitly revoke keys or remove the binding to retire automation. Never use old unconditional compensation against an unresolved attempt.

## Testing Plan

- **Unit:** Fresh-only seed shares the exact Role and permission matrix; private JSON is complete, `0600`, fsynced, and rejects existing files/symlinks/unsafe parents without overwrite. Known-failure cleanup touches only attempt-owned files/IDs; uncertain outcomes preserve them.
- **Integration:** Real fresh development and production paths create one committed Installation, human, service principal and usable key; prove Installation and Namespace operations plus Restriction/removed-binding denial. Confirm hashed storage and no secret leakage through logs, audit, HTTP bootstrap, or packaging.
- **Integration:** Reruns preserve IDs/key/file bytes, older installations remain unchanged, and expiry/revocation/removal never resurrects credentials. Race fresh starts with same/different output paths; one seed wins, the loser fails/closes, cleanup leaves the winner intact, and a whole-startup retry reloads it. Fault an ambiguous commit and prove no credential deletion even when acknowledgement is lost.
- **Manual:** Verify Compose UID 1000 volume/copy permissions and actual Job/PVC retrieval, human sign-in, first key request, saved-ID loss recovery and lost-file/IDs operator recovery, planned rotation/revocation, and unattended import only after success. Rendered Helm alone does not prove PVC permissions; unavailable runtime prerequisites remain explicit gaps.

Use focused real integration tests, `pnpm test:postgres`, `pnpm typecheck`, and `pnpm check:workspace` after implementation. This specification edit needs only link and whitespace checks; no runtime tests or live provisioning.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-31 17:33]: Apply approved simplification: retain existing bootstrap flows, share the administrator Role, deliver a private key file, and use scoped cleanup with operator recovery for partial or uncertain outcomes. (01a05a3d-526f-7553-8cd8-070bd1847acb - b43cc49)
- [2026-08-31 17:04]: Resolve independent review by adding all three owning startup flow documents and a documentation-parity acceptance criterion. (01a05a3d-526f-7553-8cd8-070bd1847acb)
- [2026-08-31 16:56]: Trace current bootstrap/IAM/key paths and propose atomic dual-identity bootstrap, private-file delivery, recovery, and verification. (01a05a3d-526f-7553-8cd8-070bd1847acb)
