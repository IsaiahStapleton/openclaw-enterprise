# RFC: Credential Gateway Driver for Sandbox-injected credentials

**Date:** 2026-09-26
**Status:** Proposed; not implemented or approved.
**Owner:** Driver contracts, Agent deployment, and the OpenShell integration.
**Source baseline:** OCE `main` at `64ab72ae`; OpenShell
[`v0.1.0-pre.7`](https://github.com/NVIDIA/OpenShell/tree/v0.1.0-pre.7) (`f8002d19`).
The OpenShell facts below must be rechecked against `v0.1.0-pre.12` before acceptance.

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
- Every OpenShell source type (see [the next section](#openshell-source-types)).
- Withdrawing one Agent's access without affecting other Agents.

Out of scope:

- The app-server transport token, projected workload token, workspace mounts,
  plugin-runtime files, and Authorization stripping on exposed OpenShell routes.
  These remain separate OpenShell blockers.
- Embedded OpenClaw, which OpenShell already rejects.
- Credential Gateway implementations without a Sandbox, such as a proxy for plain
  Kubernetes Compute. The contract permits them; none is delivered here.

## OpenShell source types

Sources: `docs/sandboxes/manage-providers.mdx:204-302` and
`docs/providers/profiles.mdx:490-512,542-580` at `v0.1.0-pre.7`.

| Source type                                                                                        | How OpenShell applies it                                                             | Inputs OCE supplies                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `static`                                                                                           | Placeholder in the workload environment; the proxy substitutes it at bound endpoints | Secret values                                                      |
| `external`                                                                                         | Same as `static`; an external owner pushes new values                                | Secret values, updated later                                       |
| Gateway refresh: `oauth2_refresh_token`, `oauth2_client_credentials`, `google_service_account_jwt` | Gateway mints access tokens; the placeholder stays stable across rotations           | Secret and non-secret refresh material                             |
| `aws_sts_assume_role`                                                                              | Gateway mints three credentials; the proxy re-signs requests with SigV4              | Role ARN, optional session settings and long-lived source keys     |
| Token grant: `client_credentials`, `token_exchange`                                                | Supervisor obtains a token with its SPIFFE JWT-SVID; the proxy inserts the header    | Profile configuration; a stored subject token for `token_exchange` |

Every type binds credentials to profile endpoints and returns 403
(`credential_endpoint_mismatch`) elsewhere. Providers belong to an OpenShell
workspace, and any workspace `user` can attach any provider in it
(`crates/openshell-server/src/grpc/sandbox.rs:1224-1278`).

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
- `withdraw` returns `withdrawn` only after the implementation observes the
  attachment removed. Otherwise it returns `pending`, and retries continue.
- `removeSource` fails while any active or candidate revision references the
  source. Withdrawal never deletes shared source material.

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

| Operation                    | Caller                                       | OpenShell calls                                                                                              |
| ---------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Create or update a source    | API, after authorization                     | `ImportProviderProfiles` (once per workspace), `CreateProvider`/`UpdateProvider`, `ConfigureProviderRefresh` |
| Rotate                       | API                                          | `RotateProviderCredential` or `UpdateProvider`                                                               |
| Source status                | API                                          | `GetProvider`, `GetProviderRefreshStatus`                                                                    |
| Prepare a revision           | Worker, in Compute before `provisionHarness` | none; provider names placed in `SandboxSpec.providers`                                                       |
| Attachment status            | Worker, before activation                    | `GetSandboxProviderStatus`                                                                                   |
| Withdraw one Agent           | API, then worker                             | `DetachSandboxProvider`                                                                                      |
| Retire a revision            | Worker                                       | Sandbox deletion removes its attachments; `attachmentStatus` verifies                                        |
| Delete a source or Namespace | API or worker                                | `DeleteProvider`, then `GetProvider` must return not found                                                   |

The API reads each OCC Secret through a new `SecretDriver` method that returns
the value only for an authorized Credential Gateway registration. The API holds
the gateway principal with workspace `admin` and `provider:write`. The worker
keeps only `sandbox:write`, so it can attach providers but not read or change
them. An Agent's model credential, therefore, no longer passes through the
worker, unlike the current `deliverHarnessAuth` copy.

Withdrawal is revocation, so it applies to a running revision. The revision
keeps its frozen binding but cannot re-attach a withdrawn source; a later
deployment must omit the source or bind a replacement.

### Harness runtime

The entrypoint receives only the literal login mode from the source type's
`harnessAuth.loginMode`. For an `openai` static source, the supervisor sets the
`OPENAI_API_KEY` placeholder, and `codex login --with-api-key` stores it. The
upstream `codex` profile supplies `CODEX_AUTH_*` placeholders for a ChatGPT
account. It declares no gateway refresh and only allows `auth.openai.com`, so
the Codex CLI would refresh with placeholder values in the request body. The
Codex startup model probe checks either path before readiness.

## Trust requirements

- OCC must be the only principal with a role in its OpenShell workspaces, because
  workspace users can attach any provider. The OpenShell reference states this;
  pre.7 offers no API for OCC to verify it.
- Sources do not cross OCC Namespaces; each OCC Namespace maps to one workspace.
- Credentialed endpoints require L7 inspection. Codex and other clients must
  trust the per-generation Sandbox CA.
- The guarantee depends on OpenShell's workload fence: a NetworkPolicy giving
  workload Pods empty egress (`docs/kubernetes/sandbox-runtime.mdx:52-78`),
  enforced by the cluster's network plugin.
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
  the four provider operations mapped as above, and support for static,
  refreshed, and dynamic credentials.
- **Omitted:** `mediate`, `BoundExchange`, `Assurance` profiles, and branded
  evidence types. OpenShell does not call OCE per request.
- **Not yet a contract:** #386's 30-second active-traffic closure. Upstream
  documentation disagrees on whether detach or rotation affects running
  processes (`manage-providers.mdx:192`, `inference-routing.mdx:113-120`).

## Verification gates

Confirm before `Accepted`:

1. The pinned Codex binary trusts the Sandbox CA and sends request shapes the
   proxy can rewrite, including any WebSocket upgrade.
2. Codex accepts placeholders from `codex login --with-api-key` and the
   `CODEX_AUTH_*` variables without parsing them locally. ChatGPT-account
   refresh works through the proxy, or the source type uses gateway refresh
   instead.
3. `DetachSandboxProvider` stops new requests from a running Sandbox, and the
   observed effect on open streams is recorded.
4. The API's gateway principal can import profiles and manage providers, and the
   worker's cannot.
5. All of the above hold on `v0.1.0-pre.12`.

## Tests

Extend `tests/integration/sandbox-driver-openshell-k3d-real.test.mjs` through the
regular API and worker workflow:

- Register a static OpenAI source, deploy a dedicated Codex Agent, and complete a
  real model turn. Assert that no Pod spec, tenant Secret, environment, or
  workspace file contains the key.
- Withdraw the source from one Agent. That Agent's next model request fails,
  while a second Agent attached to the same source keeps working.
- Register a gateway-refresh source against a real in-cluster OAuth2 issuer, such
  as Keycloak, and prove a rotation without a restart.
- Prove fail-closed cases: an unbound host returns 403, and a direct connection
  from the Harness Pod fails.
- Add conformance cases for startup membership, catalog validation, and
  admission rejection of secret-backed `harnessAuth` with a gateway selected.

Token-grant and AWS STS proofs need SPIFFE and AWS respectively; they stay
explicit gaps until that infrastructure exists.

## Documentation

The implementation PR updates:

- the platform design ([Drivers](../docs/design/drivers.md),
  [resources](../docs/design/resources.md), and
  [Secret access](../docs/design/safeguards.md#secret-access));
- a new Credential Gateway Driver reference, plus the
  [OpenShell SandboxDriver](../docs/reference/drivers/openshell-sandbox.md),
  [Backends](../docs/reference/backends.md),
  [Harness execution](../docs/reference/harness-execution.md), and
  [Secret Driver](../docs/reference/drivers/secret.md) references;
- the API, permissions, and database-entity cheat sheets;
- the [OpenShell provisioning flow](../docs/flows/openshell-sandbox-provisioning.md)
  and [OpenShell testing](../docs/testing/openshell.md).

## Open questions

- Should `CredentialSource` keep the design's reserved `SecretBroker` name?
- Should ChatGPT account tokens issued by the ServiceAccount Driver become an
  `external` source that the Driver updates?
- Which principal may supply a `token_exchange` subject token?
