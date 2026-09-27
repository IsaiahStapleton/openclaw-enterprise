# RFC: Credential Gateway Driver for Sandbox-injected credentials

**Date:** 2026-09-26
**Status:** Implementing; the first slice shipped in
[#461](https://github.com/openclaw/openclaw-enterprise/pull/461). See the
[delivery record](#delivery-record).
**Owner:** Driver contracts, Agent deployment, and the OpenShell integration.
**Source baseline:** OCE `main` at `e4a807e7`, which pins OpenShell
[`v0.1.0`](https://github.com/NVIDIA/OpenShell/tree/v0.1.0) (`496ebba2`). Upstream
paths below are relative to that tag.

## Problem and decision

Agents need credentials for model providers, source control, cloud APIs, and
package registries. OCE delivers them today as Kubernetes `secretKeyRef`
environment entries, which puts the real value in the Harness process. The
[target design](../docs/design/safeguards.md#secret-access) calls this a temporary
exception: the Harness should receive only scoped substitutes.

OpenShell keeps credentials out of the workload for every provider type it
supports. Its gateway stores a _provider_, and the Sandbox's supervisor Pod
applies it to outbound requests. The workload Pod has no direct egress and
never receives a real value.

Add a `credential_gateway` Driver capability. It manages credential sources and
their attachment to Agent revisions. How a credential reaches a request
(placeholder substitution, proxy-inserted headers, request signing, or
gateway-minted tokens) belongs to the implementation. OCE's contract never names
those mechanisms. The OpenShell module implements both `sandbox` and
`credential_gateway` through one shared `openshell` Backend.

This follows the separate-capability direction of
[PR #386](https://github.com/openclaw/openclaw-enterprise/pull/386) and the
deferred `CredentialGatewayDriver` in the
[archived Sandbox provisioning spec](.archive/13-sandbox-driver-provisioning.md).
It omits #386's per-request `mediate` operation, because OCE is not on the
request path when the Sandbox injects credentials.

## Scope

In scope:

- The `credential_gateway` Driver contract, the `openshell` Backend, and their
  composition with the OpenShell SandboxDriver.
- A Namespace-scoped `CredentialSource` resource, Agent bindings to it, and
  Harness model authentication through a bound source.
- A contract that accommodates every OpenShell source type, with first delivery
  limited to the types that have a real integration proof (see
  [the next section](#openshell-source-types)).
- Withdrawing one Agent's access without affecting other Agents.

Out of scope:

- The app-server transport token, projected workload token, workspace mounts,
  plugin-runtime files, and Authorization stripping on exposed OpenShell routes.
  These remain separate OpenShell blockers.
- Embedded OpenClaw, which OpenShell already rejects.
- Credential Gateway implementations without a Sandbox, such as a proxy for plain
  Kubernetes Compute. The contract permits them; none is delivered here.

## OpenShell source types

Sources: `docs/how-it-works/providers/overview.mdx:204-302` and
`docs/how-it-works/providers/profiles.mdx:500-600`.

| Source type                                                          | How OpenShell applies it                                                             | Inputs OCE supplies                                                | First delivery                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `static`                                                             | Placeholder in the workload environment; the proxy substitutes it at bound endpoints | Secret values                                                      | Yes: real OpenAI key                                               |
| `external`                                                           | Same as `static`; an external owner pushes new values                                | Secret values, updated later                                       | Yes: real OpenAI key                                               |
| Gateway refresh: `oauth2_refresh_token`, `oauth2_client_credentials` | Gateway mints access tokens; the placeholder stays stable across rotations           | Secret and non-secret refresh material                             | Yes: real in-cluster Keycloak                                      |
| Gateway refresh: `google_service_account_jwt`                        | Same as above                                                                        | Service account email and private key                              | Deferred: needs an authorized Google service account               |
| `aws_sts_assume_role`                                                | Gateway mints three credentials; the proxy re-signs requests with SigV4              | Role ARN, optional session settings and long-lived source keys     | Deferred: needs an authorized AWS role                             |
| Token grant: `client_credentials`, `token_exchange`                  | Supervisor obtains a token with its SPIFFE JWT-SVID; the proxy inserts the header    | Profile configuration; a stored subject token for `token_exchange` | Deferred: needs SPIRE and an issuer that accepts SPIFFE assertions |

The contract and catalog shape cover every row. The OpenShell driver's
`listSourceTypes` omits deferred types, so registration rejects them. Each
deferred type ships in its own change with a real-path integration test.
None is claimed as delivered without one.

Every type binds credentials to profile endpoints and returns 403
(`credential_endpoint_mismatch`) elsewhere
(`docs/how-it-works/providers/overview.mdx:411-433`). Providers belong to an
OpenShell workspace, and any workspace `user` can attach any provider in it
(`crates/openshell-server/src/grpc/sandbox.rs:1257-1278`).

## Contract

### Composition

Add `credential_gateway` to `DRIVER_CAPABILITIES`
(`packages/contracts/src/index.ts:42`) and an `openshell` Backend type. The
Backend owns the gateway client and declares both required members, following
the existing [Backend membership](../docs/reference/backends.md) pattern:

```yaml
backends:
  - id: openshell
    type: openshell
    configuration: { endpoint: https://…, auth: { mode: bearerTokenFile, path: … } }
    drivers: { sandbox: openshell-sandbox, credential_gateway: openshell-credentials }
```

Startup rejects a selected `credential_gateway` whose Backend members are not
both selected. The shared Backend replaces #386's `sandboxDriverId`
configuration, and each role keeps its own selection.

### Driver interface

```ts
interface CredentialGatewayDriver extends Driver {
  readonly capability: "credential_gateway";
  listSourceTypes(context: CredentialGatewayContext): Promise<readonly CredentialSourceType[]>;

  registerSource(context: SourceContext, input: CredentialSourceInput): Promise<SourceStatus>;
  updateSource(context: SourceContext, input: CredentialSourceInput): Promise<SourceStatus>;
  rotateSource(context: SourceContext): Promise<SourceStatus>;
  sourceStatus(context: SourceContext): Promise<SourceStatus>;
  removeSource(context: SourceContext): Promise<void>;

  attachForRevision(context: RevisionContext): Promise<readonly SourceAttachment[]>;
  attachmentStatus(context: RevisionContext): Promise<readonly AttachmentStatus[]>;
  withdraw(context: RevisionContext & { readonly sourceId: string }): Promise<AttachmentStatus>;
}

interface CredentialSourceType {
  readonly type: string; // implementation-defined, for example "openai" or "aws"
  readonly config: readonly FieldSpec[]; // non-secret inputs
  readonly secrets: readonly FieldSpec[]; // inputs supplied as OCC Secret references
  readonly rotation: "none" | "external" | "gateway";
  readonly harnessAuth?: { readonly modelProvider: string; readonly loginMode: string };
}

interface CredentialSourceInput {
  readonly type: string;
  readonly config: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>; // resolved values, never persisted by OCC
}

interface SourceAttachment {
  readonly sourceId: string;
  readonly ref: string; // opaque; consumed by the paired SandboxDriver
}
```

Contract rules:

- `listSourceTypes` is the implementation's catalog, like `PluginDriver.listCatalog`.
  OCC validates inputs against it; unknown types and fields fail before any effect.
- Register, update, and remove are idempotent for one source. The driver never
  logs, returns, or persists a secret value outside its credential store.
- `attachForRevision` returns one attachment per bound source or throws. The
  paired SandboxDriver's `provisionHarness` must consume every attachment and
  reject any it did not issue.
- `withdraw` returns `withdrawn` only after the implementation observes
  revocation. For OpenShell, that is a detach receipt in state `revoked`: the
  withdrawn placeholders stop resolving, even in running processes, but
  requests already forwarded upstream are not undone
  (`docs/how-it-works/providers/profiles.mdx:1018-1080`). Otherwise `withdraw`
  returns `pending`, and retries continue.
- `removeSource` fails while any active or candidate revision references the
  source. OpenShell also refuses to delete an attached provider. Withdrawal never
  deletes shared source material.
- Static updates reach only newly started processes, so a running Harness keeps
  the previous value until it restarts. Gateway refresh keeps stable references.

### Resource and bindings

`CredentialSource` is a Namespace-scoped OCC resource: name, type, non-secret
config, OCC Secret references for secret inputs, selected driver ID, and safe
status. It fills the deferred `SecretBroker` slot in the
[resource model](../docs/design/resources.md). Values stay with the Secret Driver
and the credential store, and never enter OCC state, revisions, or audit.

An Agent gains nullable `credentialSources: CredentialSourceReference[]`.
Admission freezes the references, source types, and `credentialGatewayId` in the
revision. `harnessAuth` gains `{ method: "credential_source"; sourceId }`. It
requires a source type whose `harnessAuth.modelProvider` matches the configured
model. With a credential gateway selected, secret-backed `harnessAuth` methods
return 409; there is no fallback to environment delivery.

IAM follows existing Secret patterns. Source create, read, update, and delete are
exact-resource actions. Registration also requires `operate` on each referenced
OCC Secret. Binding a source to an Agent requires `operate` on the source for the
actor, and admission also requires it for `Agent.servicePrincipalId`.

### Lifecycle and authority

OpenShell checks both the token scope and the caller's role on every RPC
(`proto/openshell.proto` authorization options). OCC uses two gateway principals:

- **Worker principal:** global `platform_admin`, which the existing Sandbox
  driver already needs to create and delete workspaces. Its token carries
  `workspace:read`, `workspace:write`, `sandbox:read`, and `sandbox:write`, and
  no `provider:*` scope, so it cannot read or change provider material.
- **API principal:** workspace `admin` membership in each OCC workspace, with
  `provider:read` and `provider:write`. It has no role outside OCC workspaces
  and no `sandbox:*` scope.

| Operation                 | Principal | OpenShell RPCs (scope; role)                                                                                                                                                                                |
| ------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepare a Namespace       | Worker    | `GetWorkspace` (`workspace:read`; user), `CreateWorkspace` (`workspace:write`; `platform_admin`), `AddWorkspaceMember` for the API principal as admin and `ListWorkspaceMembers` (`workspace:write`/`read`) |
| Create or update a source | API       | `ImportProviderProfiles`, `CreateProvider`, `UpdateProvider`, `ConfigureProviderRefresh` (`provider:write`; admin)                                                                                          |
| Rotate a source           | API       | `RotateProviderCredential` (`provider:write`; admin)                                                                                                                                                        |
| Read source status        | API       | `GetProvider`, `GetProviderRefreshStatus` (`provider:read`; user)                                                                                                                                           |
| Provision a revision      | Worker    | `CreateSandbox` with `SandboxSpec.providers` (`sandbox:write`; user)                                                                                                                                        |
| Read attachment status    | Worker    | `GetSandboxProviderStatus` (`sandbox:read`; user)                                                                                                                                                           |
| Withdraw one Agent        | Worker    | `DetachSandboxProvider` (`sandbox:write`; user), then `GetSandboxProviderStatus`                                                                                                                            |
| Retire a revision         | Worker    | `DeleteSandbox` (`sandbox:write`; user); attachments go with the Sandbox                                                                                                                                    |
| Delete a source           | API       | `DeleteProvider`, `DeleteProviderProfile` with the last source (`provider:write`; admin), then `GetProvider` (`provider:read`)                                                                              |
| Delete a Namespace        | Worker    | `DeleteWorkspace` (`workspace:write`; `platform_admin`)                                                                                                                                                     |

The API reads each OCC Secret through a new `SecretDriver` method that returns
the value only for an authorized Credential Gateway registration. An Agent's
model credential therefore no longer passes through the worker, unlike the
current `deliverHarnessAuth` copy. An authorized withdrawal request is recorded
by the API and carried out by the worker, because only the worker holds
`sandbox:write`.

Withdrawal is revocation, so it applies to a running revision. The revision
keeps its frozen binding but cannot re-attach a withdrawn source; a later
deployment must omit the source or bind a replacement.

### Cleanup and retry

- **Sources.** Deleting a source marks it `deleting`, then the API calls
  `DeleteProvider` and confirms that `GetProvider` returns not found. If the
  gateway is unavailable or the outcome is uncertain, the record stays
  `deleting`, the API returns 503, and the caller retries. A provider that is
  already absent counts as deleted. `DeleteProvider` also removes the provider's
  refresh state (`crates/openshell-server/src/grpc/provider.rs`,
  `delete_provider_record_with_credentials`).
- **Namespaces.** `CredentialSource` joins the resources that make a Namespace
  nonempty, so Namespace deletion returns `409 NAMESPACE_NOT_EMPTY` while any
  source record exists, including one in `deleting`. The worker therefore
  deletes the workspace only after every OCC provider and profile is gone.
  OpenShell rejects `DeleteWorkspace` with `FailedPrecondition` while providers,
  profiles, or refresh state remain (`docs/how-it-works/workspaces.mdx:221-234`).
  The worker keeps the Namespace `deleting` and retries.
- **Withdrawal.** The worker repeats `DetachSandboxProvider`, which is
  idempotent, until the receipt reaches `revoked`. After
  `CONFIG_OPERATION_STORAGE_UNCERTAIN`, it reads the current status before
  retrying, as upstream requires.
- **Revisions.** Existing retirement retries until the Sandbox is gone. Sources
  it referenced become deletable only after that.

### Harness runtime

The entrypoint receives only the literal login mode from the source type's
`harnessAuth.loginMode`. For an `openai` static source, the supervisor sets the
`OPENAI_API_KEY` placeholder, and `codex login --with-api-key` stores it. The
upstream `codex` profile supplies `CODEX_AUTH_*` placeholders for a ChatGPT
account. It declares no gateway refresh and only allows `auth.openai.com`, so
the Codex CLI would refresh with placeholder values in the request body. The
Codex startup model probe checks either path before readiness.

## Trust requirements

- OCC's two principals must be the only members of its OpenShell workspaces,
  because workspace users can attach any provider. The worker checks this with
  `ListWorkspaceMembers` when preparing the Namespace and fails on any other
  member. Platform Admins bypass membership, so the worker principal must be the
  only Platform Admin; OCC cannot verify that through the API.
- Sources do not cross OCC Namespaces; each OCC Namespace maps to one workspace.
- Credentialed endpoints require L7 inspection. Codex and other clients must
  trust the per-generation Sandbox CA.
- The guarantee depends on OpenShell's NetworkPolicy, which admits only
  supervisor ingress to the workload and denies workload-initiated connections.
  The cluster's network plugin must enforce it
  (`docs/kubernetes/setup.mdx:11-34`).
- Token grants require a SPIFFE Workload API for supervisors.
- `token_exchange` stores a subject token. The design's non-goals exclude
  "Delegating human identity or authentication to an Agent", so the subject must
  be a non-human principal until that is revisited.
- Outside development, registration requires an `https` gateway endpoint with
  bearer authentication.

## Failure behavior

- Unknown source types, missing inputs, and unauthorized Secrets fail before any
  gateway call.
- A failed registration leaves no source. An uncertain one stays pending, and
  the record keeps the provider name so retries adopt it or delete it.
- Missing attachment readiness keeps the candidate inactive.
- An endpoint mismatch at the proxy fails the request, and the Harness startup
  probe keeps the Pod unready.
- A pending withdrawal stays visible in attachment status and is retried; it
  never reports success early.

## Differences from PR #386

- **Adopted:** separate capability, shared sources with per-Agent attachments,
  the four provider operations mapped as above, and a contract for static,
  refreshed, and dynamic credentials.
- **Omitted:** `mediate`, `BoundExchange`, `Assurance` profiles, and branded
  evidence types. OpenShell does not call OCE per request.
- **Not yet a contract:** #386's 30-second active-traffic closure. OpenShell
  `v0.1.0` defines revocation for new resolution, but it does not undo requests
  already forwarded, and it sets no bound for open streams.

## Verification gates

Confirm before `Accepted`:

1. The pinned Codex binary trusts the Sandbox CA and sends request shapes the
   proxy can rewrite, including any WebSocket upgrade.
2. Codex accepts placeholders from `codex login --with-api-key` and the
   `CODEX_AUTH_*` variables without parsing them locally. ChatGPT-account
   refresh works through the proxy, or the source type uses gateway refresh
   instead.
3. A `revoked` detach receipt stops new requests from a running Codex process,
   and the observed effect on open streams is recorded.
4. The principal split works as specified: the worker principal is denied
   provider RPCs, and the API principal is denied workspace and Sandbox RPCs.

## Tests

Extend `tests/integration/sandbox-driver-openshell-k3d-real.test.mjs` through the
regular API and worker workflow:

- Register a static OpenAI source, deploy a dedicated Codex Agent, and complete a
  real model turn. Assert that the key is absent from the Harness Pod spec, every
  Agent- or revision-owned Kubernetes Secret, the Harness process environment,
  and workspace files. The source's own OCC Secret is excluded: it is the stored
  source of record, which the Kubernetes Secret Driver keeps in the tenant's
  control-plane namespace. Also assert that no Pod references that Secret.
- Update an `external` source and prove that a restarted Harness uses the new
  value.
- Withdraw the source from one Agent. That Agent's next model request fails,
  while a second Agent attached to the same source keeps working.
- Register `oauth2_client_credentials` and `oauth2_refresh_token` sources against
  a real in-cluster Keycloak, call a Keycloak-protected endpoint from the
  Harness, and prove a rotation without a restart.
- Prove the permission split and cleanup: denied RPCs for each principal, source
  deletion refused while attached, and Namespace deletion refused while a source
  exists.
- Prove fail-closed cases: an unbound host returns 403, and a direct connection
  from the Harness Pod fails.
- Add conformance cases for startup membership, catalog validation, rejection of
  deferred types, and admission rejection of secret-backed `harnessAuth` with a
  gateway selected.

Deferred source types stay out of the catalog until their real-path tests exist.
This avoids the need for a human override to omit tests.

## Documentation

The implementation PR updates:

- the platform design ([Drivers](../docs/design/drivers.md),
  [resources](../docs/design/resources.md), and
  [Secret access](../docs/design/safeguards.md#secret-access));
- a new Credential Gateway Driver reference, plus the
  [OpenShell SandboxDriver](../docs/reference/drivers/openshell-sandbox.md),
  [Backends](../docs/reference/backends.md),
  [Namespaces](../docs/reference/namespaces.md),
  [Harness execution](../docs/reference/harness-execution.md), and
  [Secret Driver](../docs/reference/drivers/secret.md) references;
- the API, permissions, and database-entity cheat sheets;
- the [OpenShell provisioning flow](../docs/flows/openshell-sandbox-provisioning.md)
  and [OpenShell testing](../docs/testing/openshell.md).

## Delivery record

[#461](https://github.com/openclaw/openclaw-enterprise/pull/461) delivered
registration, removal, attachment, and status for the `openai` source type. A
real OpenShell model turn used the injected key while the Harness held only the
placeholder. The current contract is owned by
[Credential Gateway](../docs/reference/drivers/credential-gateway.md) and
[credential sources](../docs/reference/credential-sources.md).

The implementation differs from this proposal:

- Registration commits a `registering` record before the gateway call. After an
  uncertain call, the record stays `deleting`, and deletion finalizes only
  70 seconds after `createdAt`.
- Secret values come from the existing `SecretDriver.withValue`.
- Compute's `resolveSandboxNamespace` supplies the gateway Workspace, and
  providers set `profile_workspace`.
- Plain in-cluster gateway transport requires `insecureTransport: network-policy`.
- One gateway principal serves the API and worker.

Remaining work is tracked in
[#118](https://github.com/openclaw/openclaw-enterprise/issues/118).

## Open questions

- Should `CredentialSource` keep the design's reserved `SecretBroker` name?
- Should ChatGPT account tokens issued by the ServiceAccount Driver become an
  `external` source that the Driver updates?
- Which principal may supply a `token_exchange` subject token?
