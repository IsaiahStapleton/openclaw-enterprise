# Give an Agent repository access

Select approved repository references when creating an Agent, deploy it, and ask
it to use ordinary `git` and `gh` commands. The worker delivers gateway session
material to the runtime; GitHub App keys and installation tokens remain in the
credential service. Review the [profiles and lifecycle](../reference/repository-credentials.md)
before selecting `git-full`.

## Prepare the platform installation

Use Kubernetes Compute-owned **embedded OpenClaw**, `api_key` Harness
authentication and no Sandbox Driver. Enable the optional credential sidecar
through the [repository installation procedure](repository-credentials/installation.md).
It requires one immutable registry ConfigMap shared by API, worker and service,
a separate public CA Secret, and service-only configuration, App-key and TLS
Secrets. The [registry reference](../reference/repository-credentials.md#canonical-platform-registry)
defines repository and Namespace policy. Set `sessionDurationSeconds: 86400` for
a 24-hour revision; keep it within the registry's maximum.

The chart's `repositoryCredentials.enabled` defaults to `false`. Enabling it
requires the selected Provider/Driver, sidecar image, registry and Secret names,
and explicit upstream network ranges. Follow the installation guide for exact
values, certificate names and tenant RBAC. Use one worker/service owner with
`Recreate`; replicas cannot share in-memory sessions. This protects credential
custody and supplies routing, without establishing strong network isolation.

Build the full Agent runtime from the checkout root and select its immutable
image reference in Compute configuration:

```sh
docker build -f deploy/runtime/Dockerfile \
  -t openclaw-enterprise-runtime:repository-credentials .
```

The build context is the repository root. This image contains the delivered
client router, Git and pinned `gh` 2.100.0. Publishing or importing the image,
selecting its digest and configuring model authentication follow the production
installation and Agent guides.

## Create and deploy an Agent

Complete [Namespace and embedded Agent preparation](deploy/production-agents.md)
to prepare the embedded `configuration.json` and Namespace-owned model Secret
`HARNESS_SECRET_ID`. Enable native command tools before creating the Configuration;
merge these fields into its `values` while preserving the model and gateway settings:

```json
{
  "agents": {
    "defaults": {
      "workspace": "/home/node/.openclaw/workspace",
      "sandbox": { "mode": "off" }
    }
  },
  "tools": {
    "allow": ["exec", "process"],
    "exec": { "host": "gateway", "mode": "full" }
  }
}
```

This gives the embedded Agent command execution in its gateway container. It is
not an additional sandbox. Create the Configuration as that guide describes and
capture `CONFIGURATION_ID`. Keep its
operator environment, including `OCC_URL`, protected `OCC_SERVICE_KEY_FILE`,
`NAMESPACE_ID` and Kubernetes context. The registry must authorize the actual
platform Namespace ID. The example uses its `application` reference:

```bash
export OCC_NAMESPACE="$NAMESPACE_ID"
export CONFIGURATION_ID HARNESS_SECRET_ID NAMESPACE_ID
python3 - <<'PYTHON'
import json, os
body = {
    "name": "repository-agent",
    "configurationId": os.environ["CONFIGURATION_ID"],
    "executionMode": "embedded",
    "harnessAuth": {
        "method": "api_key",
        "source": {
            "kind": "secret",
            "namespaceId": os.environ["NAMESPACE_ID"],
            "id": os.environ["HARNESS_SECRET_ID"],
        },
    },
    "repositoryBindings": [{"repositoryRef": "application", "profile": "git-full"}],
}
with open("agent.json", "w") as output:
    json.dump(body, output)
PYTHON
AGENT_RESPONSE="$(occ agent create --file agent.json --output json)"
AGENT_ID="$(printf '%s' "$AGENT_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
export AGENT_ID
```

Select `git-read` for read-only work, or omit `profile` for default `git-write`.
Add distinct approved references to the array for more repositories. API
creation uses `POST /namespaces/$NAMESPACE_ID/agents`; the CLI returns the
unwrapped Agent. Bindings confer no model access: before deploying, complete the
production guide's exact Agent-principal Secret grant and initial transport
credential provisioning. Ordinary API-only operators need the administrator's
help with that private principal grant.

```bash
REVISION_RESPONSE="$(occ agent deploy "$AGENT_ID" --output json)"
REVISION_ID="$(printf '%s' "$REVISION_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
export REVISION_ID
occ agent get "$AGENT_ID" --output json
```

Wait until `activeRevisionId` equals `REVISION_ID`. The admitted revision exposes
repository references, profiles and its fixed deadline. Deployment readiness
alone does not prove a model task or GitHub operation. Failed policy checks,
unsupported topology, missing material or expired authority must be corrected
before proceeding; do not add a PAT as a fallback.

## Ask the Agent to work in the repository

Select the Ready active `GATEWAY_POD` using the
[production TUI procedure](deploy/production-agents.md#attach-with-the-openclaw-tui),
then send a normal model task. Use a repository and temporary branch explicitly
approved for writes; replace `example/project` with the registry's canonical
name:

```bash
REPOSITORY_TASK_SESSION="repository-task-$(date +%Y%m%d%H%M%S)"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" exec -it "$GATEWAY_POD" -c gateway -- \
  env -u OPENAI_API_KEY OPENCLAW_STATE_DIR=/tmp/occ-tui-client \
  node /app/openclaw.mjs tui --session "$REPOSITORY_TASK_SESSION" --message \
  'Clone https://github.com/example/project.git into your workspace using the default destination. Create a new branch, configure repository-local Git author name Repository Agent and email agent@example.invalid, add a short repository-access-check.md, commit it, push the new branch, and open a draft PR with gh pr create using an explicit head and body text. Report the commit and PR URL.'
```

The model-executing gateway keeps its model credential; the TUI client unsets
its copy. The runtime workspace is `/home/node/.openclaw/workspace`. No operator
session-opening or pre-clone step is required. The Agent can use:

```sh
git clone https://github.com/example/project.git
cd project
git fetch origin
git switch -c agent-example
git config user.name "Repository Agent"
git config user.email "agent@example.invalid"
# Edit files, then git add and git commit.
git push origin HEAD:refs/heads/agent-example
gh pr create -R github.com/example/project --base main --head agent-example \
  --draft --title "Repository access check" --body "Verify the Agent repository workflow."
```

Commands select the admitted binding from their target or effective remotes;
renaming a checkout or choosing a different clone destination does not change
authority. When remotes point to different repositories, name the remote or URL,
for example `git fetch upstream`. `OCE_REPOSITORY_REF=application` pins the admitted
binding and must agree with the destination; it does not resolve ambiguous
implicit remotes. Concurrent commands may use different bindings;
no global repository switch is required. `gh api` accepts supported relative
paths such as `repos/example/project/pulls/1`; absolute API URLs are refused.
API operations require `git-full`.

Inspect the actual remote commit and PR to confirm completion. If a push or
mutation has an uncertain response, inspect remote state before repeating it.
Stop the Agent through the normal lifecycle when finished; inspect pending
cleanup separately. A service restart can replace private runtime material and
restart the embedded gateway, but cannot renew the revision's absolute deadline.
After expiry, a new authorized deployment is required.

## Use the standalone service

The remaining steps are for independently launched clients. They do not create
an OCC Agent or connect a client container to the platform lifecycle.

## Build and validate

Prepare the repository's Node 24 and pinned pnpm dependencies. Run the `pnpm`
and Docker examples from the checkout root; the client commands below run from
your working repository. Build the controller project and stage the separate
credential service and client artifacts:

```sh
pnpm credentials:build
pnpm credentials:check-config /absolute/path/service.json
```

The build stages `.build/repository-credentials/service` and
`.build/repository-credentials/client`. Each contains a minimal manifest and its
selected emitted modules, using Node built-ins without runtime `node_modules`.
The check validates protected configuration, RSA and TLS inputs, and prints a
safe summary without starting listeners or calling GitHub. The service entrypoint
is `repository-credentials.js`; the client launch, operator, Git helper and router
entrypoints live under `drivers/repo/github/credentials/client/` in emitted output.
These artifacts retain separate service/client dependency closures.

For `invalid-configuration`, inspect the file and every directory in its absolute
path. Use root or service-user ownership, private configuration/key files, and
directories that other users cannot modify. A root-owned sticky temporary
directory is allowed above the protected immediate parent. Move files out of
shared writable deployment directories before retrying; the complete policy is
in the [reference](../reference/repository-credentials.md#configuration).

Create the protected configuration shown in the
[reference](../reference/repository-credentials.md#configuration). Use a GitHub
App installed on the selected repository with the permissions for your chosen
profile. Configure public DNS and a TLS certificate covering the gateway
hostname. GitHub CLI requires HTTPS port 443 on that hostname. Provision a
private control directory owned by the service/operator:

```sh
install -d -m 700 /absolute/path/control /absolute/path/sessions
chmod 600 /absolute/path/service.json /absolute/path/app.pem /absolute/path/tls.key
pnpm credentials:start --config /absolute/path/service.json
```

The configured control socket must be inside the private control directory.
Keep the service's configuration, App key, TLS private key and control socket
outside the Agent's filesystem mounts.

## Open and use a session

Choose a duration within `maximumDurationSeconds` and a profile enabled in
`allowedProfiles`. Omit `--profile` to use the configured default, `git-write` in
the example configuration, for Git clone, fetch, checkout and push. Select
`--profile git-read` when push is unnecessary. The example below selects
`git-full` because the later commands create PRs, issues and comments; both
Git-only profiles deny all API calls.

The output directory must not exist, and its parent must be owned and mode 0700. The command writes private
files atomically and prints the session identifier, deadline and directory,
without printing the bearer:

```sh
pnpm credentials:operator open \
  --socket /absolute/path/control/control.sock \
  --duration-seconds 86400 --profile git-full \
  --output /absolute/path/sessions/task \
  --ca /absolute/path/gateway-ca.pem
```

Omit `--ca` when the gateway uses a publicly trusted certificate. Protect the
resulting directory like any credential. It contains `bearer`, public metadata,
Git configuration, isolated `gh` configuration and optional public CA trust.
Mount only this private client material and the working directory into the
Agent. Preserve the session files' ownership and mode 0600, and their directories'
mode 0700. Bind-mount only the selected session directory, never its host parent
or sibling sessions. The client validates that directory beneath the protected
container root.

Use an absolute launcher path so commands continue to work after entering the
cloned repository. Replace `/absolute/path/checkout` with the OCE checkout:

```sh
credential_client=/absolute/path/checkout/apps/controller/dist/drivers/repo/github/credentials/client/launch.js
node "$credential_client" /absolute/path/sessions/task git clone \
  https://credentials.example.internal/example/project.git
cd project
node "$credential_client" /absolute/path/sessions/task git fetch origin
node "$credential_client" /absolute/path/sessions/task git switch an-existing-branch
node "$credential_client" /absolute/path/sessions/task git push origin HEAD:refs/heads/agent-feature
```

Use credential-free HTTPS URLs. If the launcher refuses inherited URL credentials,
remove userinfo from remote fetch/push URLs and `url.*.insteadOf` or
`url.*.pushInsteadOf` destinations; the selected session helper supplies authentication.

For API work, use the same absolute launcher with `gh api` and relative paths,
or `gh pr create` with an explicit already-pushed head, as shown above. The
launcher checks for `gh` 2.100.0. It does not support `gh auth login`, browser
flows, extensions or arbitrary CLI commands. Never inject a PAT to bypass a
route or permission failure.

## Recover an admission

Return to the OCE checkout root for operator commands.
If `open` loses its response, use the `credential-admission` ID printed to
stderr before dispatch. Repeat the command with the same duration and profile,
adding `--admission-id`:

```sh
pnpm credentials:operator open \
  --socket /absolute/path/control/control.sock \
  --duration-seconds 86400 --profile git-full \
  --output /absolute/path/sessions/task \
  --ca /absolute/path/gateway-ca.pem \
  --admission-id ADMISSION_ID
```

A recovered response contains `recovered: true` and public session status,
without creating client files or returning the bearer again. Close that session
using its reported ID and inspect cleanup status. Then explicitly run `open`
without `--admission-id`, choosing a new output directory if needed.
Do not generate replacement admissions blindly after an ambiguous response.
An unknown stale ID or a service restart cannot recover the original session;
see the [ephemeral-session limits](../reference/repository-credentials.md#sessions-and-closure).

## Container images

Build from the staged artifacts produced by `pnpm credentials:build`:

```sh
pnpm credentials:image
pnpm credentials:client-image
```

If build-time HTTPS downloads require an additional trusted CA, optionally pass
a PEM CA bundle through a BuildKit secret:

```sh
docker build --secret id=build-ca,src=/absolute/path/build-ca-bundle.pem \
  -f deploy/runtime/repository-credentials/Dockerfile.client \
  -t repository-credentials-client:local .build/repository-credentials/client
```

The secret supplies curl trust for that download step and is not stored in the
image. Without it, curl uses the image's default CA trust. Runtime gateway trust
still comes from the selected session configuration.

The Dockerfiles under `deploy/runtime/repository-credentials/` use separate
staged service and client contexts. The client image includes only the client
modules, installs Git and checksum-verifies pinned `gh` 2.100.0; it excludes the
service and GitHub provider implementation. Neither image includes service
configuration, private keys, session files or a control socket. The client
entrypoint takes `SESSION_DIRECTORY git|gh ARGS...`.

The optional [Compose example](../../deploy/examples/repository-credentials/compose.yaml)
publishes service port 8443 at host port 443. Supply its required service UID/GID,
protected input/control paths, selected client-session directory and workspace.
`CREDENTIAL_CLIENT_SESSION` must name only the selected directory, mounted at
`/session`. Match ownership and arrange gateway DNS/certificate trust first;
Compose does not provision them:

```sh
docker compose -f deploy/examples/repository-credentials/compose.yaml run --rm client \
  /session git clone https://credentials.example.internal/example/project.git
```

## Inspect and close

From the OCE checkout root:

```sh
pnpm credentials:operator status --socket /absolute/path/control/control.sock \
  --session SESSION_ID
pnpm credentials:operator close --socket /absolute/path/control/control.sock \
  --session SESSION_ID
```

Inspect cleanup status after local closure. Pending or uncertain cleanup remains
an obligation; process exit is not proof of revocation. If writing client files
fails after admission, the CLI attempts local closure and prints the affected
session ID so you can inspect it.

For an uncertain push or mutation, inspect remote state before deciding on a
new operation. For authentication failures, check the selected profile,
installation permission, repository identity and TLS/DNS configuration. A moved
repository requires trusted configuration refresh. After a process restart,
admit a new session; old gateway bearers are invalid. Remove the old private
client directory after closing its session and recording any pending cleanup.
