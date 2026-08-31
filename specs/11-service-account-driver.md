# Feature Spec: ChatGPT Service Account Driver

**Date:** 2026-08-24
**Status:** Planning
**Owner:** OCC, ChatGPT integration, and Kubernetes Compute
**Source baseline:** `openai/openclaw-enterprise@c11ba6418d06`.

## Problem and Decision

Implement a generic `ServiceAccountDriver` capability with a concrete `ChatGPTServiceAccountDriver` that
creates an upstream account, issues its Codex-enabled access token, and supplies that token to an
associated dedicated Codex Agent. OCC owns only its provider-agnostic, Namespace-scoped account. The
Driver privately owns upstream identities and credential lifecycle; an injected `ChatGPTClient` owns
provider transport and admin authentication; Kubernetes Compute stores and installs the issued token.

Update the authoritative [platform design](../docs/design.md) to replace `ResourceDriver` entirely with
`ServiceAccountDriver`. Explicitly supersede the historical [native-account specification](10-native-service-accounts.md)
where it defers provider Drivers, assigns provider operations to `ResourceDriver`, or prohibits Compute
Secret access. Keep the historical specification unchanged.

## Scope

**Accepted:** selectable `service_account` Driver capability; concrete ChatGPT implementation and shared
provider client; mounted admin credential; durable driver-private account/credential bindings;
provider-agnostic OCC accounts; separate account-creation and credential-creation operations;
Compute-owned Kubernetes Secret storage and installation; dedicated Codex access-token login; and one
real, provider-backed Agent turn.

**Preserved:** existing native accounts, manually associated API-key references, embedded OpenClaw API-key
execution, OCC authorization, Namespace isolation, immutable revisions, and operator-owned transport
Secrets.

**Deferred:** OAuth refresh and execution; access-token execution through embedded OpenClaw; credential
rotation and automated reconciliation; Namespace-to-workspace mapping; plugin/permission Drivers; other
providers; and general-purpose resource, client, credential-materializer, or Harness frameworks.

## Contract

### Provider clients and Driver ownership

A Driver implements one OCC-selected capability and receives an authorized, scoped operation.
`ChatGPTClient` is one concrete, reusable provider dependency injected into Drivers; it owns HTTP
transport and provider authentication, not OCC resources or a selected Driver capability. Its initial
operations create/delete provider accounts and issue/revoke provider credentials. Future
permission/plugin Drivers may reuse the client with independently required authentication and scopes;
additional client facets are deferred. `IAMDriver` remains authorization-only.

Installation startup configuration optionally selects `drivers.service_account` and defines a `chatgpt`
integration with its fixed `workspaceId`, mounted admin-key file path, and bounded credential TTL. Default
the TTL to the existing provider client's 30 days; allow a smaller explicit Installation setting when the
workspace enforces a stricter maximum. Hardcode the trusted `https://api.chatgpt.com/v1` endpoint.
Existing native-only Installations need no provider integration.

Both existing processes use the shared Installation configuration loader. Instantiate `ChatGPTClient` and
`ChatGPTServiceAccountDriver` only from the existing API entrypoint after shared configuration loads;
read the admin key from a dedicated Secret mounted only into that API Pod. The worker keeps its existing
entrypoint and never constructs the client, initializes the service-account Driver, or reads the admin
key. No `role` parameter or alternate Installation initialization path is required. Keep admin
credentials out of startup YAML, PostgreSQL, resources, HTTP responses, logs, Agent workloads, and
worker Pods.

The workspace ID identifies the configured provider backend, not an OCC Namespace. OCC Namespaces retain
their independent existing scope; multiple Namespaces may create separately owned account links against
the same configured workspace. The provider checks the admin key's organization, workspace authority,
and `chatgpt.enterprise.service_account.write` scope independently of OCC authorization.

```ts
interface ServiceAccountCredential {
  readonly kind: "api_key" | "access_token" | "oauth_access_token";
  readonly secretRef: SecretRef;
}

interface ServiceAccount {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly credential?: ServiceAccountCredential;
}

interface ServiceAccountDriver extends Driver {
  readonly capability: "service_account";
  create(account: ServiceAccount): Promise<void>;
  createCredential(account: ServiceAccount): Promise<ServiceAccountCredential>;
  delete(account: ServiceAccount): Promise<void>;
}

class ChatGPTServiceAccountDriver implements ServiceAccountDriver {
  constructor(
    private readonly client: ChatGPTClient,
    private readonly controller: OpenClawController,
    private readonly state: PostgresPlatformState,
    private readonly compute: ComputeDriver,
  ) {}
}
```

