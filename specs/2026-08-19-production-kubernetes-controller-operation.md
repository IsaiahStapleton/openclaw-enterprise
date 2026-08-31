# Feature Spec: Production Kubernetes Controller Operation

**Date:** 2026-08-19
**Status:** Superseded by [Production Kubernetes Packaging and Agent Wireup](04-production-kubernetes-wireup.md)
**Owner:** OpenClaw Controller and Kubernetes Compute Driver

> Historical specification: this document preserves the earlier milestone's
> Namespace-only worker, gateway, and configuration assumptions. For the current
> production API, Helm deployment, Agent-owned gateways, and Codex revision
> activation, use the [current production specification](04-production-kubernetes-wireup.md)
> and [platform design](../docs/design.md).

## Problem and Decision

The shipped [Kubernetes Compute Driver](../apps/controller/src/drivers/compute/kubernetes/index.ts) provisions isolated tenant namespaces and gateways, but the [production HTTP composition](../apps/controller/src/composition/production.ts) rejects startup and the [worker entrypoint](../apps/controller/src/worker.mjs) rejects production mode and silently defaults to fake compute. Ordinary convergence exhausts failure retries, request timeouts leave Kubernetes operations running, and in-cluster credentials have not been exercised. Tenant access remains operator-provisioned. The [previous driver specification](2026-08-18-kubernetes-deployment-design.md) established infrastructure behavior; this milestone makes its internal API and controller operation dependable without claiming a complete production platform.
Run an **internal-only production HTTP API and production worker** with the same explicitly selected Kubernetes driver. Expose the API only through an operator-provisioned Kubernetes `ClusterIP` Service protected by restrictive ingress NetworkPolicies; authenticate requests using an explicitly configured bearer token mapped to one existing OCC Principal, and preserve exact-resource IAM authorization. Keep tenant RoleBindings operator-provisioned, distinguish pending convergence from operational failures, and propagate cancellation into the actual Kubernetes SDK transport. Verify in-cluster authentication with the unchanged driver inside a disposable k3d Job.
The [authoritative platform design](../docs/design.md) governs singleton Installation ownership, exact tenant authorization, one Namespace-owned gateway, immutable revisions, and fail-closed operation.

## Scope

**Changes**

- Explicit shared driver selection for the production HTTP API and production-mode background worker, including authenticated preflight and namespace-only production dispatch.
- Internal-only production API exposure through an operator-provisioned `ClusterIP` Service and restrictive ingress NetworkPolicy, with required bearer authentication and existing exact-resource OCC authorization.
- Transport cancellation, claim fencing, bounded convergence deadlines, and separate pending-versus-failure retry accounting.
- Real production-entrypoint, PostgreSQL, operator-provisioned tenant grants, and in-cluster k3d verification.
  **Does not change**
- OAG admission, external authentication, trusted ingress, production OCI images, Helm or general deployment manifests, managed database provisioning, or application deployment packaging.
- The four-method `ComputeDriver` contract, one singleton Installation, one single-replica `Recreate` gateway per Namespace, existing tenant isolation, or rejected client injection.
- Operator-provisioned tenant RoleBindings and existing on-demand namespace reconciliation; independent tenant access and autonomous namespace maintenance are tracked in [TODO.md](../TODO.md).
- Production Agent dispatch, actual OpenClaw/Codex execution, sandbox enforcement, Harness activation, gateway traffic release, workload-token verification, or populated-tenant offboarding.
- Shared-cluster admission, additional gateways, gateway replicas, custom Agent egress, broker integration, `imagePullSecrets`, or the unrelated existing lifecycle-hooks specification.
  This milestone approves narrowly scoped production API startup with internal bearer admission and the production-worker exception to the current [repository boundary](../AGENTS.md). External ingress, OAG admission, general deployment packaging, and production application-image exclusions remain in force; operators provide the required internal `ClusterIP` Service and NetworkPolicy.

## Contract

### Runtime ownership and cluster selection

One shared controller-local runtime loader recognizes `OCC_COMPUTE_DRIVER=kubernetes` and an absolute `OCC_KUBERNETES_CONFIG_PATH` containing the existing [`KubernetesComputeDriverOptions`](../apps/controller/src/drivers/compute/kubernetes/index.ts). The configuration selects exactly one `{ "mode": "inCluster" }` identity or one explicitly named kubeconfig/context. No ambient kubeconfig, fake production driver, injected client, extra Installation identifier, or secret-bearing log is permitted.
Both production processes require the same driver configuration, existing explicit `OCC_DATABASE_URL` and `OCC_INSTALLATION_ID`, immutable workload image digests, and authenticated read-only Kubernetes API access. The API additionally requires `OCC_INTERNAL_API_TOKEN_PATH` pointing to an operator-provided mounted Secret and `OCC_INTERNAL_API_PRINCIPAL_ID` naming an existing installation-scoped `Principal`. Both verify the persisted Installation, Kubernetes credential identity, and HTTPS/CA trust before serving requests or claiming work. An invalid or incomplete dependency fails startup without an HTTP listener, queue claim, or mutation.
The existing loopback development API and development workers retain their existing restrictions and may explicitly select the same driver. Operators provide the required tenant-local RoleBindings; the worker receives no `bind`, `escalate`, or RoleBinding mutation privileges. This milestone supports an **Installation-dedicated cluster only**. The production worker claims, recovers, and counts **Namespace provisioning and deletion only**; pending AgentRevision work remains untouched until a separate sandbox/activation milestone makes production execution safe.

