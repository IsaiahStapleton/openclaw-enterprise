# Repository credential core and configuration

Build and validate protected configuration with the [guide](../guides/repository-credentials.md).
The callable service and GitHub backend implement the profiles and lifecycle below.
The emitted command checks configuration only. HTTPS and control listeners,
Git/gh clients, containers, and ordinary-Agent integration remain pending; this
core does not yet expose a platform Driver capability.

## Configuration

A protected JSON file supplies `gateway`, `sessionPolicy`, `backend`, and optional
positive finite `limits`. Configuration loading validates these inputs without
starting a listener.
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

| Profile               | Exact requested GitHub permissions                                           | Admitted operations                                                 |
| --------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `git-read`            | `metadata: read`, `contents: read`                                           | Clone, fetch and branch checkout; no push or API calls              |
| `git-write` (default) | `metadata: read`, `contents: write`                                          | Git clone, fetch, branch checkout and push; no API calls            |
| `git-full`            | `metadata: read`, `contents: write`, `pull_requests: write`, `issues: write` | Git plus selected REST and GraphQL PR, issue and comment operations |

`git-read` and `git-full` require explicit selection with the configuration above.
Every issuance explicitly requests the configured repository and the complete
permission map for its profile. `git-read` denies
both push discovery and push execution. Both Git-only profiles deny every REST
and GraphQL request, including API reads. `git-full` admits only the supported
API routes and methods; it does not grant every permission held by the App or
import PAT permissions. The former `read-write` name is unsupported, with no
compatibility alias.

Git discovery, upload-pack and receive-pack accept case differences in the
admitted owner/repository and an optional `.git` suffix. The backend constructs
a canonical upstream path; a literal `.git` repository name remains part of the
admitted identity. Endpoint names, methods, media types, service queries and
profile restrictions still apply. API request paths and repository authority
remain unchanged.

`git-full` does not provide branch-only or per-field GraphQL authorization.
GitHub may also return public information permitted by its API. The backend
treats every GraphQL POST as a possible write, including queries, and never
automatically replays a possible Git or API write after an uncertain result.

Native repository rules still apply. Administration, workflow changes requiring
additional permissions, Actions, packages, projects, SSH, LFS, and other
repositories are outside the supported scope. Missing App permissions cause
failure rather than a broader grant.

## Common lifecycle

The callable service owns session admission, bearer lookup, immutable grants,
bounded custody, credential replacement, and close/status operations. Its private
`RepositoryBackend` and `RepositoryBackendFactory` contracts keep native scope,
authentication, and credential operations with the backend. The service retains
the complete private status, including active uses and cleanup accounting.

Closing moves local admission to `CLOSED` and denies new use immediately.
`DISPOSED` requires original actions, exchanges, captured material, and auxiliary
renewal authority to finish their obligations. Confirmed provider revocation and
observed process termination are separate facts. Cancellation alone does not
settle an action or release its capacity. Unknown issuance blocks automatic
remint; possible writes require remote-state inspection before a separately
authorized follow-up.

`shutdown(graceMs)` closes admission and waits for disposal within a finite grace
period. It can return `graceExpired: true` with pending actions, credentials, or
auxiliary cleanup. Those obligations remain owned until settlement or process
exit. This core keeps no durable provider inventory: after exit or restart,
issued tokens may remain usable until their provider expiry.

Demand-driven replacement retains the same session and bearer after hour thirteen
without extending the original admission deadline. GitHub and the alternate
fixture backend use the same common owners. See the
[lifecycle flow](../flows/repository-credentials.md) and
[proof boundaries](../testing/repository-credentials.md#proof-boundaries).

## GitHub response data

Bounded REST JSON responses omit the provider's `temp_clone_token` from the
repository object, its `parent` and `source` repository relationships, and
pull-request `head.repo` and `base.repo` objects. Human text and unrelated
metadata remain unchanged. Qualified machine links still pass through the
existing origin, repository, route, and profile checks before gateway rewriting;
other informational links remain data.

## GitHub credential timing

The backend allows 60 seconds of provider clock skew and reports an earlier authentication expiry. Captured cleanup retains a separate one-hour bound from local receipt; a forward wall-clock change cannot prove remote expiration. Canonical response links accept casing differences only in the matching repository owner/name while preserving route, origin and profile restrictions.

Use deadlines stay anchored to original capture, even when acquisition settlement is delayed. Failed session construction seals renewal access and retains pending custody against session capacity and shutdown cleanup until callbacks drain and material is disposed.
