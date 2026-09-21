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

Source lives under the controller, while the credential service runs in its own
process. Trusted startup composition loads protected configuration and keeps
backend construction and request-sender callbacks private. Its session controls
are limited to `open`, `status`, `close`, and `shutdown`. The build produces
separate service and Git/gh client artifacts; the client runtime contains no
signing or service modules. `SIGTERM` or `SIGINT` starts bounded cleanup and
material disposal.

## Configuration

A protected JSON file supplies `gateway`, `sessionPolicy`, `backend`, and optional
positive finite `limits`. The service validates configuration before listening.
Private keys come from protected files, not environment variables or command
arguments. The configuration file and private keys must be regular files owned
by root or the service user, with private permissions. Every directory ancestor
must have one of those owners and reject group/other writes. A root-owned sticky
ancestor such as `/tmp` is allowed above the immediate parent; the immediate
parent must always reject group/other writes. Symlinks and file replacement
during loading are rejected. See the [configuration flow](../flows/repository-credential-configuration.md)
for the validation and key-ownership sequence.

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

The privileged GitHub transport captures the installation, repository and exact
permission profile when the backend is constructed. Its only operations are issuance
for that captured scope and revocation of an owned token; callers cannot supply an
HTTP URL, method, path, request body, or extra headers. Extending those operations
changes a credential boundary and requires security review.

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
import PAT permissions. GraphQL may return public information GitHub permits;
`git-full` provides no per-field GraphQL or branch-only authorization. Every
GraphQL POST is treated as a possible write. The former `read-write` name is
unsupported, with no compatibility alias.

Git discovery, upload-pack and receive-pack accept case differences in the
admitted owner/repository and an optional `.git` suffix. The backend constructs
a canonical upstream path; a literal `.git` repository name remains part of the
admitted identity. Endpoint names, methods, media types, service queries and
profile restrictions still apply. API request paths and repository authority
remain unchanged.

Native repository rules still apply. Administration, workflow changes requiring
additional permissions, Actions, packages, projects, SSH, LFS, and other
repositories are outside the supported scope. Missing App permissions cause
failure rather than a broader grant.

## Sessions and closure

A trusted local operator uses HTTP over a private mode-0600 Unix socket:

| Request                                                           | Response                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `POST /v1/sessions` with `durationSeconds` and optional `profile` | Private status, client configuration and bearer once        |
| `GET /v1/sessions/{id}`                                           | Private session and cleanup status                          |
| `POST /v1/sessions/{id}/close`                                    | Immediate local closure status; cleanup reported separately |

The socket's parent is private to the service/operator. It is never mounted into
the client. Control bodies are limited to 16 KiB. The HTTPS client listener has
no admission or close endpoint.

Admission requires `X-Admission-Id`: a 13-digit Unix-millisecond timestamp,
a hyphen, and a lowercase UUIDv4. The operator CLI generates and prints this
nonsecret ID before dispatch. The first response is HTTP 201 with the bearer.
Repeating the same ID and effective duration/profile returns HTTP 200 with
credential-free status only; conflicting inputs fail. Follow the
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
exchanges. `CLOSED` does not imply confirmed revocation. The private control
response retains active-use counts and pending, revoked, expired and uncertain
credential counts, plus auxiliary cleanup.
`DISPOSED` requires settled actions, resolved access-token obligations and
completed auxiliary finalization. An uncertain issuance blocks automatic minting.
An uncertain push or API mutation is never automatically replayed.

Failed admission can also retain cleanup work. If session construction fails,
renewal access closes immediately; retained material remains counted against
session capacity and shutdown's `pendingAuxiliary` until admitted callbacks
finish and their material is disposed.

## GitHub response data

Bounded REST JSON responses omit the provider's `temp_clone_token` from the
repository object, its `parent` and `source` repository relationships, and
pull-request `head.repo` and `base.repo` objects. Human text and unrelated
metadata remain unchanged. Qualified machine links still pass through the
existing origin, repository, route, and profile checks before gateway rewriting;
other informational links remain data.

## Client routing and limits

Ordinary Git uses `/usr/bin/git` and native configuration. Git owns commands,
identity, hooks, aliases, remotes, push URLs, worktrees, and user settings.
The client does not parse Git arguments or create a temporary HOME. The operator's
single-session launcher remains available and adds the same scoped defaults to
stock Git.

