---
created: "2026-09-21"
updated: 2026-09-28
last_updated_session: authoring-run/3d7564e8-24cd-4cb3-9584-efce1cc55bd6
---

# OpenShell Sandbox provisioning flow

## Overview

The Kubernetes Compute Driver delegates dedicated Codex and native OpenClaw
Harnesses to the selected OpenShell Sandbox Driver. One deployment-paired OpenShell Gateway uses
an explicitly configured workspace mode. Operator mode is implemented: for each
OCC Namespace, the Driver labels the Kubernetes namespace, reconciles rendered
workspace-chart resources, and creates or adopts an OpenShell Workspace with
the same physical name. Managed mode is recognized but fails before mutation.
Sandbox requests are homed in the operator-mode Workspace.

The model credential no longer needs a Secret projection: a
[credential source](credential-source-lifecycle.md) attaches an OpenShell
provider to the Sandbox, and the supervisor proxy injects the key. The regular
Agent workflow with stock OpenShell still stops before Sandbox creation because
`v0.1.0` cannot accept the Secret-backed app-server token or projected workload
identity. The verification-only compatibility path stages those inputs without
changing the production fail-closed contract and completes successive real
model turns from two sessions inside one
AgentRevision Sandbox.

The local Kubernetes development profile installs the pinned Gateway and
renders the workspace chart into the Installation configuration, in either a
Kubernetes-only or Compose control plane. Neither uses the verification-only
compatibility projection.

## Entry Points

- Trigger: a worker reconciles an Agent revision that selects the OpenShell
  Sandbox Driver and Kubernetes Compute Driver.
- Source: `apps/controller/src/drivers/sandbox/openshell.ts:ensureNamespace`
- Source: `apps/controller/src/drivers/sandbox/openshell.ts:provisionHarness`
- Source: `apps/controller/src/drivers/compute/kubernetes/index.ts:prepareRevision`
- Assumptions: the Installation selected Kubernetes Compute, the OpenShell
  Sandbox, and the OpenShell Credential Gateway through one `openshell` Backend;
  the tenant Namespace and baseline isolation exist; and the Gateway is ready in
  operator workspace mode.

## Flow

```mermaid
graph TD
  A["<b>Reconcile revision</b><br/>Worker selects Drivers"] --> B["<b>Prepare Namespace</b><br/>Kubernetes isolation"]
  B --> C{"<b>Workspace mode</b><br/>Installation setting"}
  C -- "managed" --> X["<b>Reject configuration</b><br/>Before mutation"]
  C -- "operator" --> D["<b>Reconcile resources</b><br/>Labels and workspace chart"]
  D --> E["<b>Own Workspace</b><br/>Create or adopt"]
  E --> F["<b>Derive Harness</b><br/>Compute requirements"]
  F --> Q["<b>Attach sources</b><br/>attachForRevision"]
  Q --> G{"<b>Secret environment</b><br/>App-server token?"}
  G -- "yes" --> R["<b>Reject provisioning</b><br/>Candidate stays inactive"]
  G -- "no" --> H["<b>Create Sandbox</b><br/>Providers and exposure"]
  H --> I{"<b>Native projections</b><br/>Supported?"}
  I -- "no: stock v0.1.0" --> R
  I -. "verification bridge" .-> V{"<b>Harness</b><br/>Selected runtime"}
  V -- "Codex" --> J["<b>Sandbox ready</b><br/>App-server route"]
  J --> K["<b>Verify route</b><br/>Protected 401"]
  K --> L["<b>Run model turn</b><br/>Sandbox loopback"]
  V -- "OpenClaw" --> T["<b>Sandbox ready</b><br/>No inbound exposure"]
  T --> U["<b>Run two sessions</b><br/>Successive retained workers"]
  J --> M["<b>Wait for Harness</b><br/>Compute readiness"]
  M --> S{"<b>Attachment status</b><br/>All ready?"}
  S -- "failed, withheld, revoked" --> R
  S -- "ready" --> N["<b>Delete Sandbox</b><br/>Revision cleanup"]
  T --> M
  N --> O["<b>Delete Workspace</b><br/>Namespace cleanup"]
  O --> P["<b>Delete Namespace</b><br/>Compute cleanup"]

  classDef state fill:#EDF2F7,stroke:#879AB0,color:#25364A,stroke-width:1px
  classDef operation fill:#EBF3F0,stroke:#7F9D93,color:#2B4038,stroke-width:1px
  classDef gate fill:#F7F1E5,stroke:#B3A078,color:#514532,stroke-width:1px
  classDef blocked fill:#F3F4F6,stroke:#98A2AE,color:#44505F,stroke-width:1px
  class A,B,F state
  class D,E,Q,H,J,K,L,M,N,O,P,T,U operation
  class C,G,I,S,V gate
  class X,R blocked
  linkStyle default stroke:#8B949E,stroke-width:1px
```

