---
created: "2026-09-21"
updated: "2026-09-23"
last_updated_session: "authoring-run/dc7a0b75-945c-4091-8600-eb919ad138dd"
---

# OpenShell Sandbox provisioning flow

## Overview

The Kubernetes Compute Driver delegates a dedicated Codex Harness to the
selected OpenShell Sandbox Driver. One deployment-paired OpenShell Gateway uses
an explicitly configured workspace mode. Operator mode is implemented: for each
OCC Namespace, the Driver labels the Kubernetes namespace, reconciles rendered
workspace-chart resources, and creates or adopts an OpenShell Workspace with
the same physical name. Managed mode is recognized but fails before mutation.
Sandbox requests are homed in the operator-mode Workspace.

The regular Agent workflow currently stops before Sandbox creation because
OpenShell `v0.1.0-pre.7` cannot accept the required Secret-backed environment or
projected workload identity.

The local Kubernetes development profile installs the pinned Gateway chart in
`openshell-system`, renders the pinned workspace chart into the Installation
configuration, and lets the Driver reconcile those resources in every
Compute-created namespace. It proves the real Workspace through the Gateway API
and the same supported fail-closed Agent path; it does not use the CI-only
compatibility projection.

## Entry Points

- Trigger: a worker reconciles an Agent revision that selects the OpenShell
  Sandbox Driver and Kubernetes Compute Driver.
- Source: `apps/controller/src/drivers/sandbox/openshell.ts:ensureNamespace`
- Source: `apps/controller/src/drivers/sandbox/openshell.ts:provisionHarness`
- Source: `apps/controller/src/drivers/sandbox/openshell-gateway-client.ts:createSandbox`
- Assumptions: the Installation selected both Drivers, the tenant Namespace and
  baseline isolation exist, and the deployment OpenShell Gateway is ready in
  operator workspace mode.

## Flow

```mermaid
graph TD
  A["Worker reconciles Agent revision"] --> B["Kubernetes prepares Namespace isolation"]
  B --> M{"Configured workspace mode"}
  M -- "managed" --> X["Fail before Kubernetes<br/>or Gateway mutation"]
  M -- "operator" --> C["Label namespace and reconcile<br/>rendered workspace-chart resources"]
  C --> W["Check Gateway health, then create or adopt<br/>the owned OpenShell Workspace"]
  W --> D["Compute derives dedicated Harness requirements"]
  D --> E{"Requirements contain Secret-backed environment?"}
  E -- "yes: regular Codex path" --> F["Driver rejects provisioning; candidate stays inactive"]
  E -- "no" --> G["Client sends Sandbox request<br/>to the Namespace Workspace"]
  G --> K{"Gateway supports exact identity and mounts?"}
  K -- "no: stock pre.7" --> F
  K -. "yes: compatibility proof" .-> H["Create Sandbox and expose app-server port"]
  H --> L["OpenShell returns gateway-routed service URL"]
  L --> M["Test observes protected 401 after OpenShell strips authorization"]
  M --> N["Test runs authenticated model turn on Sandbox loopback"]
  H --> I["Compute waits for provider Harness readiness"]
  I --> J["Revision cleanup deletes the Sandbox"]
  J --> N["Namespace cleanup deletes the Workspace"]
  N --> O["Compute deletes the Kubernetes namespace"]
```

## Execution Trace

### 1. Prepare the Namespace and OpenShell Workspace

`apps/controller/src/drivers/compute/kubernetes/index.ts:ensureNamespace`

Kubernetes Compute reconciles quota, limits, and baseline NetworkPolicies before
calling `SandboxDriver.ensureNamespace`. The Driver first checks
`gateway.workspaceMode`. Managed mode returns an unsupported-mode error before
using the Kubernetes client or Gateway. Operator mode applies the configured
namespace label, workspace-chart resources, and provider NetworkPolicies, in
that order, then calls the Gateway health RPC. If configured, namespace-local
readiness observations happen before that health check; the development
operator instead supplies the central Gateway endpoint directly.

