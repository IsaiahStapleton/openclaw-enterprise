# Feature Spec: Provider and related Drivers

**Date:** 2026-09-01
**Status:** Implemented and locally verified in PR #8; live Provider proof pending
**Owner:** OCC / controller composition

## Problem and Decision

Introduce an Installation-owned `Provider` that groups an authenticated provider client with its related Drivers. Replace the special-cased integration configuration with this abstraction. Each Agent has an optional Provider association, and deployment copies that reference into its immutable AgentRevision.

Baseline source at `b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d` has `integrations.chatgpt`, an API-only [ChatGPTClient](https://github.com/openclaw/openclaw-enterprise/blob/b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d/apps/controller/src/integrations/chatgpt.ts), and one globally selected [ServiceAccount Driver](https://github.com/openclaw/openclaw-enterprise/blob/b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d/apps/controller/src/drivers/service-account/chatgpt.ts). There is no common Integration interface or registry to replace. The client authenticates with an admin API key and creates accounts and access-token credentials; it does not perform model inference. Baseline [Agent and revision contracts](https://github.com/openclaw/openclaw-enterprise/blob/b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d/packages/contracts/src/index.ts) carry no Provider reference.

This proposal extends the [platform design](../docs/design.md#drivers-and-providers). It preserves OCC resource ownership, exact Namespace authorization, one Installation-selected Driver per capability, and the API-only admin-credential boundary. Existing model configuration and Harness selection remain authoritative for inference and execution.

## Scope

- Add Provider configuration, client ownership, related-Driver membership, nullable Agent association, immutable deployment references, and provider injection into consuming Drivers.
- Replace the existing integration abstraction in code, Installation YAML, Helm configuration, and current documentation when implementation ships.
- All related Drivers are required now. Required/optional selection, automatic account creation, OAuth/refresh, credential renewal, Provider CRUD/discovery, clientless Providers, installed-package Provider injection/loading, and a common inference/HTTP transport API are deferred.
- Preserve native API-key accounts, providerless Agents, existing ServiceAccount operations, Driver package trust rules, and current development/production support boundaries.

## Contract

### Provider configuration and client

The operator owns an Installation-scoped collection keyed by unique, nonempty Provider IDs. Multiple Namespaces and Agents may reference the same configured Provider. A Provider is runtime configuration, not an OCC resource or an authorization authority. Its client stays in process memory; credentials and client objects never enter Agent records, revisions, API responses, audit payloads, or workload configuration.

Kevin's starting sketches are `interface Provider { client: Client }` and `provider: [{ id: openai }]`. The concrete contract adds identity and Driver membership while retaining the required runtime client:

```ts
interface Provider<Client = unknown> {
  readonly id: string;
  readonly client: Client;
  readonly drivers: Readonly<Partial<Record<DriverCapability, string>>>;
}
type ProviderRef = string | null; // Agent and AgentRevision each add providerId: ProviderRef.
```

`Client` is the concrete implementation's API, not a new universal client interface. The bundled Driver receives `Provider<ChatGPTClient>` and invokes `provider.client.createServiceAccount(...)` and the existing credential/deletion methods. Workers consume nonsecret configuration metadata, not runtime Provider objects.

The singular top-level YAML key `provider` is an array; omission or `[]` means no Providers. This fragment extends the existing required `occ` and ordinary Driver selections:

```yaml
provider:
  - id: openai
    type: chatgpt
    configuration:
      workspaceId: "11111111-1111-4111-8111-111111111111"
      apiKeyPath: /etc/openclaw/chatgpt/admin-key
      credentialTtlSeconds: 2592000
    drivers:
      service_account: chatgpt-service-accounts
drivers:
  service_account:
    id: chatgpt-service-accounts
    configuration: {}
```

`id: openai` is an operator-chosen reference; `type: chatgpt` selects the only bundled Provider implementation in scope. The workspace is provider connection context, never a Namespace mapping. Preserve existing workspace/key validation and TTL default/range; `apiKeyPath` replaces `adminKeyPath` and must be an absolute mounted file path. No inline key or configurable upstream URL is added. Preserve the client's fixed endpoint, redirect rejection, bounded responses/timeouts, sanitized errors, and narrowly idempotent deletion.

### Membership, selection, and process ownership

`provider[].drivers` is the sole configuration authority for membership: capability keys reference exact IDs in `drivers`. The bundled `chatgpt` type requires exactly the `service_account` entry matching the selected `drivers.service_account.id`; selecting that Driver requires its Provider. Composition constructs the concrete client and injects its Provider into the bundled member factory. Ownership stays private to that implementation; the generic `Driver` contract gains no `providerId` field or Provider registration protocol.

Keep the existing [registry](../packages/occ/src/index.ts), `(capability, id)` identities, and one selected Driver per capability. Configuration rejects duplicate Provider IDs, conflicting membership, and missing or unselected members before client construction. All related Drivers are required. The bundled type and singleton ServiceAccount selection allow at most one ChatGPT Provider; installed Provider injection and per-Agent Driver selection remain deferred.

The API resolves Provider metadata, reads mounted keys, builds the ChatGPT client, and injects its Provider before registering the bundled ServiceAccount Driver. Preserve that factory's later controller/state injection and its Compute credential-storage dependency. Installed Driver factory signatures, identity/capability/package validation, and operator trust remain unchanged.

The worker loads the same nonsecret Provider definitions and membership but does not construct the ChatGPT client or ServiceAccount Driver. Required membership is validated against configured selections there; administrative readiness remains the API's responsibility. Preserve the [API-only client initialization](../apps/controller/src/server.mjs) and [worker composition](../apps/controller/src/worker.mjs), including API-only Secret mounts and provider egress.

Provider association does not replace Driver lifecycle methods or create a lifecycle coordinator. Namespace preparation/deletion and Installation-wide IAM/Compute operations retain their existing owners. Workload hooks retain their order, cancellation, and reverse cleanup. The current ChatGPT Driver has no compute hooks; this change adds no Provider hook API.

### Agent creation and deployment

Use `providerId` consistently in request bodies, Agent records, revisions, and responses. `ProviderRef` names its nullable type; `providerref` and `providerRef` are not additional wire fields. Provider IDs are independent of native model prefixes such as `openai` or `codex`; association neither rewrites model configuration nor grants model access.

```http
POST /namespaces/{namespaceId}/agents
Content-Type: application/json

{"name":"helper","configurationId":"cfg_11111111-1111-4111-8111-111111111111","providerId":"openai"}
```

This completes the conceptual `{ providerId: openai }` body with existing required fields. Successful creation returns the existing `201 { data, meta }` envelope with `data.providerId`. Deployment remains the separate `POST /namespaces/{namespaceId}/agents/{agentId}/deploy`, returning `202 { data, meta }`; it takes the association from the saved Agent.

| Input | Create | Existing Agent PATCH |
| --- | --- | --- |
| `providerId` omitted | Persist `null` | Preserve the saved reference |
| `providerId: null` | Persist `null` | Clear the draft reference |
| Nonempty known ID | Persist that ID | Replace the draft reference |
| Empty, malformed, or unknown ID | Reject | Reject |

Existing PATCH-required fields still apply. No default Provider is inferred from available Providers, model configuration, or a ServiceAccount. A Provider change affects the next deployment; prior revisions retain their saved reference. A null reference is valid with existing independently supplied model credentials and does not require a configured Provider.

1. **Admit:** authenticate and perform existing exact Agent, Configuration, ServiceAccount, and Secret authorization; validate a nonnull Provider ID against operator configuration. Resolve the existing same-Namespace references and persist the Agent. Creation never calls the Provider or creates a ServiceAccount/credential.
2. **Bind credentials:** ServiceAccount creation and credential issuance remain separate authorized operations using the Installation-selected Driver. Add `providerId` to that Driver's existing private binding, beside its exact account, Namespace, Driver, and workspace identities. Preserve compensation and exact revocation/deletion; never infer ownership solely from a public credential kind.
3. **Deploy:** under existing admission locks, resolve the saved Provider and require its related selected Drivers. For an attached managed `access_token`, require a nonnull matching Provider, exact private binding with an issued credential, matching member Driver, and matching configured ChatGPT workspace. An absent credential keeps the current deployment failure. Native `api_key` paths remain valid with `providerId: null`. Persist `providerId` in `occ.agent_revisions.provider_id` and enqueue through the existing transaction. The existing whole-row immutability trigger protects this column; `admitted_spec` retains its existing configuration/Harness/Compute/credential shape.
4. **Reconcile:** after current IAM reauthorization and before workload effects, the worker resolves the revision's Provider metadata and repeats the managed binding check through a read-only projection on `ServiceAccountReadRepository`. That projection returns only provider/Driver/workspace identity and confirms credential issuance; external IDs stay private. No client, admin key, upstream call, or secret value is required. Preserve account-owned Secret projection only into the compatible dedicated Codex workload.
5. **Fail:** unknown request IDs use existing validation errors; missing runtime dependencies fail closed through current dependency/reconciliation errors. A null or mismatched Provider with a managed token is a resource conflict at admission. Worker mismatch prevents candidate activation and follows existing failure recovery, preserving the previous active workload where supported. No implicit Provider, Driver, credential, or model fallback is introduced. Provider removal or workspace retargeting must not reinterpret existing bindings or revisions.

### Migration and implementation boundaries

Use a single current configuration format. Replace `integrations.chatgpt` with the shown Provider entry, preserving workspace, mounted key, TTL, and Driver ID. Reject retired keys in Installation YAML and Helm values with a migration hint. The chart's packaging object is distinct from the Installation YAML array:

```yaml
provider:
  chatgpt:
    enabled: true
    secretName: occ-chatgpt-admin
    key: admin-key
    providerCidr: "203.0.113.10/32" # Example only; supply the approved provider/proxy IP.
```

When enabled, the chart projects that dedicated Secret key to `/etc/openclaw/chatgpt/admin-key` only in the API Pod; Installation `apiKeyPath` must match. Preserve the dedicated-Secret checks and API-only TCP/443 egress to the configured approved `/32`. Disabled defaults retain the current Secret name/key and empty CIDR; enable the chart setting together with the Installation Provider entry.

Startup validates configuration and selected dependencies, without traversing saved Agent drafts, revisions, or managed bindings. A stale Provider reference must not prevent API/worker startup. Create/PATCH/deploy and reconciliation validate their Provider reference; issuance/deletion, admission, and reconciliation enforce exact managed binding ownership. Affected operations fail closed, and the API remains available for authorized repair. The worker uses metadata only. Key/TTL changes retain identity and do not rewrite issued credentials.

Removing or retargeting Provider configuration does not reassign old bindings or revoke their credentials. Retain the original configuration for exact upstream cleanup. To replace an affected deployment, detach the account, clear/change its Provider, supply valid independent credentials, deploy, and wait for predecessor retirement before deleting the unused account. Failure preserves state for retry. Cleanup is an operator responsibility, not an installation-wide startup gate.

For the initial format change, use the approved clean development-state transition. Prevent new deployments, pause reconciliation, and verify affected workloads stopped through operator infrastructure controls. Keep the old API/configuration available: PATCH each Agent with its current `configurationId` and `serviceAccountId: null`, then DELETE its exact managed ServiceAccount through the existing [API](../packages/contracts/src/api/routes.ts). The current API has no Agent stop/delete operation; draft edits, Namespace deletion, database cascades, and control-plane shutdown do not perform runtime/upstream cleanup. Verify cleanup before deliberately recreating the selected disposable Installation state and initializing resources with explicit Provider IDs. New Agent/revision rows store nullable `provider_id` columns; managed bindings store their owner. Do not backfill old revisions, guess ownership, or silently convert managed state to null. Failed cleanup stops the transition and preserves old state/configuration for recovery.

## Implementation

1. Add shared Provider/Agent contracts in [contracts](../packages/contracts/src/index.ts); update request/response schemas, controller projections, generated OpenAPI, and both state adapters. Own `providerId` once per Agent/revision; keep private binding projection in [platform-state](../packages/occ/src/state/platform-state.ts) and its PostgreSQL implementation.
2. Replace integration parsing in [installation-config](../apps/controller/src/composition/installation-config.ts), move the concrete client under `apps/controller/src/providers/`, and wire typed Provider injection through API/production/development composition. Validate concrete member selection at composition; retain the ordinary Driver registry contract unchanged.
3. Add per-use admission/worker binding checks and immutable revision-column storage, preserving existing ServiceAccount CRUD, deployment queue, cancellation, credential delivery, and cleanup. Update schema artifacts through the repository's database workflow and require the clean state transition described above.
4. Update Helm values/templates, startup examples, tests, and current [Driver selection](../docs/reference/drivers/selection.md), [ServiceAccount](../docs/reference/drivers/service-account.md), [Agent](../docs/reference/agents.md), settings/security, architecture, startup/credential-delivery flows, and deployment documentation when shipping. Update the platform design's integration terminology narrowly; retain historical specs unchanged.

## Verification

| Required outcome | Implementation proof |
| --- | --- |
| One membership authority, mandatory ChatGPT/service-account pairing, correct client injection | Configuration-startup and bundled Driver tests reject missing/conflicting/unselected membership; ordinary Driver registration needs no Provider metadata. |
| Nullable association and immutable revisions | Real API tests for create/PATCH matrix, `201`/`202` and response projections; PostgreSQL round-trip/restart tests for Agent and revision; draft edits preserve prior revision values. |
| Exact credential ownership without worker admin access | Extend PostgreSQL worker/ServiceAccount tests: null/native success; managed matched success; null, wrong Provider/Driver/workspace, absent issuance, and cross-Namespace denial before effects; unchanged failure recovery. |
| Stale references do not block repair; credential ownership remains exact | Actual API startup accepts stale saved references and permits authorized draft repair. PostgreSQL deployment/worker tests reject invalid Provider and binding identities at use. Preserve same-identity key/TTL changes, exact old-config cleanup and recoverable failures. |
| Existing provider calls and credential delivery still work | Retain conformance plus authorized service-account-driver-real coverage: create, issue, dedicated Codex delivery, revoke/delete and rollback; no admin key in worker/gateway/revisions/logs. Missing credentials must be reported as a proof gap. |
| Integration format fully removed and clean state transition enforced | Startup rejects old configuration/persisted formats; Helm render checks exact Secret path, API-only mounts/egress and `/32`; verify a fresh database through normal initialization and recreation. Scoped search excludes historical specs and generic test/integration terminology. |

Implementation gates: focused tests above, workspace/type checks, generated OpenAPI checks, and scoped formatting. Delivery evidence and remaining proof limits are recorded below.

## Delivery Record

The approved simplification removes global startup saved-state traversal and generic Driver ownership metadata, moves revision Provider snapshots into immutable columns, and consolidates test fixtures. Provider configuration, nullable API fields, exact per-use credential checks, and API-only client construction remain. Current behavior is owned by [Providers](../docs/reference/providers.md), [Agents](../docs/reference/agents.md), and the [Provider lifecycle flow](../docs/flows/provider-driver-lifecycle.md).

The simplified [implementation a635483](https://github.com/openclaw/openclaw-enterprise/commit/a635483aa62d41df7b45040b89d9edf4a3cee725) passed independent local verification: 139 conformance tests, 27 API/configuration/ServiceAccount tests, 36 PostgreSQL tests, and three production-image smoke tests. The PostgreSQL run had five explicit skips: four require a live Kubernetes ConfigurationDriver, and one requires an uninitialized singleton after an earlier case bootstrapped it. Workspace, TypeScript, formatting, OpenAPI, actual Helm rendering, flow-doc, and link checks passed. Two review passes resolved the bootstrap-fixture identity and security wording findings. Live ChatGPT account issuance, dedicated model turns, and upstream revocation remain unverified because authorized credentials/workspace and explicitly selected Kubernetes runtime fixtures are unavailable. No pre-existing Installation was reset or deployed.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-01 10:58: Completed the approved simplification, fixed review findings, and independently verified the smaller implementation; live Provider proof remains pending (01a05d6b-e21d-7fc0-b1bd-b5cb15b365c6 - a635483aa62d41df7b45040b89d9edf4a3cee725).

- 2026-09-01 10:19: Kevin approved composition-owned Driver membership, immutable revision columns, per-use ownership checks without startup traversal, and consolidated test fixtures; implementation/verification underway (01a05d6b-e21d-7fc0-b1bd-b5cb15b365c6 - 1c7eae4d11e6c474cc7f1bbbb05d2c2e7052a158).

- 2026-09-01 09:41: Implemented Provider configuration and Driver ownership, nullable Agent associations, immutable revisions, startup/admission/worker checks, and current reference/flow docs; independent local verification passed, live Provider proof remains pending (01a05d6b-e21d-7fc0-b1bd-b5cb15b365c6 - 118de64066c330e0828b50cdf4f2409ec22dc001).

- 2026-09-01 08:19: Applied Kevin's approved review direction: required client and bundled pairing, scoped injection, cleanup guard, exact Helm shape, and clean development-state transition; specification only (01a05d6b-e21d-7fc0-b1bd-b5cb15b365c6 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d).
- 2026-09-01 07:43: Draft Provider contract and source-grounded migration proposal; awaiting independent reviews and user direction (01a05d6b-e21d-7fc0-b1bd-b5cb15b365c6 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d).