For a delivered generation, the native preparer reads the staged public manifest
and session metadata, validates identities, final paths and private file metadata,
and writes a private aggregate `gitconfig`. It does not read bearer contents or
admit sessions. The supported automatic routing profile maps each canonical
HTTPS host to one gateway origin. Distinct origins for one canonical host fail
preparation; an environment pin cannot change the connection origin after Git
has chosen it. Same-origin public CA inputs must agree.

A host-prefix rewrite preserves owner/repository casing and an optional terminal
`.git`. It also routes unadmitted repositories on that host to the gateway, where
the helper releases no bearer. Separately authenticated same-host use needs an
explicit native configuration override. SSH and additional-repository submodule
workflows are outside supported acceptance.

The generated defaults scope helper reset, `credential.useHttpPath=true`, verified
TLS, optional CA trust and disabled redirects to the exact gateway HTTPS origin.
The helper checks the effective protocol, host/port, username and repository path;
escaped paths, dot segments, extra components and unmatched names receive no
bearer. A literal repository name ending in `.git` can overlap another admitted
identity, so the helper compares both spellings and refuses ambiguous selection.
It never chooses a first, stronger or unexpired alternate grant.

Duplicate repository bindings remain valid. Select one with `OCE_REPOSITORY_REF`;
gh also propagates `OCE_REPOSITORY_SELECTION` containing generation, repository
reference and session ID. Conflicting or stale pins fail remote authentication.
The helper command embeds the prepared generation and refuses material from a
new generation. It validates the selected original deadline before reading its
bearer; gateway closure can deny use earlier. Local commands continue after
expiry or with stale pins because they do not consult the helper. Generation
pinning does not promise a command-wide snapshot across arbitrary subprocesses.

Native user configuration can override these defaults, and caller-added helpers
or credential stores can retain credentials. The feature installs no cache/store
helper; its `store` and `erase` operations are inert. There is no whole-command
preflight or guarantee that every request in a multi-request command fails before
any allowed request executes. An uncertain mutation is never retried by the
client to obtain a successful result.

The API launcher requires GitHub CLI **2.100.0**, `GH_HOST=github.com`, a gateway
hostname with verified TLS, and HTTPS port 443. Its private `hosts.yml` uses the
experimental `api_host` routing option and stores only the gateway bearer in
`oauth_token`. Supported API calls use relative endpoint paths. The launcher
admits `gh api` and explicit-head `gh pr create`; browser flows, extensions,
absolute API destinations and arbitrary command compatibility are excluded.
Response rewriting is limited to validated pagination links and explicitly
followed resource fields. Matching owner/repository names may differ in casing;
route casing, origin, purpose, profile and query restrictions still apply.
Native `/repositories/<id>` response URLs must match
the configured repository ID and are rewritten to its admitted `/repos/OWNER/REPO`
route. Issue collection pagination accepts bounded `after` and `before` cursors;
direct requests to repository-ID routes remain unsupported.
Informational labels, milestones, nested repository
metadata and human-authored content remain unchanged. Each listener and sender
captures its permitted upstream origins at construction. The sender rejects
ambiguous or malformed adapter headers before dispatch, then supplies canonical
authority, framing and connection headers within the configured header bounds.
Routing configuration is not network egress confinement.

Default service bounds are 16 sessions including pending cleanup, two credential
slots per session, one provider action and 64 queued actions, 64 sockets per
listener, and 32 exchanges total and four per session. Headers are limited to 32 KiB/64 pairs;
request targets to 8 KiB. Git fetch input is 1 MiB; push input and Git output are
256 MiB. API input is 1 MiB and response data 8 MiB. Git gzip input has independent
wire and decoded limits. Exchanges have a five-minute total bound and 60-second
credential margin. The response-header deadline starts after the upload finishes;
connection, input and stall deadlines remain independent. Provider actions have at most 30 seconds. Shutdown allows
60 seconds for cleanup before reporting unresolved obligations and terminating.
Unsettled actions retain capacity until exit; grace expiry does not establish
`DISPOSED` or confirmed revocation. Restart cannot recover the lost provider
cleanup inventory. Overrides remain positive and finite.

Controlled source tests, detached-artifact checks, separate running containers
and authorized live-provider tests establish different evidence. See the
[testing guide](../testing/repository-credentials.md)
for current selection and prerequisites, and the [runtime flow](../flows/repository-credentials.md)
for source ownership. A local fixture success does not establish live GitHub
App compatibility or release readiness.
