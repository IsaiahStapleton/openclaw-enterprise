# Repository credential configuration and adapter

Build and validate protected configuration with the [guide](../guides/repository-credentials.md). The GitHub adapter implements the exact repository profiles below. Listener and client delivery are pending; the capability descriptions identify adapter intent.

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
    "allowedProfiles": ["git-write", "read-write"]
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

| Profile      | Exact requested GitHub permissions                                           | Supported work                           |
| ------------ | ---------------------------------------------------------------------------- | ---------------------------------------- |
| `git-write`  | `metadata: read`, `contents: write`                                          | Clone, fetch, branch checkout, push      |
| `read-write` | `metadata: read`, `contents: write`, `pull_requests: write`, `issues: write` | Git plus PR, issue and comment workflows |

`read-write` requires explicit selection. Both profiles select exactly the
configured repository. Native repository rules still apply. Administration,
workflow changes requiring additional permissions, Actions, packages, projects,
SSH, LFS, and other repositories are outside the supported scope. Missing App
permissions cause failure rather than a broader grant.

## Common lifecycle

The callable service owns session admission, bearer lookup, immutable grants, bounded custody, credential replacement, and close/status operations. Closing denies new use immediately; upstream cleanup remains separately pending or uncertain until original actions settle. Demand-driven replacement retains the same session after hour thirteen. The GitHub and alternate fixture factories use these same owners. See the [lifecycle flow](../flows/repository-credentials.md).