The concrete Driver calls `/v1/manage/workspaces/{workspaceId}/service-accounts` for account creation and
`.../service-accounts/{externalAccountId}/credentials` for credential issuance; requests exactly
`chatgpt.workspace.feature.allow-codex-local-access.access`; and sends the explicitly bounded TTL.
It looks up the exact persisted upstream credential ID internally for deletion. Provider denial of an
excessive TTL fails closed; expiration does not trigger renewal. Account names sent upstream must be
unique across OCC Namespaces sharing the provider workspace. The issued access token exists only in the
API process while the Driver hands it directly to Kubernetes Compute for storage; its returned Driver
result contains only the generic credential kind and Secret reference. These components are in-process,
not process-isolated. Provider
behavior is defined by the workspace account Admin API
and existing typed ChatGPT client.

### Account identity, operations, and authorization

Keep the existing Namespace-owned OCC `ServiceAccount` provider-agnostic: its `sa_*` identity owns
authorization, association, and audit; its optional credential contains only a generic kind and exact
Namespace-local `secretRef`. Add the provider-neutral `access_token` kind; preserve `api_key` and the
representable-but-undeployable `oauth_access_token`. Never add `chatgpt`, `provider`, workspace identity,
upstream account identity, or upstream credential identity to the public account contract.

`ChatGPTServiceAccountDriver` privately persists one binding for each managed OCC account:

```ts
{
  serviceAccountId: "sa_...",
  namespaceId: "ns_...",
  driverId: "...",
  externalAccountId: "...",
  externalCredentialId: "...", // Present after issuance; required for exact deletion/reconciliation.
  workspaceId: "...",
}
```

The binding belongs to the Driver, not the public OCC account or API schema. Enforce exact account and
Namespace ownership, immutable Driver/upstream account/workspace identity, and durable upstream
credential identity through private persistence. The Driver participates in the same existing
outer OCC transaction as its account and credential mutations by joining `OpenClawController.transact`
and querying its existing `PostgresPlatformState` transaction context. Keep provider-specific binding
repositories out of the public `PlatformUnitOfWork`; do not introduce an independent pool, a parallel
transaction, or a second transaction context. Persist upstream credential IDs for exact deletion and
future rotation/reconciliation without placing them in API responses, OCC account contracts, or Agent
revisions.

Account creation remains `POST /namespaces/:namespaceId/service-accounts`. With the selected Driver, OCC
authorizes `create` against the exact Namespace collection, allocates the OCC identity, creates the
provider account through the selected Driver, and commits its private binding with the OCC account.
Credential creation is a distinct
`POST /namespaces/:namespaceId/service-accounts/:serviceAccountId/credentials`: authorize `update` on
that exact account, verify its exact Namespace and private Driver binding, reject an existing credential
with `409`, invoke the Driver, and persist only its returned generic credential metadata in the OCC
account. Return `201` with the existing `{ data: ServiceAccount, meta: { requestId } }` envelope; account
responses include only the generic credential kind and Secret reference, never provider identity,
upstream credential identity, workspace identity, or credential bytes.
Existing manual
`PATCH .../credential` remains the existing native/API-key operation and cannot overwrite a provider
account's managed credential. Agent create, update, and deployment additionally require exact account
`read`; an associated account cannot be deleted. Deleting an unassociated provider-linked account removes
its exact source Secret and upstream account; provider or Kubernetes failures leave the operation
unconfirmed and expose only safe cleanup identifiers.

Authorization denial happens before upstream or Kubernetes side effects. OCC audit identifies the actual
OCC principal; the upstream provider independently attributes the call to its authenticated admin key.
OCC permission does not grant provider privileges, and provider admin privileges do not bypass OCC IAM.
An admitted Agent revision snapshots only the exact OCC account ID, generic credential kind, and Secret
reference; no snapshot contains provider identity, workspace identity, upstream credential identity, or
token bytes.

### Compute-owned credential storage and Codex execution

Kubernetes Compute stores an issued access token in one deterministically named, account-owned Secret in
the account's exact backing Kubernetes namespace, labeled with the OCC Namespace and account identities.
The Secret stores the access token and its workspace ID as separate keys; the workspace remains private
driver/runtime data, not public OCC account metadata. The Driver invokes one Compute credential-storage
operation and receives only the token's `{ name, key }`. The API identity creates and deletes this
account Secret. During `prepareRevision`, the worker uses the immutable account identity and generic
Secret reference to project both required keys directly into the associated dedicated Codex Pod through
`secretKeyRef`. Kubernetes resolves both references; neither the worker nor workload receives Kubernetes
Secret API access. Agents associated with the same account intentionally share its one credential. Do not
create an Agent-specific copy.

