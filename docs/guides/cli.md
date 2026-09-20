# OCC CLI

Use `occ` to manage OpenClaw Control Plane (OCC) resources from a terminal. You
need your Installation's OCC endpoint and a protected service-key response file.
For a first deployment using the browser, follow
[Deploy your first Agent](first-agent.md).

## Connect to your Installation

From a trusted OpenClaw Enterprise checkout, install `occ` on your `PATH`:

```bash
go install ./cmd/occ
```

To use the binary only inside the checkout, run `pnpm cli:build` and substitute
`./bin/occ` for `occ` below. Set the endpoint and the service-key file provided
by your administrator or created during bootstrap:

```bash
export OCC_URL='https://occ.example.com'
export OCC_SERVICE_KEY_FILE='/private/path/occ-service-key.json'
occ installation get
occ namespace list
```

Replace the example origin and file path with your own. `installation get`
prints the Installation ID and name. `namespace list` shows authorized Namespaces
with their `STATUS`; select a `ready` Namespace before deploying an Agent. The
commands print tables by default; append `--output json` or `--output yaml` for
the resource or list directly, without an HTTP response envelope.

The resource groups are `installation`, `namespace`, `configuration`, and
`agent`. Look up operations with `occ --help`, `occ namespace --help`, or
`occ agent deploy --help`.

## Create an Agent draft

Set the Namespace ID from `occ namespace list`. `--namespace` overrides the
environment variable for a single command.

```bash
export OCC_NAMESPACE='<namespace-id>'
```

Save the following minimal draft as `configuration.json`:

```json
{
  "kind": "agent",
  "values": {}
}
```

This is enough to create a Configuration. If you are ready to deploy, replace
the **entire** `configuration.json` before creation with the matching
[embedded or dedicated runtime example](deploy/production-agents.md#configure-the-agent-runtime).
Those examples already contain both `kind` and `values`; choose a model your
Installation can access. Never put a plaintext credential in these files.

```bash
occ configuration create --file configuration.json
```

The result includes its `ID`, `KIND`, and initial `GENERATION` of `1`. Copy the
Configuration ID into `agent.json`:

```json
{
  "name": "support-agent",
  "configurationId": "<configuration-id>",
  "executionMode": "embedded"
}
```

Use `dedicated` instead if you chose the Codex runtime Configuration. Then run:

```bash
occ agent create --file agent.json
```

Copy the returned Agent `ID`. A new Agent shows `DESIRED STATE` as `stopped` and
`ACTIVE REVISION` as `-`. It has not started a workload. These commands require
permission to create Configurations and Agents in the Namespace and to read the
exact Configuration. See [Configuration](../reference/configuration.md#create-read-update-and-delete)
and [Agent operations](../reference/agents.md#supported-operations) for other fields.

## Deploy and check an Agent

Before deploying the minimal draft above, update the saved Configuration. Copy the
matching [runtime example](deploy/production-agents.md#configure-the-agent-runtime)
into `configuration-update.json`, then remove only the top-level `kind` field;
keep the top-level `values` object. Run
`occ configuration update '<configuration-id>' --file configuration-update.json`.
Save a compatible
[model credential source](../reference/agents.md#harness-authentication) on the
Agent using the console or `occ agent update '<agent-id>' --file agent-update.json`; the
[Agent update document](../reference/agents.md#editable-configuration) must also
contain `configurationId`. On Kubernetes, provision
[initial runtime credentials](../reference/console/create-and-deploy.md#initial-runtime-credentials)
through the console or with your operator. For an API-key binding, an
administrator must also grant the Agent's own service principal `operate` on
the exact Secret before deployment.

```bash
occ agent deploy '<agent-id>'
occ agent get '<agent-id>'
```

An accepted deployment prints a new revision `ID`, `REVISION` number, `AGENT`,
and `CONFIGURATION`. `agent get` shows the desired state and selected revision;
neither command reports live runtime health. There is no CLI deployment-status
command. Use the returned revision ID with the
[deployment status API](../reference/agents.md#deployment-status) to follow the
worker, or ask your operator to [verify the running workload](deploy/production-agents.md#verify-production-workloads).
If the deploy response is lost, inspect the Agent and its
[revision history](../reference/agents/deployment.md#revisions-and-deployment)
before retrying; another accepted request creates a new revision.

To stop the workload while keeping its revision history and persistent state:

```bash
occ agent stop '<agent-id>'
```

## Manage local development

From the checkout root, start the default Docker Compute profile and use the
cleanup command printed after startup:

```bash
./bin/occ dev up
./bin/occ dev down
```

`./bin/occ dev up` runs the [development quickstart](quickstart.md), including its
container-engine, runtime-image, and readiness checks. The default profile lets
you explore the control plane; it cannot deploy Agents. Its default cleanup
preserves database and configuration volumes; pass `--volumes` only to delete
the local Installation.

Set `OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes` for the
[local Kubernetes profile](deploy/local-kubernetes-development.md). Its cleanup
deletes the profile's k3d cluster, Compose volumes, and private state. Keep the
printed cleanup command so it selects the same profile and state directory.

## Connection and credential boundaries

Use `--url` and `--service-key-file` instead of the environment variables when
needed. The URL must be an HTTP or HTTPS origin without embedded credentials or
a base path. The CLI constructs resource operations internally and disables
redirects so it cannot send a service key to a different origin. Requests time
out after 30 seconds. Set `OCC_TIMEOUT_SECONDS` or `--timeout-seconds` to a
positive integer to change the timeout.

For an HTTPS endpoint signed by a private certificate authority, pass its PEM
bundle without disabling verification:

```bash
export OCC_CA_BUNDLE=/private/path/occ-ca.pem
occ installation get
```

The service-key file is the complete JSON response created by bootstrap or key
issuance, not a file containing only the raw key. Keep it owner-readable and
never place the key in command arguments, logs, workloads, or source control.

## Troubleshoot

- `invalid service-key file`: Check that the JSON contains a nonempty `data.key`
  with no line break.
- `HTTP 401`: OCC rejected the credential. Retrieve or issue the intended key.
- `HTTP 403`: Ask your administrator to check that the service principal has the
  exact permission and Namespace scope for the operation.
- Certificate error: Supply the correct `OCC_CA_BUNDLE`; the CLI provides no
  insecure TLS mode.

See the [HTTP API reference](../reference/api.md) for the underlying platform
contracts and permissions.