## Execution Trace

### 0. Create the development control plane

`scripts/dev-up`, `internal/occdev/openshell_k3d.go:upK3d`,
`internal/occdev/openshell.go:prepareOpenShell`,
`internal/occdev/kubernetes.go:writeInstallation`

The written Installation declares the `openshell` Backend with the Gateway
endpoint, the Sandbox, and a Credential Gateway whose `binaries` list holds the
native Codex executable. The Sandbox policy has no model-egress rule; the
credential source's provider profile supplies it.

The environment selects Kubernetes Compute and OpenShell. `scripts/dev-up`
validates that combination and delegates lifecycle ownership to `occ dev up`.
The control plane defaults to Compose; `OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes`
selects the Kubernetes-only profile. Both verify the `v0.1.0` source archive
before packaging its Gateway and Workspace charts, and import the matching
digest-pinned Gateway, Sandbox, and supervisor images. The launcher supplies v0.1.0's separate
image registry, repository, and digest values for each component and omits the
NetworkPolicy acknowledgement removed from that chart.
The CLI records the exact engine endpoint, cluster,
platform Namespace, API port, and key destination before creating resources.
The Kubernetes-only mode creates k3d without a Compose network, imports the OCE controller, Agent
runtime, PostgreSQL, and three OpenShell images, and resolves their in-cluster
digests. Unless the developer selects existing images explicitly, startup
rebuilds the controller and Agent runtime from the current checkout before
importing them.

`installKubernetesControlPlane` creates protected PostgreSQL and bootstrap PVCs,
runs migration and bootstrap through the production OCE Helm chart, and deploys
the API and worker in `oce-system`. The Installation selects in-cluster
Kubernetes authentication and the central Gateway's ClusterIP DNS name. A
labeled development proxy is the API NetworkPolicy's only local client; k3d
publishes its NodePort on host loopback. A separate development NetworkPolicy
admits the OCE API, which registers providers, and the worker to the Gateway. The Gateway ingress policy also admits
OpenShell supervisor Pods, but only from OCE-owned tenant namespaces. In each
tenant namespace, the callback egress policy selects only Pods carrying the
OpenShell managed-by and supervisor boundary labels. Other tenant Pods cannot
reach the Gateway even though this disposable profile enables OpenShell's
unauthenticated development mode. Because the cluster is disposable, the helper
also binds the Helm chart's tenant roles to the OCE service accounts for all
Namespaces. A development ClusterRole lets the worker manage the workspace Role
and RoleBinding, with `bind` and `escalate` limited to the pinned OpenShell
workspace Role. Production retains operator-owned tenant-local RoleBindings.
Startup copies the generated service key
through a temporary PVC reader Pod, verifies it against the live Installation,
and removes the reader.

Cleanup validates the private state and recorded engine endpoint before deleting
the named cluster. The Kubernetes-only state contains no Compose snapshot, and
the cleanup path never calls a Compose provider.

In Compose mode, `internal/occdev/up.go:Up` starts PostgreSQL, migration, and
bootstrap before creating k3d on the private Compose network. It installs the
Gateway in `openshell-system` with a fixed NodePort, writes kubeconfig-based
Driver configuration, and starts the API and Kubernetes worker in Compose. The
worker reaches the Gateway through the owned container network. Cleanup stops
the reconcilers, deletes the cluster, removes the recorded Compose project and
volumes, and retains recovery state if any step fails.

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
so the same name satisfies OpenShell v0.1.0's 19-character limit.

### 2. Derive the provider-owned Harness request

`apps/controller/src/drivers/compute/kubernetes/index.ts:prepareRevision`

For a dedicated revision with `provisionHarness`, Compute derives Harness image,
command, labels, environment, workspace mounts, ServiceAccount identity, and
resources from the same Deployment shape used by the regular Kubernetes path.
For a `credential_source` revision it renders only `CODEX_LOGIN_MODE=api_key`,
no model Secret, and calls `CredentialGatewayDriver.attachForRevision`. The
attachments, one provider name per source, go into
`requirements.credentialAttachments`. Compute passes those requirements and the
immutable revision to OpenShell instead of creating the Deployment itself.

