# Repository credentials

Give an Agent bounded Git HTTPS and selected GitHub API access through optional
repository bindings. OCC authorizes the Agent operation, freezes approved
repository grants into its revision, and lets the worker prepare private runtime
material. The separately running credential service retains GitHub App signing
keys, App JWTs and installation tokens. The Agent receives gateway session
bearers, client configuration and public CA trust. Start with the
[operator guide](../guides/repository-credentials.md).

The bundled platform path supports Kubernetes Compute-owned embedded OpenClaw
with `api_key` Harness authentication and no Sandbox Driver. It requires one
worker/credential-service owner; Helm uses `Recreate` to avoid overlapping
owners. Dedicated Harnesses and other Compute topologies reject repository-bearing
revisions. Agents without bindings retain their existing lifecycle.

Bearer possession authorizes a session; it does not establish workload identity.
Private files and scoped Kubernetes Secrets protect custody. Client routing and
this topology do not establish strong network isolation. A service restart
invalidates its in-memory sessions and loses provider cleanup inventory; existing
GitHub tokens can remain valid until expiry. Platform State retains safe session
identifiers and cleanup work, allowing the worker to replace runtime material
within the original revision deadline. It cannot reconstruct lost provider tokens
or prove their revocation.

## Agent bindings

Agent creation and update accept up to 16 `repositoryBindings`:

```json
{
  "repositoryBindings": [
    { "repositoryRef": "application", "profile": "git-full" },
    { "repositoryRef": "library", "profile": "git-read" }
  ]
}
```

References and profiles are 1–128-character ASCII selectors beginning with a
letter or digit and then containing letters, digits, `.`, `_` or `-`. References
must be distinct. The GitHub Driver defaults an omitted profile to `git-write`.
The existing Agent/configuration permissions apply; a reference is selectable
only when the registry authorizes that exact Namespace and profile. Omission on
update preserves selections; `[]` clears them for future deployments.

Deployment resolves the selections again and freezes the Driver identity, exact
grants and absolute deadline into the immutable revision. Registry drift fails
closed; changing an Agent draft cannot retarget its active revision. The configured
`sessionDurationSeconds` determines the deadline; use `86400` for a 24-hour
revision. Reconciliation, token renewal and service recovery cannot extend it.
A new deployment admits a new revision and deadline. Public Agent responses expose selections; revision responses also expose the
deadline. Neither exposes grant internals, bearer material or session files.

## Configuration

### Canonical platform registry

The GitHub Provider selects one registry through `configuration.registryPath`;
its `drivers.repository_credentials` names the selected Driver. API, worker and
service load the same immutable, versioned ConfigMap. The registry contains
nonsecret identity and Namespace policy for one App installation and multiple
repositories:

```json
{
  "version": 1,
  "providerId": "repository-provider",
  "providerInstanceId": "github-production",
  "appId": "123456",
  "githubInstallationId": "789012",
  "maximumDurationSeconds": 86400,
  "repositories": [
    {
      "repositoryRef": "application",
      "repositoryId": "345678",
      "repository": "example/project",
      "namespaces": [{ "namespaceId": "team", "profiles": ["git-read", "git-write", "git-full"] }]
    }
  ]
}
```

Use actual platform Namespace IDs. App, installation and repository IDs are
positive decimal safe integers represented as strings. Repository names are
canonicalized to lowercase. The registry admits at most 128 repositories, 128
Namespace policies per repository and 4,096 policies overall. References, numeric
repository IDs and canonical names must be unique.

The resolved grant fingerprint covers provider/App/installation identity,
repository identity, maximum duration, Namespace, its complete allowed-profile
set and the selected profile. The service independently resolves and compares
that fingerprint before admission. A changed policy cannot preserve an older
grant merely by keeping the same reference.

The selected Driver configuration supplies `controlSocket`,
`sessionDurationSeconds` and `publicCaPath`; it contains no App key. See
[Provider configuration](providers.md) and the
[installation procedure](../guides/deploy/production-installation.md) for wiring.

### Profiles

| Profile               | Exact requested GitHub permissions                                           | Supported work                                                      |
| --------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `git-read`            | `metadata: read`, `contents: read`                                           | Clone, fetch and checkout; no push or API calls                     |
| `git-write` (default) | `metadata: read`, `contents: write`                                          | Git clone, fetch, checkout and push; no API calls                   |
| `git-full`            | `metadata: read`, `contents: write`, `pull_requests: write`, `issues: write` | Git plus selected REST, GraphQL and PR, issue and comment workflows |

