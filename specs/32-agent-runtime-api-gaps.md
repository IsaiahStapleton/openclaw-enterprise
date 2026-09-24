# Feature Spec: Agent runtime API completion

**Date:** 2026-09-19
**Status:** Accepted — implementation in progress.
**Owner:** OCC admission and console; selected IAM and Compute Drivers; native runtime integration behind the selected Drivers.
**Source baseline:** Public `openclaw/openclaw-enterprise` at `06c23b9cf60915ba58baa38b23cf304562e674a1`; source inspection, not live deployment proof.

## Current scope amendment

Generated-credential rotation and recovery were removed from implementation scope. The supported API provides initial provisioning only; subsequent model and channel credential replacement uses Secret update and explicit deployment. The original proposal below remains historical. Current diagnostics use `succeeded`, `failed`, and `unknown` states. See the [current credential contract](../docs/reference/drivers/compute.md#optional-runtime-credential-management) and [diagnostics contract](../docs/reference/drivers/compute.md#optional-runtime-diagnostics). Runtime qualification remains incomplete.

## Problem and Decision

Dedicated Slack Agent provisioning currently needs IAM database writes; credential recovery and model/channel troubleshooting need cluster access.

Complete provisioning and repair through Namespace IAM APIs, Secret bindings, stopped-Agent credential rotation and exact-revision diagnostics. Reuse stop, Secret update, deploy and status APIs; remove operator database writes, Pod deletion and log scraping.

## Scope

- Deliver Role and AccessBinding management with native IAM, and credential rotation/diagnostics with bundled Kubernetes Compute and Compute-owned dedicated gateway/Harness Pods. Other selected Drivers report unsupported capability; they never fall back to native storage or another backend.
- Core APIs express platform resources and operations, without provider names, token fields or native protocol schemas. IAM binds Namespace-local identities to exact resources through reusable Roles. Integration credentials use Secrets and Configuration `secretBindings`; generated runtime credentials belong to Compute. Startup failures persist in deployment status; explicit current-runtime checks return generic observations.
- Keep the existing direct credential-delivery exception and exact Namespace/Agent ownership. Shared model Secrets require each consuming Agent's authorization and deployment.
- Defer Group/membership and Restriction management, broad Installation/Namespace grants, Role/binding updates, cross-Namespace access, Secret/Configuration discovery and API-wide idempotency, provider account/app creation or funding, automatic/zero-downtime rotation, standalone model preflight, chat/history/native admin UI, and Slack message sending.

## Contract

### Existing APIs own the lifecycle

[Secret PATCH](../packages/occ/src/index.ts) changes stored bytes only; [explicit deployment](../docs/flows/secret-storage-and-delivery.md#5-update-restart-or-remove) admits a new immutable revision and delivers current values. Use `GET /namespaces/{ns}/agents/{agent}/deployments/{revision}` for status, errors and warnings. Successful storage, deployment admission, runtime readiness, and Slack delivery remain different outcomes.

Use existing authentication, envelopes, exact-resource authorization, selected-Driver dispatch, audit and errors from [API contracts](../packages/contracts/src/api/routes.ts). Exclude credentials and raw provider errors from logs, audit and responses.

### Namespace-scoped IAM Roles and AccessBindings

Use existing [Role and AccessBinding contracts](../packages/contracts/src/index.ts). A binding connects an identity, Role and exact resource independently of Agent configuration. Deployment validates effective permissions; no Agent-specific grant resource is added.

| Route                                              | Methods and result                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/namespaces/{ns}/iam/roles`                       | GET lists Namespace Roles; POST creates and returns a Role with server-generated ID.              |
| `/namespaces/{ns}/iam/roles/{roleId}`              | GET reads that Role; DELETE removes it only when no AccessBinding references it.                  |
| `/namespaces/{ns}/iam/access-bindings`             | GET lists Namespace bindings; POST creates and returns an AccessBinding with server-generated ID. |
| `/namespaces/{ns}/iam/access-bindings/{bindingId}` | GET reads that binding; DELETE removes only that explicitly identified binding.                   |

GET returns 200, POST 201, DELETE 204; missing items return 404. Reads expose policy in the path Namespace, excluding Installation bootstrap policy. Mutations support Namespace-local identity subjects and exact targets, excluding Groups and broad grants.

Role POST accepts `{name?: string, permissions: Permission[]}`; require a nonempty, duplicate-free set of existing `{action, resourceKind}` pairs. AccessBinding POST accepts `{subjectKind: "identity", subjectId, roleId, resourceKind, resourceId}`, with both target fields required. Reject caller-supplied IDs/scope, wildcard targets, unknown actions/kinds and extra fields. OCC supplies Installation/Namespace identity. In this release, exact targets are Namespace-owned Agents, AgentRevisions, Configurations, Secrets or ServiceAccounts; Role permission kinds use the same set. Existing action semantics remain unchanged; a permission only matches operations whose target and action agree with the binding.

Expose immutable, read-only `servicePrincipalId` in authorized public Agent responses. Agent create/PATCH inputs reject caller-supplied values; console and CLI use the returned ID without deriving it from a naming convention.

For a model Secret, select/create a Role with `permissions: [{action: "operate", resourceKind: "secret"}]`, then bind the Agent service principal with `{subjectKind: "identity", subjectId: "<service-principal-id>", roleId: "<role-id>", resourceKind: "secret", resourceId: "<secret-id>"}`. Namespace bindings may share Roles. Names are labels; inspect permissions before reuse.

Require Installation `administer` and path Namespace `read` for every IAM operation, evaluated by the selected IAM Driver and applicable Restrictions. Creating a binding additionally requires `read` on its exact resource. IAM verifies that subject, Role and resource exist within the path Namespace; a ServiceAccount resource is not an IAM identity. Validate and persist atomically against concurrent source deletion. Possession of an ordinary resource permission never authorizes delegation.

Extend selected IAM with optional Role/AccessBinding management. Native IAM owns policy validation/persistence in existing tables; OCC owns HTTP admission and resource ownership resolution. Pass validated scope/identity across that boundary. Policy and attributable audit commit together and become visible across replicas without restart.

Roles and bindings are immutable through these APIs. To change permissions, create a replacement Role/binding and explicitly remove the old binding. Deleting a referenced Role returns 409 and never cascades. An unknown POST outcome is recovered by listing and inspecting policy before retrying; equivalent bindings may coexist because API-wide idempotency is deferred. Removing one binding never deletes equivalent or unrelated bindings. Unsupported selected Drivers return 503 without a native fallback.

Return policy resources without `managedGrant` or effective-access claims. Other bindings and Restrictions still govern access after deletion. Revocation blocks later admission but cannot retract delivered bytes. Immediate containment uses stop and, when necessary, upstream revocation; IAM mutations never silently stop Agents or revoke provider keys.

### Integration credentials use Secrets

Use Namespace Secret create/PATCH and Configuration `secretBindings`. Configuration stores references; Secret Driver owns bytes/delivery. Native integration owns provider fields and validation. OCC enforces scope, permissions, immutable references and delivery boundaries without interpreting providers.

The bundled OpenClaw path uses two Secrets bound to gateway environment variables consumed by native Slack configuration. These are implementation examples, not core API fields. Existing env delivery suffices; do not require the deferred Secret Broker. Channel credentials reach only the dedicated gateway; model credentials continue through `harnessAuth` to the Harness. Embedded channel credentials remain unsupported because that topology cannot isolate them from the Agent.

Current Kubernetes Compute still injects channel credentials from a legacy Agent backend Secret and rejects duplicate env destinations. Replace that injection and validation with the admitted Configuration bindings; changing callers alone is insufficient. Remove Slack request/status fields from runtime-credentials and its shared Driver contract, and update callers together. Existing deployments require explicit Secret creation, IAM binding, Configuration update and redeployment; do not silently adopt legacy bytes or retain a second credential source.

For coordinated replacement, stop the Agent, wait for shutdown, PATCH each selected Secret, then explicitly deploy. Partial updates leave it stopped until repaired; there is no atomic multi-Secret transaction or value rollback. Shared Secrets retain per-consumer authorization and explicit deployment; updating storage never restarts other consumers automatically.

### Compute-owned runtime credential recovery

`/namespaces/{ns}/agents/{agent}/runtime-credentials` manages one opaque, Compute-owned credential bundle for runtime communication. GET returns `{configured: boolean, version: string | null}`. Version identifies backend incarnation/revision without bytes or a database copy; absent credentials return `false`/`null`.

POST accepts `{}` for initial server-generated provisioning. Add PATCH `{expectedVersion: string | null}` to regenerate or repair the bundle after stopping. Both return the same metadata. Reject supplied credential values and extra fields. The selected Compute Driver defines internal keys and storage; there is no `group` discriminator or integration-token payload.

Require Agent `read` and `operate`, a ready Namespace and stopped intent. Serialize PATCH against deployment admission with the Agent lock; reject outstanding runtime-changing controller work or a live claim. Compute must prove gateway/Harness workloads and Pods absent; stopped intent alone is insufficient. Incomplete shutdown returns 409.

Kubernetes verifies exact ownership and atomically replaces its runtime transport Secret with backend compare-and-swap. Null permits creation only when absent; stale versions, foreign ownership or ambiguous workload absence fail closed. Unsupported selected Drivers return 503 without fallback.

The sequence is **stop → wait → GET metadata → PATCH → deploy → poll status → diagnose**. Success means stored, not deployed or authenticated. After an unknown write outcome, read metadata before deciding to retry; never replay against a newer version blindly. Failure leaves the Agent stopped. Explicit deployment preserves history/workspace; repeated regeneration may create another key and is not request deduplication.

### Startup failures belong to deployment status

Use `GET /namespaces/{namespaceId}/agents/{agentId}/deployments/{deploymentId}`; deployment ID identifies the revision. Preserve revision `read` authorization and the durable status/error/warnings envelope; no Agent `operate` permission is needed. GET reads persisted state only: no runtime RPC, authentication probe or model call.

Native integration captures startup failure evidence; Compute exposes it during reconciliation, before readiness. Persist it with terminal failure in existing controller-work `resultData`, before cleanup. Extend write/read validation only for `CONVERGENCE_DEADLINE_EXCEEDED`: retain required positive `timeoutMs`, permit optional `runtimeFailure: {component, check, checkedAt, code}`, reject other fields. Identifiers are implementation-owned strings of 1–64 characters; `checkedAt` is an ISO timestamp. Other reason codes still reject result data. Project unchanged through `error.data`, preserving the primary code and fixed safe message. Native probe failures remain details, never queue reason codes.

Only exact revision/current-runtime evidence may enter that result. Commit through the current work claim; stale workers cannot overwrite it. Records survive Pod deletion/restart. Missing evidence retains the ordinary error without a specific cause. Queued/running/succeeded deployments retain `error: null`; successful activation clears failed-attempt evidence. Do not change retry, deadline or activation policy, add a health-history store, or collect evidence in GET.

For bundled Codex, capture login/probe failures inside the credential-owning Harness before failure hold. Safe implementation codes are `LOGIN_FAILED`, `MODEL_PROBE_FAILED`, `MODEL_PROBE_TIMEOUT` and `UNAVAILABLE`. Distinguish credentials, model access, credits or networking only from verified structured native evidence; never classify arbitrary stderr. There is no startup-diagnostics endpoint or new model probe.

### Explicit current-runtime checks

Retain bodyless `POST /namespaces/{ns}/agents/{agent}/deployments/{revision}/diagnostics` only for an explicitly requested fresh runtime observation, such as current channel authentication/connectivity. Require Agent `read` and `operate` plus exact revision ownership. It neither reruns nor returns the cached startup model probe; console links deployment GET for startup failures. No background monitoring is added.

Return `{revisionId, observedAt, checks}` with `{component, check, state, checkedAt, code?}` entries. Identifiers and safe codes belong to the selected implementation, not core provider enums. States are `not_started`, `checking`, `succeeded`, `failed` or `unknown`; evidence time is nullable. OCC validates the common envelope; console/CLI render it generically. Compute owns bounded native collection/normalization. Missing evidence yields unknown; an absent runtime returns unknown with an unavailable code. Unsupported capability returns 503 without affecting deployment GET.

The bundled gateway probes the fixed native default-account channel-status operation. Project configuration, authentication and socket state independently: observed booleans become succeeded/failed; absent fields become unknown. False configuration/authentication/connection use implementation codes `NOT_CONFIGURED`/`AUTHENTICATION_FAILED`/`DISCONNECTED`. Only verified credential rejection makes authentication failed; unclassified probe failure gives unknown with `PROBE_FAILED`. Disabled configuration leaves other checks unknown; missing fields use `INCOMPATIBLE_RESPONSE`, unreachable runtime `UNAVAILABLE`. Verify these mappings against the pinned runtime. No messages or extra model turns are sent.

Reuse the private status listener and [exact-Pod readback](../apps/controller/src/drivers/compute/kubernetes/index.ts) for worker startup evidence and explicit current checks. Support unready Harnesses and plugin-disabled configurations without changing plugin behavior or token derivation. Verify revision ownership and Pod UID/container incarnation after reads; replacement or ambiguity invalidates evidence. Never attribute results through the Agent serving route. Bound collection to ten seconds, propagate cancellation and cap response size. Permit controller-only network access. Exclude credentials, raw errors, account/team details and token-source metadata. Live checks do not prove a message round trip.

### Operator and console path

Console/CLI use IAM, Secret/Configuration, generated-credential, deployment and diagnostic APIs. The Agent UI uses IAM with its returned service principal. Native setup uses generic APIs. Offer stopped rotation; distinguish storage success from deployment/health. Console never receives generated transport values or backend Secret URLs. A denied grant remains a permissions problem, not an automatic escalation.

## Implementation

1. Add route/body/response schemas in [contracts](../packages/contracts/src/api/), admission in [OCC](../packages/occ/src/index.ts), handlers in [controller](../apps/controller/src/index.ts), and generated OpenAPI/CLI coverage. Include `servicePrincipalId` in the Agent response schema and controller projection. Update [console credentials](../apps/controller/src/console/agents/credentials.mjs), native channel setup and Agent views with real callers. Remove Slack-specific core schemas; render persisted failure details and current checks generically.
2. Implement optional Role/AccessBinding management in [native IAM](../packages/iam/src/index.ts) and its [PostgreSQL state adapter](../packages/occ/src/state/postgres-state.ts), using existing policy tables, scope checks, reference-safe deletion and transactional audit. Reuse selected-driver authorization; unsupported Drivers reject management. Verify cross-replica visibility and exact resource existence through OCC-owned repositories.
3. Replace legacy native channel-secret injection with admitted gateway-only Configuration bindings in [Kubernetes Compute](../apps/controller/src/drivers/compute/kubernetes/index.ts). Add opaque generated-credential recovery with version checks and stopped-workload proof, reusing stop/deploy and locks. Sandbox-owned Harnesses remain unsupported until their owner supplies equivalent quiescence evidence.
4. Add native evidence in [runtime entrypoints](../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts), Compute readback and [worker](../apps/controller/src/worker.ts) failure capture. Extend [controller-work](../packages/occ/src/state/controller-work.ts) result validation/projection and migrate the [PostgreSQL check constraint](../packages/occ/src/state/postgres-schema.ts) to permit exactly the same timeout/runtimeFailure shape. Keep current checks separate; no new workers or health store.
5. Update current [authorization](../docs/reference/authorization.md), [Agents](../docs/reference/agents.md), [Compute](../docs/reference/drivers/compute.md), [harness execution](../docs/reference/harness-execution.md), console/API guides and [credential flow](../docs/flows/secret-storage-and-delivery.md). Replace provisioning SQL, Pod deletion and validation Jobs with API calls; infrastructure/external credentials remain prerequisites.

## Verification

Implementation acceptance requires the regular API/console workflow with real PostgreSQL/Kubernetes. Record actual proof and remaining gaps before marking this specification completed.

| Required outcome                        | Required proof                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API-only provisioning                   | Dedicated-Agent integration binds model and channel Secrets using the returned service principal and IAM APIs, provisions generated runtime credentials, deploys and performs a real model turn. No IAM fixture writes after bootstrap or channel credentials through runtime-credentials.                               |
| Reusable attributable IAM policy        | Real API/IAM/DB covers Secret-operate and Agent-read bindings; denies non-admin, foreign scope, absent identity/target, Group and broad mutations; rejects bound-Role deletion. Verify cross-replica visibility, rollback with audit failure, and deletion preserving equivalent bindings; no claim of effective denial. |
| Rotation and failed-first-deploy repair | Real Kubernetes proves stop/Secret PATCH/deploy for channels and stopped generated-credential recovery. Missing bundles, stale versions, live Pods, competing work and foreign ownership fail safely; partial Secret updates remain stopped. Fresh revision preserves workspace.                                         |
| Failed-candidate diagnostics            | Real Harness failures appear in deployment GET with/without plugins and survive Pod deletion/controller restart. Missing evidence remains unspecific; success clears failed-attempt details. Repeated GET performs no runtime/provider calls; verify revision-read authorization and stale-claim rejection.              |
| Honest Slack health                     | Pinned gateway verifies independent configuration/authentication/connectivity checks for invalid credentials, disconnected sockets, missing fields and unreachable runtime. Generic rendering requires no provider schema; probes never post.                                                                            |
| Isolation and freshness                 | Real API/NetworkPolicy denies cross-Agent access and stale Pod results. Channel bytes reach only the gateway; model bytes only the Harness. No legacy credential source overrides bindings. Diagnostics expose no secrets/raw errors or extra model calls.                                                               |
| Operator recovery                       | Browser/CLI uses IAM, Secret/Configuration, generated-credential, deployment-status and generic current-check routes without database/cluster access; startup failures come from deployment GET. An additional native credential binding needs no new core provider branch.                                              |

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-19 13:41: Drafted runtime API completion from source-backed provisioning gaps for trigger:spec review; no implementation or deployment.

- 2026-09-19 19:59: Applied the user-requested IAM resource design and clarified Slack diagnostic mappings; retained runtime lifecycle scope and deferred broader policy administration.

- 2026-09-19 20:10: Applied user direction to keep core APIs implementation-neutral: integration Secrets/bindings, Compute-owned generated credentials and generic diagnostic checks.

- 2026-09-19 20:30: Reused deployment GET and durable work results for startup failures; kept explicit current-runtime checks separate.
