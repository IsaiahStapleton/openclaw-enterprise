# Deploy OpenClaw Enterprise

Run OpenClaw Control Center (OCC), its database, and its worker in one of two
supported environments:

| Environment                 | Deployment                                           | API access                                            |
| --------------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| [Development](#development) | Docker Compose with PostgreSQL and Docker Compute    | Host loopback only                                    |
| [Production](#production)   | Helm with external PostgreSQL and Kubernetes Compute | Private API behind an operator-managed HTTPS endpoint |

Run repository commands from the checkout root. For the smallest local setup
and first authenticated request, use the [quickstart](quickstart.md).

## Development

### Development prerequisites

- Docker Engine with Docker Compose and permission to access its socket.
- A local OpenClaw/Codex runtime image already loaded or pulled into that
  Engine. For a public Docker-only build, use
  [`deploy/runtime`](../../deploy/runtime/README.md). The worker checks runtime
  image references at startup; it does not fetch them.
- `curl` for the authenticated API check and Python 3 for JSON handling.
- An interactive terminal for attaching the OpenClaw TUI.
- An existing `OPENAI_API_KEY` only when deploying an Agent that makes model
  calls. Starting OCC and reading its Installation does not require a model key.

The gateway image must provide Node 24.15+, `/app/openclaw.mjs`, bundled
OpenClaw skills at `/app/skills`, and the OpenClaw Codex plugin discoverable by
the gateway. The Agent image must provide Node 24.15+, `codex` on `PATH`, and
the Codex app-server runtime. The checked-in runtime recipe builds one combined
image that provides both surfaces from public packages:
`openclaw@2026.7.1`, `@openclaw/codex@2026.7.1-1`, and
`@openai/codex@0.147.0`.
The [Docker Compute reference](../reference/drivers/docker-compute.md) describes
the supported runtime boundary.

The worker receives the host Docker socket and runs as root in this local
stack. Treat the worker and its images as having control of that Docker host.
Do not expose the development API, database ports, or Docker socket publicly.

### Configure and start development

Create `.env` only when it does not already exist; preserve existing settings:

```bash
umask 077
test -f .env || cp .env.example .env
```

For the public quickstart image, build the recipe and set one shared runtime
image in `.env`:

```bash
docker build -f deploy/runtime/Dockerfile \
  --tag openclaw-enterprise-runtime:quickstart \
  deploy/runtime
```

```dotenv
OCC_DOCKER_RUNTIME_IMAGE=openclaw-enterprise-runtime:quickstart
```

Alternatively, set `OCC_DOCKER_GATEWAY_IMAGE` and `OCC_DOCKER_AGENT_IMAGE` when
you intentionally use separate images. The individual image variables override
the shared image. Keep an existing provider credential in your environment or
protected `.env` when needed; do not print expanded Compose configuration
containing credentials.

The defaults are API port `3000`, database port `55432`, administrator
`admin@openclaw.local`, and password `openclaw-development-password`. Set
`OPENCLAW_DEV_PORT`, `OCC_POSTGRES_PORT`, `OPENCLAW_DEV_EMAIL`, and
`OPENCLAW_DEV_PASSWORD` before first startup to override them. Use these default
credentials only on the loopback development stack. See
[settings](../reference/settings.md) for the complete environment reference.

```bash
docker compose config --quiet
docker compose up --build -d
docker compose ps -a
docker compose logs --tail=50 controller worker
```

Compose builds the controller image, starts PostgreSQL, initializes the
database, then starts the API and worker. On an empty database, the API creates
the administrator and singleton Installation automatically. Do not submit a
second bootstrap request.

PostgreSQL and native Configuration documents live in separate named volumes.
Restarting with those volumes preserves the Installation, administrator,
configuration, and revision history. Changing `OPENCLAW_DEV_PASSWORD` after
bootstrap does not change the stored account password.

### Verify development

Expect the `migrate` service to exit successfully, PostgreSQL and the controller
to be healthy, and the worker to remain running. Logs should contain API
`listening`, then `worker.started` with Compute Driver
`compute-docker-development`, followed by `worker.health`. Follow
[quickstart sign-in](quickstart.md#sign-in-and-read-the-installation) to verify
that a real session can read `/installation`; the Compose health probe alone
does not verify login or a model turn.

| Symptom                                     | Check                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Controller or worker exits immediately      | Inspect its `startup-error` or `worker.startup-error` log; confirm both images are configured.             |
| Worker cannot find an image                 | Load or pull that approved image into the same Docker Engine before restarting the worker.                 |
| Docker access denied                        | Verify the worker's socket mount and Engine permissions; never add the socket to the API.                  |
| Sign-in returns `401` after changing `.env` | Use the existing database's account password; bootstrap does not rotate it.                                |
| API port or bridge conflicts                | Select a free `OPENCLAW_DEV_PORT` or nonoverlapping `OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` before starting. |

For execution order and source links, see the
[development startup flow](../flows/development-startup.md). Live Agent
verification is described in the [Docker Compose flow](../flows/docker-compose-development.md).

### Development end-to-end TUI

After completing the [quickstart sign-in](quickstart.md#sign-in-and-read-the-installation),
reuse that private session cookie to provision one embedded OpenClaw Agent,
wait for its Docker runtime, then attach the OpenClaw terminal UI (TUI) inside
the Agent-owned gateway container. The TUI uses the gateway configuration and
token already injected by the Docker Compute Driver, so do not pass gateway
tokens, API keys, `--url`, or `--token` on the command line.

The runtime image must be `openclaw-enterprise-runtime:quickstart`, built from
[`deploy/runtime`](../../deploy/runtime/README.md). The checked-in recipe pins
OpenClaw `2026.7.1`, `@openclaw/codex` `2026.7.1-1`, and Codex `0.147.0`.
The example defaults to the exact GPT-5.6 Sol API model ID `gpt-5.6-sol`;
set `OCC_E2E_MODEL` before the configuration step only when your
`OPENAI_API_KEY` is authorized for another model.
The
[OpenAI GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
documents `gpt-5.6-sol` as the provider model ID; OpenClaw Configuration uses
`openai/gpt-5.6-sol` for embedded OpenClaw and `codex/gpt-5.6-sol` for
dedicated Codex.

Make the model credential available to the worker before deploying an Agent:

```bash
: "${OCC_URL:?Run the quickstart sign-in block first.}"
: "${OCC_SESSION_COOKIE_JAR:?Run the quickstart sign-in block first.}"

cleanup_occ_e2e() {
  set +e
  local sign_out_rc=0
  if [ -n "${OCC_SESSION_COOKIE_JAR:-}" ] && [ -f "$OCC_SESSION_COOKIE_JAR" ]; then
    curl --fail-with-body --max-time 15 --silent --show-error \
      --cookie "$OCC_SESSION_COOKIE_JAR" --cookie-jar "$OCC_SESSION_COOKIE_JAR" \
      --request POST "$OCC_URL/api/auth/sign-out" --output /dev/null
    sign_out_rc="$?"
    if [ "$sign_out_rc" -ne 0 ]; then
      echo "OCC sign-out failed; local cookie will be removed, but the server session may still be active." >&2
    fi
    OCC_COOKIE_DIRECTORY="$(dirname "$OCC_SESSION_COOKIE_JAR")"
    rm -- "$OCC_SESSION_COOKIE_JAR"
    rmdir -- "$OCC_COOKIE_DIRECTORY" 2>/dev/null
  fi
  if [ -n "${OCC_E2E_DIRECTORY:-}" ] && [ -d "$OCC_E2E_DIRECTORY" ]; then
    rm -- "$OCC_E2E_DIRECTORY/namespace.json" \
      "$OCC_E2E_DIRECTORY/configuration.json" \
      "$OCC_E2E_DIRECTORY/agent.json" 2>/dev/null
    rmdir -- "$OCC_E2E_DIRECTORY" 2>/dev/null
  fi
  set -e
  return "$sign_out_rc"
}
trap 'cleanup_occ_e2e || true' EXIT

docker compose up -d --force-recreate worker
if ! docker compose exec -T worker \
  node -e 'process.exit((process.env.OPENAI_API_KEY || "").trim() ? 0 : 1)'; then
  echo "Worker does not see OPENAI_API_KEY; set it in the Compose-starting shell or protected .env, then recreate the worker." >&2
  exit 1
fi
```

Recreate the worker when it was already running without the key. Docker Compose
passes the Compose-starting environment and protected `.env` values to the
worker; the worker injects the model credential only into the embedded
gateway/Harness container that makes the model call.

From the same shell used for the quickstart sign-in, create a small API helper.
Protected OCC requests use the existing session cookie and every response must
be the documented `{ "data": ..., "meta": ... }` envelope:

```bash
set -euo pipefail

: "${OCC_URL:?Run the quickstart sign-in block first.}"
: "${OCC_SESSION_COOKIE_JAR:?Run the quickstart sign-in block first.}"

export OCC_E2E_MODEL="${OCC_E2E_MODEL:-gpt-5.6-sol}"
export OCC_E2E_NAME="tui-$(date +%Y%m%d%H%M%S)"
OCC_E2E_DIRECTORY="$(mktemp -d)"

json_get() {
  python3 -c '
import json
import sys

value = json.load(sys.stdin)
for part in sys.argv[1].split("."):
    value = value[part]
print(value)
' "$1"
}

occ_request() {
  local method="$1"
  local request_path="$2"
  local body_file="${3:-}"
  local response_file
  local http_status
  local curl_rc

  response_file="$(mktemp)"
  set +e
  if [ -n "$body_file" ]; then
    http_status="$(curl --fail-with-body --max-time 30 \
      --silent --show-error --write-out '%{http_code}' \
      --output "$response_file" \
      --cookie "$OCC_SESSION_COOKIE_JAR" \
      --request "$method" "$OCC_URL$request_path" \
      -H 'Content-Type: application/json' \
      --data-binary @"$body_file")"
    curl_rc="$?"
  else
    http_status="$(curl --fail-with-body --max-time 30 \
      --silent --show-error --write-out '%{http_code}' \
      --output "$response_file" \
      --cookie "$OCC_SESSION_COOKIE_JAR" \
      --request "$method" "$OCC_URL$request_path")"
    curl_rc="$?"
  fi
  set -e

  set +e
  python3 - "$http_status" "$curl_rc" "$response_file" <<'PY'
import json
import pathlib
import sys

http_status = int(sys.argv[1])
curl_rc = int(sys.argv[2])
body = pathlib.Path(sys.argv[3]).read_text()
try:
    payload = json.loads(body)
except json.JSONDecodeError:
    print(body, file=sys.stderr)
    raise SystemExit(1)

if http_status < 200 or http_status >= 300:
    print(json.dumps(payload, indent=2), file=sys.stderr)
    raise SystemExit(f"HTTP {http_status or 'unavailable'}")
if curl_rc != 0:
    raise SystemExit(f"curl failed with exit {curl_rc}")

if "data" not in payload or "meta" not in payload:
    print(json.dumps(payload, indent=2), file=sys.stderr)
    raise SystemExit("OCC response did not include data and meta")

print(json.dumps(payload))
PY
  local rc="$?"
  set -e
  rm -- "$response_file"
  if [ "$rc" -ne 0 ]; then
    cleanup_occ_e2e || true
    return "$rc"
  fi
  return "$rc"
}
```

Create a Namespace and wait until Docker Compute has provisioned its owned
network. Stop on `failed` or `deleting`; a Namespace that is still
`provisioning` is not ready for deployment:

```bash
python3 - "$OCC_E2E_NAME" > "$OCC_E2E_DIRECTORY/namespace.json" <<'PY'
import json
import sys

print(json.dumps({"name": f"{sys.argv[1]}-namespace"}))
PY

NAMESPACE_RESPONSE="$(occ_request POST /namespaces "$OCC_E2E_DIRECTORY/namespace.json")"
NAMESPACE_ID="$(printf '%s' "$NAMESPACE_RESPONSE" | json_get data.id)"
export NAMESPACE_ID

wait_for_namespace_ready() {
  local deadline="$((SECONDS + 180))"
  local response
  local namespace_status

  while [ "$SECONDS" -lt "$deadline" ]; do
    response="$(occ_request GET "/namespaces/$NAMESPACE_ID")"
    namespace_status="$(printf '%s' "$response" | json_get data.status)"
    case "$namespace_status" in
      ready)
        printf '%s' "$response"
        return 0
        ;;
      failed|deleting)
        printf '%s\n' "$response" >&2
        cleanup_occ_e2e || true
        return 1
        ;;
    esac
    sleep 2
  done

  printf '%s\n' "$response" >&2
  echo "Timed out waiting for Namespace $NAMESPACE_ID to become ready." >&2
  cleanup_occ_e2e || true
  return 1
}

wait_for_namespace_ready > /dev/null
```

Create the native Configuration from the same shape used by the real Docker
integration helper. Keep `${OPENCLAW_GATEWAY_TOKEN}` literal; the Docker
runtime resolves it from the gateway container environment. The model
credential is not part of this payload. `skipBootstrap` keeps a fresh demo
session focused on the model prompt instead of the packaged onboarding message:

```bash
python3 > "$OCC_E2E_DIRECTORY/configuration.json" <<'PY'
import json
import os

model = os.environ["OCC_E2E_MODEL"]
model_ref = f"openai/{model}"
payload = {
    "kind": "agent",
    "values": {
        "gateway": {
            "mode": "local",
            "bind": "lan",
            "controlUi": {"enabled": False},
            "auth": {"mode": "token", "token": "${OPENCLAW_GATEWAY_TOKEN}"},
            "http": {"endpoints": {"chatCompletions": {"enabled": True}}},
        },
        "agents": {
            "defaults": {
                "model": model_ref,
                "skipBootstrap": True,
                "models": {model_ref: {"agentRuntime": {"id": "openclaw"}}},
            }
        },
        "models": {
            "providers": {
                "openai": {
                    "baseUrl": "https://api.openai.com/v1",
                    "api": "openai-responses",
                    "models": [{"id": model, "name": model}],
                }
            }
        },
    },
}
print(json.dumps(payload))
PY

CONFIGURATION_RESPONSE="$(
  occ_request POST "/namespaces/$NAMESPACE_ID/configurations" \
    "$OCC_E2E_DIRECTORY/configuration.json"
)"
CONFIGURATION_ID="$(printf '%s' "$CONFIGURATION_RESPONSE" | json_get data.id)"
export CONFIGURATION_ID
```

Create the Agent, deploy it, and wait until the admitted immutable revision is
the Agent's `activeRevisionId`. The bodyless deploy returning HTTP `202` means
the worker accepted reconciliation work; it does not prove that messaging is
ready:

```bash
python3 > "$OCC_E2E_DIRECTORY/agent.json" <<'PY'
import json
import os

payload = {
    "name": f"{os.environ['OCC_E2E_NAME']}-agent",
    "configurationId": os.environ["CONFIGURATION_ID"],
    "executionMode": "embedded",
}
print(json.dumps(payload))
PY

AGENT_RESPONSE="$(
  occ_request POST "/namespaces/$NAMESPACE_ID/agents" \
    "$OCC_E2E_DIRECTORY/agent.json"
)"
AGENT_ID="$(printf '%s' "$AGENT_RESPONSE" | json_get data.id)"
export AGENT_ID

REVISION_RESPONSE="$(occ_request POST "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/deploy")"
REVISION_ID="$(printf '%s' "$REVISION_RESPONSE" | json_get data.id)"
export REVISION_ID

wait_for_agent_active() {
  local deadline="$((SECONDS + 240))"
  local response
  local active_revision

  while [ "$SECONDS" -lt "$deadline" ]; do
    response="$(occ_request GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID")"
    active_revision="$(printf '%s' "$response" | json_get data.activeRevisionId 2>/dev/null || true)"
    if [ "$active_revision" = "$REVISION_ID" ]; then
      printf '%s' "$response"
      return 0
    fi
    sleep 2
  done

  printf '%s\n' "$response" >&2
  echo "Timed out waiting for Agent $AGENT_ID to activate revision $REVISION_ID." >&2
  cleanup_occ_e2e || true
  return 1
}

wait_for_agent_active > /dev/null
```

Discover exactly one running gateway container by the Docker labels owned by
this Namespace, Agent, and active revision. Missing, multiple, or foreign
matches mean the guide must stop before attaching a client:

```bash
if ! GATEWAY_CONTAINER_IDS="$(docker ps -q \
    --filter label=org.openclaw.enterprise.managed=true \
    --filter label=org.openclaw.enterprise.compute-driver=docker \
    --filter label=org.openclaw.enterprise.namespace-id="$NAMESPACE_ID" \
    --filter label=org.openclaw.enterprise.agent-id="$AGENT_ID" \
    --filter label=org.openclaw.enterprise.revision-id="$REVISION_ID" \
    --filter label=org.openclaw.enterprise.role=gateway
  )"; then
  cleanup_occ_e2e || true
  exit 1
fi
export GATEWAY_CONTAINER_IDS

if ! GATEWAY_CONTAINER="$(
  python3 - <<'PY'
import os
import sys

ids = [line.strip() for line in os.environ["GATEWAY_CONTAINER_IDS"].splitlines() if line.strip()]
if len(ids) != 1:
    print(f"Expected exactly one owned gateway container, found {len(ids)}.", file=sys.stderr)
    raise SystemExit(1)
print(ids[0])
PY
)"; then
  cleanup_occ_e2e || true
  exit 1
fi
export GATEWAY_CONTAINER

if ! docker inspect --format '{{.Id}} {{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' \
    "$GATEWAY_CONTAINER"; then
  cleanup_occ_e2e || true
  exit 1
fi
```

Revoke the OCC session, remove the private cookie, and clear temporary request
files before launching the TUI. The TUI authenticates through the Agent gateway,
not through the OCC API:

```bash
cleanup_occ_e2e
trap - EXIT
```

Launch the TUI from a dedicated terminal. It inherits
`OPENCLAW_CONFIG_PATH`, `OPENCLAW_GATEWAY_PORT`, and
`OPENCLAW_GATEWAY_TOKEN` from the gateway container and stores client state in
container-local `/tmp` instead of the host's personal OpenClaw state:

```bash
export E2E_SESSION="occ-tui-$OCC_E2E_NAME"
export NONCE="OCC_TUI_$(date +%s)"
export SECOND_NONCE="OCC_TUI_FOLLOWUP_$(date +%s)"
printf 'After the first reply, send this in the same TUI: Reply exactly: %s\n' "$SECOND_NONCE"

docker exec -it -e OPENCLAW_STATE_DIR=/tmp/occ-tui-client \
  "$GATEWAY_CONTAINER" node /app/openclaw.mjs tui \
  --session "$E2E_SESSION" --message "Reply exactly: $NONCE"
```

The first `--message` sends the initial prompt and leaves the TUI open. Verify
that the assistant replies with `$NONCE`, then type the printed follow-up prompt
in the same TUI process and verify the assistant replies with `$SECOND_NONCE`.
Use Ctrl+D to exit the client after the second reply. Ctrl+D exits only the
TUI; the Agent gateway remains running. To attach again, rediscover the active
container with the label block above.

Do not use `--local`, `chat`, or `terminal` for this proof; those commands
select local execution in the pinned runtime. If pairing or gateway
authentication fails, keep the error and container labels for diagnosis instead
of adding local state or extracting tokens. For optional HTTP diagnostics, use
the loopback gateway checks in the
[Docker Compose development flow](../flows/docker-compose-development.md#debugging-and-verification).

### Stop development safely

```bash
docker compose down
```

This stops the Compose services and preserves both named data volumes. It does
not remove Agent containers and tenant networks created separately by Docker
Compute. Inspect resources carrying
`org.openclaw.enterprise.compute-driver=docker` and their exact Namespace and
Agent ownership before any manual cleanup. Do not run a broad Docker prune.
`docker compose down --volumes` permanently deletes this stack's database and
Configuration volumes; use it only when deliberately discarding the entire
local Installation, after separately accounting for its runtime workloads.

## Production

Deploy the private controller, worker, and per-Agent runtimes with
[`deploy/helm/openclaw-enterprise`](../../deploy/helm/openclaw-enterprise).
This path requires independently prepared images, credentials, networking,
and storage; development defaults are not production configuration.

### Production prerequisites

- A dedicated Kubernetes cluster with enforcing NetworkPolicies and external
  PostgreSQL.
- Docker for image builds, host Node.js 24+ for local image smoke tests, Helm
  and `kubectl` for the explicitly selected cluster, and `curl` plus Python 3
  for the sign-in example.
- An operator-managed HTTPS endpoint that forwards to the private API from an
  approved client Pod. The chart does not install an Ingress or TLS endpoint.
- Separately approved immutable controller, OpenClaw gateway, and Codex Agent
  image digests. Interactive TUI attachment runs another Node process inside
  the selected gateway Pod, so size gateway limits for both the serving gateway
  and the temporary operator client. Use at least `1Gi` memory in the
  interactive proof environment.
- Operator-created Secrets for PostgreSQL application and initialization
  credentials, the trusted Installation startup YAML, and Better Auth signing
  material.
- An operator-created protected PersistentVolumeClaim for the generated
  bootstrap administrator password.
- A StorageClass for every gateway's private `10Gi` RWO disk, backed by local
  or cloud block storage rather than NFS/SMB. Set
  `runtime.gatewayStorageClassName` to its reviewed name (`sqlite-block` below
  is an example, not a chart-created class). Verify the provider meets the
  [gateway disk requirements](../reference/drivers/kubernetes-compute.md#storage-and-credentials);
  RWO alone does not establish SQLite compatibility.
- For dedicated Agents, a default StorageClass supporting `40Gi`
  `ReadWriteMany` claims. The driver creates each Agent's shared workspace claim
  without a StorageClass override; see the
  [Kubernetes Compute requirements](../reference/drivers/kubernetes-compute.md#requirements).
- Provider-managed accounts additionally require a dedicated ChatGPT admin
  Secret and one approved `/32` provider or egress-proxy address.
- Secret-backed Configuration bindings additionally require selected IAM policy
  grants for both the deploying actor and the consuming Agent service principal;
  see
  [Kubernetes Secret binding requirements](../reference/drivers/kubernetes-secret.md#bind-a-secret-to-gateway-environment).
- Exact approved internal API client selectors and `/32` PostgreSQL/Kubernetes
  API destinations.

Build the controller image from an explicitly approved Node 24 digest:

```bash
docker build \
  --build-arg NODE_BASE_IMAGE='node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584' \
  --tag openclaw-enterprise:reviewed .
```

Replace the example Node digest only after approving another immutable Node 24
base image.

Verify that the built image can load the production server startup graph and
bundled runtime assets:

```bash
OCC_TEST_PRODUCTION_IMAGE=openclaw-enterprise:reviewed \
  node --test tests/integration/production-image-startup.test.mjs
```

This smoke test runs the image with no network and an intentionally unreachable
PostgreSQL URL. Passing means startup reaches the expected database boundary
without missing production modules or OpenShell proto assets. It does not
install Helm, connect to PostgreSQL, reconcile Kubernetes, or prove a model
turn.

Before building with an external IAM, Compute, or Configuration Driver, follow
the [Driver package installation and private-registry instructions](../reference/drivers/selection.md).
The API and worker must use the same immutable controller image digest.

The gateway image must contain Node 24.15+, `/app/openclaw.mjs`, bundled
OpenClaw skills at `/app/skills`, and the Codex plugin. The Agent image must
provide Node 24.15+ and a Codex CLI supporting API-key login,
`login --with-access-token` with
`forced_chatgpt_workspace_id`, and
capability-token-authenticated app-server WebSockets.
The public [`deploy/runtime`](../../deploy/runtime/README.md) recipe documents
the package inputs used for local proof; production operators must rebuild,
scan, publish, and configure immutable registry digests before Helm install.
Verify the runtime image before running Docker Compose or importing it into a
cluster:

```bash
OCC_TEST_RUNTIME_IMAGE=openclaw-enterprise-runtime:quickstart \
  node --test tests/integration/runtime-image-startup.test.mjs
```

### Configure the Installation

Save the complete [Installation startup configuration](../reference/configuration.md#installation-startup-configuration)
as a protected `installation.yaml`. Replace the illustrative image digests,
cluster name, and allowed gateway-client selector with approved values:

```yaml
occ:
  cluster: production-west
integrations:
  chatgpt:
    workspaceId: <chatgpt-workspace-uuid>
    adminKeyPath: /etc/openclaw/chatgpt/admin-key
    credentialTtlSeconds: 2592000
drivers:
  configuration:
    id: config-kubernetes
    configuration:
      authentication:
        mode: inCluster
  iam:
    id: native-iam
    configuration: {}
  service_account:
    id: chatgpt-service-accounts
    configuration: {}
  compute:
    id: compute-kubernetes
    configuration:
      authentication:
        mode: inCluster
      images:
        gateway: registry.example/openclaw-gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        agent: registry.example/openclaw-codex-agent@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
        requireImmutableDigest: true
      resources:
        gateway:
          requests: { cpu: 250m, memory: 512Mi }
          limits: { cpu: 1000m, memory: 1Gi }
        agent:
          requests: { cpu: 100m, memory: 128Mi }
          limits: { cpu: 500m, memory: 256Mi }
        namespace:
          quota: { pods: "10" }
          containerDefaults:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: 500m, memory: 256Mi }
      network:
        dns:
          namespace: kube-system
          podLabels: { k8s-app: kube-dns }
        gatewayPort: 8080
        gatewayClients:
          - namespace: openclaw-system
            podLabels: { app: approved-gateway-client }
      servicePrincipalCredentials:
        mode: projectedServiceAccountToken
        audience: openclaw-enterprise
        expirationSeconds: 900
      runtime:
        gatewayStorageClassName: sqlite-block
        transportSecretPrefix: openclaw-agent-transport
        modelSecretPrefix: openclaw-agent-model
  secret:
    id: secret-kubernetes
    configuration:
      authentication:
        mode: inCluster
```

The bundled Kubernetes Compute Driver requires digest-pinned gateway and Agent
images, projected ServiceAccount credentials, and both runtime Secret prefixes.
Each Secret prefix appends the owning Agent's 12-character SHA-256 hash. The
Helm chart owns the controller image separately; it does not accept or
cross-check gateway and Agent image values.

The bundled Kubernetes Secret Driver stores Namespace-owned OCC Secrets in the same
backing Kubernetes namespace selected by Compute. It uses controller API
Kubernetes credentials and does not give the worker or workload direct Secret
API permission. See
[Kubernetes Secret Driver](../reference/drivers/kubernetes-secret.md).

The optional `integrations.chatgpt` and `drivers.service_account` sections must
be configured together; omit both for native API-key installations. See
[ChatGPT service-account configuration](../reference/service-accounts.md#provider-selection-and-configuration)
for workspace ownership, credential lifetime, and API-only admin access.

### Provision system Secrets and install

Create the operator-managed system namespace and its separate Secrets before
installing the chart. Store credential files outside the repository with mode
`0600`; never put token values or database URLs on a command line:

```bash
umask 077
kubectl create namespace openclaw-system

kubectl -n openclaw-system create secret generic occ-installation-startup \
  --from-file=installation.yaml=/secure/operator/installation.yaml

kubectl -n openclaw-system create secret generic occ-database \
  --from-file=application-url=/secure/operator/occ-application-url \
  --from-file=migration-url=/secure/operator/occ-migration-url

kubectl -n openclaw-system create secret generic occ-auth \
  --from-file=secret=/secure/operator/occ-auth-secret

# Required only when the ChatGPT service-account integration is selected.
kubectl -n openclaw-system create secret generic occ-chatgpt-admin \
  --from-file=admin-key=/secure/operator/occ-chatgpt-admin-key
```

The migration URL must identify the separate database migrator role; the
application URL must identify the less-privileged application role. The Better
Auth secret signs controller API session material. Also create the protected
PersistentVolumeClaim named by `bootstrap.password.claimName`; the
initialization Job writes the generated first-administrator password there and
fails if the output file already exists during first bootstrap. A previously
bootstrapped Installation is verified without replacing its administrator or
password. Use exact database and Kubernetes API
destinations. Determine the API address and port visible to NetworkPolicy
enforcement after service-address translation: in the validated k3d topology,
the correct destination was the Kubernetes API endpoint on TCP `6443`, not its
`10.43.0.1:443` Service address. Other clusters may use different endpoint
addresses or ports.

```bash
helm upgrade --install oce deploy/helm/openclaw-enterprise \
  --namespace openclaw-system --create-namespace \
  --set images.controller='<approved-controller>@sha256:<digest>' \
  --set auth.baseUrl='https://<internal-occ-host>' \
  --set auth.secretName=occ-auth \
  --set auth.secretKey=secret \
  --set bootstrap.adminEmail='<first-admin@example.com>' \
  --set bootstrap.password.claimName='<existing-protected-pvc>' \
  --set 'api.clients[0].namespace=<approved-client-namespace>' \
  --set 'api.clients[0].podLabels.app=<approved-client>' \
  --set database.cidr='<postgresql-ip>/32' \
  --set cluster.cidr='<network-policy-visible-kubernetes-api-ip>/32' \
  --set cluster.port='<network-policy-visible-kubernetes-api-port>' \
  --set integrations.chatgpt.enabled=true \
  --set integrations.chatgpt.providerCidr='<approved-provider-or-egress-proxy-ip>/32'
```

The final two settings enable the optional ChatGPT integration; omit them when
the Installation does not select its service-account Driver. The enabled chart
mounts the admin Secret and grants restricted provider egress only to the API;
missing or broader provider CIDRs fail rendering. See the
[service-account integration settings](../reference/service-accounts.md#provider-selection-and-configuration).

The chart isolates its initialization Job before startup, initializes the
singleton Installation, writes the generated administrator password to the
protected PVC path, and starts separately identified private API and worker
Deployments. The API exposes `/healthz` and database-backed `/readyz`; worker
readiness expires when real queue-health observations stop.

### Authenticate to the production API

Wait for initialization and both Deployments before using the API:

```bash
kubectl -n openclaw-system wait --for=condition=complete \
  job/oce-initialization --timeout=300s
kubectl -n openclaw-system rollout status \
  deployment/openclaw-enterprise-api --timeout=300s
kubectl -n openclaw-system rollout status \
  deployment/openclaw-enterprise-worker --timeout=300s
```

Use your approved protected-storage access to retrieve the initial password
from the bootstrap PVC, at `/var/lib/openclaw/bootstrap/initial-admin-password`
by default. Keep the local copy owner-readable only; never print the password
or copy it into a command argument. Set `OCC_URL` to the HTTPS endpoint configured
as `auth.baseUrl` and run these commands from an authorized client environment:

```bash
set -o pipefail
umask 077
export OCC_URL='https://<internal-occ-host>'
export OCC_ADMIN_EMAIL='<first-admin@example.com>'
export OCC_ADMIN_PASSWORD_FILE='/secure/operator/initial-admin-password'
OCC_SESSION_DIRECTORY="$(mktemp -d)"
export OCC_SESSION_COOKIE_JAR="$OCC_SESSION_DIRECTORY/cookies"

python3 -c 'import json, os, pathlib, sys
json.dump({"email": os.environ["OCC_ADMIN_EMAIL"],
           "password": pathlib.Path(os.environ["OCC_ADMIN_PASSWORD_FILE"]).read_text().rstrip("\n")}, sys.stdout)' |
  curl --fail-with-body --silent --show-error \
    --cookie-jar "$OCC_SESSION_COOKIE_JAR" \
    "$OCC_URL/api/auth/sign-in/email" \
    -H 'Content-Type: application/json' --data-binary @- --output /dev/null

curl --fail-with-body --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" "$OCC_URL/installation"
```

Expect HTTP `200` and the singleton Installation. Reuse that session cookie for
protected requests below. OCC has no login UI or controller bearer-token login;
see the [authentication contract](../reference/authentication.md). Health and
readiness alone do not prove that an authenticated client can reach the API.

### Prepare each Namespace

#### Use a driver-managed Kubernetes namespace

Use an exactly authorized internal controller client to create the platform
Namespace through `POST /namespaces`; save its returned identifier as
`NAMESPACE_ID`. The worker creates the exact owned Kubernetes namespace before
the platform Namespace can become ready. Wait until that backing namespace
exists, verify its `openclaw.dev/namespace-id` annotation matches
`NAMESPACE_ID`, and save its name as `TENANT_NAMESPACE`.

#### Use an existing Kubernetes namespace

To use an existing, operator-owned namespace instead, set `TENANT_NAMESPACE` to
its exact Kubernetes name. The namespace must be `Active` and exclusively
dedicated to this tenant, without unrelated workload Pods; the driver cannot
verify foreign-Pod absence. Remove foreign NetworkPolicies, then mark it
externally owned and apply all three restricted Pod Security labels without
changing its existing Helm or GitOps manager label:

```bash
kubectl label namespace "$TENANT_NAMESPACE" \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/warn=restricted

kubectl annotate namespace "$TENANT_NAMESPACE" \
  openclaw.dev/namespace-lifecycle=external
```

Create the [tenant RoleBindings](#grant-tenant-rolebindings) before creating its
platform Namespace. As an identity authorized both to create Namespaces and to
`administer` the Installation, send this body to `POST /namespaces`:

```json
{
  "name": "customer-support",
  "existingNamespace": "customer-support-prod"
}
```

This option requires the bundled Kubernetes Compute Driver; Docker or external
Compute installations reject `existingNamespace` with `409`.
Set `existingNamespace` to the exact value of `TENANT_NAMESPACE` and save the
response's server-generated identifier as `NAMESPACE_ID`. The worker binds the Namespace identity without replacing its existing
manager or lifecycle annotation. No worker pause, restart, or Installation
configuration change is needed. See the [Kubernetes Compute namespace
contract](../reference/drivers/kubernetes-compute.md) for ownership checks and
concurrent adoption behavior.

A missing requested namespace, duplicate claim, foreign tenant identity,
insufficient Pod Security, termination, or foreign NetworkPolicy fails closed
without creating a replacement. A missing worker RoleBinding keeps provisioning
pending; a missing API RoleBinding allows readiness but makes Configuration
operations return `503`. Both Kubernetes Drivers use the same namespace after
its tenant identity is bound;
wait for the platform Namespace to become `ready` before creating its first
Configuration. Deleting an empty platform Namespace removes only the five
OpenClaw-owned quota, limit, and policy objects; it preserves the Kubernetes
namespace, its tenant markers, external manager, and operator-owned resources.
Deleting an external selection that failed before either tenant marker was
bound leaves the Kubernetes namespace untouched; fix its preparation and create
a new platform Namespace to retry. Reusing a previously claimed namespace
instead requires an operator to deliberately remove both old tenant markers
first. Partial or foreign previous-tenant markers block reassignment; a matching
current-tenant marker can be completed during adoption. Deletion fails closed
on partial or foreign ownership.

#### Grant tenant RoleBindings

Grant the chart's existing worker, API Configuration, and API Secret
ClusterRoles independently through RoleBindings in that exact tenant namespace.
For an existing namespace, create these RoleBindings before submitting
`POST /namespaces`:

```bash
kubectl -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-worker \
  --clusterrole=oce-openclaw-tenant-worker \
  --serviceaccount=openclaw-system:openclaw-enterprise-worker

kubectl -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-api \
  --clusterrole=oce-openclaw-tenant-configuration \
  --serviceaccount=openclaw-system:openclaw-enterprise-api

# Required for KubernetesSecretDriver Secret CRUD and for API-side
# provider-managed service-account credential materialization.
kubectl -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-api-secrets \
  --clusterrole=oce-openclaw-tenant-api \
  --serviceaccount=openclaw-system:openclaw-enterprise-api
```

Replace the `oce-` ClusterRole prefix when using another Helm release name. A
newly created platform Namespace remains `provisioning` until its
operator-created worker RoleBinding appears or the configured convergence
deadline expires. The bundled Kubernetes Configuration Driver cannot read or
write its tenant ConfigMaps until the separate API RoleBinding exists.
The Secret RoleBinding grants the API only tenant-local Secret `get`, `create`,
`update`, `patch`, and `delete`; it grants the worker no Secret API permission.

Wait until `GET /namespaces/:namespaceId` reports `status: "ready"`. Then
create the exact Namespace-owned base `kind: "agent"` Configuration and save
its returned `CONFIGURATION_ID`. Store any Namespace-owned OCC Secrets that the
runtime needs, then patch the Configuration with `secretBindings` and the
complete native document in
[Configure the Agent runtime](#configure-the-agent-runtime). Binding and
assignment changes require caller `operate` on every selected Secret, including
retained bindings when PATCH omits `secretBindings`.

Create or update the Agent assignment, then grant its service principal
`operate` on every bound Secret before deploying. Kubernetes RoleBindings and
Driver YAML do not provide that grant; see
[Kubernetes Secret binding requirements](../reference/drivers/kubernetes-secret.md#bind-a-secret-to-gateway-environment).

### Prepare each Agent

Create each production Agent with its exact Namespace-owned Configuration and
the placement matching its native Harness. Dedicated Codex explicitly uses
`executionMode: "dedicated"`:

```json
{
  "name": "production-codex-agent",
  "configurationId": "cfg_<exact-namespace-owned-configuration>",
  "executionMode": "dedicated"
}
```

For production built-in OpenClaw, use `executionMode: "embedded"` and native
`agentRuntime: { "id": "openclaw" }`; omitted placement also defaults to
`embedded`. Send either body to `POST /namespaces/:namespaceId/agents` using an
exactly authorized internal controller client. Update existing Agents through
`PATCH /namespaces/:namespaceId/agents/:agentId` with both the required
`configurationId` and selected `executionMode`. Mismatched Harness/mode pairs
fail before deployment. See
[Agent execution modes](../reference/agents.md#execution-mode).

An Agent may optionally include `serviceAccountId` for an exact same-Namespace
[service account](../reference/service-accounts.md). Native API-key accounts support both
Harnesses; provider-managed `access_token` accounts require dedicated Codex.
Both require exact-account `read`, and the immutable account credential is the
only permitted model credential.

For every Agent, calculate its stable suffix and create its operator-owned
transport Secret in the exact tenant namespace. Dedicated Codex uses both transport
tokens; embedded OpenClaw uses only its gateway token and never receives the
app-server token. Generate transport tokens in a private directory:

```bash
umask 077
SECRET_DIRECTORY="$(mktemp -d)"
AGENT_SUFFIX="$(printf %s "$AGENT_ID" | shasum -a 256 | cut -c1-12)"
openssl rand -hex 32 | tr -d '\n' > "$SECRET_DIRECTORY/app-server-token"
openssl rand -hex 32 | tr -d '\n' > "$SECRET_DIRECTORY/gateway-token"

kubectl -n "$TENANT_NAMESPACE" create secret generic \
  "openclaw-agent-transport-$AGENT_SUFFIX" \
  --from-file=app-server-token="$SECRET_DIRECTORY/app-server-token" \
  --from-file=gateway-token="$SECRET_DIRECTORY/gateway-token"
```

For an Agent **without** an associated service account, either keep the existing
operator-managed direct Agent model Secret path or create a Namespace-owned OCC
Secret through the protected API and bind it in Configuration. The direct
Kubernetes path reads the model credential from standard input:

```bash
printf %s "$OPENAI_API_KEY" | kubectl -n "$TENANT_NAMESPACE" \
  create secret generic "openclaw-agent-model-$AGENT_SUFFIX" \
  --from-file=OPENAI_API_KEY=/dev/stdin
```

For an Agent **with an associated native API-key account**, an independently
authorized operator verifies exact ownership, copies only the persisted
`secretRef.name[secretRef.key]` into the Agent model Secret, and verifies
matching safe fingerprints. Replace or clear stale destinations when the source changes:
OCC and Compute cannot detect a missing source behind an existing Secret.
Never use the preceding direct-key command for an associated account; a
production-owned materializer remains unimplemented. See
[native API-key credential delivery](../reference/service-accounts.md#native-api-key-references).

For an Agent **with an associated provider-managed access-token account**,
issue its credential first. Compute projects the resulting account-owned Secret
directly into dedicated Codex; do not create another model Secret. See
[provider-managed credential delivery](../reference/service-accounts.md#provider-managed-access-tokens).

For an embedded OpenClaw Agent that should consume an OCC Secret, create the
Secret after the Namespace is ready with `POST /namespaces/:namespaceId/secrets`.
Bind the returned ref to
`OPENAI_API_KEY` in `secretBindings` and set the native OpenClaw model provider
to `{ "source": "env", "provider": "model", "id": "OPENAI_API_KEY" }`.
Dedicated Codex rejects this model-binding path because the separate gateway
must not receive the model credential. See
[Secret bindings](../reference/configuration.md#secret-bindings).

Grant the Agent service principal `operate` on the bound Secret before
`POST /namespaces/:namespaceId/agents/:agentId/deploy`; see
[Kubernetes Secret binding requirements](../reference/drivers/kubernetes-secret.md#bind-a-secret-to-gateway-environment).

The already-authorized worker can create immutable Agent-owned gateway
ConfigMaps but has no direct Secret API permissions and cannot manage
RoleBindings; its Deployment write authority still provides indirect access to
Secrets within its authorized tenant namespace. Once the exact Agent, its
transport Secret, selected model-credential source, and any required
`secretBindings` exist, send a bodyless
`POST /namespaces/:namespaceId/agents/:agentId/deploy` request and wait for its
immutable AgentRevision to become active.

### Configure the Agent runtime

For dedicated Codex, create the Agent's Namespace-scoped Configuration with
`kind: "agent"` and a native OpenClaw configuration document equivalent to the
following. Select a model that supports Codex custom tools, such as the exact
GPT-5.6 Sol API model ID `gpt-5.6-sol`.

```json
{
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "auth": { "mode": "token", "token": "${OPENCLAW_GATEWAY_TOKEN}" },
    "http": { "endpoints": { "responses": { "enabled": true } } }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "codex/gpt-5.6-sol" },
      "models": {
        "codex/gpt-5.6-sol": { "agentRuntime": { "id": "codex" } }
      }
    }
  },
  "models": {
    "providers": {
      "codex": {
        "baseUrl": "http://127.0.0.1:9",
        "api": "openai-responses",
        "models": [{ "id": "gpt-5.6-sol", "name": "gpt-5.6-sol" }]
      }
    }
  },
  "plugins": {
    "allow": ["codex"],
    "entries": {
      "codex": {
        "enabled": true,
        "config": {
          "appServer": {
            "transport": "websocket",
            "url": "${APP_SERVER_URL}",
            "authToken": {
              "source": "env",
              "provider": "default",
              "id": "APP_SERVER_TOKEN"
            },
            "mode": "guardian",
            "approvalPolicy": "on-request",
            "sandbox": "read-only",
            "homeScope": "agent"
          }
        }
      }
    }
  }
}
```

For embedded OpenClaw, select an approved `openai/<model>` target and native
model-level `agentRuntime: { "id": "openclaw" }`; do not enable the Codex
plugin or configure `APP_SERVER_URL`/`APP_SERVER_TOKEN`. The combined gateway
receives its own exact Agent's `OPENAI_API_KEY` from either the existing
operator-owned model Secret path or an explicit same-Namespace `secretBindings`
entry. An explicit binding replaces the old operator projection for that
environment variable and cannot be combined with a ServiceAccount model source.

Select a real model available to its Agent credential. The dedicated
Codex-owned `codex/<model>` route prevents the separate gateway from holding
an OpenAI API key. Keep
`${...}` placeholders literal; the gateway resolves them from its injected
environment. Never add `OPENAI_API_KEY` or an access token to this document.
The exact dedicated Codex Pod receives either its Agent-specific model API key
or its associated account-owned access token; an embedded gateway receives
only its Agent-specific API key. A separate dedicated gateway never receives
either model credential. OCC mounts the
immutable document without rewriting it. Each dedicated Agent-owned gateway
connects only to `ws://agent-<agent-hash>:18790`; embedded OpenClaw has no
Codex Service or transport.

### Verify production workloads

```bash
kubectl -n openclaw-system get deployments,services,jobs,networkpolicies
kubectl -n "$TENANT_NAMESPACE" get deployments,services,configmaps,networkpolicies
kubectl -n "$TENANT_NAMESPACE" get persistentvolumeclaims
```

Expect one private controller Service and one completed initialization Job.
For each dedicated Agent, its `workspace-<agent-hash>` claim must become `Bound`
with `40Gi` capacity and `ReadWriteMany` access. A pending claim can prevent both
gateway and Harness Pods from starting; check the default StorageClass and
storage provisioner before debugging runtime readiness.
Each dedicated Agent owns one gateway plus one Codex workload; each embedded
Agent owns one combined gateway/Harness and no Codex workload. Resource
presence alone does not prove runtime connectivity. From an explicitly allowed
gateway client, send an authenticated request to its Responses API:

```bash
umask 077
printf 'header = "Authorization: Bearer %s"\n' \
  "$(cat "$SECRET_DIRECTORY/gateway-token")" > "$SECRET_DIRECTORY/curl.config"

curl --fail-with-body --config "$SECRET_DIRECTORY/curl.config" \
  "http://gateway-$AGENT_SUFFIX.$TENANT_NAMESPACE.svc.cluster.local:8080/v1/responses" \
  -H 'Content-Type: application/json' \
  -d '{"model":"openclaw","input":"Reply exactly: OPENCLAW_OK"}'
```

Verify the response includes `OPENCLAW_OK`, indicating the real gateway
completed an authenticated dedicated Codex WebSocket model turn or a real
embedded OpenClaw model turn, according to its selected placement. The request
model selects the OpenClaw Agent; its native configuration selects the
underlying OpenAI model. Before creating a disposable connectivity-demo Agent,
set `agents.defaults.skipBootstrap` to `true` in that Agent Configuration. A
fresh native OpenClaw workspace otherwise creates first-run `BOOTSTRAP.md`
identity guidance, and that onboarding content can replace the requested nonce
reply. This setting only affects new workspaces for the demo Agent; existing
workspaces that already contain bootstrap files keep their current files. Deploy
an immutable AgentRevision and repeat the request after revision cutover. Confirm
an authorized selected Agent connection succeeds and Agents without an admitted
binding, plus unapproved namespace connections, are denied. The existing fixture integration test and
Helm-rendering test do not prove these real-runtime outcomes; follow the
[canonical integration instructions](../../AGENTS.md#running-integration-tests)
for their precise coverage boundaries. Consult
[Kubernetes security controls](../reference/security.md) for Pod hardening, image approval,
credential boundaries, temporary model-key/egress exceptions, and live-cluster
verification limitations.

### Attach with the OpenClaw TUI

Use the native TUI only after the Agent has an active revision and the selected
gateway Pod is Ready. The gateway Deployment and Pod use stable Agent labels
across revision cutovers, so match the Pod to the active revision by its mounted
immutable ConfigMap, not by a Pod revision label. Run these commands from an
operator environment that already has `NAMESPACE_ID`, `AGENT_ID`, `REVISION_ID`,
`TENANT_NAMESPACE`, `KUBECONFIG_FILE`, and `CONTEXT` set:

```bash
set -euo pipefail

AGENT_SUFFIX="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "$AGENT_ID")"
REVISION_SUFFIX="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "$REVISION_ID")"
EXPECTED_CONFIGMAP="gateway-$AGENT_SUFFIX-rev-$REVISION_SUFFIX"
GATEWAY_PODS_FILE="$(mktemp)"

kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" get pods -l \
  "app.kubernetes.io/managed-by=openclaw-enterprise,openclaw.dev/workload-role=gateway,openclaw.dev/namespace=$NAMESPACE_ID,openclaw.dev/agent=$AGENT_ID" \
  -o json > "$GATEWAY_PODS_FILE"

export GATEWAY_PODS_FILE EXPECTED_CONFIGMAP
if ! GATEWAY_POD="$(python3 -c 'import json, os, sys
items = json.load(open(os.environ["GATEWAY_PODS_FILE"], encoding="utf-8")).get("items", [])
def ready(pod):
    return pod.get("status", {}).get("phase") == "Running" and any(
        c.get("type") == "Ready" and c.get("status") == "True"
        for c in pod.get("status", {}).get("conditions", [])
    )
def uses_expected_configmap(pod):
    return any(
        volume.get("configMap", {}).get("name") == os.environ["EXPECTED_CONFIGMAP"]
        for volume in pod.get("spec", {}).get("volumes", [])
    )
matches = [pod for pod in items if ready(pod) and uses_expected_configmap(pod)]
if len(matches) != 1:
    sys.stderr.write(f"expected exactly one active gateway Pod, found {len(matches)}\n")
    sys.exit(1)
print(matches[0]["metadata"]["name"])')"; then
  rm -- "$GATEWAY_PODS_FILE"
  exit 1
fi
rm -- "$GATEWAY_PODS_FILE"
```

Revoke the OCC operator session before opening the interactive TUI unless you
need it for another API mutation first. Gateway authentication is independent
of the controller session:

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" --cookie-jar "$OCC_SESSION_COOKIE_JAR" \
  --request POST "$OCC_URL/api/auth/sign-out" --output /dev/null
rm -- "$OCC_SESSION_COOKIE_JAR"
rmdir -- "$OCC_SESSION_DIRECTORY"
```

Start the TUI inside that exact gateway Pod. The container already has
`OPENCLAW_CONFIG_PATH`, `OPENCLAW_GATEWAY_PORT`, and
`OPENCLAW_GATEWAY_TOKEN`; do not pass a URL or token on the command line.
`--message` sends the first prompt to the native agent named `main` and leaves
the TUI open for additional operator input. That TUI-native agent name is
separate from the OCC Namespace, Agent, and AgentRevision IDs:

```bash
E2E_SESSION="production-tui-$(date +%Y%m%d%H%M%S)"
NONCE="$(python3 -c 'import secrets; print("OPENCLAW_TUI_" + secrets.token_hex(8))')"

kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" exec -it "$GATEWAY_POD" -c gateway -- \
  env -u OPENAI_API_KEY OPENCLAW_STATE_DIR=/tmp/occ-tui-client \
  node /app/openclaw.mjs tui \
    --session "$E2E_SESSION" \
    --message "Reply exactly: $NONCE"
```

The TUI connects to the gateway over the Pod-local WebSocket listener using the
injected gateway token. The extra client process unsets `OPENAI_API_KEY`; model
access stays in the serving gateway path. Normal device pairing remains
enabled. After the first assistant response, type another nonce prompt in the
same TUI process to verify continued interaction. Press Ctrl+D to exit the
client; the gateway Pod and its Service remain running. After deploying another
immutable AgentRevision,
sign in again if needed, re-read the Agent, update `REVISION_ID` from
`data.activeRevisionId`, discover a fresh matching gateway Pod and ConfigMap,
then revoke the controller session and attach again.

The production TUI integration test
[`production-tui-k3d-real.test.mjs`](../../tests/integration/production-tui-k3d-real.test.mjs)
uses the same native TUI attach path through a PTY harness. It installs the
actual Helm chart into a disposable k3d cluster, provisions an embedded
OpenClaw Agent through the production API using `agents.defaults.skipBootstrap`
for the disposable connectivity demo, verifies invalid-token denial, gets two
assistant nonce responses in one open TUI, repeats after revision cutover, and
confirms Ctrl+D exits only the client. Set
`OCC_TEST_PRODUCTION_TUI_KEEP=1` only for an operator rehearsal that should
retain the owned setup; the test then writes an `attach.sh` and `proof.json` in
its evidence directory. The default mode cleans up the Helm release and
task-owned namespaces after the run.

### End the operator session

When finished, revoke the API session and remove its local cookie:

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" --cookie-jar "$OCC_SESSION_COOKIE_JAR" \
  --request POST "$OCC_URL/api/auth/sign-out" --output /dev/null
rm -- "$OCC_SESSION_COOKIE_JAR"
rmdir -- "$OCC_SESSION_DIRECTORY"
```

Skip this step if you already revoked the session before TUI attachment.
Keep the bootstrap password and any runtime tokens in approved protected
storage. Remove temporary credential copies according to your credential
handling policy; do not delete the mounted bootstrap output to force a reset.

### Stop or remove a production deployment

Before removing the control plane, inventory its tenant workloads and arrange
any required shutdown through your operational process. Helm owns the API,
worker, and system resources; it does not own external PostgreSQL,
operator-created Secrets or the bootstrap PVC, or the tenant workloads created
by Compute. Uninstalling the release does not provide complete tenant cleanup.

For an intentionally decommissioned Installation, remove the selected release:

```bash
helm uninstall oce --namespace openclaw-system
```

Retain the database, bootstrap storage, and operator-owned tenant resources
until their retention and recovery requirements are satisfied. Helm hook
resources may also remain. Never delete a shared namespace or run broad
resource deletion to clear this Installation. Reinstallation with retained
state verifies the existing administrator instead of generating a replacement
password; preserve the matching configuration and signing Secret.

For startup failure diagnosis and readiness behavior, see the
[production startup flow](../flows/production-startup.md). For the runtime path
from OCC deployment through native TUI attachment, see the
[production TUI flow](../flows/production-tui.md).

## Service API keys for automation

Use this procedure after starting either supported environment. For the human
session examples, sign in as a
human Installation administrator using the [development quickstart](quickstart.md#sign-in-and-read-the-installation)
or [production sign-in](#authenticate-to-the-production-api), and retain
`OCC_SESSION_COOKIE_JAR`. For development, set `OCC_URL` to your loopback API
URL, such as `http://127.0.0.1:3000`; in production, retain the approved HTTPS
`OCC_URL` from sign-in. Alternatively, an existing Installation-scoped service
key with current IAM `administer` authority can use the
[service-administrator variant](#manage-keys-with-a-service-administrator).
These commands require `curl` and Python 3.

First provision a non-Agent ServicePrincipal and its exact grants through the
selected IAM authority. The controller has no public IAM-management API. See
the [authentication reference](../reference/authentication.md#service-api-keys)
for eligibility, request fields, scope, expiration, and failure behavior.

### Issue a service key

Replace the principal and Namespace placeholders below with existing IDs.
Omit the `namespaceId` field only for an Installation-scoped principal. Set
`OCC_SERVICE_KEY_DIRECTORY` to an existing operator-owned protected directory
outside the checkout. The unique owner-readable response file receives the
one-time credential; do not print it, commit it, or enable shell tracing.

```bash
set -o pipefail
umask 077
export OCC_SERVICE_KEY_DIRECTORY='/secure/operator/service-keys'
export OCC_SERVICE_KEY_FILE="$(mktemp "$OCC_SERVICE_KEY_DIRECTORY/key.XXXXXX")"

curl --fail --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" \
  "$OCC_URL/api/auth/service-keys" \
  -H 'Content-Type: application/json' \
  --data '{"servicePrincipalId":"<existing-service-principal-id>","namespaceId":"<namespace-id>","name":"nightly-reader","expiresIn":2592000}' \
  --output "$OCC_SERVICE_KEY_FILE"
```

Successful issuance returns HTTP `201`. Keep this response in protected storage;
its non-secret `data.id` identifies the key for later revocation.

### Use a service key

Replace the Namespace placeholder with the Namespace authorized for this
principal. The pipeline reads `data.key` from the protected response and sends
it directly to curl's header input, without a plaintext command argument or
terminal output. Do not add curl verbose or trace options.

```bash
export OCC_NAMESPACE_ID='<namespace-id>'

python3 -c 'import json, os, pathlib, sys
key = json.loads(pathlib.Path(os.environ["OCC_SERVICE_KEY_FILE"]).read_text())["data"]["key"]
sys.stdout.write("x-api-key: " + key + "\n")' |
  curl --fail --silent --show-error --header @- \
    "$OCC_URL/namespaces/$OCC_NAMESPACE_ID"
```

Expect HTTP `200` and the authorized Namespace. If the request fails, use the
[service-key failure table](../reference/authentication.md#service-key-failures)
and [flow verification hooks](../flows/service-api-keys.md#debugging-and-verification).
This read verifies API access, not an Agent deployment or model turn.

### Revoke or rotate a service key

For the session-based procedure, use the human administrator session, renewing
it through sign-in if necessary.
Read the non-secret ID from the issuance response and revoke that exact key:

```bash
OCC_SERVICE_KEY_ID="$(python3 -c 'import json, os, pathlib
print(json.loads(pathlib.Path(os.environ["OCC_SERVICE_KEY_FILE"]).read_text())["data"]["id"])')"

curl --fail --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" --request DELETE \
  "$OCC_URL/api/auth/service-keys/$OCC_SERVICE_KEY_ID"
```

Expect HTTP `200` and `data.revoked: true`. Repeat the key-authenticated read
to confirm it now returns `401`. To rotate, issue a replacement into a new
protected file, switch the automation client, verify its request succeeds,
then revoke the old key using its original response file. Remove retired
credential copies according to your storage policy. The reference defines
[revocation and audit boundaries](../reference/authentication.md#revocation-and-audit),
including requests already authorized and dependency failures.

### Manage keys with a service administrator

Use an existing key for an Installation-scoped non-Agent ServicePrincipal with
current IAM `administer` on the Installation. Set `OCC_ADMIN_SERVICE_KEY_FILE`
to its protected issuance response file; a Namespace key cannot authorize
these calls. Retain `OCC_URL` and `OCC_SERVICE_KEY_DIRECTORY` from above. These
commands send the administrator credential through stdin, not a command
argument, and store the newly issued credential without printing it. Keep
shell tracing and curl verbose/trace output disabled.

```bash
set -o pipefail
umask 077
export OCC_ADMIN_SERVICE_KEY_FILE='/secure/operator/service-keys/admin-response.json'
export OCC_SERVICE_KEY_FILE="$(mktemp "$OCC_SERVICE_KEY_DIRECTORY/key.XXXXXX")"

python3 -c 'import json, os, pathlib, sys
key = json.loads(pathlib.Path(os.environ["OCC_ADMIN_SERVICE_KEY_FILE"]).read_text())["data"]["key"]
sys.stdout.write("x-api-key: " + key + "\n")' |
  curl --fail --silent --show-error --header @- \
    "$OCC_URL/api/auth/service-keys" \
    -H 'Content-Type: application/json' \
    --data '{"servicePrincipalId":"<existing-service-principal-id>","namespaceId":"<namespace-id>","name":"nightly-reader","expiresIn":2592000}' \
    --output "$OCC_SERVICE_KEY_FILE"
```

Replace the target IDs as in the session example; omit `namespaceId` only for
an Installation-scoped target. Use the new key and verify its granted operation
before revoking the old one. To revoke, select the non-secret ID from the old
issuance response and send the same administrator header:

```bash
OCC_SERVICE_KEY_ID='<old-key-id>'

python3 -c 'import json, os, pathlib, sys
key = json.loads(pathlib.Path(os.environ["OCC_ADMIN_SERVICE_KEY_FILE"]).read_text())["data"]["key"]
sys.stdout.write("x-api-key: " + key + "\n")' |
  curl --fail --silent --show-error --header @- --request DELETE \
    "$OCC_URL/api/auth/service-keys/$OCC_SERVICE_KEY_ID"
```

The issuance and revocation responses are the same as for a human administrator.
A service can rotate its own administrator credential: issue a replacement
for its existing Installation-scoped principal, switch the client to that key,
verify it works, then use it to revoke the old ID. OCC does not schedule these
steps. Missing current grants or a Namespace-scoped caller return `403`;
invalid, expired, or revoked credentials return `401` without cookie fallback.
Account creation and bootstrap remain unavailable to service keys.
