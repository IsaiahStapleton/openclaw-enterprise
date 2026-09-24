# Local Kubernetes development

Run OpenClaw Enterprise (OCE) against a disposable, loopback-only k3d cluster.
The ordinary Kubernetes profile keeps the OpenClaw Control Plane (OCC) in
Compose. The OpenShell profile is Kubernetes-only: PostgreSQL, the OCE API and
worker, OpenShell Gateway, and Agent workloads all run in the owned cluster.

## Start the profile

Install Node.js 24 or newer, the repository-pinned pnpm, the Go version from
`go.mod`, k3d, kubectl, Helm, and either Docker or Podman. The container engine
hosts k3d and builds or imports images; it does not run application services.

For the ordinary Compose-backed Kubernetes Compute profile, build the CLI and
select Kubernetes explicitly:

```bash
pnpm cli:build
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=none
./scripts/dev-up
```

That profile remains useful when changing Kubernetes Compute independently of
OpenShell. It accepts the Compose overrides documented by `occ dev up --help`.

### Start the OpenShell fail-closed profile

For an OpenShell environment, use the owned launcher:

```bash
pnpm cli:build
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
./scripts/dev-up
```

The checkout-local CLI creates one k3d cluster and then:

1. installs the pinned Agent Sandbox controller and OpenShell
   `v0.1.0-pre.7` assets;
2. imports digest-resolved OpenShell, OCE controller, Agent runtime, and
   PostgreSQL images;
3. creates `oce-system` and installs PostgreSQL, OpenShell Gateway, and the OCE
   Helm release there;
4. exposes a labeled development proxy through a loopback-only k3d port map;
5. waits for the bootstrap Namespace and its OpenShell Workspace to become
   ready; and
6. writes the kubeconfig and initial administrator service-key file beneath a
   private state directory.

OpenShell's Agent Sandbox controller remains in its upstream
`agent-sandbox-system` Namespace. Tenant Workspaces, Sandbox resources, and
Agent Pods live in the OCC-owned `oce-*` Namespaces.

The first start requires Helm and network access. To use reviewed local assets
instead, set both `OCC_DEVELOPMENT_OPENSHELL_HELM_CHART` and
`OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART`, plus
`OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST` to absolute paths.

The default state directory is `/tmp/openclaw-development` after resolving any
system temporary-directory alias. Select another private absolute path with
`OCC_DEVELOPMENT_STATE_DIRECTORY`, and use the same value for cleanup. To choose
the host engine explicitly:

```bash
export OCC_DEVELOPMENT_CONTAINER_ENGINE=podman
./scripts/dev-up
```

Use `docker` instead for Docker Engine. The OpenShell profile does not require
Docker Compose or `podman-compose`, and it rejects Compose arguments.

