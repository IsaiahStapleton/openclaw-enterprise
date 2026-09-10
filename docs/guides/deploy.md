# Deploy OpenClaw Enterprise

Start OpenClaw Control Center (OCC), verify authenticated access, then deploy
Agents when you are ready to prove a workload. Run commands from the repository
root. Startup needs no model credential.

Trusted Installation YAML can also select the bundled
[SSH Compute Driver](../reference/drivers/ssh-compute.md) for embedded OpenClaw
on preprovisioned Linux hosts. That reference owns host configuration,
credentials, and operational limits; [SSH raw-host testing](../testing/ssh.md#ssh-raw-hosts)
owns the disposable verification rig. The Compose and Helm procedures below
retain their existing control-plane and Kubernetes packaging boundaries.

## Development

Prerequisites: Docker Engine with Docker Compose, socket access, Bash, `curl`,
Python 3, and a combined local runtime image or permission for the helper to
build `openclaw-enterprise-runtime:quickstart`.

```bash
./scripts/dev-up
```

The helper validates Compose without printing expanded credentials, starts the
database, migration, bootstrap, API, and worker services, privately copies the
initial service-key response, and checks `/installation`. Expected output starts
with `OpenClaw Enterprise development stack is ready.` and includes the loopback
URL, Installation ID, private key path, next check, and cleanup command.

### Verify development

`dev-up` runs this check before reporting success. To run it again, copy the
command under `Check API access again` in the output. It includes your API URL
and service-key file path. You can also set them yourself:

```bash
OCC_URL='http://127.0.0.1:3000' \
  OCC_SERVICE_KEY_FILE='/private/path/initial-admin-service-key.json' \
  scripts/occ-api GET /installation
```

Expect HTTP `200` with `data.id` matching `meta.installationId` in the key
file. This proves controller access, not an Agent deployment or model turn. For
startup internals, see the [Docker development flow](../flows/docker-compose-development.md).

For optional operational log export and Collector metrics, follow
[Configure platform observability](observability.md#docker-compose).

### Open the platform console

Open `/console/` on the API URL printed by `dev-up`, normally
`http://127.0.0.1:3000/console/`. Sign in with the provisioned human account
email and password. Production uses the same `/console/` path on the approved
internal HTTPS origin matching `OCC_AUTH_BASE_URL`; it retains the existing
ClusterIP/network boundary and secure cookie settings.

The browser uses the human administrator session path, not service keys. The
[console reference](../reference/console.md) describes Namespace selection,
Agent creation with editable starter Configuration JSON, Agent draft and revision
inspection, channel draft edits, initial Kubernetes runtime credential provisioning,
deployment, and live workspace-file editing. Rollback, Agent deletion,
Configuration listing, and live gateway health remain API or operator procedures.

## Production

### Production prerequisites

- Explicit Kubernetes context, enforcing NetworkPolicies, Helm, `kubectl`, and
  Python 3.
- `yq` v4 for validating and reading the protected YAML copies.
- Controller and runtime image digests (build them in the first step).
- External PostgreSQL with separate migrator and application roles.
- Operator-managed HTTPS access for approved clients; the chart does not create TLS or Ingress.
- Operator-created startup, database, authentication, optional Provider Secrets,
  fresh protected bootstrap PVC, gateway storage, and exact egress destinations.

### Production installation sequence

Follow these pages in order, keeping the same operator shell and protected inputs:

1. [Build images and install the control plane](deploy/production-installation.md).
   Build and publish immutable controller/runtime images, configure protected
   Installation YAML and Helm values, create system Secrets, prepare the fresh
   bootstrap PVC, install the chart, and authenticate to the production API.
2. [Prepare Namespaces and deploy Agents](deploy/production-agents.md).
   Discover the backing Kubernetes namespace, grant tenant RoleBindings, choose
   embedded OpenClaw or dedicated Codex, provision exact-Agent credentials, and
   deploy an immutable revision.
3. [Verify the production workload](deploy/production-agents.md#verify-production-workloads).
   Confirm the active revision and allowed/denied gateway connections, then
   perform the TUI model-turn proof for token-authenticated gateways.

For private workspace-file administration, configure
[Agent workspace routing](deploy/workspace-routing.md) and use OCC's file API
for the supported trusted-proxy administration path. For operational logs and
Collector health, follow [Configure platform observability](observability.md).

For a disposable local Kubernetes trial, first
[build and import local images](deploy/local-operations.md#build-images-for-local-kubernetes),
then resume the installation sequence with the generated YAML copies.

### Stop or remove a production deployment

Inventory tenant workloads before uninstalling the control plane:

```bash
helm uninstall oce --namespace openclaw-system
```

Helm does not own external PostgreSQL, operator-created Secrets, bootstrap PVCs,
or tenant workloads created by Compute. Retain database, bootstrap storage, and
tenant resources until recovery and retention requirements are satisfied.

For startup failure diagnosis and readiness behavior, see the
[production startup flow](../flows/production-startup.md). For the runtime path
from OCC deployment through native TUI attachment, see the
[production TUI flow](../flows/production-tui.md).

## Customization

Use native surfaces for customization:

- Development: `.env`, Compose environment precedence, and optional Compose
  files passed after `--`.
- Production: extra Helm values files, ordinary Helm overrides, Kubernetes
  manifests, Installation startup YAML, and optional Collector Secrets.
- Runtime images: [`deploy/runtime`](../../deploy/runtime/README.md) for the
  recipe and package-version overrides.
  [Build and publish](deploy/production-installation.md#build-and-publish-production-images) before configuring the digests.
- Settings: [environment and tooling reference](../reference/settings.md).
- Driver contracts: [Kubernetes Compute](../reference/drivers/kubernetes-compute.md),
  [Kubernetes Secret](../reference/drivers/kubernetes-secret.md), and
  [Provider configuration](../reference/providers.md).

Example local override:

```bash
OPENCLAW_DEV_PORT=3100 OCC_DOCKER_RUNTIME_IMAGE=my-runtime:local \
  ./scripts/dev-up --key-output /secure/occ/session-key.json -- -f compose.yaml -f compose.local.yaml
```

If the Installation selects the ChatGPT Provider, create `occ-chatgpt-admin`
with `--from-file=admin-key=/secure/occ/occ-chatgpt-admin-key` and enable the
matching Provider/ServiceAccount Driver settings in native values and
Installation YAML.

## Related

- [Service API keys, rotation, and bootstrap recovery](deploy/service-keys.md).
- [Local Kubernetes, development TUI, and cleanup](deploy/local-operations.md).
- [Configuration and settings](../reference/settings.md).
