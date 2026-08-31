# Feature Spec: Harness Execution Topology

**Date:** 2026-08-21
**Status:** Implementation
**Owner:** OCC, Kubernetes Compute, and Codex runtime

## Problem and Decision

OpenClaw executes its built-in harness inside its gateway; Codex requires a separate workload. Let
each Agent explicitly select `embedded` or `dedicated`, resolve its harness from the same native
Configuration, and freeze both decisions in each AgentRevision. The existing Compute Driver owns
the topology. Production supports both embedded OpenClaw and dedicated Codex.

## Scope

**Changes:** explicit Agent placement; immutable per-revision harness selection; topology-aware
Compute; production admission; guarded revision activation; and real gateway-to-model integrations.

**Unchanged:** singleton Installation, Namespace isolation, one Agent-owned gateway, one native
`Configuration.kind: "agent"`, stable Agent ServicePrincipal, exact-resource authorization, and
existing Compute ownership. Do not add a harness selector/resource/catalog/table/driver, platform
workload primitive, independent gateway configuration, or cross-cluster scheduling.

## Contract

### Native runtime policy and immutable placement

```ts
type HarnessExecutionMode = "embedded" | "dedicated";

interface Agent {
  readonly configurationId: string;
  readonly executionMode: HarnessExecutionMode;
}

interface AgentRevision {
  readonly configuration: OpenClawConfigurationDocument;
  readonly harness: {
    readonly id: string;
    readonly version: string;
    readonly mode: HarnessExecutionMode;
  };
}
```

Agent creation accepts optional `executionMode`, defaulting to `embedded`; an update preserves its
current mode when omitted. An authorized bodyless deployment freezes the exact native configuration,
user-selected mode, and server-approved harness identity/version. Later Agent or Configuration edits
affect only later revisions; reconciliation revalidates the immutable approved combination.

Use only the selected native model/provider `agentRuntime.id`, with native model policy taking
precedence. Explicitly select `codex` for Codex and `openclaw` for OpenClaw. Missing policy defaults
to embedded OpenClaw only for an unambiguous built-in configuration; plugin-routed or ambiguous
models require an explicit supported runtime. Reject conflicting, unknown, unavailable, or
mode-incompatible selections. Development and production admit the same two canonical pairs:
`openclaw` with `embedded` placement and `codex` with `dedicated` placement.

### Workload ownership and security

- **Embedded:** one real OpenClaw gateway executes its built-in harness with its exact Agent
  ServiceAccount, projected ServicePrincipal token, and operator-owned Agent-specific model key;
  `beforeWorkloadStart` runs before that combined process. No Codex workload or binary is required.
- **Dedicated:** an Agent-owned gateway and revision-scoped Codex Deployment have distinct
  ServiceAccounts. Only Codex receives the Agent's audience-scoped projected ServicePrincipal token
  and operator-owned model API key. Each Agent has isolated Pods, identities, routes, and secrets.
- **Transport:** gateway and Codex share only their exact Agent's transport capability. The Codex
  listener verifies its SHA-256 digest over approved, same-Namespace, NetworkPolicy-confined `ws://`.
  Missing credentials, disabled authentication, foreign ownership, and unsupported topology fail
  before workload creation; the controller neither reads nor creates operator-owned Secrets.

An embedded Agent still uses its own operator-owned gateway admission token and model Secret, but
receives no app-server capability or URL. Its initially nonserving gateway route activates only
after exact revision ownership and readiness are verified. Dedicated model keys never enter the
separate gateway; embedded model keys enter only the exact combined Agent-owned gateway/Harness.

Use one user-authored native Configuration for model routing and official Codex plugin transport:

```json
{
  "agents": {
    "defaults": {
      "model": "codex/gpt-4.1",
      "models": { "codex/gpt-4.1": { "agentRuntime": { "id": "codex" } } }
    }
  },
  "plugins": {
    "allow": ["codex"],
    "entries": {
      "codex": {
        "enabled": true,
        "config": {
          "appServer": {
            "mode": "guardian",
            "approvalPolicy": "on-request",
            "sandbox": "read-only",
            "transport": "websocket",
            "url": "${APP_SERVER_URL}",
            "authToken": { "source": "env", "provider": "default", "id": "APP_SERVER_TOKEN" }
          }
        }
      }
    }
  }
}
```

Production and local dedicated Compute use these same `APP_SERVER_URL` and `APP_SERVER_TOKEN`
variables. The virtual `codex/<model>` provider routes provider authentication to Codex, never its
gateway; initialize Codex's account through its authenticated WebSocket using ephemeral in-memory
credentials. Preserve guardian approval, read-only sandbox policy, restricted nonroot Pods,
token-automount denial, approved model egress, and default-deny/same-Agent NetworkPolicies.
Propagate only the bounded proxy-variable allowlist while excluding `127.0.0.1`, `localhost`, and
`::1` from proxying.

### Fenced activation and redeployment

Workers retain exact-resource authorization, immutable revision checks, claim fencing, cancellation,
and per-Agent serialization. The generic Compute contract does not change: narrow the existing
Kubernetes implementation before calling its concrete activation helper. Preparation must preserve
the predecessor's Service selector until the new revision wins its fenced active-revision
compare-and-set; failed activation must leave the old route serving. Publish only the exact active
revision, retire its predecessor, and atomically finish the claim with exactly one activation audit.
Already-active recovery safely repeats publication and predecessor retirement before finalization.

## Implementation

1. Keep Agent and revision contracts aligned in
   [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts) and existing OCC state.
2. Resolve selected-model/provider policy, one canonical approved harness, and explicit placement in
   [`packages/occ/src/index.ts`](../packages/occ/src/index.ts) and
   [`controller composition`](../apps/controller/src/composition).
