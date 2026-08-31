# Feature Spec: Configuration Kind and Agent-Owned Gateways

**Date:** 2026-08-20
**Status:** Completed
**Owner:** OCC

## Decision and scope

Require immutable `Configuration.kind: "agent"` to identify its consumer. Preserve each
Configuration's native OpenClaw document as the sole source of Agent and gateway settings. Each
deployed Agent owns exactly one gateway, so a Namespace can contain multiple gateways. The selected
Compute Driver deploys that gateway with its Agent; there is no Gateway Driver or Gateway resource.
This implementation follows the Agent-owned gateway topology in the repository-local
[platform design](../docs/design.md).

The OpenClaw built-in harness is the default. A future Harness Driver's implementation discriminator
remains independent of `Configuration.kind`. Unsupported Configuration kinds, standalone Harness
Drivers, Secret Broker resources, service-account providers, inline Agent gateway configuration, and
production Agent execution remain outside this implementation.

## Domain and API contracts

```ts
export type ConfigurationKind = "agent";

export interface Configuration {
  readonly id: string;
  readonly namespaceId: string;
  readonly kind: "agent";
  readonly generation: number;
  readonly values: OpenClawConfigurationDocument;
  readonly createdAt: string;
}

export interface AgentRevision {
  readonly configuration: OpenClawConfigurationDocument;
  readonly configurationId: string;
  readonly configurationKind: "agent";
  readonly configurationGeneration: number;
  // Existing Agent identity, selected Harness/Compute, and timestamps remain unchanged.
}
```

`POST /namespaces/{namespaceId}/configurations` requires:

```json
{
  "kind": "agent",
  "values": { "gateway": { "controlUi": { "enabled": false } } }
}
```

The response includes the unchanged native `values`, `kind: "agent"`, and `generation: 1`. A
Configuration PATCH accepts only `{ "values": { ... } }`, replaces the complete native document,
and advances its positive safe-integer generation exactly once. Missing, unknown, or changed kinds
and caller-selected generations are rejected. IAM's separate `ResourceRef.kind: "configuration"`
retains its existing meaning.

An Agent may reference only a compatible Configuration in its own Namespace. Agent create, update,
and bodyless deployment each authorize `read` on the exact Configuration. Deployment immutably
snapshots the native document, identity, kind, and generation; later Configuration updates do not
change existing revisions, running gateways, or sibling Agents. Existing inline OpenClaw SecretRefs
remain unresolved; raw credentials must never be introduced or copied into gateway environments.

## Persistence and reconciliation

PostgreSQL enforces `kind CHECK (kind = 'agent')` and a positive safe-integer generation. An
ownership trigger permits only single-step generation updates; `occ_app` receives only
`UPDATE (generation)`. Preserve same-Namespace Agent foreign keys and lock the exact Configuration
row.
The in-memory adapter provides equivalent ownership and compare-and-swap generation guarantees.

The Kubernetes Configuration Driver retains exactly one native `ConfigMap.data["openclaw.json"]`
entry and verifies kind/generation ownership annotations. Immutable Agent revisions retain their
existing native `draft_spec` and pinned Harness/Compute descriptors while adding source metadata.

`ComputeDriver.ensureNamespace` prepares tenant backing infrastructure without a gateway. Existing
`prepareRevision` creates or reuses one stable gateway for the exact `(namespaceId, agentId)`;
different Agents never share Deployments, Services, processes, tokens, or routing guards. Kubernetes
mounts an immutable Agent-owned `gateway-<agent-hash>-rev-<revision-hash>` ConfigMap containing
exactly the admitted native document read-only at `OPENCLAW_CONFIG_PATH`. The gateway Deployment has
one replica and a stable per-Agent identity. Existing immutable ConfigMaps remain until Namespace
deletion. Local Compute writes the same exact document into its private Agent-owned configuration.

Revision replacement uses the existing worker ordering and queue retry behavior; there is no
cross-driver transactional rollback or zero-downtime guarantee. A failed replacement can make its
Agent temporarily unavailable until reconciliation succeeds, but routes must fail closed on
revision/configuration mismatch and never affect sibling or cross-Namespace resources. Production
workers remain restricted to Namespace operations.

## Implementation and acceptance

- Update shared [domain and API contracts](../packages/contracts/src/index.ts), generated
  [OpenAPI](../packages/contracts/openapi/occ-api.openapi.json), and [API reference](../docs/reference/api.md).
- Update [OCC authorization](../packages/occ/src/index.ts), [in-memory state](../packages/occ/src/state/platform-state.ts),
  [PostgreSQL state](../packages/occ/src/state/postgres-state.ts), and the
  [Kubernetes Configuration Driver](../apps/controller/src/drivers/configuration/kubernetes/index.ts).
- Update [worker observations](../apps/controller/src/worker.ts), [Harness selection](../apps/controller/src/composition/production-harness.ts),
  [Kubernetes Compute](../apps/controller/src/drivers/compute/kubernetes/index.ts), and
  local-test Compute (historical path:
  `apps/controller/src/drivers/compute/local-test/index.ts`).
- Verify missing/unknown/immutable kinds, exact-resource authorization, cross-Namespace rejection,
  positive generation advancement and database constraints, immutable revision snapshots, two
  same-Namespace Agents with distinct stable gateways, unchanged native mounted documents, and
  Namespace-only production reconciliation. Real PostgreSQL, local binaries, and Kubernetes tests
  require their actual dependencies; report unavailable infrastructure accurately.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-31 18:06]: Repaired repository links while preserving historical citations and implementation decisions. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4e16a74272e716d998c6da59fff95fde806d86fa)

- [2026-08-20]: Simplified Agent-owned gateway reconciliation and removed transactional rollback while preserving native immutable snapshots and owner isolation. (01a02125-e04a-7780-95fb-22e8e4dfbffc)
- [2026-08-20 22:58]: Implemented Configuration kinds/generations, immutable revision provenance, and Agent-owned gateways. (01a02125-e04a-7780-95fb-22e8e4dfbffc - fb2be5b5b514f29669bd62aaac70d7c835de68d0)
- [2026-08-20 22:20]: Incorporated the approved Agent-owned gateway topology and native OpenClaw Configuration contract. (01a02125-e04a-7780-95fb-22e8e4dfbffc - fb2be5b5b514f29669bd62aaac70d7c835de68d0)
- [2026-08-20 21:52]: Created the Configuration-kind specification and architecture delta. (01a02125-e04a-7780-95fb-22e8e4dfbffc - 2a82234a9214da410e75f94c07cd29aa165a6fa1)
