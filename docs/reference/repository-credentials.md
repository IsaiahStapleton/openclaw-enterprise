# Repository credential service

The repository credential service forwards Git HTTPS and selected GitHub API
operations for one configured repository. It runs as a separate Node process
with ephemeral sessions and no database. Use the [operator guide](../guides/repository-credentials.md)
to build it, configure protected inputs, and admit a client.

The client receives a gateway session bearer. The service retains the GitHub App
private key and installation tokens. Possession of the bearer authorizes its
session; ordinary filesystem and container separation protect it. A bearer does
not establish workload identity. Restart invalidates every gateway session and
loses cleanup inventory; upstream tokens can remain valid until GitHub expires
them. This service does not provide durable recovery, multiple replicas, or OCC
Work/IAM integration.

## Configuration

A protected JSON file supplies `gateway`, `sessionPolicy`, `backend`, and optional
positive finite `limits`. The service validates configuration before listening.
Private keys come from protected files, not environment variables or command
arguments. The configuration file and private keys must be regular owned files
with private permissions; symlinks and replacement during loading are rejected.

```json
{
  "gateway": {
    "publicOrigin": "https://credentials.example.internal",
    "listen": "0.0.0.0:8443",
    "tlsCertFile": "/run/repository-credentials/tls.crt",
    "tlsKeyFile": "/run/repository-credentials/tls.key",
    "controlSocket": "/run/repository-control/control.sock"
  },
  "sessionPolicy": {
    "maximumDurationSeconds": 172800,
    "defaultProfile": "git-write",
    "allowedProfiles": ["git-read", "git-write", "git-full"]
  },
  "backend": {
    "kind": "github-app",
    "providerInstanceId": "github-production",
    "configVersion": "1",
    "appId": "123456",
    "installationId": "789012",
    "repositoryId": "345678",
    "repository": "example/project",
    "privateKeyFile": "/run/repository-credentials/app.pem"
  }
}
```

The identifiers above are examples. The initial production adapter fixes upstream
origins to `github.com` and `api.github.com`. An Agent cannot select an upstream,
repository, profile, or deadline after admission. Configuration changes apply to
new composition and admission.

| Profile               | Exact requested GitHub permissions                                           | Supported work                                                           |
| --------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `git-read`            | `metadata: read`, `contents: read`                                           | Clone, fetch and branch checkout; no push or API calls                   |
| `git-write` (default) | `metadata: read`, `contents: write`                                          | Git clone, fetch, branch checkout and push; no API calls                 |
| `git-full`            | `metadata: read`, `contents: write`, `pull_requests: write`, `issues: write` | Git plus selected REST, GraphQL and `gh` PR, issue and comment workflows |

`git-read` and `git-full` require explicit selection with the configuration above.
All three profiles select exactly the configured repository. `git-read` denies
both push discovery and push execution. Both Git-only profiles deny every REST
and GraphQL request, including API reads. `git-full` admits only the supported
API routes and methods; it does not grant every permission held by the App or
import PAT permissions. The former `read-write` name is unsupported, with no
compatibility alias.

Native repository rules still apply. Administration, workflow changes requiring
additional permissions, Actions, packages, projects, SSH, LFS, and other
repositories are outside the supported scope. Missing App permissions cause
failure rather than a broader grant.

## Sessions and closure

A trusted local operator uses HTTP over a private mode-0600 Unix socket:

| Request                                                           | Response                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `POST /v1/sessions` with `durationSeconds` and optional `profile` | Session status, public client configuration and bearer once |
| `GET /v1/sessions/{id}`                                           | Public session and cleanup status                           |
| `POST /v1/sessions/{id}/close`                                    | Immediate local closure status; cleanup reported separately |

The socket's parent is private to the service/operator. It is never mounted into
the client. Control bodies are limited to 16 KiB. The HTTPS client listener has
no admission or close endpoint.

