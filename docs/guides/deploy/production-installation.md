# Install the production control plane

Install the OpenClaw Control Plane (OCC) on Kubernetes, then verify
authenticated API access. Prepare [standard Kubernetes](kubernetes.md) or
[Amazon EKS](eks.md) and complete the [production prerequisites](../deploy.md#production-prerequisites)
first. Workspace access is required: install the
[routing prerequisites](workspace-routing.md#requirements), provide a GatewayClass,
and keep routing enabled in both example files. First install the ordinary
password profile with native Agent administration enabled; complete
[native admin prerequisites](native-admin.md#requirements). Optional
[GitHub sign-in](#enable-github-browser-sign-in) later requires disabling it.

Run from the repository root; retain protected files for
[Agent deployment](production-agents.md).

## Use published images

These private `linux/amd64` and `linux/arm64` image indexes were built from `e3b28515f30523eede3cd905e589c1ab9063dbda`.
Startup checks passed on both architectures (ARM64 under QEMU); remote digests
were verified in [publication run 35680912119](https://github.com/openclaw/openclaw-enterprise/actions/runs/35680912119).
These checks do not qualify production deployments.
[Build your own images](#build-and-publish-production-images) to change their contents.

Obtain read access to both GHCR packages. Authenticate with a GitHub personal
access token **(classic)** with
`read:packages`; authorize organization SSO if required. Replace the username
below and enter the token at Docker's password prompt, never in the command. See
[GitHub's registry authentication instructions](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry).

```bash
docker login ghcr.io --username '<your-github-username>'

export CONTROLLER_IMAGE='ghcr.io/openclaw/openclaw-enterprise-controller@sha256:9aa430eb19553a35ccafd5dafff58984ec1264e7c77b1440f56a893cf8e993e1'
export RUNTIME_IMAGE='ghcr.io/openclaw/openclaw-enterprise-runtime@sha256:792f0ffe88ec9f935b55c36f41ee646a828e3d83df21427cf7955a5beef52460'
```

Use the controller for API, worker, migration, and bootstrap; gateways and Agents
share the runtime image. Retain these digests; never substitute `latest` or bootstrap tags.

Configure approved cluster/node pull credentials for **both control-plane and
tenant Pods**; local `docker login` does not authenticate cluster nodes. Continue
at [Configure the Installation](#configure-the-installation) with these exports.

## Build and publish production images

Repository maintainers can use the separately approved
[private container publication workflow](../../../.github/containers.md).
To publish to your own cluster-accessible registry, build and push these images:

| Image      | Source                                                                                                         | Used by                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Controller | Root [`Dockerfile`](../../../Dockerfile), target `runtime`                                                     | API, worker, migration, and bootstrap            |
| Runtime    | [`deploy/runtime/Dockerfile`](../../../deploy/runtime/Dockerfile), assembling pinned OpenClaw source and Codex | Gateways and Agents (the same image serves both) |

With Docker Buildx and registry push access, replace the example registry and
repository and select your Kubernetes nodes’ platform. The base image below
matches the [runtime recipe](../../../deploy/runtime/README.md).

Authenticate the builder with `docker login <registry-host>` and approved
credentials; for private ECR, follow [ECR authentication](eks.md#authenticate-the-image-builder-to-ecr).

The runtime must include enabled channel plugins and their dependencies, usable
from a fresh home directory. The standard recipe packages Slack and Codex.
Before publishing, [verify plugin loading and the gateway's supported Codex app-server version](../../../deploy/runtime/README.md#verify-the-local-image).
Use the same verified image for both slots unless you separately verify the
gateway/Codex pair. This procedure does not install packages at gateway startup.

```bash
# Build from a clean checkout.
export OCC_IMAGE_REGISTRY="${OCC_IMAGE_REGISTRY:-registry.example.com}"
export OCC_IMAGE_REPOSITORY="${OCC_IMAGE_REPOSITORY:-$OCC_IMAGE_REGISTRY/your-team/openclaw-enterprise}"
export OCC_IMAGE_TAG="$(git rev-parse HEAD)"
export OCC_IMAGE_PLATFORM="${OCC_IMAGE_PLATFORM:-linux/amd64}"
export NODE_BASE_IMAGE='docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584'

docker buildx build --push --platform "$OCC_IMAGE_PLATFORM" --target runtime \
  --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" \
  --build-arg OCC_BUILD_REVISION="$OCC_IMAGE_TAG" \
  --label "org.opencontainers.image.revision=$OCC_IMAGE_TAG" \
  -t "$OCC_IMAGE_REPOSITORY/controller:$OCC_IMAGE_TAG" .
docker buildx build --push --platform "$OCC_IMAGE_PLATFORM" \
  --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" \
  -f deploy/runtime/Dockerfile \
  -t "$OCC_IMAGE_REPOSITORY/runtime:$OCC_IMAGE_TAG" .

CONTROLLER_DIGEST="$(docker buildx imagetools inspect \
  "$OCC_IMAGE_REPOSITORY/controller:$OCC_IMAGE_TAG" \
  --format '{{json .Manifest}}' | yq -p=json -r '.digest')"
RUNTIME_DIGEST="$(docker buildx imagetools inspect \
  "$OCC_IMAGE_REPOSITORY/runtime:$OCC_IMAGE_TAG" \
  --format '{{json .Manifest}}' | yq -p=json -r '.digest')"
export CONTROLLER_IMAGE="$OCC_IMAGE_REPOSITORY/controller@$CONTROLLER_DIGEST"
export RUNTIME_IMAGE="$OCC_IMAGE_REPOSITORY/runtime@$RUNTIME_DIGEST"
```

Continue only after both builds and digest lookups succeed. Retain their exports.
Private registries need cluster/node pull credentials for control-plane and tenant Pods;
`docker login` authenticates only the builder.

## Configure the Installation

For a local trial, [build and import the images](local-operations.md#build-images-for-local-kubernetes)
and set `OCC_INPUT_DIRECTORY` to the generated YAML directory. Registry-backed
installs use the digest exports above. Set shell inputs before Kubernetes commands:

```bash
umask 077
export OCC_INPUT_DIRECTORY="${OCC_INPUT_DIRECTORY:-/secure/occ}"
export KUBECONFIG_FILE="$OCC_INPUT_DIRECTORY/kubeconfig"
: "${CONTEXT:?Set the reviewed Kubernetes context from your cluster guide}"
install -d -m 700 "$OCC_INPUT_DIRECTORY"
install -d -m 700 /secure/occ
test -e "$OCC_INPUT_DIRECTORY/values.yaml" || \
  install -m 600 deploy/examples/production/values.yaml "$OCC_INPUT_DIRECTORY/values.yaml"
test -e "$OCC_INPUT_DIRECTORY/installation.yaml" || \
  install -m 600 deploy/examples/production/installation.yaml "$OCC_INPUT_DIRECTORY/installation.yaml"
test -e "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml" || \
  install -m 600 deploy/examples/production/bootstrap-pvc.yaml "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
chmod 600 "$KUBECONFIG_FILE" "$OCC_INPUT_DIRECTORY/values.yaml" \
  "$OCC_INPUT_DIRECTORY/installation.yaml" "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
```

Verify Kubernetes 1.35+:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" version
```

Older servers continue but remain unsupported; API and worker emit
`compute.preflight-warning`.

The examples use native API keys. Helm values configure OCC; Installation YAML
configures Drivers, runtime images, identity, networking, storage, and logging.
For logging changes and required restarts, see
[Choose the log level](../observability.md#1-choose-the-log-level).

For registry-backed installations, write image digests into the protected copies:

```bash
: "${CONTROLLER_IMAGE:?Set the controller digest reference}"
: "${RUNTIME_IMAGE:?Set the runtime digest reference}"
yq -i '.images.controller = strenv(CONTROLLER_IMAGE)' "$OCC_INPUT_DIRECTORY/values.yaml"
yq -i '.drivers.compute.configuration.images.gateway = strenv(RUNTIME_IMAGE) |
  .drivers.compute.configuration.images.agent = strenv(RUNTIME_IMAGE)' \
  "$OCC_INPUT_DIRECTORY/installation.yaml"
```

Edit the protected YAML copies:

- `$OCC_INPUT_DIRECTORY/values.yaml`: set `images.controller`,
  `auth.baseUrl`, `bootstrap.adminEmail`, `database.cidrs`, `cluster.cidrs`,
  `controlPlane.nodeSelector`, `database.caSecretName`, `dns`, `api.clients`, and
  `bootstrap.password.claimName`. Configure `agentNativeAdmin` domains and ingress
  through [native admin setup](native-admin.md#steps), retaining `enabled: true`
  for the ordinary password profile.
  Keep `gatewayRouting.enabled: true`, set
  `gatewayRouting.gatewayClassName` to your GatewayClass, and retain the example
  Secret names and keys; otherwise update the Secret creation commands below.
- `$OCC_INPUT_DIRECTORY/installation.yaml`: set `occ.cluster`, `logging.level`,
  `drivers.compute.configuration.images` digests, DNS selectors, matching
  `gatewayRouting` settings, service-principal token settings, Secret
  prefixes, and `runtime.gatewayStorageClassName`. Keep
  `drivers.compute.configuration.images.requireImmutableDigest: true`.
  Set `runtime.gatewayNodeSelector` (trusted) and `runtime.nodeSelector` (Harness)
  to disjoint Ready pools; Helm does not place runtimes.
  Do not set `network.gatewayClients` with routing enabled; Compute derives the
  Envoy peer from `gatewayRouting`.
  If enabling Agent plugins, set one compatible bundled `drivers.plugin` selector
  and any required Codex catalog-reader configuration. See the
  [PluginDriver reference](../../reference/drivers/plugin.md#selection-and-catalogs).
  If the default syscall policy blocks Codex user namespaces, follow
  [Codex sandbox setup](codex-sandbox.md): install a reviewed profile on every
  eligible node, set `runtime.codexSeccompProfile` to its relative kubelet path,
  and verify sandbox enforcement.
  Set `presets.includeDefaults: false` to disable the example's
  [bundled Presets](../../reference/presets.md#installation-defaults).
- `$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml`: set the bootstrap PVC name,
  namespace, size, and protected `storageClassName` for the cluster.

Run every check below, including Helm rendering, before provisioning
the password profile. API startup checks shared-cookie domain compatibility:

```bash
yq e -e '.images.controller | test("@sha256:[a-f0-9]{64}$")' \
  "$OCC_INPUT_DIRECTORY/values.yaml" >/dev/null
yq e -e '.auth.baseUrl != "" and .bootstrap.adminEmail != "" and
  (.database.cidrs | length > 0) and (.cluster.cidrs | length > 0) and
  (.controlPlane.nodeSelector | length > 0) and
  (.api.clients | length > 0) and .gatewayRouting.enabled == true and
  .gatewayRouting.gatewayClassName != "" and
  .gatewayRouting.apiKeySecretName != "" and .agentNativeAdmin.enabled == true' \
  "$OCC_INPUT_DIRECTORY/values.yaml" >/dev/null
yq e -e '.drivers.compute.configuration.images.requireImmutableDigest == true and
  (.drivers.compute.configuration.images.gateway | test("@sha256:[a-f0-9]{64}$")) and
  (.drivers.compute.configuration.images.agent | test("@sha256:[a-f0-9]{64}$")) and
  .drivers.compute.configuration.runtime.gatewayStorageClassName != "" and
  (.drivers.compute.configuration.runtime.gatewayNodeSelector | length > 0) and
  (.drivers.compute.configuration.runtime.nodeSelector | length > 0)' \
  "$OCC_INPUT_DIRECTORY/installation.yaml" >/dev/null
yq e -e '.metadata.namespace == "openclaw-system" and .spec.storageClassName != ""' \
  "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml" >/dev/null
helm template oce deploy/helm/openclaw-enterprise \
  --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
  >/tmp/oce-rendered.yaml
export CONTROLLER_IMAGE="$(yq e -r '.images.controller' "$OCC_INPUT_DIRECTORY/values.yaml")"
export BOOTSTRAP_CLAIM="$(yq e -r '.bootstrap.password.claimName' "$OCC_INPUT_DIRECTORY/values.yaml")"
test "$BOOTSTRAP_CLAIM" = "$(yq e -r '.metadata.name' "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml")"
```

`$KUBECONFIG_FILE` must select the same cluster as `$CONTEXT`.

Prepare these Secret inputs under `/secure/occ`, each containing one raw value
without quotes or a variable assignment.

| File                  | Contents and source                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `occ-application-url` | PostgreSQL connection URL for the limited application role, used by bootstrap, the API, and the worker. Obtain it from your database administrator or provider. Example shape: `postgresql://occ_app:<url-encoded-password>@<postgres-host>:5432/<database>`.                   |
| `occ-migration-url`   | Connection URL for a separate role allowed to apply schema migrations. It targets the same database. Example shape: `postgresql://occ_migrator:<url-encoded-password>@<postgres-host>:5432/<database>`. Obtain this credential separately; do not give it to the API or worker. |
| `occ-database-ca.pem` | Optional PostgreSQL root CA bundle when the database root is not in the base image trust store. Required only when `database.caSecretName` is set; the example mount path is `/etc/openclaw/database-ca/ca.pem`.                                                                |
| `occ-auth-secret`     | A random secret used to sign and verify user sessions. Generate it once for this Installation with the command below, then retain it across redeployments. It is separate from the administrator password, service API key, and model-provider key.                             |

Save both database URLs in protected files, replacing placeholders and preserving
required TLS options. For managed PostgreSQL roots supplied through `database.caSecretName`,
set `sslmode=verify-full` and `sslrootcert` to the mounted CA file in both URLs.
With the example mount settings, the path is `/etc/openclaw/database-ca/ca.pem`;
if you change them, use `<database.caMountPath>/<database.caKey>`. Introduce URL
query parameters with `?`, or join them to existing parameters with `&`. Generate the auth secret for a new Installation; this command refuses
to overwrite an existing file:

```bash
(
  umask 077
  set -C
  openssl rand -hex 32 > /secure/occ/occ-auth-secret
)
chmod 600 /secure/occ/occ-application-url /secure/occ/occ-migration-url \
  /secure/occ/occ-auth-secret
test -s /secure/occ/occ-application-url
test -s /secure/occ/occ-migration-url
export DATABASE_CA_SECRET="$(yq e -r '.database.caSecretName // ""' "$OCC_INPUT_DIRECTORY/values.yaml")"
export DATABASE_CA_KEY="$(yq e -r '.database.caKey // "ca.pem"' "$OCC_INPUT_DIRECTORY/values.yaml")"
if [ -n "$DATABASE_CA_SECRET" ]; then
  chmod 600 /secure/occ/occ-database-ca.pem
  test -s /secure/occ/occ-database-ca.pem
fi
```

Keep these values out of Helm values, Installation YAML, Configurations, shell
history, and this repository.

## Prepare workspace access

Create the controller namespace:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" create namespace openclaw-system
```

Complete [Configure private routing](workspace-routing.md#configure-private-routing):
create `occ-private-gateway-key` and match the Helm and Installation routing
settings. Rerun validation and rendering above if inputs change. Configure each
Agent's authentication during [Agent deployment](production-agents.md#configure-the-agent-runtime).

## Provision system Secrets and install

Create the remaining system Secrets from protected files:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  apply --dry-run=server -f /tmp/oce-rendered.yaml
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  apply --dry-run=server -f "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-installation-startup --from-file=installation.yaml="$OCC_INPUT_DIRECTORY/installation.yaml"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-database --from-file=application-url=/secure/occ/occ-application-url --from-file=migration-url=/secure/occ/occ-migration-url
if [ -n "$DATABASE_CA_SECRET" ]; then
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
    create secret generic "$DATABASE_CA_SECRET" \
    --from-file="$DATABASE_CA_KEY=/secure/occ/occ-database-ca.pem"
fi
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-auth --from-file=secret=/secure/occ/occ-auth-secret
```

These operator-owned Secrets are not synchronized automatically. The optional CA
Secret mounts read-only in migration, bootstrap, API, and worker containers;
PostgreSQL URLs still select `sslrootcert`.

### Optional repository credential service

Enable repository credentials only after preparing the
[repository service inputs](../repository-credentials/installation.md) and the matching
[GitHub Backend selection](../../reference/backends.md#github-repository-credentials).
The feature defaults disabled. It requires a separately built, immutable service
image, an immutable registry ConfigMap, private service configuration, App key,
TLS certificate/key for the exact internal Service hostname, and a separate
public-CA Secret. Mount the same registry version into API, worker, and service.
The Installation's Compute network peer must select this release's worker Pod on
port `8443`; the Service exposes HTTPS port `443`.

The chart runs one `Recreate` worker Pod with a credential sidecar. Only the
sidecar receives App/TLS private inputs; only the worker receives the Kubernetes
API token. API and worker receive the registry and public CA. The private control
socket is shared only by worker and service. Verify the rendered mounts through
the installation guide.

The service's `limits.shutdownGraceMs` must be at most `60000` (the default).
Projected startup rejects longer drains so the service can report unresolved
cleanup before the Pod's fixed 75-second termination grace expires.

Tenant-worker RoleBindings grant Secret `get/list/create/delete`; Kubernetes
RBAC cannot restrict those verbs by Compute's ownership labels. The worker is
trusted within each bound tenant namespace. Agent service accounts receive no
Secret API permission. NetworkPolicies apply to the whole worker Pod;
registry/session checks enforce exact Namespace and repository scope.

Restart API and worker together after replacing registry or service inputs.
Readiness proves private control availability; verify token minting, provider
reachability, and Agent Git operations separately.

### Azure PostgreSQL workload identity

For [Azure workload-identity database authentication](../../reference/settings/operations.md#postgresql-connection-authentication),
use password-free URLs with verified TLS in the database URL files above.
Prepare the identity environment variables and a renewed federation-token
projection for each connecting process: migration, bootstrap, API, and worker.
Provision federation and database grants for separate application and migrator
identities; keep the migrator privileges confined to migration. Use
`node scripts/migrate-production.mjs` for this authentication mode.

These are deployment-owned inputs. The supplied chart does not configure Azure
identities, federation, grants, identity environment variables, or token
projection for OCC. Its migration and bootstrap containers share an
initialization Pod and service account; changing database URL Secrets alone
does not configure their distinct identity inputs or enable Azure mode.

### Optional operational log export

Prepare optional Collector Secrets, values, and verification through
[Configure platform observability](../observability.md#kubernetes-and-helm).

### Prepare the fresh bootstrap output PVC

Create the fresh claim from the native example, then prepare the mounted root
with the same immutable Node-capable image selected for the controller:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n openclaw-system apply -f "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"

scripts/prepare-bootstrap-volume --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  --namespace openclaw-system --claim "$BOOTSTRAP_CLAIM" --image "$CONTROLLER_IMAGE" \
  --node-selector oce-role=control
```

Replace `--node-selector oce-role=control` with the same labels selected by
`controlPlane.nodeSelector`; repeat the option for multiple labels so preparation
and initialization can use the same volume topology.

The helper refuses any nonfresh mounted root except filesystem-owned
`lost+found`, schedules the preparation Pod with any supplied `--node-selector`
labels before storage binds, reports `Prepared bootstrap volume claim ... with
UID/GID 1000 mode 0700.` on success, and retains a failed Pod for diagnosis. If policy
forbids the preparation Pod, have the storage administrator create the same root
state through the approved storage workflow.

Install the chart with native values:

```bash
helm upgrade --install oce deploy/helm/openclaw-enterprise \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" \
  --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
  --wait --timeout 5m
```

Helm owns migration and bootstrap ordering through its initialization hook.
Readiness covers the API and worker probes. It does not prove authenticated API
access, Agent deployment, or a model turn.

## Authenticate to the production API

Retrieve `initial-admin-service-key.json` from the protected bootstrap PVC
through approved storage access and retain it privately. This example preserves
existing shell values and creates a separate session copy:

```bash
export OCC_URL="${OCC_URL:-https://<internal-occ-host>}"
export OCC_BOOTSTRAP_KEY_FILE="${OCC_BOOTSTRAP_KEY_FILE:-/secure/occ/initial-admin-service-key.json}"
umask 077
prepare_occ_service_key() {
  local working_directory
  unset OCC_SERVICE_KEY_FILE OCC_SERVICE_KEY_DIRECTORY
  if [ -z "${OCC_BOOTSTRAP_KEY_FILE:-}" ] || [ -z "${OCC_URL:-}" ]; then
    printf '%s\n' 'Set the production URL and retained bootstrap key first.' >&2
    return 1
  fi
  if ! working_directory="$(mktemp -d /tmp/occ-service-key.XXXXXXXX)"; then
    printf '%s\n' 'Could not create the working key directory; stop here.' >&2
    return 1
  fi
  if ! install -m 600 "$OCC_BOOTSTRAP_KEY_FILE" "$working_directory/occ-service-key.json"; then
    rm -f -- "$working_directory/occ-service-key.json"
    rmdir -- "$working_directory"
    printf '%s\n' 'Could not create the working key copy; stop here.' >&2
    return 1
  fi
  if ! OCC_SERVICE_KEY_FILE="$working_directory/occ-service-key.json" occ installation get; then
    rm -f -- "$working_directory/occ-service-key.json"
    rmdir -- "$working_directory"
    printf '%s\n' 'Could not authenticate; the temporary key copy was removed. Stop here.' >&2
    return 1
  fi
  export OCC_SERVICE_KEY_DIRECTORY="$working_directory"
  export OCC_SERVICE_KEY_FILE="$working_directory/occ-service-key.json"
}
prepare_occ_service_key
```

Expect the displayed `ID` to match the key file's
`meta.installationId`. Before the first image update, use that ID to
[bind upgrades to this Kubernetes Installation](production-upgrade.md#bind-the-installation-once).
API and worker cannot read the bootstrap PVC. Keep the protected source because
initialization does not reissue a lost key. The
[operator cleanup](production-agents.md#end-the-operator-session) removes the
session copy.

After authentication, follow [Namespace and Agent deployment](production-agents.md),
including its [model-response check](production-agents.md#verify-production-workloads).

For later releases, follow the
[production image upgrade](production-upgrade.md).

## Enable GitHub browser sign-in

The published controller lacks GitHub sign-in; [build a compatible image](#build-and-publish-production-images).
Follow the [single-controller profile](../../reference/authentication.md#github-sign-in-for-existing-accounts)
during stopped maintenance. Installation is two-phase: install without GitHub as
above, then enable it with `helm upgrade`.

Activation is one-way: the database refuses older images' sessions and
`auth.github` must stay set. Never `helm rollback` past activation
([rollback](production-upgrade.md#roll-back-across-human-sign-in));
[stopped maintenance](auth-maintenance.md) deactivates it.

1. Verify password recovery. Register
   the GitHub App callback and protect its **client ID** (not App ID) and secret
   as the [reference](../../reference/authentication.md#github-sign-in-for-existing-accounts) describes.
   Signed in as the recovery administrator, read `data.user.id` from
   `GET /api/auth/session`.
2. Create the Secret, then set `auth.github.enabled: true`, that ID as
   `auth.recoveryUserId`, and `agentNativeAdmin.enabled: false` in protected
   values, keeping workspace routing. Optionally narrow `auth.github.egressCidrs` or set `api.trustedProxy`
   ([settings](../../reference/settings/production.md#github-sign-in-and-trusted-proxies)). Rerender.

   ```bash
   kubectl -n openclaw-system create secret generic occ-github-login \
     --from-file=client-id=/secure/occ/github-client-id \
     --from-file=client-secret=/secure/occ/github-client-secret
   ```

3. Close ingress. Disable automatic restarts and policy/provisioning writers,
   and drain admitted requests.
4. Run `helm upgrade` with the compatible image. The api Deployment uses
   `Recreate`, so the old Pod stops first; startup enrolls qualifying accounts, logs any it skips,
   and invalidates unbound sessions before serving. After a failure, keep ingress closed.
5. Through restricted access, verify password recovery, new session admission,
   the expected Namespaces and existing Agent detail, and rejected stale sessions.
   Reopen ingress only after these checks, retaining one serving controller.

For enrollment, obtain the numeric subject with `gh api user --jq .id` authenticated
as the intended GitHub user; verify ownership through your identity process, not
email or usernames. Follow the reference's attachment and unknown-outcome handling.
Loopback tests do not qualify production stop/drain, cookies, logging, or GitHub registration.

## Related

Continue with [production Agent deployment](production-agents.md), or use the
[production image upgrade](production-upgrade.md) for an existing release. For failed
initialization, preserve state and follow [bootstrap recovery](../../reference/authentication/service-api-keys.md#recover-an-incomplete-bootstrap)
and the [production startup flow](../../flows/production-startup.md).

[Connect default metrics and logs](../observability.md) to your collectors. The
[optional demo stack](../observability/demo.md) is not recommended for production.
