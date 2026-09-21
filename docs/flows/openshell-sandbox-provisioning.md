---
created: "2026-09-21"
updated: "2026-09-21"
last_updated_session: "authoring-run/a16c607b-1ddd-4146-a4c7-05b900b65be7"
---

# OpenShell Sandbox provisioning flow

## Overview

The Kubernetes Compute Driver delegates a dedicated Codex Harness to the
selected OpenShell Sandbox Driver. OpenShell prepares namespace-local policy,
receives a workspace-scoped Sandbox request, and owns the resulting Harness
Pod. The regular Agent workflow currently stops before Sandbox creation because
OpenShell `v0.1.0-pre.5` cannot accept the required Secret-backed environment or
projected workload identity.

## Entry Points

- Trigger: a worker reconciles an Agent revision that selects the OpenShell
  Sandbox Driver and Kubernetes Compute Driver.
- Source: `apps/controller/src/drivers/compute/kubernetes/index.ts:ensureNamespace`
- Source: `apps/controller/src/drivers/sandbox/openshell.ts:provisionHarness`
- Source: `apps/controller/src/drivers/sandbox/openshell-gateway-client.ts:createSandbox`
- Assumptions: the Installation selected both Drivers, the tenant Namespace and
  baseline isolation exist, and the namespace-local OpenShell gateway is ready.

## Flow

```mermaid
graph TD
  A["Worker reconciles Agent revision"] --> B["Kubernetes prepares Namespace isolation"]
  B --> C["OpenShell applies policies and checks gateway health"]
  C --> D["Compute derives dedicated Harness requirements"]
  D --> E{"Requirements contain Secret-backed environment?"}
  E -- "yes: regular Codex path" --> F["Driver rejects provisioning; candidate stays inactive"]
  E -- "no" --> G["Client sends workspace-scoped Sandbox request"]
  G --> K{"Gateway supports exact identity and mounts?"}
  K -- "no: stock pre.5" --> F
  K -. "yes: pending upstream support" .-> H["OpenShell creates provider-owned Harness Pod"]
  H --> I["Compute waits for provider Harness readiness"]
  I --> J["Retirement sends workspace-scoped delete request"]
```

## Execution Trace

### 1. Prepare the Namespace and OpenShell gateway boundary

`apps/controller/src/drivers/compute/kubernetes/index.ts:ensureNamespace`

Kubernetes Compute reconciles quota, limits, and baseline NetworkPolicies before
calling `SandboxDriver.ensureNamespace`. OpenShell then applies its configured
namespace-scoped NetworkPolicies, waits for the configured gateway Service and
Pod, and calls the gateway health RPC. A failure returns a failed namespace
result; Compute does not mark the Namespace ready.

### 2. Derive the provider-owned Harness request

`apps/controller/src/drivers/compute/kubernetes/index.ts:prepareRevision`

For a dedicated revision with `provisionHarness`, Compute derives Harness image,
command, labels, environment, workspace mounts, ServiceAccount identity, and
resources from the same Deployment shape used by the regular Kubernetes path.
It passes those requirements and the immutable revision to OpenShell instead of
creating the Deployment itself.

### 3. Validate and serialize the Sandbox

`apps/controller/src/drivers/sandbox/openshell.ts:provisionHarness`

OpenShell accepts only dedicated Codex revisions pinned to the selected Driver.
It builds filesystem, process, and network policy plus Kubernetes driver config.
Network TLS, enforcement, and access spellings are converted to the exact
`v0.1.0-pre.5` protobuf enums.

The regular Codex requirements contain Secret-backed environment entries.
`environment` rejects the first such entry before any gateway mutation, so the
candidate revision remains inactive. Requests without those entries continue to
the gateway client.

### 4. Call the versioned gateway contract

`apps/controller/src/drivers/sandbox/openshell-gateway-client.ts:createSandbox`

The client sends the stable Sandbox name, labels, annotations, spec, and a
`workspace_scope` containing the configured workspace. It maps an OpenShell
`ALREADY_EXISTS` result to the same stable resource reference so worker retries
remain idempotent. Stock `v0.1.0-pre.5` also lacks the exact projected identity
and volume support required by the request, so any request that reaches the
gateway still fails closed. Any other gateway failure also prevents readiness.

### 5. Observe readiness or clean up

`apps/controller/src/drivers/compute/kubernetes/index.ts:prepareRevision`

After a successful create, Compute verifies that the returned reference belongs
to the revision and waits for the provider-owned Harness Pod. On revision
shutdown, `shutdownRevisionRuntime` calls OpenShell cleanup. The gateway client
sends `DeleteSandbox` with the same `workspace_scope`; a missing Sandbox is an
idempotent success. Namespace deletion instead removes OpenShell's configured
NetworkPolicies after revision resources are gone.

## Debugging and Verification

- `node --test tests/integration/ci-openshell.test.mjs` checks bootstrap safety
  and immutable Helm image value rendering without selecting a real cluster.
- `node --test tests/integration/sandbox-driver-startup.test.mjs` checks Driver
  selection and fail-closed configuration behavior.
- `OCC_TEST_OPENSHELL_K3D_REAL=1 node --env-file="$TEST_ENV_FILE" --test tests/integration/sandbox-driver-openshell-k3d-real.test.mjs`
  exercises the selected real gateway and cluster prerequisites. With stock
  `v0.1.0-pre.5`, the expected result is Secret-projection rejection before
  activation; this does not prove a model turn.
- `OpenShell v0.1.0-pre.5 cannot receive secretKeyRef environment ...` identifies
  the current fail-closed boundary.

## Related docs

- [OpenShell Sandbox Driver](../reference/drivers/openshell-sandbox.md)
- [OpenShell tests](../testing/openshell.md)
- [Kubernetes Compute Driver](../reference/drivers/kubernetes-compute.md)
- [Harness execution topology](harness-execution-topology.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-21 08:56: Documented the `v0.1.0-pre.5` workspace-scoped provisioning, fail-closed projection boundary, and cleanup flow. (authoring-run/a16c607b-1ddd-4146-a4c7-05b900b65be7 - aa6dd7415d65ffba5fa40098b2142eb2a7d73df4)
