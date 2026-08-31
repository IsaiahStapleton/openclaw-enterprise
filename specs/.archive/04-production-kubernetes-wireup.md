# Feature Spec: Production Kubernetes Packaging and Agent Wireup

**Date:** 2026-08-19

**Status:** Implemented; pending review

**Depends on:** Production Kubernetes Controller Operation, [Configuration Kind and Agent-Owned Gateways](06-configuration-kind.md)

**Authority:** [OpenClaw Enterprise platform design](../../docs/design.md)

## Outcome

Deploy the existing OCC API and worker to a private Kubernetes control plane,
then run each Agent's own OpenClaw gateway and Codex app-server. Preserve the
merged platform model: one singleton Installation, isolated Namespaces, one
gateway per Agent, immutable AgentRevision configuration, and exact-resource IAM
authorization. A Namespace can contain multiple independent Agents and gateways.

## Installation

One canonical Helm chart deploys:

- Separate, least-privileged controller API and worker Deployments and
  ServiceAccounts, plus one internal ClusterIP API Service.
- One pre-install initialization Job. Its migration init-container receives
  only the migrator PostgreSQL credential; its bootstrap container receives
  only the application credential and creates or verifies the singleton
  Installation and exact administrator Principal.
- Restrictive initialization NetworkPolicies before that Job, runtime
  default-deny policies, exact approved API clients, and narrowly scoped DNS,
  PostgreSQL, and Kubernetes API egress.
- A dedicated initialization ServiceAccount without an API token, reviewed
  worker/API RBAC, operator-provisioned tenant RoleBindings, mounted startup and
  admission Secrets, resource limits, and API/worker health checks.

The production Node 24 image includes only the active workspace's production
dependencies and reviewed migration files. Controller, gateway, and Agent
images must use explicitly approved immutable digests. Helm selects the
controller image; trusted Installation configuration selects gateway and Agent
images. Migration uses the
existing Drizzle production dependency; no alternate migration engine, archive
imports, generated credentials, or public ingress are introduced.

Production admission temporarily uses the existing internal bearer verifier
until verified OAG admission is available. Every platform operation still uses
its persisted Principal and exact selected IAM authorization.

## Agent runtime and routing

The existing Compute Driver owns one stable `gateway-<agent-hash>` Deployment
and one stable `agent-<agent-hash>` Service per Agent. Each gateway continues
to mount the admitted revision's exact immutable native `openclaw.json`
ConfigMap; startup must not generate, replace, or reinterpret that document.

Enable the existing Codex plugin through the Agent's native Configuration and
use its environment references for transport and gateway credentials. The
Agent-owned gateway connects directly to its owner's Agent Service:

```text
gateway-<agent-hash>
  -> ws://agent-<agent-hash>:<port>
  -> capability-token-authenticated codex app-server
```

The upstream plugin already supports one destination per gateway, so no shared
Namespace gateway, route alias, route registry, gateway extension, or upstream
patch is required. Stable gateway and workload Services select only workloads
owned by the exact Agent and currently active revision.

At most one AgentRevision may receive traffic or execute Agent turns at a
time. An idle candidate app-server can start alongside the previous revision;
process overlap alone does not violate Agent isolation.

Transport and model Secret names derive from their configured prefixes and the
exact Agent hash. Operators create both Secrets in that Agent's Namespace. The
controller references their keys but cannot read or copy their values. Gateway
and model credentials remain separate.

Direct Agent access to its operator-provisioned model API key and outbound
public TCP/443 are temporary exceptions pending a credential broker and model
egress proxy. Capability-token `ws://` is temporary pending workload-bound mTLS.
Mark each exception beside its implementation.

## Security and lifecycle

Preserve restricted Pod Security Admission labels, Namespace `ResourceQuota`
and `LimitRange`, nonroot UID/GID, `RuntimeDefault` seccomp, dropped Linux
capabilities, `allowPrivilegeEscalation=false`, bounded CPU/memory, read-only
root filesystems, and explicitly bounded writable `/home/node` and `/tmp`
volumes. Production and disposable fixture Pods follow the same security model.

Default-deny NetworkPolicies allow a gateway to reach only the authenticated
workload owned by that exact Agent and revision; sibling-Agent, cross-Namespace,
metadata, and Kubernetes API access remain denied. Authenticate Agent readiness
with a real loopback WebSocket handshake.

Use the existing worker queue, claim fencing, IAM reauthorization, lifecycle
hooks, and compare-and-set activation. Preserve the existing gateway,
revision-scoped NetworkPolicies, and serving route while preparing an idle
candidate. Once the candidate is ready, disable the previous serving route
before changing the active pointer. After activation, update the gateway and
policies, then publish the Agent's stable Service to its exact revision before
retiring the prior workload.
Ordinary image startup, missing operator-provisioned tenant authorization, and
incomplete route publication remain pending within the existing convergence
deadline without consuming the failure-attempt budget. Do not add
audit-log-derived phase state, queue checkpoints, cross-driver transactions,
or a zero-downtime guarantee. A failed replacement may be temporarily
unavailable but must fail closed and cannot affect another Agent.

## Verification

- Render and validate the real Helm chart, including ordered initialization,
  separate database credentials, immutable image rejection, private API
  exposure, operator-owned tenant RBAC, and restrictive network policies.
- Apply all reviewed migrations to real PostgreSQL, bootstrap exactly one
  Installation, verify idempotence and identity rejection, and execute real
  production queue work.
- Run real OpenClaw gateways and Codex app-servers; demonstrate two same-
  Namespace Agents keep distinct configurations, Services, credentials, and
  authenticated WebSocket destinations.
- Verify accepted/rejected capability tokens, exact revision activation,
  restricted Pod manifests, and missing-credential failure.
- Report missing disposable Kubernetes/CNI infrastructure explicitly; a skipped
  live-cluster test is not production isolation evidence.

## Manual notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-19]: Reconstructed the production packaging and Agent wireup task.
- [2026-08-20]: Added canonical Helm packaging and authenticated Codex execution.
- [2026-08-21]: Adopted merged Agent-owned gateways and immutable native configuration; removed shared routing, custom migration machinery, and speculative activation phases.
- [2026-08-21]: Defined exclusivity by active routing and Agent turns, permitted idle candidate overlap, and retained the previous workload until replacement routing succeeds.