The Driver derives the Workspace name from Compute's physical Kubernetes
namespace name. It reads the Workspace, creates it when missing, or rereads it
after a concurrent `ALREADY_EXISTS`. Adoption requires the expected name, OCC
Namespace ID label, managed-by label, and active phase. Any conflict fails the
Namespace operation. Kubernetes Compute uses `oce-` plus a 15-character digest
so the same name satisfies OpenShell pre.5's 19-character limit.

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
Network TLS, enforcement, and access spellings must be own keys in the Driver's
allowlists before they are converted to the exact `v0.1.0-pre.7` protobuf enums.
The Driver rejects inherited object names instead of allowing them to omit an
explicit enforcement value on the wire. It also rejects the old `passthrough`
TLS spelling because pre.7 defines that enum as an automatic inspection alias;
operators use `skip` for uninspected relay. Each network policy also requires at
least one executable path and sends those binary identities with its endpoints.

The regular Codex requirements contain Secret-backed environment entries.
`environment` rejects the first such entry before any gateway mutation, so the
candidate revision remains inactive. Requests without those entries continue to
the gateway client.

### 4. Call the versioned gateway contract

`apps/controller/src/drivers/sandbox/openshell-gateway-client.ts:createSandbox`

The client sends the stable Sandbox name, labels, annotations, spec, and a
`workspace_scope` containing the configured workspace. It also sends the
revision's UUID as `request_id` and an unnamed `service_exposures` entry for the
literal `APP_SERVER_PORT`. OpenShell registers the endpoint during Create and
returns its URL in `service_urls`; replaying the same Create request returns the
same result. The Driver requires a valid route for the unnamed exposure before
it returns the stable Sandbox reference. A Sandbox that predates the replayable
request fails explicitly rather than receiving a separate post-create mutation.
Stock `v0.1.0-pre.7` still lacks the exact projected identity and volume support
required by the request, including the immutable plugin-runtime ConfigMap
mounted by Kubernetes Compute. Any request that reaches
the gateway without those shapes still fails closed. Any other gateway failure
also prevents readiness.

### 5. Observe readiness or clean up

`apps/controller/src/drivers/compute/kubernetes/index.ts:prepareRevision`

After a successful create, Compute verifies that the returned reference belongs
to the revision and waits for the provider-owned Harness Pod. On revision
shutdown, `shutdownRevisionRuntime` calls `cleanup` with the revision. The Gateway client
sends `DeleteSandbox` with the same `workspace_scope`; a missing Sandbox is an
idempotent success.

The current unified `cleanup` contract receives the immutable revision during
revision shutdown and no revision during Namespace deletion. Namespace deletion
runs it after revision resources are gone.
OpenShell verifies exact Workspace ownership, sends idempotent
`DeleteWorkspace`, and then removes configured workspace-chart resources and
NetworkPolicies in reverse order. A terminating Workspace remains eligible for
retry after a lost response. Only after Sandbox cleanup succeeds does
Kubernetes Compute delete the Kubernetes namespace.

## Debugging and Verification

- `node --test tests/integration/ci-openshell.test.mjs` checks bootstrap safety
  and immutable Helm image value rendering without selecting a real cluster.
- `node --test tests/integration/sandbox-driver-startup.test.mjs` checks Driver
  selection, Workspace ownership, idempotence, and fail-closed configuration.
- `OCC_TEST_DEV_UP_OPENSHELL_REAL=1 node --test tests/integration/dev-up-openshell-k3d-real.test.mjs`
  installs the deployment Gateway, renders the workspace chart, lets the Driver
  apply its resources to bootstrap and post-start Namespaces in a disposable k3d
  cluster, and reads both real OCC-owned Workspaces through the Gateway API.
