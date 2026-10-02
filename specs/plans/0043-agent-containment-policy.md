---
rfc: ../rfcs/0043-agent-containment-policy.md
---

# Implementation plan: Agent containment policy

- **ID:** RFC-0043
- **Delivery status:** In progress; first OpenShell hardening slice authored, runtime proof pending
- **Owner:** OpenClaw Enterprise maintainers
- **Authority:** [RFC-0043](../rfcs/0043-agent-containment-policy.md) and the [platform design](../../docs/design.md)
- **Source baseline:** `main` at `a10baed3c`

## Outcome and scope

An authorized deployment of a dedicated Kubernetes Agent on an Installation requiring containment admits an exact Namespace-owned `SandboxPolicy`, freezes it in the AgentRevision, and activates only after the selected Sandbox Driver proves enforcement before the Harness executes. Embedded and SSH execution remain outside the first supported scope. The RFC owns the proposed contract and open design choices.

## Contract and source touchpoints

The Agent deployment path owns policy reference authorization, admission, and immutable revision contents. The worker rechecks authorization and selected Driver identity. The `SandboxDriver` owns provider-specific translation and evidence; the Kubernetes Compute Driver owns workload identity, baseline isolation, and lifecycle ordering. Start from the current [Sandbox Driver contract](../../docs/reference/drivers/sandbox.md), [Agent lifecycle](../../docs/reference/agents.md), and [OpenShell flow](../../docs/flows/openshell-sandbox-provisioning.md).

## Implementation

1. **OpenShell hardening slice:** Require `hard_requirement` Landlock compatibility in the bundled Driver, reject weaker or unknown Installation settings at startup, and check the serialized `CreateSandbox` request through the existing integration path. This is authored on this branch. It does not claim a new platform policy or qualified production deployment.
2. Add the Namespace policy resource, exact IAM and audit operations, API schema, PostgreSQL constraints, Agent reference, and immutable AgentRevision snapshot. Extend the regular Agent deployment integration test for exact authorization, scope, snapshot immutability, and refusal without a capable selected Driver.
3. Extend the provider-neutral `SandboxDriver` contract with admission and enforcement evidence. Wire the API, work queue, worker, Compute, and Driver through the real Agent workflow. Keep provider-specific translation in the Driver. Prove rejection, pending enforcement, activation, replacement, and cleanup; a test-only Driver is insufficient for a production containment claim.
4. Qualify a pinned OpenShell release for projected identity, Secret references, workspace mounts, authenticated transport, and pre-execution policy ordering. Extend the disposable Kubernetes OpenShell integration with a real model turn and allowed and denied child actions. Unsupported upstream combinations remain unavailable.
5. If host isolation is selected, qualify gVisor or Kata RuntimeClass separately through the Compute-owned Kubernetes path, including scheduling, storage, networking, and denial behavior.

Each behavior-changing step updates its owning reference, guide, source-backed flow, and integration coverage. The API cheat sheet is generated from the owning API contract.

## Verification

| Required outcome | Real check and prerequisites | Result or remaining proof |
| --- | --- | --- |
| Omitted and explicit mandatory settings compose; weaker modes fail at Installation startup; the request uses `hard_requirement` | Existing Sandbox Driver startup and provisioning integration tests | Authored; Node 24.19.0 is available, but the test cannot load because the installed `pg` dependency is missing |
| A real child cannot start without filesystem policy | Disposable Kubernetes OpenShell integration with a pinned compatible runtime | Not run; runtime qualification pending |
| Exact Agent policy scope, authorization, and immutable snapshot | Regular API and worker Agent deployment integration with PostgreSQL | Not implemented |
| Enforcement before activation and fail-closed replacement | Real API → worker → Compute → selected Driver integration | Not implemented |
| Production workload identity and credentials survive provider provisioning | Pinned OpenShell Kubernetes runtime with a real model turn | Blocked by current stock gateway projection limits |

## Open decisions

OCE maintainers must settle the smallest provider-neutral policy vocabulary and evidence for pre-execution enforcement before steps 2 and 3 can ship. The first supported scope is dedicated Kubernetes execution; expanding required containment to embedded or SSH Agents needs separately qualified paths.

## Delivery record

The OpenShell hardening slice changes [the bundled adapter](../../apps/controller/src/drivers/sandbox/openshell.ts), [its integration test](../../tests/integration/sandbox-driver-startup.test.mjs), [the current reference](../../docs/reference/drivers/openshell-sandbox.md), and [the flow](../../docs/flows/openshell-sandbox-provisioning.md). Runtime qualification remains pending. The `SandboxPolicy` resource, immutable revision snapshot, and enforcement evidence are not implemented.

[PR #919](https://github.com/openclaw/openclaw-enterprise/pull/919) review found no actionable patch defect. Startup integration execution, real filesystem denial and pre-execution failure evidence, and maintainer acceptance of the mandatory startup boundary remain outstanding. The existing compatibility suite's filesystem checks do not establish the unavailable-Landlock failure case. Local Docker is stopped and k3d is absent; runtime setup and pinned assets are still required.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-02: Added explicit mandatory-setting startup coverage and recorded PR #919's remaining runtime proof and maintainer decision (source `78db8531f`).

- 2026-10-02: Split the proposal into RFC-0043 and its implementation plan after the repository adopted separate RFC and plan locations (source `a10baed3c`).
