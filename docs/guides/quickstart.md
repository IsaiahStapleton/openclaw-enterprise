# Quickstart

Start OpenClaw Control Center (OCC) locally and read its Installation through
an authenticated API request. This proves the controller is usable; it does
not deploy an Agent or make a model call. To continue through an Agent
deployment and an interactive model-backed terminal UI (TUI) session, keep the
authenticated shell open and follow
[Development end-to-end TUI](deploy.md#development-end-to-end-tui).

You need Docker Engine with Docker Compose and `curl`. The quickstart builds a
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
OCC automatically creates the first administrator and singleton Installation.
Do not call the bootstrap endpoint again.

## Sign in and read the Installation

Run this in the same terminal after the controller is healthy. It uses the
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
Keep this shell and cookie if you are continuing to
[Development end-to-end TUI](deploy.md#development-end-to-end-tui); that guide
revokes the session before launching the TUI.

## Sign out and stop

Sign out to revoke this session, then remove its local cookie file:

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" --cookie-jar "$OCC_SESSION_COOKIE_JAR" \
  --request POST "$OCC_URL/api/auth/sign-out" --output /dev/null
rm -- "$OCC_SESSION_COOKIE_JAR"
rmdir -- "$OCC_SESSION_DIRECTORY"
docker compose down
```

Stopping Compose preserves the database and Configuration volumes. Do not add
`--volumes` unless you intend to erase them. For environment configuration and
production installation, continue to [Deploy OpenClaw Enterprise](deploy.md).
For supported resource operations, see the [feature reference](../reference/README.md).