The dedicated Codex workload receives `CODEX_ACCESS_TOKEN` and the pinned workspace ID directly from the
same Secret; its separate gateway never receives either the account token or admin key. Configure Codex
using that projected workspace and authenticate through stdin with
`codex -c forced_chatgpt_workspace_id="<workspace-id>" login --with-access-token`; store required login
state only in the existing bounded ephemeral Agent volume. Clear the token environment variable after
login. Preserve the existing `OPENAI_API_KEY` / `codex login --with-api-key` path for API-key accounts
and embedded OpenClaw; reject generic access-token deployment for every unsupported Harness/topology
before admission.
The existing Codex service-account integration
demonstrates workspace-pinned `--with-access-token` authentication.

Grant the API service identity only required Kubernetes Secret verbs through operator-authorized
RoleBindings in its exact tenant namespaces; grant no cluster-wide Secret access, `list`, or `watch`.
Worker and workload identities retain zero Secret API permissions. Kubernetes cannot constrain dynamic
Secret `create` by `resourceNames`, so a compromised authorized API identity has namespace-wide Secret
impact. A compromised worker can also indirectly expose any same-namespace Secret by creating or
modifying a Deployment that projects it; denying Secret API verbs does not prevent that access.
Deterministic account-owned names, ownership checks, distinct API/worker roles, and Namespace isolation
bound normal operations but do not remove this tenant-level controller trust boundary. Independent
workload admission that could enforce stronger worker isolation is outside this milestone. Add restricted
provider HTTPS egress for the **API Pod only**, scoped to the fixed trusted endpoint through an explicitly
configured CIDR or approved egress proxy; do not grant worker-wide or unrestricted TLS egress.

Register compensating actions on OCC's outer transaction as soon as provider creation or account-Secret
creation succeeds; preserve them through private binding/account persistence, audit append, and
PostgreSQL `COMMIT`. The Driver revokes only the exact newly issued upstream credential ID from its
private binding or issuance result, deletes only the exact newly created account Secret, and deletes only
the newly created upstream account. It also revokes a newly issued credential if Secret creation fails
before OCC receives the result. If commit outcome is ambiguous, inspect committed private binding/account
state before compensation; never revoke a durably committed credential or guess when durable state is
unavailable. Surface failed compensation or unknown commit outcome for operator reconciliation using
safe driver-private identities.

A provider denial, excessive TTL, unavailable admin credential, missing API tenant RoleBinding, upstream
failure, provider/workspace mismatch, missing or foreign account Secret, expired credential, or
unsupported Harness fails closed; never substitute another account, ambient API key, or workspace. Keep
prior snapshots immutable.

OAuth refresh belongs to a future credential/provider owner that holds refresh authority. It is outside
this implementation; OCC, IAM, Compute, and Harnesses do not refresh OAuth credentials.

## Implementation

1. Amend the authoritative [platform design](../docs/design.md): remove every `ResourceDriver` reference;
   add `ServiceAccountDriver`, shared provider-client dependency, distinct OCC/provider account ownership,
   the approved Compute Secret boundary, dedicated Codex access-token execution, and exact tenant risks.
   Update the current [security model](../docs/reference/security.md), [service-account guide](../docs/reference/service-accounts.md),
   and [Kubernetes Compute guide](../docs/reference/drivers/kubernetes-compute.md) in the same implementation.
2. Add the generic Driver contract, generic `access_token` credential and closed response schemas,
   separate credential route, provider-free immutable revision snapshot, and generated OpenAPI in
   [shared contracts](../packages/contracts/src/index.ts), [API routes](../packages/contracts/src/api/routes.ts),
   [request schemas](../packages/contracts/src/api/common.ts), and
   [response schemas](../packages/contracts/src/api/resources.ts). Update the real Fastify dispatcher and
   account serializer in the [controller](../apps/controller/src/index.ts); implement exact OCC
   authorization, selected Driver dispatch, outer-transaction compensation, and deployment admission in
   [OCC](../packages/occ/src/index.ts).
3. Add a new `migrations/0009_*.sql` and update [PostgreSQL schema/state](../packages/occ/src/state/postgres-schema.ts)
   for generic credential variants, exact Namespace ownership, provider-free revision snapshots, and a
   separate driver-owned binding table containing durable upstream account, credential, Driver, and
   workspace identities. Bind each row to its exact OCC account/Namespace; share the existing outer
   transaction. Do not alter the already shipped [0007 migration](../migrations/0007_native_service_accounts.sql).
4. Add `ChatGPTClient` and `ChatGPTServiceAccountDriver` with private persisted bindings; extend shared
   [Installation configuration](../apps/controller/src/composition/installation-config.ts) with optional
   Driver selection, fixed ChatGPT endpoint, bounded TTL, and closed configuration validation. Initialize
   the client only in the existing [API entrypoint](../apps/controller/src/server.mjs), and construct its
   Driver after API composition creates the existing PostgreSQL state and controller; leave the
   [worker entrypoint](../apps/controller/src/worker.mjs) free of provider initialization and avoid a
   process-role configuration switch.