### Internal-only production HTTP admission

The [production HTTP composition](../apps/controller/src/composition/production.ts) starts only with an explicit internal-only admission verifier. It loads one nonempty bearer token from the configured mounted Secret, compares it without timing-dependent equality, and resolves the configured existing `Principal` to its exact persisted Installation, issuer, and subject. Extend [`AdmissionVerifier`](../apps/controller/src/admission/admission-verifier.ts) with a distinct `internal-bearer` admission method; never reuse development admission, trust forwarded identity headers, grant implicit administrator rights, or accept a request-selected principal.
Internal bearer admission, its mounted Secret, and its configured Principal mapping are temporary and must be removed when verified OpenClaw Access Gateway (OAG) admission supplies authenticated caller identity.
Every authenticated request continues through existing exact-action, exact-resource OCC IAM and Restrictions checks. Missing or invalid credentials return `401`; a valid caller without the required permission returns `403`, with no side effects. Missing Secrets, empty tokens, unknown or cross-Installation Principals, absent database/Kubernetes connectivity, or incomplete internal-exposure configuration prevent production startup. Token material never appears in configuration JSON, command arguments, logs, audit records, or responses; rotation takes effect after Secret replacement and process restart.
An operator-provisioned `ClusterIP` Service is the sole supported production API exposure. A default-deny ingress NetworkPolicy permits connections only from explicitly approved internal namespace and Pod selectors; an enforcing CNI is required. Production Pods may bind their configured Pod interface so the Service can reach them, but the milestone creates or supports no Ingress, Gateway API route, `NodePort`, `LoadBalancer`, `hostNetwork`, public endpoint, or forwarded external authentication.

### Cancellation and convergence

Propagate one claim-bound `AbortSignal` through a controller-local `AsyncLocalStorage` execution context; retain all four existing `ComputeDriver` method signatures. Compose worker shutdown, lease loss, and per-request deadlines. Official Kubernetes SDK middleware attaches the signal to `RequestContext.setSignal` while preserving the existing server-side-apply content-type middleware and verified typed clients.
A timeout or lost claim aborts the underlying HTTP request and waits for it to settle before another request is attempted. An ambiguous mutating result is followed by an exact owned-resource observation before retry; no later mutation or database finalization may proceed under a lost claim.
Expected pending tenant grants, gateway startup, image pulls, and Kubernetes Namespace termination are **convergence**, not transport failure. A fenced queue deferral releases its current claim, preserves the stable operation identity, schedules bounded backoff, and does not consume the normal failure-attempt budget. Provisioning and deletion use an explicit durable convergence deadline derived from their original creation time; genuine retryable dependency failures still consume their bounded budget, and permanent authorization/ownership failures fail immediately. Deletion is never reported complete while the backing namespace exists.

## Implementation

1. Add a shared production-safe driver loader under [`apps/controller/src/composition/`](../apps/controller/src/composition) and update [`production.ts`](../apps/controller/src/composition/production.ts), [`admission-verifier.ts`](../apps/controller/src/admission/admission-verifier.ts), [`server.mjs`](../apps/controller/src/server.mjs), [`index.ts`](../apps/controller/src/index.ts), [`worker.mjs`](../apps/controller/src/worker.mjs), [`worker.ts`](../apps/controller/src/worker.ts), and [`package.json`](../package.json). Implement distinct production internal-bearer admission, mounted-Secret and persisted-Principal validation, shared authenticated driver preflight, and documented API/worker commands; preserve development loopback restrictions and namespace-only production worker dispatch.
2. Update [`postgres-work-queue.ts`](../packages/occ/src/state/postgres-work-queue.ts) and [`worker.ts`](../apps/controller/src/worker.ts) with production namespace-only filtering and fenced, bounded pending deferral.
3. Add controller-local operation cancellation and update the existing [Kubernetes driver](../apps/controller/src/drivers/compute/kubernetes/index.ts) to attach composed abort signals through official SDK middleware, settle cancelled transports, and observe ambiguous owned mutations before retry. Preserve server-side apply, exact ownership, single-gateway behavior, and all public Driver signatures.
4. Extend [`tests/integration/kubernetes-compute-real.test.mjs`](../tests/integration/kubernetes-compute-real.test.mjs), [`tests/conformance/kubernetes-compute.test.mjs`](../tests/conformance/kubernetes-compute.test.mjs), focused HTTP admission and PostgreSQL queue/worker integrations under [`tests/integration/`](../tests/integration), and [`tests/fixtures/kubernetes/`](../tests/fixtures/kubernetes). Verify the actual production API behind a test-only k3d `ClusterIP` Service and restrictive NetworkPolicy. Update the existing **test-only** fixture to the repository's Node 24 baseline; bundle the unchanged driver and installed official SDK with existing transitive `esbuild`, compress it below the ConfigMap size limit, and run it under a short-lived nonroot k3d Job with the dedicated controller ServiceAccount. Do not add a production application image, hostPath, dependency install, or kubeconfig to that Job.
5. Update [`docs/config.md`](../docs/reference/settings.md), [`docs/controller.md`](../docs/reference/controller.md), and [`docs/drivers/kubernetes-compute.md`](../docs/reference/drivers/kubernetes-compute.md) alongside implementation with the exact runtime inputs, internal token/Principal mapping, required `ClusterIP` and ingress policy, operator-provisioned tenant access, deadlines, namespace-only production behavior, and k3d setup.

