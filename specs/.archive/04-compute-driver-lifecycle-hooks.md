# Feature Spec: Compute Driver Lifecycle Hooks

**Date:** 2026-08-20
**Status:** Completed
**Owner:** OCC and selected Drivers

## Problem and Decision

Let selected Drivers participate in Namespace and workload lifecycles through four optional hooks
invoked by ComputeDriver. An OpenShell SecretBrokerDriver can prepare tenant-scoped providers,
configure OpenClaw's existing sandbox, and revoke access before teardown. Compute still owns every
workload; the broker still owns every credential.

## Scope

**Changes:** selected-Driver lifecycle hooks, bounded workload launch configuration, and
the extension seam needed for future Namespace-scoped OpenShell provider integration.

**Does not change:** public APIs, persistence, queue semantics, immutable AgentRevisions,
ConfigurationDriver, credential-operation protocols, concrete production ComputeDriver type,
production's Namespace-only worker scope, or the existing Secret Broker branch.
Current `origin/main` has no SecretBrokerDriver or OpenShell gateway; their implementation and
live provider integration remain deferred until those real dependencies exist.

## Contract

```ts
interface WorkloadLaunchContext {
  environment: Record<string, string>;
}
interface ComputeLifecycleHooks {
  afterNamespacePrepared?(namespace: Readonly<Namespace>, signal: AbortSignal): Promise<void>;
  beforeWorkloadStart?(
    revision: Readonly<AgentRevision>,
    launch: WorkloadLaunchContext,
    signal: AbortSignal,
  ): Promise<void>;
  beforeWorkloadStop?(revision: Readonly<AgentRevision>, signal: AbortSignal): Promise<void>;
  beforeNamespaceDelete?(namespace: Readonly<Namespace>, signal: AbortSignal): Promise<void>;
}
```

`Driver` may expose `computeLifecycleHooks`. OCC accepts only selected non-Compute Drivers with
stable `{ capability, id, implementation }` and orders them deterministically. Shared Installation
startup independently constructs the currently available Configuration-owned hook set for the API
and worker; IAM is reconstructed separately and currently has no hooks. Inject hooks into the
existing ComputeDriver; do not wrap or replace its concrete production implementation. Hook
ownership cannot change after the first lifecycle operation begins.

Preparation runs in registration order; teardown runs in reverse:

1. `ensureNamespace` creates the Namespace/gateway, then runs `afterNamespacePrepared` before
   reporting ready.
2. `prepareRevision` runs `beforeWorkloadStart`, validates/freezes launch configuration, then
   starts the workload.
3. `retireRevision` runs `beforeWorkloadStop` and awaits credential revocation before stopping it.
4. `deleteNamespace` applies that same workload teardown first, then runs `beforeNamespaceDelete`
   before deleting Namespace infrastructure.

The immutable revision already identifies the Namespace, Agent, revision, selected ComputeDriver,
and `servicePrincipalId`; add no parallel workload identity. Only allowlisted `opaque-`-prefixed
environment placeholders are mutable. Images, commands, placement, network policy, authorization,
and revision contents remain Compute/OCC-owned.

Preparation or launch failure compensates completed hooks in reverse; a failing hook cleans up its
own partial work. Failed revocation blocks teardown. Retries are idempotent, cancellation uses the
existing operation signal, and Namespace/revision operations remain serialized. Provider access
requires the exact authenticated workload and currently active revision; lost claims, failed
activation, superseded revisions, and revocation must never enable stale access.

When an OpenShell SecretBrokerDriver and verified gateway become available, they must prepare one
provider domain per Namespace and resolve the canonical OpenClaw `SecretRef` shape only within that
tenant: `{ source: "env" | "file" | "exec" | "store", provider: string, id: string }`. That future
integration must use OpenClaw's existing sandbox and provider settings, which generate the
corresponding `--provider` flags, without adding speculative fields to the current launch contract.
Credential injection belongs to the trusted gateway, never the workload. Providers may be shared
within one Namespace; bindings and revocation remain specific to the exact workload.