3. Preserve worker claim fencing, guarded Kubernetes Service activation, predecessor continuity, and
   exactly-once audit in [`worker.ts`](../apps/controller/src/worker.ts) and
   [`Kubernetes Compute`](../apps/controller/src/drivers/compute/kubernetes/index.ts).
4. Start a single embedded gateway or an authenticated dedicated gateway/Codex pair through
   `local-test Compute` (historical path:
   `apps/controller/src/drivers/compute/local-test/index.ts`).
5. Keep [Agent operator guidance](../docs/reference/agents.md),
   [ComputeDriver contract](../docs/reference/drivers/compute.md), and
   [execution flow](../docs/flows/harness-execution-topology.md) accurate.

## Verification

- Focused conformance proves explicit Codex/OpenClaw, an unambiguous built-in default, rejection of
  missing ambiguous policy and conflicting/mismatched routes, and immutable per-revision placement.
- Security coverage preserves exact Agent/Namespace ownership, distinct dedicated identities,
  Codex-only dedicated provider credentials, embedded exact-Agent identity/model credentials,
  capability authentication, NetworkPolicies, and production approval of both canonical modes.
- Real k3d Kubernetes regressions prove both production topologies, exact model-key and projected
  identity placement, authenticated dedicated transport, isolated routing, and predecessor Service
  continuity; worker recovery proves fenced exactly-once activation.
- `harness-topology-real.test.mjs` (historical path:
  `tests/integration/harness-topology-real.test.mjs`) runs both
  required model turns with real runtimes, a shell-provided `OPENAI_API_KEY`, and fresh nonces:
  1. Dedicated Codex: real gateway → authenticated Codex app-server → `codex/gpt-4.1`; only
     Codex receives the provider key and ephemeral account initialization.
  2. Embedded OpenClaw: one real gateway/built-in harness → `openai/gpt-4.1`; no Codex process.

Missing credentials, runtimes, provider access, or either real model response is a failure; a
readiness probe, initialization handshake, mock, or skipped scenario is not integration proof.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-31 18:06]: Repaired repository links while preserving historical citations and implementation decisions. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4e16a74272e716d998c6da59fff95fde806d86fa)

- [2026-08-21 14:01]: Consolidated the topology contract around explicit native runtime policy, one canonical harness approval, isolated credentials, predecessor-safe activation, and both real model-turn proofs. (01a021b2-292b-7ee1-ab55-4f8dc4f0ba7c - 8796ccc)
- [2026-08-21 12:43]: Specified Codex-owned model routing, in-memory authenticated account bootstrap, guardian/read-only execution, and bounded loopback-safe proxy propagation for both real provider turns. (01a0119a-9843-7423-a4c6-955ff4187bd9 - be58d1b)
- [2026-08-21 19:12]: Reconciled approved explicit placement with existing production worker, concrete Kubernetes activation, operator-owned Codex-only model credentials, authenticated same-Namespace transport, and two real local model-turn scenarios. (01a021b2-292b-7ee1-ab55-4f8dc4f0ba7c - 149882c)
- [2026-08-21 19:01]: Required live dedicated Codex and embedded OpenClaw gateway-to-Harness integration turns using a shell-provided API key without exposing production provider credentials. (01a021b2-292b-7ee1-ab55-4f8dc4f0ba7c - 01ad9ed8dc170ca0b727e1402d58afb45b950202)
- [2026-08-21 18:57]: Defined fail-closed post-CAS route handoff and exact-active request checks; added server-enforced, monotonic Kubernetes Service publication fencing and stale-writer recovery coverage without extra activation state. (01a021b2-292b-7ee1-ab55-4f8dc4f0ba7c - 01ad9ed8dc170ca0b727e1402d58afb45b950202)
- [2026-08-21 18:54]: Aligned existing fresh-bootstrap SQL definitions without adding upgrade logic; resolved approved Harnesses per revision; preserved active routes during replacement; and defined fenced two-transaction activation, exactly-once audit, and crash recovery. (01a021b2-292b-7ee1-ab55-4f8dc4f0ba7c - 01ad9ed8dc170ca0b727e1402d58afb45b950202)
- [2026-08-21 18:48]: Removed migration and installation-cutover requirements; preserved existing explicit revision placement; clarified crash-safe activation, reusable approved security infrastructure, and semantic native configuration preservation. (01a021b2-292b-7ee1-ab55-4f8dc4f0ba7c - 01ad9ed8dc170ca0b727e1402d58afb45b950202)
- [2026-08-21 18:35]: Preserved explicit user-selected placement while removing duplicate harness selection/catalog; required end-to-end production dedicated worker execution, workload attestation, authenticated Codex transport, upstream support, and fenced route activation. (01a021b2-292b-7ee1-ab55-4f8dc4f0ba7c - 01ad9ed8dc170ca0b727e1402d58afb45b950202)
- [2026-08-21 06:08]: Applied approved simplification: fixed Installation-owned Harness catalog, existing IAM/Compute ownership, explicit empty-state immutable cutover, real embedded activation guard, and deferred authenticated Codex integration. (01a021b2-292b-7ee1-ab55-4f8dc4f0ba7c - 01ad9ed8dc170ca0b727e1402d58afb45b950202)
- [2026-08-21 05:54]: Defined Installation-owned Harness resources, per-Agent embedded/dedicated execution, conditional identity boundaries, native configuration projection, and Compute-owned topology realization. (01a021b2-292b-7ee1-ab55-4f8dc4f0ba7c - 01ad9ed8dc170ca0b727e1402d58afb45b950202)
