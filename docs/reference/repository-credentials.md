# Repository credential configuration and adapter

Build and validate protected configuration with the [guide](../guides/repository-credentials.md). The GitHub adapter implements the exact repository profiles below. Listener and client delivery are pending; the capability descriptions identify adapter intent.

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
permission profile when the driver is constructed. Its only operations are issuance
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
import PAT permissions. The former `read-write` name is unsupported, with no
compatibility alias.

Native repository rules still apply. Administration, workflow changes requiring
additional permissions, Actions, packages, projects, SSH, LFS, and other
repositories are outside the supported scope. Missing App permissions cause
failure rather than a broader grant.

## GitHub credential timing

The adapter allows 60 seconds of provider clock skew and reports an earlier authentication expiry. Captured cleanup retains a separate one-hour bound from local receipt; a forward wall-clock change cannot prove remote expiration. Canonical response links accept casing differences only in the matching repository owner/name while preserving route, origin and profile restrictions.