Admission requires `X-Admission-Id`: a 13-digit Unix-millisecond timestamp,
a hyphen, and a lowercase UUIDv4. The operator CLI generates and prints this
nonsecret ID before dispatch. The first response is HTTP 201 with the bearer.
Repeating the same ID and effective duration/profile returns HTTP 200 with
public status only; conflicting inputs fail. Follow the
[lost-response recovery procedure](../guides/repository-credentials.md#recover-an-admission)
to close that session and explicitly request replacement client material.

Unseen IDs must be less than 60 seconds old and cannot be future-dated.
Correlations are process-local and bounded to twice the session limit, including
short-lived tombstones; rapid churn can temporarily return `overloaded`.
Existing correlations can recover status after the initial window, until
expiration or reclamation. Unknown stale IDs cannot create sessions, and an
evicted session returns `not-found`. Correlations never retain a recoverable
bearer and do not survive restart.

Session duration is independent of token lifetime. Credentials are replaced on
demand using the original immutable repository grant. A credential must cover
the full remaining exchange budget plus a safety margin before dispatch. An idle
session needs no periodic mint. A 24-hour session can use its original bearer
after hour 13, provided the process and upstream authorization remain available.

Authentication eligibility and terminal cleanup expiry are separate deadlines.
Both use elapsed monotonic time from the original capture; delayed acquisition
settlement cannot extend either. The GitHub adapter allows 60 seconds of provider
clock skew and conservatively stops authentication before the reported expiry.
Cleanup retains the one-hour bound from local receipt. A forward wall-clock
change can deny authentication but cannot establish remote expiration.

Closing or expiring a session prevents new use immediately and cancels owned
exchanges. `CLOSED` does not imply confirmed revocation. Status distinguishes
pending, revoked, expired and uncertain credentials, plus auxiliary cleanup.
`DISPOSED` requires settled actions, resolved access-token obligations and
completed auxiliary finalization. An uncertain issuance blocks automatic minting.
An uncertain push or API mutation is never automatically replayed.

Failed admission can also retain cleanup work. If session construction fails,
renewal access closes immediately; retained material remains counted against
session capacity and shutdown's `pendingAuxiliary` until admitted callbacks
finish and their material is disposed.

## Client routing and limits

The client launcher uses a private home and configuration, disables prompts,
redirects and inherited global helpers, and removes ambient token, proxy and
debug settings. Before running Git, it inspects configuration in the selected
repository context and overrides URL-specific TLS verification, redirect, proxy
and header settings. User-agent values containing carriage returns or newlines
are rejected, including inherited URL-specific values; ordinary user-agent
values remain supported. Repository trust-root, client-certificate, cookie and DNS
overrides and URL-specific credential helper/identity settings are rejected. Git's helper answers only the exact configured HTTPS host and
repository path with `credential.useHttpPath=true`. HTTP(S) usernames and passwords
in command URLs, remote fetch/push URLs, and URL rewrite destinations are rejected
before network commands run, including percent-encoded userinfo. Explicit remote
helper forms such as `https::https://...` are unsupported on those same surfaces.
Clone admits ordinary destination, branch/origin, shallow/filter, verbosity,
checkout, bare/mirror and tag-selection options. It rejects additional options,
including clone-specific `-c`/`--config`, templates and submodule recursion, and
rejects inherited `init.templateDir` and conditional includes; these can add uninspected configuration
or launch additional transports after preflight.

The launcher preserves the child command's exit status while retrying temporary
home removal up to three times. If removal still fails, stderr reports
`repository-client-cleanup-pending` with the JSON-quoted directory path.
This warning reports a separate cleanup obligation; a successful mutation
retains exit status zero. Remove that directory after any external writers stop;
do not repeat a completed mutation to clear the warning.

The API launcher requires GitHub CLI **2.100.0**, `GH_HOST=github.com`, a gateway
hostname with verified TLS, and HTTPS port 443. Its private `hosts.yml` uses the
experimental `api_host` routing option and stores only the gateway bearer in
`oauth_token`. Supported API calls use relative endpoint paths. The launcher
admits `gh api` and explicit-head `gh pr create`; browser flows, extensions,
absolute API destinations and arbitrary command compatibility are excluded.
GraphQL uses the exactly scoped installation token and can return public data
GitHub permits; the service does not claim per-field GraphQL authorization.
Response rewriting is limited to validated pagination links and explicitly
followed resource fields. Matching owner/repository names may differ in casing;
route casing, origin, purpose, profile and query restrictions still apply.
Native `/repositories/<id>` response URLs must match
the configured repository ID and are rewritten to its admitted `/repos/OWNER/REPO`
route. Issue collection pagination accepts bounded `after` and `before` cursors;
direct requests to repository-ID routes remain unsupported.
Informational labels, milestones, nested repository
metadata and human-authored content remain unchanged. Routing configuration is
not network egress confinement.

Default service bounds are 16 sessions including pending cleanup, two credential
slots per session, one provider action and 64 queued actions, 64 sockets, 32
exchanges total and four per session. Headers are limited to 32 KiB/64 pairs;
request targets to 8 KiB. Git fetch input is 1 MiB; push input and Git output are
256 MiB. API input is 1 MiB and response data 8 MiB. Git gzip input has independent
wire and decoded limits. Exchanges have a five-minute total bound and 60-second
credential margin; provider actions have at most 30 seconds. Shutdown allows
60 seconds for cleanup before reporting unresolved obligations and terminating.
Overrides remain positive and finite.

Controlled tests, container tests and authorized live-provider smoke establish
different evidence. See the [testing guide](../testing/repository-credentials.md)
for current selection and prerequisites, and the [runtime flow](../flows/repository-credentials.md)
for source ownership. A local fixture success does not establish live GitHub
App compatibility or release readiness.