### 3. Validate and serialize the Sandbox

`apps/controller/src/drivers/sandbox/openshell.ts:provisionHarness`

OpenShell accepts only dedicated Codex or OpenClaw revisions pinned to the selected Driver.
It builds filesystem, process, and network policy plus Kubernetes driver config.
Network TLS, enforcement, and access spellings must be own keys in the Driver's
allowlists before they are converted to the exact `v0.1.0` protobuf enums.
It rejects inherited object names and the old `passthrough` TLS spelling,
which v0.1.0 defines as an automatic inspection alias; use `skip` instead. Each network policy also requires at
least one executable path and sends those binary identities with its endpoints.

The regular Harness requirements still contain the Secret-backed
`APP_SERVER_TOKEN`. `environment` rejects it before any gateway mutation, so the
candidate revision remains inactive. Requests without such entries continue.
`sandboxProviders` appends each attachment to the static `providers` list and
rejects a name outside the OCC `oce-cs-` shape or one that repeats a static
provider. The development profile and real-runtime fixture bind the provider
profile to the exact native Codex executable in the runtime image's pnpm tree.
A dependency-layout change must update that path; a stale one fails the Codex
startup model probe.

The verification-only v0.1.0 Gateway permits caller driver configuration and
disables OpenShell resource admission so the compatibility request can attach
OCE-owned PVCs without OpenShell approval labels. The Enterprise Driver still
limits the request to the Harness mounts approved by Kubernetes Compute. The
stock fail-closed path never reaches this Gateway setting, and production does
not use this compatibility configuration.

OpenShell supplies the provider placeholder and its interception CA paths when
it starts the Harness. The native OpenClaw authentication probe preserves
`NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` in its restricted child environment,
so the broker can terminate TLS and substitute the credential. After the probe,
the native worker combines the OpenShell CA with the private Gateway enrollment
CA before starting `connect --ephemeral`; replacing either CA would break model
egress or the Gateway connection.

### 4. Call the versioned gateway contract

`apps/controller/src/drivers/sandbox/openshell-gateway-client.ts:createSandbox`

The client sends the Sandbox identity, spec, Namespace Workspace scope, and
revision UUID as `request_id`. Codex requests one unnamed exposure for
`APP_SERVER_PORT`; OpenShell returns its `service_urls` entry. Native OpenClaw
requests no exposure because its worker connects outbound, so only that request
may omit the URL map and must reject an unexpected URL. A replay returns the
same result. A Sandbox that predates replayable Codex creation fails instead of
receiving a separate mutation. The verification configuration pins the native
node to two session slots inside its one AgentRevision Sandbox.

Stock `v0.1.0` still lacks the exact projected identity and volume support
required by the request, including the immutable plugin-runtime ConfigMap
mounted by Kubernetes Compute. Any request that reaches
the gateway without those shapes still fails closed. Any other gateway failure
also prevents readiness.

For private node routing, OpenShell's policy proxy opens the connection from its
supervisor Pod rather than the Harness Pod. The Helm-owned Envoy NetworkPolicy
therefore admits supervisor Pods only from tenant namespaces bearing the exact
Gateway attachment label. OpenShell still restricts the destination and calling
binary through the Sandbox network policy.

### 5. Observe readiness or clean up

`apps/controller/src/drivers/compute/kubernetes/index.ts:prepareRevision`

After a successful create, Compute verifies that the returned reference belongs
to the revision and waits for the provider-owned Harness Pod. For bound
sources it then calls `attachmentStatus`, which reads
`GetSandboxProviderStatus`. `pending` or a missing status retries; `failed`,
`withheld`, `revoked`, or `absent` fails the revision; only `ready` for every
attachment completes preparation. On revision
shutdown, `shutdownRevisionRuntime` calls `cleanup` with the revision. The
Gateway client sends `DeleteSandbox` with the same `workspace_scope`; a missing
Sandbox is an idempotent success.

The current unified `cleanup` contract receives the immutable revision during
revision shutdown and no revision during Namespace deletion. Namespace deletion
runs it after revision resources are gone. OpenShell verifies exact Workspace
ownership, sends idempotent
`DeleteWorkspace`, and then removes configured workspace-chart resources and
NetworkPolicies in reverse order. A terminating Workspace remains eligible for
retry after a lost response. Only after Sandbox cleanup succeeds does
Kubernetes Compute delete the Kubernetes namespace.

## Debugging and Verification

