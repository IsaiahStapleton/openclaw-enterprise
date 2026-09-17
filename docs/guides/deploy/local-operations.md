# Local Kubernetes and development operations

Build digest-pinned local Kubernetes images, verify Kubernetes TUI access, or
stop the development stack. Run commands from the repository root. Use the
[production deployment sequence](../deploy.md#production) for Namespace and Agent setup.

## Build images for local Kubernetes

This uses the same build/import path as the local Kubernetes tests. Build the
controller from this checkout and one combined OpenClaw/Codex image for both
Installation image slots. Local build digests vary by build and platform, so
read them from the imported images instead of copying a sample digest.

Prerequisites: Docker, k3d, and [yq v4](https://github.com/mikefarah/yq).
Create a disposable single-server cluster without changing your kubeconfig:

```bash
export CLUSTER="occ-images-$(date +%s)"
export OCC_EXAMPLE_DIRECTORY="$(mktemp -d)"
k3d cluster create "$CLUSTER" --servers 1 --agents 0 \
  --api-port 127.0.0.1:0 \
  --kubeconfig-update-default=false --kubeconfig-switch-context=false
k3d kubeconfig get "$CLUSTER" > "$OCC_EXAMPLE_DIRECTORY/kubeconfig"
chmod 600 "$OCC_EXAMPLE_DIRECTORY/kubeconfig"
export KUBECONFIG_FILE="$OCC_EXAMPLE_DIRECTORY/kubeconfig"
export CONTEXT="k3d-$CLUSTER"
```

Build and import the images:

```bash
docker build --target runtime \
  --build-arg NODE_BASE_IMAGE=docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584 \
  -t "localhost/$CLUSTER/controller:local" .
docker build -f deploy/runtime/Dockerfile \
  -t "localhost/$CLUSTER/runtime:local" deploy/runtime
k3d image import "localhost/$CLUSTER/controller:local" \
  "localhost/$CLUSTER/runtime:local" -c "$CLUSTER"
```

Register each imported manifest digest in k3s:

```bash
for role in controller runtime; do
  tag="localhost/$CLUSTER/$role:local"
  digest="$(docker exec "k3d-$CLUSTER-server-0" ctr -n k8s.io images list |
    awk -v image="$tag" '$1 == image { print $3 }')"
  printf '%s\n' "$digest" | grep -Eq '^sha256:[a-f0-9]{64}$' || exit 1
  reference="localhost/$CLUSTER/$role@$digest"
  docker exec "k3d-$CLUSTER-server-0" ctr -n k8s.io images tag "$tag" "$reference"
  if [ "$role" = controller ]; then
    export CONTROLLER_IMAGE="$reference"
  else
    export RUNTIME_IMAGE="$reference"
  fi
done
```

Populate private YAML copies with those references:

```bash
umask 077
cp deploy/examples/production/{values,installation,bootstrap-pvc}.yaml "$OCC_EXAMPLE_DIRECTORY/"
yq -i '.images.controller = strenv(CONTROLLER_IMAGE)' "$OCC_EXAMPLE_DIRECTORY/values.yaml"
yq -i '.drivers.compute.configuration.images.gateway = strenv(RUNTIME_IMAGE) |
  .drivers.compute.configuration.images.agent = strenv(RUNTIME_IMAGE)' "$OCC_EXAMPLE_DIRECTORY/installation.yaml"
printf 'Image-configured examples: %s\n' "$OCC_EXAMPLE_DIRECTORY"
```

These references work in this cluster and retain `requireImmutableDigest: true`.
Use the generated directory in place of `/secure/occ` in the production commands;
keep its image values and kubeconfig instead of copying the templates again.
Set the remaining database, HTTPS, network, and storage inputs for your trial
(k3d's default StorageClass is `local-path`). The images alone do not configure
those dependencies or prove an Agent model turn. When finished with the trial,
run `KUBECONFIG="$KUBECONFIG_FILE" k3d cluster delete "$CLUSTER"`.

## Stop development safely

Run the exact command under `Cleanup` in the `dev-up` output. The Podman form
includes its detected API socket and `compose.podman.yaml`; the Docker form
remains `docker compose down` plus any forwarded global options.

This preserves PostgreSQL, Configuration, and bootstrap-key volumes. Add
`--volumes` only when deliberately deleting the local
Installation after accounting for Agent containers and tenant networks owned by
Docker Compute.

## Development end-to-end TUI

Docker and Podman Compose currently support control-plane startup and Namespace
operations, but their Compute Driver rejects Agent harness authentication
bindings. Agent deployment requires a binding, so the Compose Agent/TUI journey
is unavailable. Exporting `OPENAI_API_KEY` to the worker does not enable it.

For a local authenticated Agent and TUI trial, build the Kubernetes images above,
then follow [production Agent deployment](production-agents.md) and
[production TUI verification](production-agents.md#attach-with-the-openclaw-tui) against that disposable cluster.
Complete the same Secret binding, exact IAM grants, and tenant RoleBindings as
for a production installation.