## Verification

| Required outcome                               | How to verify                                                                                                                                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production worker uses real Kubernetes only.   | Start the actual worker entrypoint with the explicit driver/config, immutable images, PostgreSQL, and Installation; missing configuration, invalid credentials, mutable images, or an unavailable cluster fail before queue claims.                       |
| Production HTTP starts with exact admission.   | Start the actual production API with its mounted token and existing Principal; missing token/Principal fails startup, wrong token returns 401, unauthorized resources return 403, and authorized requests retain exact IAM checks.                        |
| Production API is internal-only.               | On k3d, reach the API only through its ClusterIP from an approved internal Pod; disallowed Pods are blocked by an enforcing NetworkPolicy and no external exposure or development admission exists.                                                       |
| Both processes select the same implementation. | Run the production API and production worker as separate processes with shared driver configuration; created Namespaces with operator-provisioned RoleBindings converge without an injected JavaScript driver or identity mismatch.                       |
| Production never executes Agent revisions.     | Seed revision work beside Namespace work and prove claim, recovery, backlog, and worker startup never consume, mutate, or activate the revision.                                                                                                          |
| In-cluster authentication is genuine.          | Run the bundled unchanged driver inside a nonroot test-only k3d Job with its projected controller token and cluster CA; observe an owned ready tenant without kubeconfig, and prove missing token or an unauthorized ServiceAccount creates no resources. |
| Convergence does not exhaust failure retries.  | Delay grant provisioning, gateway readiness, and namespace finalization beyond five observations; each operation remains recoverable until its explicit deadline and completes after the dependency recovers.                                             |
| Timeouts and lost leases fence side effects.   | Exercise real SDK/HTTP cancellation and PostgreSQL claim takeover; prove the old request settles, no overlapping mutation survives, ambiguous effects are observed, and a stale worker cannot publish status or audit completion.                         |
| Existing infrastructure remains isolated.      | Preserve current real-k3d coverage for restricted Pods, denied cross-tenant traffic, DNS-only egress, dedicated ServiceAccounts, nonserving candidates, scoped ownership, single-replica gateways, and idempotent empty-tenant deletion.                  |

## Delivery Status

- Implemented the explicitly selected Kubernetes runtime, internal mounted-Secret bearer admission, persisted Principal resolution, namespace-only production API/worker boundaries, authenticated Kubernetes preflight, claim-bound SDK transport cancellation, durable convergence deferral, and Node 24 test-fixture baseline.
- Verified actual HTTP bearer outcomes and exact-resource native IAM, live HTTP transport cancellation, and real migrated PostgreSQL application-role claim isolation, stale-revision recovery exclusion, repeated convergence deferral, durable completion, audit evidence, and expired-claim fencing.
- Real production Fastify entrypoint execution, installed official Kubernetes SDK runtime verification, disposable k3d `ClusterIP`/NetworkPolicy proof, and the in-cluster ServiceAccount Job remain unavailable until a supported installed dependency graph, Docker access, and k3d infrastructure are provided.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-21 11:38]: Marked the completed historical controller milestone superseded by the current production packaging and Agent-owned gateway specification while preserving its original design record. (01a0119a-9843-7423-a4c6-955ff4187bd9 - 9ae2efc)
- [2026-08-19 07:54]: Defer autonomous namespace maintenance and its controller principal, queue target, migration, and repair verification; track both deferred Kubernetes driver tasks as reliability work. (01a016e9-16e0-7b60-8a48-acd48f535366 - acd6efe)
- [2026-08-19 07:53]: Defer independent tenant-access provisioning to the KubernetesComputerDriver section in the repository TODO; retain operator-provisioned tenant RoleBindings and worker least privilege. (01a016e9-16e0-7b60-8a48-acd48f535366 - acd6efe)
- [2026-08-19 07:47]: Enable an internal-only production HTTP API with ClusterIP exposure, restrictive NetworkPolicies, mounted-secret bearer admission, an existing provisioned Principal, and unchanged exact-resource OCC authorization. (01a01a7a-902c-7f53-9031-39c7f9200c01 - e8f7139)
- [2026-08-19 07:34]: Created the production-safe headless Kubernetes controller operation milestone, with independent tenant grants, durable maintenance, cancellation/convergence fencing, and actual in-cluster k3d verification. (01a016e9-16e0-7b60-8a48-acd48f535366 - e8f7139)