- `OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell ./scripts/dev-up`
  creates the reusable Kubernetes-only development environment: PostgreSQL, the
  Helm-installed OCE control plane, and the central Gateway share `oce-system`;
  tenant resources remain in OCC-owned Namespaces. `scripts/dev-down` removes
  only the recorded cluster and private state.
- Use the default `OCC_DEVELOPMENT_CONTROL_PLANE=compose` to keep PostgreSQL
  and OCC in Compose while retaining the same k3d Compute, operator Workspace,
  and fail-closed Agent boundaries.
- `node --test tests/integration/ci-openshell.test.mjs` checks bootstrap safety
  and immutable Helm image value rendering without selecting a real cluster.
- `node --test tests/integration/sandbox-driver-startup.test.mjs` checks Driver
  selection, Workspace ownership, idempotence, and fail-closed configuration.
- `OCC_TEST_DEV_UP_OPENSHELL_REAL=1 node --test tests/integration/dev-up-openshell-k3d-real.test.mjs`
  installs the deployment Gateway, renders the workspace chart, lets the Driver
  apply its resources to bootstrap and post-start Namespaces in a disposable k3d
  cluster, and reads both real OCC-owned Workspaces through the Gateway API.
- `OCC_TEST_DEV_UP_OPENSHELL_COMPOSE_REAL=1 node --test tests/integration/dev-up-openshell-k3d-real.test.mjs`
  runs the Compose control-plane profile against a disposable real k3d cluster,
  reads its operator-mode Workspace through the Gateway API, and exercises
  recorded Compose and cluster cleanup.
- `OCC_TEST_OPENSHELL_K3D_REAL=1 node --env-file="$TEST_ENV_FILE" --test tests/integration/sandbox-driver-openshell-k3d-real.test.mjs`
  exercises the selected real gateway and cluster prerequisites. Set
  `OCC_TEST_OPENSHELL_SECRET_PROJECTION=0` for stock `v0.1.0`; the expected
  result is `APP_SERVER_TOKEN` projection rejection before activation, which
  does not prove a model turn. Both modes register an `openai` credential source
  through the API. Mode `1` selects a verification-only compatibility path: an
  operator Job stages the app-server token, plugin-runtime files, and projected
  workload token in revision-specific PVC subpaths, never the model key. The
  test asserts that Harness processes hold only the OpenShell placeholder. The provider-owned
  Sandbox exposes its app-server port at create time. The test observes the
  protected app server's authentication rejection because v0.1.0 strips its bearer header,
  then runs the real model and tool checks from inside the Pod. This mode proves
  v0.1.0 containment, the Compute-created node route, Helm NetworkPolicy
  enforcement, exposed-route reachability, and lifecycle behavior. It does not
  prove native workload projection or an authenticated model turn through the
  exposed route. The tested runtime uses the OpenClaw source commit pinned by
  `deploy/runtime/Dockerfile`; that source provides the native worker's
  environment-managed `connect --ephemeral` path and the Codex workspace-node's
  `--pair-if-needed` and `--commands` options required by the test.
- `OpenShell v0.1.0 cannot receive secretKeyRef environment APP_SERVER_TOKEN ...`
  identifies the current fail-closed boundary.
- Set `OCC_TEST_OPENSHELL_HARNESS=openclaw` to replace the Codex route and
  loopback checks with successive native worker model turns from two session
  keys through one outbound Gateway connection and verification that no inbound
  Harness service exists.

## Related docs

- [OpenShell Sandbox Driver](../reference/drivers/openshell-sandbox.md) and [OpenShell Credential Gateway](../reference/drivers/openshell-credential-gateway.md)
- [Credential source lifecycle](credential-source-lifecycle.md)
- [OpenShell tests](../testing/openshell.md)
- [Kubernetes Compute Driver](../reference/drivers/kubernetes-compute.md)
- [Harness execution topology](harness-execution-topology.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-25..28 (#440): full-facet native OpenClaw provisioning, outbound-only Harness without a service URL map, ephemeral enrollment, two-session capacity and OpenShell broker CA trust.
- 2026-09-26..28 (#461, #512): shared `openshell` Backend, credential-source attachments before activation, and Compose defaults with Kubernetes-only startup.
- 2026-09-24..25 (#398, #433, #435): OpenShell v0.1.0 pin, selectable Compose control plane and restricted development Gateway.
- 2026-09-21..23 (#272, #301): pre.5/pre.7 workspace-scoped provisioning, operator Workspace mode and the fail-closed projection boundary.
- Earlier per-change history is in `git log -- docs/flows/openshell-sandbox-provisioning.md`.
