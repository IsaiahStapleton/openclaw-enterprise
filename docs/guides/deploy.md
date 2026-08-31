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
- Approved OpenClaw gateway and Codex runtime images already loaded or pulled
  into that Engine. The worker checks them at startup; it does not fetch them.
- `curl` for the authenticated API check.
- An existing `OPENAI_API_KEY` only when deploying an Agent that makes model
  calls. Starting OCC and reading its Installation does not require a model key.

The gateway image must provide Node 24+ and `/app/openclaw.mjs`; dedicated
Codex also needs the OpenClaw Codex plugin. The Agent image must provide Node
24+ and the Codex app-server runtime. A combined image can provide both.
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

Set the following values in `.env`, replacing image placeholders with approved
images that exist in Docker:

```dotenv
OCC_DOCKER_GATEWAY_IMAGE=<approved-openclaw-gateway-image>
OCC_DOCKER_AGENT_IMAGE=<approved-codex-agent-image>
```

Alternatively, set `OCC_DOCKER_RUNTIME_IMAGE` to one image providing both
runtimes. The individual image variables override the shared image. Keep an
existing provider credential in your environment or protected `.env` when
needed; do not print expanded Compose configuration containing credentials.

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
- Docker for image builds, Helm and `kubectl` for the explicitly selected
  cluster, and `curl` plus Python 3 for the sign-in example.
- An operator-managed HTTPS endpoint that forwards to the private API from an
  approved client Pod. The chart does not install an Ingress or TLS endpoint.
- Separately approved immutable controller, OpenClaw gateway, and Codex Agent
  image digests.
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
- Exact approved internal API client selectors and `/32` PostgreSQL/Kubernetes
  API destinations.

Build the controller image from an explicitly approved Node 24 digest:

```bash
docker build \
  --build-arg NODE_BASE_IMAGE='<approved-node-24-image>@sha256:<digest>' \
  --tag openclaw-enterprise:reviewed .
```

Before building with an external IAM, Compute, or Configuration Driver, follow
the [Driver package installation and private-registry instructions](../reference/drivers/selection.md).
The API and worker must use the same immutable controller image digest.

The gateway image must contain Node 24+, `/app/openclaw.mjs`, and the Codex
plugin. The Agent image must provide Node 24+ and a Codex CLI supporting
API-key login, `login --with-access-token` with
`forced_chatgpt_workspace_id`, and
capability-token-authenticated app-server WebSockets.

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
          requests: { cpu: 100m, memory: 128Mi }
          limits: { cpu: 500m, memory: 256Mi }
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
runtime needs, patch the Configuration with `secretBindings` and the complete
native document in [Configure the Agent runtime](#configure-the-agent-runtime),
then create or update the Agent assignment and deploy. Binding and assignment
changes require `operate` on every selected Secret, including retained bindings
when PATCH omits `secretBindings`.

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
`kind: "agent"` and a native OpenClaw configuration document equivalent to:

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
      "model": { "primary": "codex/gpt-4.1" },
      "models": {
        "codex/gpt-4.1": { "agentRuntime": { "id": "codex" } }
      }
    }
  },
  "models": {
    "providers": {
      "codex": {
        "baseUrl": "http://127.0.0.1:9",
        "api": "openai-responses",
        "models": [{ "id": "gpt-4.1", "name": "gpt-4.1" }]
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
underlying OpenAI model. Deploy a new
immutable AgentRevision and repeat the request after revision cutover. Confirm
an authorized selected Agent connection succeeds and Agents without an admitted
binding, plus unapproved namespace connections, are denied. The existing fixture integration test and
Helm-rendering test do not prove these real-runtime outcomes; follow the
[canonical integration instructions](../../AGENTS.md#running-integration-tests)
for their precise coverage boundaries. Consult
[Kubernetes security controls](../reference/security.md) for Pod hardening, image approval,
credential boundaries, temporary model-key/egress exceptions, and live-cluster
verification limitations.

### End the operator session

When finished, revoke the API session and remove its local cookie:

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" --cookie-jar "$OCC_SESSION_COOKIE_JAR" \
  --request POST "$OCC_URL/api/auth/sign-out" --output /dev/null
rm -- "$OCC_SESSION_COOKIE_JAR"
rmdir -- "$OCC_SESSION_DIRECTORY"
```

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
[production startup flow](../flows/production-startup.md).

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