5. Extend [Kubernetes Compute](../apps/controller/src/drivers/compute/kubernetes/index.ts) for exact-account
   Secret creation and direct revision-driven access-token/workspace `secretKeyRef` projection; select
   API-key versus generic access-token login in
   [runtime entrypoints](../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts).
6. Update production [deployment mounts](../deploy/helm/openclaw-enterprise/templates/deployments.yaml),
   [tenant RBAC](../deploy/helm/openclaw-enterprise/templates/rbac.yaml), and
   [NetworkPolicies](../deploy/helm/openclaw-enterprise/templates/networkpolicies.yaml). Replace existing
   assertions that prohibit all Compute Secret access with exact Namespace-limited API authorization;
   preserve existing worker/workload Secret-denial assertions.

## Verification

Extend the existing real [dedicated-Harness Kubernetes integration](../tests/integration/harness-topology-k3d-real.test.mjs)
using actual OCC HTTP routes, PostgreSQL, selected Drivers, tenant RoleBindings, Kubernetes, approved
OpenClaw/Codex images, an authorized real ChatGPT workspace admin key, and the real ChatGPT Admin API:

1. Create a fresh OCC ServiceAccount; verify its provider-free public `sa_*` identity and inspect the
   Driver's private persisted binding for the distinct real upstream account and configured workspace.
2. Invoke the separate credential-creation route; verify `201`, a real provider credential with exactly
   the Codex access scope and bounded TTL, its provider credential ID durably persisted only in the
   private binding, a public generic `access_token`/`secretRef`, and one account-owned Secret containing
   token/workspace keys in the exact tenant namespace. Never print the token or admin key.
3. Associate that exact account with a dedicated Codex Agent and deploy. Verify its immutable,
   provider-free account/credential snapshot; the Codex Pod projects both access-token/workspace keys
   directly from exactly the account-owned Secret; only that Pod receives `CODEX_ACCESS_TOKEN`; no
   ambient `OPENAI_API_KEY` authenticates the token scenario; its separate gateway receives neither token
   nor admin key; Codex pins the exact provider workspace; and the authenticated app-server returns a
   fresh scenario-specific nonce from one actual provider-backed model turn. Delete the disposable
   provider account and Kubernetes resources.

Cover remaining boundaries in focused existing suites: closed provider-free HTTP contracts and exact
account IAM; cross-Namespace/sibling denial; API-only client initialization without role switches;
immutable driver-private upstream account/workspace identity and durable credential IDs; missing Secret,
unsupported OAuth/embedded token, excessive TTL, duplicate credentials, and no token/provider-identity
disclosure; compensation after storage, audit, persistence, and commit failures; and unchanged native
API-key dedicated/embedded execution. The real tenant-RBAC integration verifies API-only direct tenant
Secret permission and worker/workload denial of direct Secret API access using separate actual API/worker
identities and scoped kubeconfigs; one shared identity cannot prove this isolation. It does not claim to
prevent a trusted worker from projecting tenant Secrets through its existing Deployment authority. The separate
[production Helm packaging test](../tests/integration/production-kubernetes-packaging.test.mjs) verifies
the API-only admin Secret mount and provider-egress policy; rendered-chart assertions are not live Helm
deployment or NetworkPolicy-enforcement evidence.

Missing live provider authorization, actual provider account/credential creation, tenant-scoped Secret
proof, or the genuine Codex model response is an integration blocker, not successful verification.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-31 18:10]: Removed private source hyperlinks without changing the historical implementation specification. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4e16a74272e716d998c6da59fff95fde806d86fa)

- [2026-08-24 22:10]: Defined selected ChatGPT ServiceAccountDriver, reusable provider client, immutable provider-linked OCC accounts, separate token issuance, approved tenant-bound Compute Secret ownership, dedicated Codex access-token execution, and real provider-backed acceptance. (01a03542-30ff-77a1-9967-587d55548ace - c11ba6418d06)
- [2026-08-24 22:20]: Simplified execution to one account-owned Secret and shared concrete client; retained durable provider credential IDs; added explicit token lifetime, API-only composition, complete HTTP wiring, outer-transaction compensation, and accurately separated runtime versus Helm verification. (01a03542-30ff-77a1-9967-587d55548ace - c11ba6418d06)
- [2026-08-24 23:05]: Encapsulated upstream account, credential, and workspace identity in durable driver-private bindings; made OCC accounts/revisions and access tokens provider-agnostic; projected workspace alongside the token; and initialized the concrete ChatGPT client/Driver only from the existing API entrypoint without a role switch. (01a03542-30ff-77a1-9967-587d55548ace - c11ba6418d06)
- [2026-08-25 00:27]: Removed the unused public credential-deletion operation and separate binding-store abstraction; retained durable private identities and account-owned credential cleanup. (01a03542-30ff-77a1-9967-587d55548ace - 96a841f)
