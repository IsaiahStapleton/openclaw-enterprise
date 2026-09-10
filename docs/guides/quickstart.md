# Quickstart

Start [OpenClaw Control Center (OCC)](concepts.md#control-plane-and-tenancy)
locally, sign in to the console, and read the Installation through an
authenticated API request. This proves controller access; it does not deploy an
[Agent](concepts.md#agents-and-revisions) or make a model call.

You need Docker Engine with Docker Compose, Bash, `curl`, and Python 3. Run
commands from the repository root.

## Start the local stack

```bash
./scripts/dev-up
```

The helper starts PostgreSQL, migration, bootstrap, API, and worker services,
then copies the bootstrap service-key response into a private local file. Fresh
bootstrap also creates the initial platform
[Namespace](concepts.md#control-plane-and-tenancy) named `default`.

The helper reuses the local quickstart runtime image tag. After changing the
runtime recipe or package versions, [rebuild and verify the image](../../deploy/runtime/README.md#rebuild-an-existing-image)
before rerunning it.

Expected output includes:

- `OpenClaw Enterprise development stack is ready.`
- the API URL, usually `http://127.0.0.1:3000`
- the Installation ID
- the owner-readable service-key file path
- a copy-paste API check

## Open the platform console

Open `/console/` on the API URL printed by `dev-up`, normally
`http://127.0.0.1:3000/console/`. Enter the provisioned human account email as
**Username** and use its password. An existing database keeps its original
password. Browser login uses the human session path, not service keys.

A fresh Installation has a `default` Namespace and no Agents. Use the
[console reference](../reference/console.md) for supported pages, Agent creation,
credential provisioning, deployment, workspace files, and limits.

## Read the Installation with the bootstrap service key

`dev-up` already checks API access. To repeat the check and run the remaining
commands, export the URL and service-key path printed by the helper:

```bash
export OCC_URL='http://127.0.0.1:3000'
export OCC_SERVICE_KEY_FILE='/private/path/initial-admin-service-key.json'
scripts/occ-api GET /installation
```

Expect HTTP `200` and JSON containing the Installation `id` and name. The
Installation ID must match `meta.installationId` in the service-key response.
The helper sends the [service key](concepts.md#identity-and-access) as
`x-api-key` without exposing it in process arguments or terminal output.

Keep these variables for the
[development TUI procedure](deploy/local-operations.md#development-end-to-end-tui). The OCC key
stays with the operator. It is separate from the Agent
[gateway](concepts.md#gateways-and-harnesses) token and model credential and
must never enter a workload or TUI.

## Find the initial Namespace

```bash
scripts/occ-api GET /namespaces
```

On a fresh Installation, expect one Namespace named `default` with a server-assigned `id`. Use that ID
for Namespace-scoped API paths and wait for `status: "ready"` before deploying
an Agent.

## Clean up and stop

If you are stopping after this API check, remove only the temporary local key
copy printed by `dev-up`, then stop Compose:

```bash
rm -- "$OCC_SERVICE_KEY_FILE"
test -z "${OCC_SERVICE_KEY_DIRECTORY:-}" || rmdir -- "$OCC_SERVICE_KEY_DIRECTORY"
unset OCC_SERVICE_KEY_FILE OCC_SERVICE_KEY_DIRECTORY
docker compose down
```

Local cleanup does not revoke the service key. `docker compose down` preserves
the database, [Configuration](concepts.md#configuration-and-secrets), and
bootstrap-key volumes. Use
`docker compose down --volumes` only when intentionally deleting the local
Installation.

Next, use [Deploy OpenClaw Enterprise](deploy.md) for production installation,
customization, Agent/TUI proof, and startup-error diagnosis. For supported
resource operations, see the [feature reference](../reference/README.md).
