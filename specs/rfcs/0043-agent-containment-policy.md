---
status: Proposed
---

# Proposal: Agent containment policy

- **ID:** RFC-0043
- **Owner:** OpenClaw Enterprise maintainers
- **Current references:** [Agents](../../docs/reference/agents.md), [Sandbox Driver](../../docs/reference/drivers/sandbox.md), and [runtime security](../../docs/reference/security/runtime-isolation.md)
- **Architecture:** [Resources](../../docs/design/resources.md), [Drivers](../../docs/design/drivers.md), and [safeguards](../../docs/design/safeguards.md)
- **Delivery:** [Implementation plan](../plans/0043-agent-containment-policy.md)

## Problem and decision

An operator needs to require containment before an Agent can execute untrusted work. Today, selecting a Sandbox Driver records its ID in the AgentRevision and delegates dedicated Harness provisioning, but the revision contains no exact platform policy. A Driver's declared `networking`, `filesystem`, or `process` facet does not prove that it applied the restrictions required for this Agent. The bundled OpenShell integration also cannot complete a supported production deployment against its pinned stock gateway version.

Make `SandboxPolicy` a Namespace-owned resource and an immutable AgentRevision input. OpenClaw Control Plane (OCC) authorizes the exact policy reference, validates that the Installation-selected Sandbox Driver can enforce it, and admits its complete normalized contents into the revision. The worker must reject a changed or unavailable Driver and must not activate the revision until enforcement of that exact snapshot is confirmed. The Driver owns implementation-specific policy translation and evidence; Compute retains Agent identity, gateway, routing, baseline isolation, and cleanup order.

This is a platform capability. OpenShell is one possible Driver, not the policy model or its sole caller. The first supported caller is an authorized deployment of a dedicated Kubernetes Agent on an Installation that requires containment. The Installation refuses a deployment without an enforceable policy; it never silently uses a weaker runtime. Requiring containment for embedded and SSH Agents remains later work until those modes have a qualifying implementation.

## Scope and contract

The first policy version specifies the required network, filesystem, and process outcomes for one Harness. It must express denial by default, permitted outbound destinations and peers, readable and writable paths, user and privilege requirements, and any allowed process capabilities. OCE owns a small, versioned, provider-neutral vocabulary. A Driver may support only a subset, but admission must reject any requirement it cannot enforce. Driver-specific configuration stays in the Driver's trusted Installation settings; it cannot broaden an Agent policy.

The policy is created and updated under its Namespace with exact IAM operations and audit records. An Agent draft references a policy in the same Namespace. Deployment authorizes both `deploy` on that Agent and `read` on the referenced policy, then freezes the policy ID, generation, normalized contents, selected Driver ID, and enforcement contract version in the AgentRevision. Editing a policy affects only a later deployment. An Agent cannot choose its own Driver or use a policy from another Namespace.

The `SandboxDriver` contract needs operations to check a proposed policy before admission and to establish and report enforcement for the exact revision. Those operations consume platform types and exact owner identities. They must not grant IAM permissions, rewrite a revision, select another target, or claim success from a facet declaration alone. Existing optional Harness provisioning remains a separate lifecycle operation until the owning Compute contract is revised. A policy change must not be silently applied to an active revision.

The worker rechecks the original actor's authorization and the revision's owner and Driver selection before effects. Compute prepares the nonserving candidate and calls the Driver through its existing lifecycle. The Driver must apply the frozen policy before untrusted code can execute and return evidence bound to the exact AgentRevision and workload generation. The worker checks that evidence before activation. A pending observation defers; a denial or unsupported policy fails the revision. An unavailable provider cannot cause fallback to an unsandboxed Harness. Stop, retirement, and Namespace deletion keep their current exact-owner cleanup order and retry rules.

The first implementation must explicitly prove its pre-execution ordering. The current OpenShell `provisionHarness` call submits policy with `CreateSandbox`, but OCE's later Pod readiness check alone does not prove the child could not run before policy enforcement. Before this work, the adapter defaulted Landlock compatibility to `best_effort` and accepted an arbitrary compatibility string. The first hardening slice now sends `hard_requirement` and rejects weaker or unknown values. Real runtime verification is still required. If the provider cannot supply pre-execution evidence or preserve OCE workload identity, the production path remains unavailable.

## Ownership and trust boundaries

| Owner | Responsibility |
| --- | --- |
| OCC | Policy resource, IAM, immutable revision snapshot, admission and activation decisions, audit. |
| Compute Driver | Namespace baseline, Agent identity, gateway, candidate workload, route and lifecycle ordering. |
| Sandbox Driver | Translate, apply, and prove the exact admitted containment requirements; clean up its own resources. |
| Kubernetes runtime | Optional host isolation, such as an approved RuntimeClass; it does not replace Agent policy or IAM. |

Secret values and provider credentials are not policy data or revision data. Credential Gateway attachments remain separately authorized and must be ready before activation. Network permission does not grant a credential, and credential binding does not grant network permission. Production network rules must be checked as the union of all matching Kubernetes NetworkPolicies and the provider's own policy.

## Delivery and verification

The [implementation plan](../plans/0043-agent-containment-policy.md) records the ordered work and proof. The first OpenShell hardening slice requires mandatory Landlock compatibility but does not deliver the policy resource or production support. Production support requires installed-runtime evidence; passing unit tests or a simulated provider does not establish it.

## Open decisions

- **Later rollout:** Decide whether and when to require containment for embedded Kubernetes and SSH Agents after each has a qualified implementation. The first milestone covers dedicated Kubernetes execution only.
- **Policy vocabulary:** Agree on the smallest normalized network, filesystem, and process fields that can be enforced by at least one supported provider without making the platform core parse provider configuration. Version the contract and reject unknown requirements.
- **Enforcement proof:** Define the evidence that binds an applied policy to the exact revision and workload generation, and how a controller recovers after an uncertain provider response. Pod readiness and declared facets are insufficient.
- **OpenShell qualification:** Pin an upstream release only after confirming its Kubernetes contract. Current upstream documentation describes capabilities that the OCE `v0.1.3-pre.1` adapter does not consume; compatibility must be tested rather than inferred.

## Current implementation boundary

The first hardening slice does not add `SandboxPolicy` or change the supported deployment combinations. The current Sandbox Driver contract has optional `configureAgent`, `ensureNamespace`, and `provisionHarness` hooks plus required cleanup. It exposes broad containment facets, not an Agent policy resource or exact enforcement evidence. Dedicated OpenClaw requires all three facets and provisioning, while ordinary embedded execution cannot use the selected Sandbox Driver. The bundled OpenShell production path is blocked by its pinned gateway's missing workload projections. See the linked current references for operational limits.
