# Use the repository credential service

Build the service and admit a session to give an ordinary container Git and
selected GitHub CLI access to one repository. The container receives a gateway
bearer; GitHub App keys and installation tokens stay in the service. Review the
[profiles and lifecycle](../reference/repository-credentials.md) before selecting
`git-full`.

## Build and validate

From a checkout with the repository's Node 24 and pinned pnpm dependencies
prepared, compile the workspace and assemble the credential artifacts:

```sh
pnpm credentials:build
pnpm credentials:check-config /absolute/path/service.json
```

The check reads protected configuration, validates the RSA key and TLS inputs,
and prints a safe configuration summary. It does not start listeners or call
GitHub. The service artifact is emitted under `.build/repository-credentials/service`;
the client artifact is under `.build/repository-credentials/client`. Both contain
only their required JavaScript modules and use Node built-ins without runtime
`node_modules`. Source ownership under the controller does not combine the
credential process with the control-plane process.

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

Use the emitted client launcher for each supported command. Set its absolute
path before changing into the checkout so later commands use the same artifact:

```sh
credential_client=/absolute/path/checkout/.build/repository-credentials/client/dist/drivers/repo/github/credentials/client/launch.js
node "$credential_client" /absolute/path/sessions/task git clone \
  https://credentials.example.internal/example/project.git
cd project
node "$credential_client" \
  /absolute/path/sessions/task git fetch origin
node "$credential_client" \
  /absolute/path/sessions/task git switch an-existing-branch
node "$credential_client" \
  /absolute/path/sessions/task git push origin HEAD:refs/heads/agent-feature
```

Use credential-free HTTPS URLs. If the launcher refuses inherited URL credentials,
remove userinfo from remote fetch/push URLs and `url.*.insteadOf` or
`url.*.pushInsteadOf` destinations; the selected session helper supplies authentication.

API commands require a `git-full` session. The launcher checks that the
executable is exactly `gh` 2.100.0. Create a
request body file in the working directory, then use relative API paths:

```sh
node "$credential_client" /absolute/path/sessions/task gh api \
  --method POST repos/example/project/pulls --input create-pr.json
node "$credential_client" /absolute/path/sessions/task gh api \
  repos/example/project/pulls/1
node "$credential_client" /absolute/path/sessions/task gh api \
  --method PATCH repos/example/project/pulls/1 --input update-pr.json
node "$credential_client" /absolute/path/sessions/task gh api \
  --method POST repos/example/project/issues --input create-issue.json
node "$credential_client" /absolute/path/sessions/task gh api \
  --method POST repos/example/project/issues/1/comments --input comment.json
node "$credential_client" /absolute/path/sessions/task gh api \
  --paginate repos/example/project/issues/1/comments
```

Native PR creation uses an explicit already-pushed head branch:

```sh
node "$credential_client" /absolute/path/sessions/task gh pr create \
  -R github.com/example/project --base main --head agent-feature \
  --title "Example change" --body-file body.md
```

Select a separate branch when trying both REST and native PR creation. Do not
run `gh auth login` or inject a PAT when a command fails. The gateway routes and
exact App permissions define supported access.

## Recover an admission

Run operator commands from the OCE source checkout. If `open` loses its response, use the `credential-admission` ID printed to
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

A recovered response contains `recovered: true` and credential-free session status,
without creating client files or returning the bearer again. Close that session
using its reported ID and inspect cleanup status. Then explicitly run `open`
without `--admission-id`, choosing a new output directory if needed.
Do not generate replacement admissions blindly after an ambiguous response.
An unknown stale ID or a service restart cannot recover the original session;
see the [ephemeral-session limits](../reference/repository-credentials.md#sessions-and-closure).

## Inspect and close

From the OCE source checkout:

```sh
pnpm credentials:operator status --socket /absolute/path/control/control.sock \
  --session SESSION_ID
pnpm credentials:operator close --socket /absolute/path/control/control.sock \
  --session SESSION_ID
```

Inspect cleanup status after local closure. Pending or uncertain cleanup remains
an obligation. Shutdown stops after its finite grace period even when cleanup
remains unresolved; process exit is not proof of revocation. If writing client
files fails after admission, the CLI attempts local closure and prints the affected
session ID so you can inspect it.

For an uncertain push or mutation, inspect remote state before deciding on a
new operation. For authentication failures, check the selected profile,
installation permission, repository identity and TLS/DNS configuration. A moved
repository requires trusted configuration refresh. After a process restart,
admit a new session; old gateway bearers are invalid. Remove the old private
client directory after closing its session and recording any pending cleanup.