- `OCC_TEST_OPENSHELL_K3D_REAL=1 node --env-file="$TEST_ENV_FILE" --test tests/integration/sandbox-driver-openshell-k3d-real.test.mjs`
  exercises the selected real gateway and cluster prerequisites. Set
  `OCC_TEST_OPENSHELL_SECRET_PROJECTION=0` for stock `v0.1.0-pre.7`; the expected
  result is Secret-projection rejection before activation, which does not prove
  a model turn. Mode `1` selects a verification-only compatibility path: an
  operator Job stages the exact Secret values, plugin-runtime files, and
  projected workload token in revision-specific PVC subpaths. The provider-owned
  Sandbox exposes its app-server port at create time. The test observes the
  protected app server's `401` response because pre.7 strips its bearer header,
  then runs the real model and tool checks from inside the Pod. This mode proves
  pre.7 containment, exposed-route reachability, and lifecycle behavior. It does
  not prove native workload projection, an authenticated model turn through the
  exposed route, or production Compute gateway-to-agent routing.
- `OpenShell v0.1.0-pre.7 cannot receive secretKeyRef environment ...` identifies
  the current fail-closed boundary.

## Related docs

- [OpenShell Sandbox Driver](../reference/drivers/openshell-sandbox.md)
- [OpenShell tests](../testing/openshell.md)
- [Kubernetes Compute Driver](../reference/drivers/kubernetes-compute.md)
- [Harness execution topology](harness-execution-topology.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-22 17:19: Corrected the pre.7 service-routing boundary: the route reaches the protected app server, but OpenShell strips its bearer authorization, so the real model turn stays on the authenticated Sandbox loopback endpoint. (authoring-run/df798764-b1d9-4722-bccb-4ffe2bbb2980 - a9965e452145e2a5b9677338e75ef008fdf10e06)
- 2026-09-22 16:45: Documented pre.7 create-time app-server exposure, stable Create replay, and the gateway-routed real model turn. (authoring-run/aa808c3e-483e-408b-8915-7017b839c09a - f2b14314188ab7aecdbcbfb465c92868cb4f73a1)
- 2026-09-23 01:52: Documented explicit managed/operator selection and Driver-owned workspace-chart reconciliation before operator Workspace creation. (authoring-run/dc7a0b75-945c-4091-8600-eb919ad138dd - fbaf3e2dfeccbcf2815327d7d5a9aa6643a26cf2)
- 2026-09-23 01:11: Documented operator workspace mode, deployment-paired Gateway ownership, and split Sandbox versus Namespace cleanup. (authoring-run/955359e5-5631-48e4-acc1-a5e32b9ade00 - fbaf3e2dfeccbcf2815327d7d5a9aa6643a26cf2)
- 2026-09-22 18:36: Documented namespace readiness polling and the project-chart development profile that proves the supported fail-closed path. (authoring-run/e7b89de2-9e58-4849-b078-791560cc5d58 - fbaf3e2dfeccbcf2815327d7d5a9aa6643a26cf2)
- 2026-09-21 15:05: Documented binary-scoped pre.5 network policy and the CI-only bootstrap for Secret, plugin-runtime, and workload-identity files. (authoring-run/09cfddeb-9530-40a4-9247-b093d2270929 - 946f5b52587be2720e2a8d3aaf74712f89088d5f)
- 2026-09-21 12:41: Documented own-key network enum validation, the rejected pre.5 `passthrough` alias, and explicit CI projection-mode selection. (authoring-run/180c9046-1da2-444d-ab1d-7d5cf04532e2 - b3a4c00462163edb81cb0588b59a6be8722ffe40)
- 2026-09-21 08:56: Documented the `v0.1.0-pre.5` workspace-scoped provisioning, fail-closed projection boundary, and cleanup flow. (authoring-run/a16c607b-1ddd-4146-a4c7-05b900b65be7 - aa6dd7415d65ffba5fa40098b2142eb2a7d73df4)
