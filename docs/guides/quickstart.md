# Quickstart

Start OpenClaw Control Center (OCC) locally and read its Installation through
an authenticated API request. This proves the controller is usable; it does
not deploy an Agent or make a model call. To continue through an Agent
deployment and an interactive model-backed terminal UI (TUI) session, keep the
authenticated shell open and follow
[Development end-to-end TUI](deploy.md#development-end-to-end-tui).

You need Docker Engine with Docker Compose, `curl`, and Python 3. The quickstart builds a
public local runtime image from Docker and npm; no host Node installation is
needed. The [deployment guide](deploy.md#development-prerequisites) defines the
runtime image contract and Docker socket access risk. Run commands from the
repository root.

## Build the runtime image

Build the combined runtime image used by the worker for embedded OpenClaw and
dedicated Codex Agent execution:

```bash
docker build -f deploy/runtime/Dockerfile \
  --tag openclaw-enterprise-runtime:quickstart \
  deploy/runtime
```

This recipe installs public `openclaw`, `@openclaw/codex`, and `@openai/codex`
packages. It checks that `node /app/openclaw.mjs --version` and
`codex --version` work before the image is complete. See
[`deploy/runtime`](../../deploy/runtime/README.md) for pinned package inputs
and production digest guidance.

## Start the local stack

Preserve an existing `.env`, or create one from the example:

```bash
umask 077
test -f .env || cp .env.example .env
```

Edit `.env` to select the local runtime image:

```dotenv
OCC_DOCKER_RUNTIME_IMAGE=openclaw-enterprise-runtime:quickstart
```

The default administrator is `admin@openclaw.local` with password
`openclaw-development-password`. These defaults are for loopback development
only. You can set `OPENCLAW_DEV_EMAIL` and `OPENCLAW_DEV_PASSWORD` before the
first startup; reusing a database retains its existing account and password.
A model credential is not needed for this quickstart.

```bash
docker compose up --build -d
docker compose ps -a
```

Wait for PostgreSQL and the controller to be healthy and the worker to remain
running. The `migrate` service should exit with code `0`. On a new database,
OCC automatically creates the singleton Installation, human administrator, and
service administrator. Its initial service API key stays in a private JSON file
on a controller-only volume. Do not call the bootstrap endpoint again. After
startup succeeds, retrieve that key for the API check below.

## Read the Installation with the bootstrap service key

Set the API URL from the running controller's loopback port:

```bash
export OCC_URL="http://$(docker compose port controller 3000)"
```

Follow [Retrieve the bootstrap service key](deploy.md#retrieve-the-bootstrap-service-key)
to copy the JSON from the controller-only volume into a private local directory,
define `occ_api`, and run `occ_api GET /installation`. The helper reads
`data.key` and sends it as `x-api-key` without exposing the key in process
arguments or terminal output.

Expect HTTP `200` and JSON containing the Installation's server-assigned `id`
and name. Keep this shell and protected file if you are continuing to
[Development end-to-end TUI](deploy.md#development-end-to-end-tui). The OCC key
stays with the operator; it is separate from the Agent gateway token and model
credential and must never enter a workload or TUI.

If the key is expired or revoked, use [human administrator sign-in](#sign-in-and-read-the-installation)
to issue a replacement. See [development verification](deploy.md#verify-development)
for startup errors.

## Clean up and stop

If you are stopping after this API check, remove the temporary local key copy
and stop Compose:

```bash
rm -- "$OCC_SERVICE_KEY_FILE"
rmdir -- "$OCC_SERVICE_KEY_DIRECTORY"
unset OCC_SERVICE_KEY_FILE OCC_SERVICE_KEY_DIRECTORY
docker compose down
```

Local cleanup does not revoke the service key. Keep the original bootstrap
output or imported key in protected storage; revoke or rotate it deliberately
when retiring the credential. Stopping Compose preserves the database,
Configuration, and bootstrap-key volumes. Do not add `--volumes` unless you
intend to erase them. For environment configuration and production installation,
continue to [Deploy OpenClaw Enterprise](deploy.md). For supported resource
operations, see the [feature reference](../reference/README.md).

## Sign in and read the Installation

Use this optional human sign-in for key recovery, key issuance with human
authority, or account-only APIs. The deployment and TUI path above uses the
bootstrap service key. After the controller is healthy, this command uses the
running controller's configured development credentials, JSON-encodes them,
and sends them through standard input. The session cookie stays in a unique,
private temporary directory.

```bash
set -o pipefail
umask 077
export OCC_URL="http://$(docker compose port controller 3000)"
OCC_SESSION_DIRECTORY="$(mktemp -d)"
export OCC_SESSION_COOKIE_JAR="$OCC_SESSION_DIRECTORY/cookies"

docker compose exec -T controller node --input-type=module -e '
  process.stdout.write(JSON.stringify({
    email: process.env.OPENCLAW_DEV_EMAIL,
    password: process.env.OPENCLAW_DEV_PASSWORD,
  }));
' | curl --fail-with-body --silent --show-error \
  --cookie-jar "$OCC_SESSION_COOKIE_JAR" \
  "$OCC_URL/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' --data-binary @- --output /dev/null

curl --fail-with-body --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" "$OCC_URL/installation"
```

Expect HTTP `200` and JSON containing the Installation's server-assigned `id`
and name. Use `--cookie "$OCC_SESSION_COOKIE_JAR"` for subsequent protected
requests. If sign-in fails after changing the configured password, the existing
database still expects its original account password; startup does not reset it.
See [development verification](deploy.md#verify-development) for startup errors.
Use this session for the [service-key issuance or revocation procedures](deploy.md#service-api-keys-for-automation).

### Sign out and stop

Sign out to revoke this session, then remove its local cookie file:

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" --cookie-jar "$OCC_SESSION_COOKIE_JAR" \
  --request POST "$OCC_URL/api/auth/sign-out" --output /dev/null
rm -- "$OCC_SESSION_COOKIE_JAR"
rmdir -- "$OCC_SESSION_DIRECTORY"
docker compose down
```

Stopping Compose preserves the database, Configuration, and bootstrap-key volumes. Do not add
`--volumes` unless you intend to erase them. For environment configuration and
production installation, continue to [Deploy OpenClaw Enterprise](deploy.md).
For supported resource operations, see the [feature reference](../reference/README.md).