IAM remains authoritative. Reject unselected hooks, foreign tenants, inactive revisions, malformed
references, and conflicting launch contributions. Existing lifecycle audit retains resource
identities and outcomes; hook failures expose only sanitized owner/phase details, never
credentials, resolved references, placeholders, or sensitive endpoints.

## Implementation

1. Add optional hook and launch contracts to
   [`packages/contracts/src/index.ts`](../../packages/contracts/src/index.ts).
2. Select and wire trusted hooks through [`packages/occ/src/index.ts`](../../packages/occ/src/index.ts),
   [`installation-config.ts`](../../apps/controller/src/composition/installation-config.ts), and
   [`worker.ts`](../../apps/controller/src/worker.ts).
3. Dispatch hooks inside [`KubernetesComputeDriver`](../../apps/controller/src/drivers/compute/kubernetes/index.ts)
   and `LocalTestComputeDriver` (historical path:
   `apps/controller/src/drivers/compute/local-test/index.ts`).
4. When available, implement the OpenShell hooks inside the selected SecretBrokerDriver; require a
   real gateway and verified workload authentication before enabling production use. This step is
   deferred while the broker and gateway are absent from the selected base.
5. Extend existing [`contract`](../../tests/conformance/contracts.test.mjs),
   [`Kubernetes compute`](../../tests/conformance/kubernetes-compute.test.mjs),
   [`controller lifecycle`](../../tests/integration/controller-lifecycle.test.mjs), and
   [`worker revision`](../../tests/integration/postgres-worker-agent-revision.test.mjs) tests; update
   [`ComputeDriver contract`](../../docs/reference/drivers/compute.md) when the implementation ships.

## Verification

| Required outcome                 | Concrete proof                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration and ordering        | Reject unselected/duplicate owners; verify forward preparation, reverse teardown, and matching API/worker selection.                                       |
| Namespace and workload lifecycle | Keep a Namespace unready until hooks succeed; configure providers before launch; revoke before workload/Namespace deletion.                                |
| OpenShell compatibility          | With a real available gateway, verify canonical SecretRefs, existing sandbox settings, and exact `--provider` flags; otherwise explicitly skip live proof. |
| Isolation and authorization      | Reject foreign tenants, mismatched workload identities, inactive revisions, and malformed references; preserve independently shared provider bindings.     |
| Failure and concurrency          | Exercise failed hooks/launch, rollback, retries, revocation, lost claims, superseded revisions, and failed activation; never restore stale access.         |
| Credential and audit safety      | Canary credentials never enter workloads, revisions, Configuration, errors, logs, or audit; only opaque placeholders reach workloads.                      |

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-31 18:06]: Repaired repository links while preserving historical citations and implementation decisions. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4e16a74272e716d998c6da59fff95fde806d86fa)

- [2026-08-20 15:42]: Removed speculative sandbox launch fields and documented the shared ComputeDriver contract separately from concrete drivers. (01a01fc3-fa66-7d53-92bf-338fada8fd9f - d1294fc)
- [2026-08-20 07:36]: Completed selected-driver lifecycle implementation; clarified immutable hook ownership, validated opaque placeholders, existing audit boundaries, and deferred OpenShell integration. (01a01dfc-dbec-79e1-9400-356f32af7d11 - 875f7a1b47f3ee3645a432c27aa72da57e300f29)
- [2026-08-20 07:18]: Incorporated pre-implementation review: ship generic selected-driver hooks only and explicitly defer absent SecretBroker/OpenShell runtime integration. (01a01dfc-dbec-79e1-9400-356f32af7d11 - 875f7a1b47f3ee3645a432c27aa72da57e300f29)
- [2026-08-20 07:12]: Reduced the design to four hooks over existing Namespace and AgentRevision types, one bounded launch context, and essential lifecycle/security verification. (01a01dfc-dbec-79e1-9400-356f32af7d11 - 875f7a1b47f3ee3645a432c27aa72da57e300f29)
- [2026-08-20 07:08]: Defined selected-driver lifecycle phases, bounded workload launch integration, canonical OpenShell SecretRefs, fail-closed revocation, repository touchpoints, and verification. (01a01dfc-dbec-79e1-9400-356f32af7d11 - 875f7a1b47f3ee3645a432c27aa72da57e300f29)