Every session selects exactly one repository, even when one Agent has several
bindings. Both Git-only profiles deny all REST and GraphQL calls. `git-read`
denies push discovery and execution. `git-full` admits selected repository
metadata, PR, issue and issue-comment routes, `GET /meta` and `POST /graphql`,
subject to method, query, framing and media-type restrictions. GraphQL uses the
exact installation-token grant; the service does not provide per-field GraphQL
authorization. The former `read-write` profile has no compatibility alias.

Native repository rules still apply. Administration, workflow changes requiring
additional permissions, Actions, packages, projects, SSH, LFS and unselected
repositories are outside scope. Missing App permissions fail without widening
the grant.

### Standalone service inputs

A protected JSON file supplies `gateway`, `sessionPolicy`, `backend` and optional
positive safe-integer `limits`. For standalone single-repository operation:

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

The identifiers are examples. Production upstream origins are fixed to
`github.com` and `api.github.com`. Registry mode instead uses backend fields
`kind: "github-app-registry"`, `providerId`, `registryFile` and `privateKeyFile`;
all repository policy comes from that registry, and unbound admission is refused.

Private configuration and keys must be regular, owned files with private
permissions; symlinks or replacement during loading are rejected. Kubernetes
composition copies the selected projection into service-owned private files
before validation. API and worker receive registry/public CA inputs; only the
service receives App and TLS private keys.

## Sessions and closure

The trusted worker or local operator uses HTTP over a private mode-0600 Unix socket:

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

Platform admission additionally requires `namespaceId`, `repositoryRef`,
normalized `profile`, `expectedBinding` and `deadlineWallMs`. Replays must match
all original fields. `recoverOnly: true` may return public status or
`admission-missing`, never create a session. A missing lookup fences a delayed
first-open using that still-fresh ID. Capacity or transport failure remains an
error, not evidence of absence.

Unseen IDs must be less than 60 seconds old and cannot be future-dated.
Correlations are process-local and bounded to twice the session limit, including
short-lived tombstones; rapid churn can temporarily return `overloaded`.
Existing correlations recover status after the initial window and remain while
a closed session has unresolved cleanup, including after its deadline. They may
be reclaimed after disposal or authoritative absence. Unknown stale IDs cannot
create sessions: admission lookup returns `admission-missing`, while status for
an absent session returns `not-found`. Correlations never retain a recoverable
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

The embedded runtime provides `git` and `gh` shims. Each invocation selects one
immutable material generation from its actual target or effective Git remotes;
checkout directory names are not authority. Canonical clone URLs route to the
selected gateway and retain Git's ordinary destination behavior. Explicit
`OCE_REPOSITORY_REF` pins an admitted reference and must agree with the target.
Without an explicit target, all effective remotes must match that binding.
Remotes for different repositories require an explicit remote or URL even with
a pinned reference; multi-destination commands fail. No shared selected-repository
file or global routing state is
mutated, so concurrent commands can use different bindings.

Each command owns a private HOME and sanitized environment. Network operations
require valid material and never fall back to ambient authentication or another
profile. Known local Git operations can run without a binding. The launcher
inspects the same Git context it executes, disables prompts/redirects and
inherited global helpers, and enforces exact HTTPS host/path matching. It rejects
URL userinfo, explicit remote-helper syntax, unsafe TLS/proxy/header overrides,
custom trust/client certificates/cookies/DNS, newline-containing user agents,
and clone options that introduce uninspected configuration or transports.
Git's helper uses `credential.useHttpPath=true`. Routing does not confine egress.

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
Response rewriting is limited to validated pagination links and explicitly
followed resource fields. Native `/repositories/<id>` response URLs must match
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
Overrides must be positive safe integers. `providerActions` must remain `1`,
`credentialSlotsPerSession` must be at least `2`, `accessTokenBytes` cannot exceed
16,384, `privateKeyBytes` cannot exceed 65,536, and `providerActionMs` cannot
exceed 30,000. Unknown limit names are rejected.

Controlled tests, container tests and authorized live-provider smoke establish
different evidence. See the [testing guide](../testing/repository-credentials.md)
for current selection and prerequisites, and the [runtime flow](../flows/repository-credentials.md)
for service internals and the [Agent flow](../flows/agent-repository-credentials.md)
for platform ownership. A local fixture success does not establish live GitHub
App compatibility or release readiness.
