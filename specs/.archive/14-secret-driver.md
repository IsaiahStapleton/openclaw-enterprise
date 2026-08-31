# Feature Spec: SecretDriver storage and delivery

**Date:** 2026-08-28
**Status:** Implemented and verified for Namespace-owned Secret storage and delivery. Broader runtime limits are recorded below.

**Current reference:** [Kubernetes Secret Driver](../../docs/reference/drivers/kubernetes-secret.md).
**Owner:** OCC, KubernetesSecretDriver, Kubernetes ComputeDriver, and Installation operator

## Problem and Decision

Add the singular **SecretDriver**, capability `secret`, with **KubernetesSecretDriver** as the default Installation-selected implementation. It stores Namespace-owned secret material before any Agent exists. Kubernetes delivers the value only to an explicitly selected Agent gateway environment, and OpenClaw resolves native SecretRefs from that environment.

Each Secret belongs to **exactly one Namespace**. Same-Namespace Agents may consume it only through explicit Configuration binding and Agent assignment checks; cross-Namespace use is unsupported. Namespace membership, Configuration access, Agent access, or possession of a reference never grants Secret consumption. The Secret reference stays stable when its value is updated. Each affected Agent must be explicitly redeployed or restarted to consume the latest value; secret updates do not automatically restart workloads.

## Scope

**Changes:** protected secret create/update, metadata-only read, and delete; Namespace-owned Secret storage with Namespace-unique names; source/delivery bindings in Configuration and immutable AgentRevision; exact Agent workload delivery targeting; real Kubernetes bootstrap-to-Agent-turn proof.

**Preserves:** Kubernetes-first placement, Installation-selected Drivers, immutable revision documents, existing ServiceAccount issuance/storage, dedicated Codex credential placement, and the API-only mounted `adminKeyPath` consumer.

**Deferred:** cross-Namespace secrets, value-version history, automatic rotation/restart, durable mutation replay, adoption of existing Secrets, additional storage backends, public reveal/list APIs, new grant APIs, credential issuance/revocation, SecretBroker services, CredentialGateway/OpenShell substitution implementation, generic source registries, arbitrary text replacement, and non-Kubernetes compute.