State and credentials are written to the private
`/tmp/openclaw-development` directory by default. Set the absolute
`OCC_DEVELOPMENT_STATE_DIRECTORY` before both startup and cleanup to use
another location. Startup refuses an existing state directory, cluster, or
Compose project. To pick up source changes, [rebuild the running services](#rebuild-after-a-source-edit);
cleanup is for discarding the Installation. The state directory remains mode
`0700`; the generated files
mounted into the non-root controller and worker are container-readable but
remain inaccessible to other host users through that private directory. The
helper does not modify the default kubeconfig or current kubectl context.

For separate stacks, select distinct state directories, Compose projects,
cluster names, and published API ports. Set an unused, non-overlapping
`OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` and a distinct `OCC_POSTGRES_PORT` for each
stack. Startup derives the development bridge gateway from the rendered subnet
unless Compose explicitly supplies one. Generated runtime workloads have a
2 GiB memory limit each; size the local engine VM for OCC plus the Agents you run.
Keep each stack's resources under the helper's lifecycle until cleanup;
do not reuse its names for unrelated resources.

Podman delegates Compose to `podman-compose`. On rootless Linux, its
Docker-compatible API socket must be running so k3d can create the cluster.
Startup resolves the reported socket and supplies it to k3d; it must be
reachable from the host.

## Verify the local boundary

Startup prints the API URL, kubeconfig, Kubernetes context, and service-key file.
Use those paths with other tools without changing the default kubeconfig or
context:

```bash
export KUBECONFIG="<Kubeconfig path printed by scripts/dev-up>"
kubectl get pods -A

export OCC_URL="<API URL printed by scripts/dev-up>"
export OCC_SERVICE_KEY_FILE="<Service key file printed by scripts/dev-up>"
./bin/occ installation get
```

The API is reachable only through the loopback k3d publication. The published
Service selects a dedicated in-cluster proxy whose exact Namespace and Pod
labels are admitted by the OCE Helm NetworkPolicy. The OCE API itself remains a
ClusterIP Service. OCE's worker authenticates to Kubernetes in-cluster and
reaches OpenShell Gateway through a narrow development NetworkPolicy in
`oce-system`. The Gateway uses OpenShell's unauthenticated development mode, so
an ingress policy admits only the OCE worker and OpenShell supervisor Pods from
OCE-owned tenant Namespaces. A matching tenant policy grants Gateway egress only
to supervisor Pods; ordinary Agent and tenant Pods cannot call the Gateway.

Because this cluster is disposable and owned by one development profile, the
helper binds the chart's tenant worker, configuration, and Secret ClusterRoles
to the OCE service accounts cluster-wide. It also lets the worker manage tenant
Roles and RoleBindings while limiting `bind` and `escalate` to the pinned
OpenShell workspace Role. Production and shared clusters must instead create
tenant-local RoleBindings as each Namespace is admitted.

To prove the entire setup and cleanup path in a separate fresh cluster, first
stop the reusable environment and run:

```bash
OCC_TEST_DEV_UP_OPENSHELL_REAL=1 \
  node --test tests/integration/dev-up-openshell-k3d-real.test.mjs
```

The selected real test must pass without a skip. It verifies the Helm-installed
OCE control plane and PostgreSQL Pods, central OpenShell Gateway, bootstrap and
new Namespace Workspace reconciliation, immutable image registration, and
owned-cluster cleanup. It does not create an Agent or perform a model turn.
Follow the [Kubernetes model-turn procedure](../../testing/kubernetes.md#kubernetes-model-turns-and-secrets)
for that separate credentialed proof.

## Configure workspace storage on single-node k3d

Dedicated Agents use a `40Gi` RWO workspace claim. Stock k3d `local-path`
storage supports this mode without a shared-filesystem ConfigMap patch. Gateway
state uses a separate RWO claim. The worker stops the previous revision before
starting its replacement; expect a downtime window during deployment.
See [storage ownership and recovery](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#harness-storage).

Use the kubeconfig and context printed by startup to check the Agent namespace:

```bash
kubectl --kubeconfig '<profile-kubeconfig>' --context '<profile-context>' \
  -n '<agent-kubernetes-namespace>' get pvc,pods
```

Expect the workspace to become `Bound` with access mode `RWO`, followed by a
running Harness Pod. With `WaitForFirstConsumer`, a pending claim before Pod
creation is normal. Existing owned RWX claims are retained; do not delete a claim
or change its access mode to adopt the new default.

### Preserve storage across restarts

Keep the node's `/var/lib/rancher/k3s` volume, which contains workspace files and
K3s state. Normal container restarts retain that volume; cluster deletion, volume
deletion, and profile cleanup can destroy the data. Local-path storage is bound
to its node; adding another node does not replicate existing workspace data.
Use a portable StorageClass if workloads must move between nodes.

The `local-path` StorageClass uses reclaim policy `Delete`, so deleting a claim
also permits deletion of its backing directory. The ordinary profile stores
PostgreSQL in a Compose volume; the OpenShell profile stores it in the owned
cluster. Neither location backs up Agent workspaces. Use a durable private state
directory instead of `/tmp` for a long-lived demo.

## Rebuild after a source edit

The environment registers immutable image digests, so running containers do not
silently pick up source edits. Recreate it after controller, runtime, migration,
Helm, or OpenShell integration changes. Unless an existing controller or runtime
image was selected explicitly, startup rebuilds both images from the current
checkout:

```bash
./scripts/dev-down
./scripts/dev-up
```

Use a different `OCC_DEVELOPMENT_STATE_DIRECTORY`, `OPENCLAW_DEV_PORT`,
`OCC_DEVELOPMENT_KUBERNETES_API_PORT`, and
`OCC_DEVELOPMENT_KUBERNETES_CLUSTER` for each concurrent environment. Startup
refuses an existing state directory or cluster instead of adopting it.

## Stop and clean up

Remove only the cluster and private state recorded by the launcher:

```bash
./scripts/dev-down
```

Cleanup reads the recorded engine endpoint and cluster name. If cluster deletion
fails, it preserves the state directory so the same command can retry without
discovering or deleting an unrelated cluster.

## Limits

Development startup readiness does not prove Agent deployment, model execution,
provider authentication, or dedicated Codex WebSocket execution. OpenShell
startup deliberately proves only its infrastructure and fail-closed boundary.
Other checks require the real-cluster procedures, approved digest-pinned runtime
images, and existing authorized credentials described in the [Kubernetes
testing guide](../../testing/kubernetes.md).

## Gateway placement boundary

Dedicated Gateways use a managed Gateway runtime namespace, separate from the
Harness namespace. The local development profile selects its single k3d server
for Gateway scheduling. This exercises namespace separation on one disposable
node; it does not prove production node isolation. Production must configure
`runtime.gatewayNodeSelector` and `runtime.nodeSelector` for disjoint trusted and
data-plane pools. See [production Namespace preparation](production-agents.md#prepare-each-namespace)
for both scoped RoleBindings.

- This is a development environment, not a production deployment recipe.
- The OpenShell profile installs one control plane and central Gateway per
  cluster. OCC creates tenant resources in separate `oce-*` Namespaces.
- Stock OpenShell `v0.1.0-pre.7` remains fail-closed for unsupported Secret and
  workload-identity projections. Workspace readiness does not prove that an
  Agent Sandbox can start or complete a model turn.
- OpenShell Gateway permits unauthenticated users only inside this disposable,
  loopback-owned cluster profile. Do not carry that setting into a shared
  cluster.
- The development-only cluster-wide tenant bindings are not a production RBAC
  pattern. Production admission must supply the tenant-local RoleBindings
  described by the deployment guide.
