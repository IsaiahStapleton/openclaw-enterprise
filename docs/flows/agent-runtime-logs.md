---
created: 2026-09-30
updated: 2026-09-30
last_updated_session: build-2/agent-logs-slice-2
---

# Agent runtime logs flow

## Overview

An authorized reader requests Pod status or one page of container output for an
admitted Agent revision. OpenClaw Control Plane (OCC) authorizes the exact target,
asks the selected Compute Driver for raw Kubernetes data, and returns only
classified, redacted, bounded records. Nothing is stored or exported.

## Entry Points

- Trigger: `GET /namespaces/:namespaceId/agents/:agentId/deployments/:deploymentId/runtime`
  and `GET .../runtime/logs` (optionally `download=true`) from the console Logs
  tab, `occ agent runtime|logs` (`internal/occcli/cli.go`) or the API.
- Source: `apps/controller/src/index.ts:createFastifyApp`,
  `packages/occ/src/index.ts:OpenClawController.describeAgentRuntime` and
  `readAgentRuntimeLogs`, `packages/occ/src/runtime-logs/`, and
  `apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.describeAgentRuntime`
  and `readAgentRuntimeLogs`.
- Assumptions: `deploymentId` is an admitted AgentRevision ID. Status needs exact
  Agent `operate` and `read` plus AgentRevision `read`; log text needs Agent
  `administer` instead of `operate`.

## Flow

```mermaid
graph TD
  A["GET runtime or runtime/logs"] --> B["Feature switch and rate limit"]
  B -->|off| C["Return 501"]
  B -->|limited| D["Return 429 with Retry-After"]
  B -->|admitted| E["OCC authorizes revision and Agent tier"]
  E -->|denied| F["Audit denial, return 403"]
  E -->|authorized| G["Select recorded Compute Driver"]
  G -->|no method or driver-owned logging| C
  G -->|supported| H["Driver lists revision Pods and Pod Events per plane"]
  H --> I["OCC validates and redacts the description"]
  I -->|status route| J["Return runtime description"]
  I -->|logs route| K["Validate cursor and listed Pod"]
  K -->|invalid| L["Return 400"]
  K -->|new view or download| M["Write view or download audit event"]
  M -->|failed| N["Return 503, no content"]
  M -->|written| O["Driver reads bounded container log and re-reads Pod"]
  K -->|cursor poll| O
  O --> P["De-duplicate, label gaps, classify and redact"]
  P --> Q["Return sanitized page and signed cursor"]
  P -->|download=true| R["Return the same records as a text/plain attachment"]
```

## Execution Trace

### 1. Admit and authorize

`packages/contracts/src/api/routes.ts:occApiRoutes` declares both GET routes with
a closed query schema. `apps/controller/src/index.ts:perform` answers `501` when
`agentRuntimeLogs` is disabled and applies the replica-local
`apps/controller/src/http/runtime-logs.ts:RuntimeLogLimiter`.
`OpenClawController.runtimeLogTarget` authorizes revision `read`, the tier action
and Agent `read`, then rejects a Driver without `describeAgentRuntime` or with
`runtimeLogging: "driver"`.

### 2. Describe the runtime

`KubernetesComputeDriver.describeAgentRuntime` resolves the owned Namespace, then
lists Pods by the exact Agent, revision and workload-role labels: dedicated
Gateways in the control-plane Gateway namespace, Harnesses and embedded Gateways
in the tenant namespace on the execution plane. It lists Events by
`involvedObject.uid`, keeps only that Pod's Events and caps them at 100. A log
read passes `{ source, events: false }`, so it lists only that source's Pods and
no Events. Each
Kubernetes call has a five-second deadline; a `403` becomes
`RuntimeLogsForbiddenByClusterError`. `runtime-logs/description.ts:validRuntimeDescription`
checks names, UIDs and counts, masks node, image and Secret names in Event
messages (`runtime-logs/redact.ts:maskRuntimeEventText`) and redacts reasons and
Event messages.

### 3. Read one page

`runtime-logs/read.ts:readRuntimeLogPage` verifies the HMAC cursor
(`runtime-logs/cursor.ts`) against the principal, Agent, revision and source,
and accepts only a Pod the description listed. A request without a cursor, or
with one older than an hour, or a cursor whose Pod is gone, starts a view: the controller appends
`openclaw.agents.runtime_logs.view` before any log read. The Driver re-checks
Pod ownership, calls `readNamespacedPodLog` with `tailLines`, `sinceSeconds`,
`previous`, a 1 MiB `limitBytes` and timestamps, and re-reads the Pod. OCC
drops lines already delivered at the cursor time, emits `stream_replaced`,
`window_exceeded`, `cursor_expired` or `truncated` gaps, and passes the rest to
`runtime-logs/sanitize.ts:sanitizeRuntimeLogChunk`, the only producer of
`SanitizedRuntimeLogRecord`.

A download (`download=true`) forces `tailLines` to 1000, rejects a `cursor` with
`400`, and always starts a new view; `apps/controller/src/index.ts:auditAction`
names its audit event, and any denial, `openclaw.agents.runtime_logs.download`.

### 4. Return

`apps/controller/src/http/runtime-logs.ts:runtimeLogPageBody` accepts only
sanitized records and fails on the reserved `content` class.
`runtimeLogDownloadBody` serializes the same branded records as text lines with
the same check, and `runtimeLogDownloadFileName` names the attachment
`<agent>-<revision>-<source>-<pod>.log`. The console filters
(`apps/controller/src/console/agents/logs.mjs`) run only over loaded rows; the
CLI's `--follow` loop re-sends the cursor every 2 seconds. Driver errors map to
fixed `RUNTIME_LOGS_*` codes; the whole request has a ten-second deadline.

## Debugging and Verification

- `503 RUNTIME_LOGS_CLUSTER_RBAC` means the API ServiceAccount lacks
  `pods/log`, `events` or, on an execution cluster, `pods` reads in that
  namespace. `503 RUNTIME_LOGS_AUDIT_UNAVAILABLE` means no output was read.
- `tests/conformance/runtime-logs-content.test.mjs` plants credentials, prompts
  and protocol lines through the real handler; `occ-api-security.test.mjs` covers
  tiers, cursors and failures; `kubernetes-compute.test.mjs` covers plane
  selection, Event filtering and the typed `403`. These use in-memory Kubernetes
  responses; `agent-runtime-logs-k3d-real.test.mjs` reads a real cluster.

## Related docs

- [Agent logs guide](../guides/topics/agent-logs.md)
- [Console and API runtime log reads](../reference/security.md#console-and-api-runtime-log-reads)
- [Compute Driver runtime status and logs](../reference/drivers/compute.md#optional-runtime-status-and-logs)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-30 08:30: Document runtime status and container log reads for Kubernetes Compute. (build-1/agent-logs-slice-1 - 0918be781)
- 2026-09-30 11:40: Add downloads, console filters and the `occ agent runtime|logs` callers. (build-2/agent-logs-slice-2)