**Architecture handoff:** the repository [platform design](../../docs/design.md#secret-access) is the current implementation design and records this approved env-delivery amendment. This same PR updates it from exact-Agent to Namespace-owned Secrets. Project-root `ref/design.md` remains the external broker-target owner handoff outside this worktree's write scope; it does not reopen the accepted storage/env decision.

## Contract

### Storage, owner, and bootstrap

OCC owns each Secret's stable ID, name, Namespace ID, selected driver identity, and opaque backend reference. Names are unique within the Namespace, parallel to existing ServiceAccount names. Secret metadata and backend identity do not contain `agentId`, do not require Agent existence, and do not create a foreign key to Agents. Each Secret holds one nonempty UTF-8 value without NUL; only that value is mutable. IAM grants cannot override the Namespace boundary or convert Namespace membership into Secret consumption.

Reuse the [Configuration ownership pattern](../../packages/occ/src/state/postgres-schema.ts): PostgreSQL owns safe metadata, while the driver stores secret bytes. Public metadata reads use OCC state, not a second driver metadata authority, and do not assert backend readiness. Values must not enter OCC PostgreSQL, operation/audit payloads, revisions, ConfigMaps, public responses, platform logs, or containers without an admitted binding for that Secret. Audit only allowlisted identities, actions, and outcomes; regex redaction is insufficient.

The operator establishes Kubernetes access, tenant-local API RBAC, at-rest encryption, safe backups, and metadata-only Kubernetes auditing for Secret operations. An authorized owner or upstream issuer supplies material through the protected API; SecretDriver stores it but does not mint credentials. OCC verifies the existing Namespace's ready Compute-owned placement, not an Agent record. Kubernetes credentials remain installation bootstrap inputs, outside the store they enable.

Bootstrap order is: ready Namespace -> create Namespace-owned Secret -> create or update a Configuration binding -> create or update an Agent assignment -> deploy. A Secret may exist before any Agent in the Namespace. Neither secret storage nor Agent identity depends on a running gateway; the driver does not create another namespace, Agent, grant, broker, compatibility mode, or provisioning phase.

The API-side KubernetesSecretDriver creates an ordinary **mutable** Opaque Kubernetes Secret with a Namespace-derived, non-reused name and fixed `value` key. OCC records its UID/name/key; the driver checks exact Namespace/Secret ownership for writes, binding validation, delivery, and deletion. Update preserves object identity and unrelated metadata, uses Kubernetes concurrency preconditions, and surfaces conflicts. Missing or foreign objects are not silently recreated or adopted; callers cannot choose raw Kubernetes namespace/name selectors. Existing bootstrap/ServiceAccount Secrets retain their owners.

### API and per-use binding

Add Namespace-scoped Secret create/read/update/delete through the existing resource API. Create accepts `{ name, value }`; read and write responses contain only `{ id, namespaceId, name, ref }`. `ref` retains the existing resource-reference shape `{ kind: "secret", namespaceId, id }`. Update accepts `{ value }` for an existing Secret ID and returns the same reference. Reject oversize values; use protected input, never command-line literals or value-bearing errors.

| Method | Route                                        | Operation      | Result                |
| ------ | -------------------------------------------- | -------------- | --------------------- |
| POST   | `/namespaces/:namespaceId/secrets`           | `createSecret` | 201 metadata only     |
| GET    | `/namespaces/:namespaceId/secrets/:secretId` | `getSecret`    | 200 metadata only     |
| PATCH  | `/namespaces/:namespaceId/secrets/:secretId` | `updateSecret` | 200 same metadata/ref |
| DELETE | `/namespaces/:namespaceId/secrets/:secretId` | `deleteSecret` | 204                   |

The driver implements storage `create`, `update`, `delete`, and validated env-projection resolution. It returns no plaintext to ordinary OCC/Compute consumers. Bundled Installation configuration selects KubernetesSecretDriver under `drivers.secret`; unavailable selection or persisted driver-identity mismatch fails closed. No request can select its own driver or fall back to another source.

This proposed SDK fragment stores the Secret before any Agent exists. Unchanged provider endpoint/model fields are omitted:

```ts
const secret = await occ.secrets.create({ namespaceId, name: "model-key", value });
const configuration = {
  secretBindings: {
    OPENAI_API_KEY: { source: secret.ref }, // defaults to delivery: { type: "env" }
  },
  values: {
    secrets: {
      providers: {
        model: { source: "env", allowlist: ["OPENAI_API_KEY"] },
      },
    },
    models: {
      providers: {
        openai: {
          apiKey: { source: "env", provider: "model", id: "OPENAI_API_KEY" },
        },
      },
    },
  },
};
// Later: update this Secret's value; keep secret.ref and the binding unchanged.
```

`Configuration.secretBindings` maps destination env names to `{ source, delivery?: { type: "env" } }`, separately from native `Configuration.values`. All bound Secrets must belong to the same Namespace as the Configuration and consuming Agent. A Configuration create or update whose resulting Configuration contains bindings requires the caller to have the existing Configuration mutation permission and `operate` on every selected Secret, including retained bindings when PATCH omits `secretBindings`. Creating or updating an Agent assignment to a bound Configuration requires the caller to have the existing Agent mutation permission and `operate` on each exact Secret. Unbound Configurations retain their existing semantics. Admission freezes normalized bindings and selected driver identity in AgentRevision; it does not snapshot backend locators or pin secret values. OCC metadata remains the sole authority for each immutable Namespace/backend identity.

Source identifies the supplying authority; delivery specifies consumption. Only typed Secret references and env delivery are implemented here. A future CredentialGateway can supply its own typed reference and substitution mode without routing every opaque reference through SecretDriver. Its schema/executor stays deferred. Unknown source kinds or delivery modes are rejected, never downgraded to plaintext env.

The accepted OpenClaw [v2026.5.28 SecretRef](https://github.com/openclaw/openclaw/blob/v2026.5.28/src/config/types.secrets.ts) remains `{ source, provider, id }`, supporting `env`, `file`, and `exec`. The example uses env; preserve other supported native refs without claiming this driver provisions their files/executables. Do not add a native `kubernetes` source or resolve arbitrary configuration text in OCC.

### Authorization and delivery

Use existing IAM actions on resource kind `secret`: `create`, `read`, `update`, `delete`, and **`operate` for consumption**. Create requires Secret create authority in the exact Namespace; it does not require an Agent or grant any Agent access. Every mutation validates exact Namespace ownership. Binding writes separately authorize each exact Secret. Deployment requires `operate` on each Secret for both the deploying caller and the consuming Agent service principal, plus existing Agent deployment authority and Restrictions. Metadata read, Configuration access, Agent access, Namespace membership, or possession of a ref grants no consumption. Deny cross-Namespace refs even when both IAM decisions allow.

Binding changes validate OCC metadata, exact Namespace ownership, and authorization; admission additionally validates live backend existence/ownership through the API-side driver. Both serialize dependencies against deletion. Before each preparation, the worker resolves the revision's typed refs from OCC metadata and passes safe env-projection references as an ephemeral Compute preparation/activation context. Compute verifies the exact Agent and backing Namespace before rendering. No backend locator is duplicated in an immutable revision, and neither worker nor workload gains Secret API verbs. This uses existing composition, not a new gateway/bootstrap RPC.

Compute projects explicit `env[].valueFrom.secretKeyRef`, with `optional: false`, into only the selected consuming Agent gateway container for that revision. Authorized same-Namespace sharing means multiple Agent assignments can reference the same Namespace Secret, but each Agent still receives only bindings explicitly admitted for its Configuration/revision. Reject duplicate destinations, malformed env names, and control/transport/identity variable overrides. Missing material blocks readiness/activation. Native projection cannot pin a UID or value version: non-reused names, Namespace checks, deletion guards, and trusted Kubernetes writers protect identity, while value updates intentionally affect future container starts. [Kubernetes delivery](https://kubernetes.io/docs/concepts/configuration/secret/)

`OPENAI_API_KEY` is an embedded model-credential slot: an explicit binding replaces its operator projection for that selected Agent gateway, so the old model Secret is not additionally required; a competing ServiceAccount source is rejected. A dedicated gateway cannot bind model credentials; dedicated Codex retains its existing credential path. Generic bindings never fan out to Harnesses, sidecars, workers, or an Agent without an explicit binding and assignment. [Current projection](../../apps/controller/src/drivers/compute/kubernetes/index.ts)

Env delivery intentionally exposes bytes in backing Kubernetes storage, transient protected API/driver memory, and the gateway container's environment/process memory, including inheriting subprocesses. These are not leak-test failures. Platform logging/audit/responses and unselected consumers must omit values; an authorized application can still disclose a value it receives. Operators must constrain Secret and Pod-spec writers: Pod creation can indirectly expose same-namespace Secrets despite denied direct reads. [Kubernetes trust boundary](https://kubernetes.io/docs/concepts/security/secrets-good-practices/)

### Update, restart, deletion, and failure

An authorized update changes the existing backing Secret, not its reference, Configuration, AgentRevision, or running process environment. Success means **stored**, not delivered. Updates serialize per Secret; a retry is a new write, not replay of a durable operation. No controller watches Secrets to restart gateways automatically. [Environment updates require restart](https://kubernetes.io/docs/tasks/inject-data-application/distribute-credentials-secure/#define-container-environment-variables-using-secret-data)

The operator explicitly uses the existing OCC Agent deployment action with the binding unchanged for each consumer that should observe the update. Each new revision restarts only that Agent's gateway through normal preparation/cutover; readiness precedes activation. A process starts with the current backing value, including when an older revision restarts. A failed cutover preserves existing workload/routing recovery behavior but **does not restore the previous secret value**. This contract provides immutable references, not credential-value rollback. Accidental infrastructure restarts can also consume the updated value before an explicit redeploy.

Revoking `operate` denies new OCC admissions; kubelet env injection does not reauthorize each process start. Revocation cannot erase delivered bytes. Stop affected workloads or revoke at the issuer when immediate loss of credential access is required.

Delete is rejected when referenced by current Configuration metadata, the active revision, or pending controller work for a referencing revision. Serialize authoritative dependency checks with Configuration changes and deployment; do not use an unlocked JSON scan. Retired history may retain opaque refs, but cannot redeploy a missing source. Namespace removal is blocked while owned Secrets remain; Agent removal does not own or garbage-collect Namespace Secret storage. Cleanup deletes only exact Namespace-owned objects, including in adopted backing namespaces.

Keep Secret CRUD synchronous; the existing [PlatformOperation](../../packages/occ/src/state/platform-state.ts) is a reconciliation ledger, not a mutation-replay queue. Creation exposes bindable metadata only after backing storage is verified. A partial delete may leave metadata whose backend is missing; binding validation denies it, and an authorized delete retry can finish exact-owned cleanup. There is no generic retry worker or secret-value journal.

PostgreSQL and Kubernetes are not atomic. Backend failure/ambiguous commit returns a safe failure or unknown outcome, never false success or an assertion that the value stayed unchanged. Preserve the existing unknown-commit guard: do not destructively compensate a possibly committed create, and never persist old values for rollback. An authorized operator resolves exact metadata/backend identity before cleanup or a new write; a lost create response may require operator recovery rather than automatic replay. Test known failures and ambiguous outcomes without logging values.

## Implementation

1. Extend [resource/driver/Configuration/revision contracts](../../packages/contracts/src/index.ts), [API schemas](../../packages/contracts/src/api/resources.ts), [routes](../../packages/contracts/src/api/routes.ts), and [IAM](../../packages/iam/src/index.ts) for Namespace-owned Secret CRUD, existing `operate` authorization, and separate bindings. Keep write bodies outside generic log/audit/error serialization.
2. Extend [OCC resource, assignment, and admission checks](../../packages/occ/src/index.ts), [state repositories](../../packages/occ/src/state/platform-state.ts), [PostgreSQL constraints](../../packages/occ/src/state/postgres-schema.ts), and [revision encoding](../../packages/occ/src/state/postgres-state.ts) for Namespace-only metadata, serialized dependencies, frozen refs, and safe synchronous failures; no plaintext columns, `secret.agentId`, Agent foreign key, or generic mutation queue.
3. Add KubernetesSecretDriver using existing [Kubernetes ConfigurationDriver](../../apps/controller/src/drivers/configuration/kubernetes/index.ts) and [API-side Secret storage](../../apps/controller/src/drivers/compute/kubernetes/index.ts) as client/ownership prior art. Register through [Installation config](../../apps/controller/src/composition/installation-config.ts), [production](../../apps/controller/src/composition/production.ts), and [development composition](../../apps/controller/src/composition/development-postgres.ts); consume verified Compute placement.
4. Wire [HTTP handlers](../../apps/controller/src/index.ts), [Compute projection/redeployment](../../apps/controller/src/drivers/compute/kubernetes/index.ts), and [Helm RBAC](../../deploy/helm/openclaw-enterprise/templates/rbac.yaml). Grant the API needed tenant-local Secret verbs independently of ChatGPT integration; retain worker/workload Secret-verb denial and default-deny networking.
5. Reconcile the architecture handoff; update [Configuration](../../docs/reference/configuration.md), [settings](../../docs/reference/settings.md), [deployment guidance](../../docs/guides/deploy.md), and a short [Kubernetes Secret Driver](../../docs/reference/drivers/kubernetes-secret.md) reference linked from [the index](../../docs/README.md). Document protected input, Namespace-first bootstrap, explicit per-consumer redeploy, no value rollback, and safe cleanup; preserve account/admin-key guidance.

## Verification

1. Prove Secret creation before any Agent exists in the Namespace, Namespace-unique naming, metadata-only read/update/delete, and no `secret.agentId` or Agent foreign key in public metadata, backend identity, or PostgreSQL. Namespace membership alone must not read, update, delete, or operate the Secret.
2. Prove every Configuration create/update whose resulting Configuration contains `secretBindings` requires the normal Configuration mutation permission and `operate` on every selected Secret, including retained bindings when PATCH omits `secretBindings`. Possession of a Secret ref, Configuration read/update alone, or Namespace membership alone must fail.
3. Prove Agent create/update assignment to a bound Configuration requires the normal Agent mutation permission and `operate` on each exact Secret. Cross-Namespace refs are unsupported and fail even when both Namespaces contain matching names or IDs.
4. Extend [real Kubernetes Agent proof](../../tests/integration/harness-topology-k3d-real.test.mjs) with PostgreSQL, actual API/worker composition, and pinned OpenClaw. The deploying caller and the Agent service principal both need `operate` on every bound Secret. The authorized operator deploys an embedded Agent, completes a real provider-backed turn, then invalidates only the native provider/reference so the turn fails and restoring it succeeds. Ambient/operator model credentials cannot bypass this proof.
5. Prove explicit same-Namespace sharing through two Agent assignments that bind the same Secret. Kubernetes projects `env[].valueFrom.secretKeyRef` only into each selected gateway's authorized env destinations; Agents without an admitted binding for that Secret, dedicated model credentials, sidecars, workers, logs, audits, responses, revisions, and ConfigMaps do not receive values. Updating the shared Secret keeps the same ref, restarts no workload, and requires explicit redeploy/restart for each consumer to observe the new value.

### Current verification

On 2026-08-28, independent verification of the real Kubernetes Secret API
scenario after rebasing onto main `84e773f` passed: 1 passed, 0 failed, 0 skipped, exit 0, in
386.4s with OpenClaw 2026.8.1. It proved pre-Agent Secret creation, caller
binding denial before exact Secret grants, Agent service principal denial before
explicit Secret grant, two selected Agent model-sharing turns, private env
absence, shared sentinel `v1` to `v2` update with no automatic restart and
independent redeploy per consumer, cross-Namespace denial, missing-backend
rejection, unbound deletion, private stable-ref same-revision restart and
redeploy, native-ref startup failure followed by restoration, and no-leak
assertions.

Post-rebase focused verification also passed: conformance 134 passed with
1 optional skip, and static, API, startup, and Helm checks passed. The prior
PostgreSQL Secret-state proof remains 2 passed with 0 skipped, and post-rebase
real Compute passed 2 cases with 0 skipped. The earlier exact-Agent-owned proof
is superseded for ownership and retained only as historical storage/delivery
context.

This does not claim the broader runtime suite is green: host OpenClaw model tests
encountered stale generated assets, and the dedicated Codex file-edit scenario was
blocked by an unavailable native hook relay after its real turn and Secret-binding
denial succeeded. Those runtime repairs are outside this implementation.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-28 16:33]: Updated Namespace-owned Secret verification to the passing post-rebase Agent and Compute proofs against main 84e773f and conformance 134. (01a043fa-27fd-7651-b75a-4d46538a2809 - f7c33d5)

- [2026-08-28 15:56]: Recorded current Namespace-owned Secret verification from the parent-inspected live proof and focused suites. (01a043fa-27fd-7651-b75a-4d46538a2809 - 9214fbb56f0437b7529f4a9aaa325ae73a489453)

- [2026-08-28 14:48]: Applied accepted review fixes for retained Configuration binding authorization, repository-design handoff wording, implementation-pending status, and unselected-consumer leakage language. (01a043fa-27fd-7651-b75a-4d46538a2809 - 9214fbb56f0437b7529f4a9aaa325ae73a489453)

- [2026-08-28 14:40]: Amended the SecretDriver contract to Namespace-owned Secrets, explicit same-Namespace consumption, no `secret.agentId`, per-consumer restart, and superseded prior exact-Agent verification for ownership. (01a043fa-27fd-7651-b75a-4d46538a2809 - 9214fbb56f0437b7529f4a9aaa325ae73a489453)

- [2026-08-28 13:43]: Removed the research link after moving the reports to the project workspace; implementation decisions are unchanged. (01a043fa-27fd-7651-b75a-4d46538a2809 - 4e6162e27fd0a6790054125267dcc48db44da8d0)

- [2026-08-28 13:12]: Recorded implemented storage/delivery, current reference ownership, independently passed SecretDriver acceptance, and separate broader-runtime limits. (01a043fa-27fd-7651-b75a-4d46538a2809 - 07d8eb57a05cf4b439f1cb04816da723e4a36209)

- [2026-08-28]: Began authorized sw-loop implementation; incorporated one-pass reviews with explicit routes, metadata-only Configuration checks, admission-time backend checks, and one OCC backend-reference authority. (01a043fa-27fd-7651-b75a-4d46538a2809 - 315b1ef5dc4c8dedc5512637f46eb947317ee61b)

- [2026-08-28 10:17]: Applied Kevin's stable-value update plus explicit restart and no-sharing decisions; made Secrets exact-Agent-owned, clarified owner-first bootstrap and no credential rollback, and incorporated compatible IAM/metadata/synchronous-failure review corrections. (01a043fa-27fd-7651-b75a-4d46538a2809 - 315b1ef5dc4c8dedc5512637f46eb947317ee61b)
- [2026-08-28 09:34]: Replaced the resolver-only draft with KubernetesSecretDriver storage, scoped source/delivery bindings, immutable replacement semantics, explicit bootstrap/architecture boundaries, and real Agent acceptance; independent reviews and approval pending. (01a043fa-27fd-7651-b75a-4d46538a2809 - 315b1ef5dc4c8dedc5512637f46eb947317ee61b)
- [2026-08-28 09:24]: Marked the resolver-only draft superseded by Kevin's storage, default KubernetesSecretDriver, and explicit delivery requirements; linked the platform research without treating its API proposals as approved implementation scope. (01a043fa-27fd-7651-b75a-4d46538a2809 - 315b1ef5dc4c8dedc5512637f46eb947317ee61b)
- [2026-08-27 21:12]: Included the canonical production startup example in the implementation documentation checklist after rebasing onto origin/main; the approved design is unchanged. (01a043fa-27fd-7651-b75a-4d46538a2809 - 315b1ef5dc4c8dedc5512637f46eb947317ee61b)
- [2026-08-27 10:29]: Applied approved review simplifications: version-pinned native references, API-only file consumption, owner-derived Agent projection, gateway-owned resolution, and reference-specific live proof. (01a043fa-27fd-7651-b75a-4d46538a2809 - 1f3c8445e0da0609023b3446f35ebfcc66939afd)
- [2026-08-27 09:09]: Drafted the source-backed singular SecretDriver contract, operator-owned bootstrap boundary, native OpenClaw provider resolution, and real isolated Agent-turn acceptance. (01a043fa-27fd-7651-b75a-4d46538a2809 - 1f3c8445e0da0609023b3446f35ebfcc66939afd)
