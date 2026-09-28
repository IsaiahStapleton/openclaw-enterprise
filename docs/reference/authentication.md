# Authentication

OpenClaw Control Plane (OCC) authenticates human controller API clients with
user sessions established through email/password sign-in or an administrator-enrolled
GitHub identity. Programmatic non-Agent automation authenticates with service
API keys. Better Auth owns
password verification, revocable session cookies, and hashed API-key storage.
The selected IAM Driver resolves the authenticated account or service identity
to an explicitly provisioned Principal or ServicePrincipal and owns
[authorization](authorization.md).

This page defines the currently supported authentication behavior. For a
working sign-in procedure, see
[human administrator sign-in](authentication/service-api-keys.md#sign-in-as-a-human-administrator).
For non-Agent automation, see the [service-key procedure](authentication/service-api-keys.md).
The [platform console](console.md) provides login at `/console/` and uses these
same session endpoints. Public signup, Google, enterprise OIDC, and bearer
credentials are not supported controller API authentication paths.

## Installation and account ownership

Authentication belongs to one bootstrapped Installation. The controller requires
`OCC_AUTH_SECRET` and `OCC_AUTH_BASE_URL`; their deployment configuration is
specified in [settings](settings.md). An account's immutable Better Auth user ID
and Installation-specific trusted issuer identify its IAM Principal. Email
addresses and display names do not grant access.

Fresh native-IAM bootstrap creates the first human administrator and one
Installation-scoped, non-Agent ServicePrincipal. Both have separate bindings to
the same [administrator Role](authorization.md#supported-policy-surface).
The service identity has no email, password, session, Namespace, or Agent owner;
its authority does not depend on the human account remaining present.

Fresh bootstrap also creates the initial [`default` Namespace](namespaces.md#initial-namespace)
under the bootstrap Principal's ordinary Namespace creation permission.
Installation/IAM state, the Namespace, its queued reconciliation, and bootstrap
audit commit together. Worker provisioning remains asynchronous.

Bootstrap issues a 30-day service API key named `bootstrap-admin` and writes its
one-time response to `OCC_BOOTSTRAP_SERVICE_KEY_FILE`. The JSON contains
`data.id`, `data.servicePrincipalId`, `data.name`, `data.expiresAt`, `data.key`,
and `meta.installationId`; it is usable with the existing service-key examples.
Better Auth retains the hash, not plaintext. The file remains readable until the
operator removes it; there is no server-side plaintext retrieval endpoint.

Production also creates the configured `OCC_BOOTSTRAP_ADMIN_EMAIL` account with
a random password written to `OCC_BOOTSTRAP_PASSWORD_FILE`. Both paths must be
absolute, distinct siblings on protected operator-owned storage. Output is
exclusive, owner-only (`0600`), and synced before committing Installation/IAM
state; existing files, symlinks, or unsafe parent directories fail closed.
Credentials never appear in bootstrap logs, audit, or the HTTP bootstrap
response. OCC creates no Kubernetes Secret or PVC for delivery.

In Helm, `bootstrap.password.claimName` selects the existing protected PVC.
Only the initialization Job mounts it; `bootstrap.password.fileName` and
`bootstrap.serviceKey.fileName` are written under `bootstrap.password.mountPath`.
See [initial-key retrieval](authentication/service-api-keys.md#retrieve-the-bootstrap-service-key)
and [bootstrap recovery](authentication/service-api-keys.md#recover-an-incomplete-bootstrap).

The shared `scripts/bootstrap-installation.mjs` initializer runs after migration
and before either API or worker startup in Compose and Helm. Development
provisions the configured `OPENCLAW_DEV_EMAIL` and
`OPENCLAW_DEV_PASSWORD` on a fresh database, using the defaults in
[settings](settings/development.md#required-development-controller-environment), and
bootstraps the Installation before serving requests. It does not generate a
password output file or rotate an existing account's password. Compose stores
the service-key JSON on the bootstrap-only `occ_bootstrap_data` volume. The API
and worker do not mount it. Direct development runs the same initializer with
an explicit private key-file path before starting the API or worker.
The [quickstart](../guides/quickstart.md) uses the service key for its API check.

An already-bootstrapped Installation receives no new Namespace, identity, grants, key, or
output, including installations created before initial-key delivery existed.
Restarting does not replace missing files, expired/revoked keys, removed service
identities, or removed grants. Use normal issuance/revocation for credential
recovery and rotation.

Bootstrap makes one attempt. Any error emits `installation.bootstrap-failed`
with available non-secret IDs and paths, then exits unsuccessfully. Created
accounts, keys, and files remain, including partial output from a failed write.
Bootstrap does not automatically revoke, delete, retry, repair, or reset them.
The Helm initialization Job uses `backoffLimit: 0` and does not retry a failed
attempt. Better Auth persistence and the Installation/IAM commit are separate;
an error does not establish whether the transaction committed. Operators must
resolve that outcome before manual repair, or explicitly reset an identified
disposable Installation. See [incomplete bootstrap recovery](authentication/service-api-keys.md#recover-an-incomplete-bootstrap).
File existence alone is not proof of successful initialization.

## Browser request origin

Browser sign-in and sign-out requests must use the origin configured by
`OCC_AUTH_BASE_URL`. An explicit untrusted or malformed `Origin` is rejected
before password verification or session revocation. A request marked
`Sec-Fetch-Site: cross-site` without an Origin is also rejected. Rejection leaves
an existing session intact. Command-line clients that send neither browser
header keep the documented sign-in/sign-out flow.

## Session lifecycle

| Operation                      | Supported behavior                                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/sign-in/email` | Verifies an existing account's email and password and issues a session cookie. The JSON response confirms authentication without returning a session token. |
| `GET /api/auth/session`        | Returns safe account identity and a noncredential `sessionKey`, or `data: null` without a valid session.                                                    |
| `POST /api/auth/sign-out`      | Revokes the current session. Protected API requests using that session subsequently return `401`.                                                           |

The `sessionKey` identifies the current session record, stays stable across reads,
and changes on a new sign-in, including for the same account. It cannot authenticate
requests; the session token remains in its HttpOnly cookie. Console uses this key
to discard retained content and drafts when the session changes.

For example, the sign-in body is:

```json
{
  "email": "admin@example.invalid",
  "password": "<account-password>"
}
```

The successful sign-in response contains `data: { "authenticated": true }` and
request metadata. The session credential is delivered through `Set-Cookie`, not
the JSON body. Protected OCC API calls use that cookie.

The controller configures the Better Auth cookie with the `openclaw_occ`
prefix; the OpenAPI contract names it `openclaw_occ.session_token`. Cookies are
HTTP-only, use `SameSite=Lax`, and cover `/`. Production enables secure cookies;
the configured base URL is also the trusted origin. Session inspection exposes
only `authenticated` and the account's `id`, `email`, and `name`.

Protected requests resolve the current stored session with cookie caching
disabled. A missing, expired, revoked, or forged session is rejected. Supplying
an `Authorization` header is rejected even if a session cookie is also present.

## GitHub sign-in for existing accounts

GitHub sign-in requires one serving controller, one Installation, PostgreSQL with
its restricted application role, native IAM, one GitHub App on github.com, and one
canonical HTTPS Console origin with host-only cookies. Shared-cookie native
administration, other session readers, rolling or mixed-version serving, and
mutable Installation policy are unsupported. Keep bootstrap, seeding, account
provisioning, external policy writers, and recovery-affecting changes stopped.
Native IAM's policy read remains separate from State's actor guard. Loopback
development does not qualify deployed HTTPS.

HTTPS sessions use `__Host-openclaw_occ.session_token`, `Secure`, `HttpOnly`,
`Path=/`, and no `Domain`, preventing sibling hosts from planting that cookie.
Session reads, protected requests, and logout reject duplicate session cookies.

Provision password accounts and explicit IAM grants before activation. Startup
rejects unsupported or incomplete account populations. Activation enrolls existing
password accounts; account creation then stays frozen (see
[Account provisioning](#account-provisioning)).
Set all three API-process variables; partial configuration fails startup:

| Variable                           | Purpose                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `OCC_AUTH_GITHUB_CLIENT_ID`        | GitHub App client ID, not App ID; determines the provider-instance key. |
| `OCC_AUTH_GITHUB_CLIENT_SECRET`    | GitHub App client secret in protected server configuration.             |
| `OCC_AUTH_GITHUB_RECOVERY_USER_ID` | Existing local password administrator retained for recovery.            |

The Helm chart cannot yet carry these variables: its API container accepts no
extra environment, so out-of-band values vanish on the next `helm upgrade` and
an activated controller then fails startup.

Use the repository integration's GitHub App. Register `OCC_AUTH_BASE_URL` +
`/api/auth/providers/github/callback` as its callback. Login receives the
[client ID and secret](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app);
the private key stays with the existing repository credential consumer.

OCE requests no OAuth scopes. [App permissions and user access](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-login-with-github-button-with-a-github-app#specify-additional-parameters)
govern the bearer token, which may carry repository authority; `read:user` would
not restrict it. Login uses only [`GET /user`](https://docs.github.com/en/rest/users/users#get-the-authenticated-user),
then discards tokens, expiry, and scope data. It performs no refresh, creates no
repository grants, and gives no provider credentials to repository consumers or Agents.

A new client ID requires reattachment under a new provider instance. Secret
rotation preserves enrollment and invalidates pending attempts. Emails and login
names are not identity keys.

A human Installation administrator reads `GET /api/auth/accounts/:userId`
([requirements](#session-and-recovery-controls)). Its no-store response
contains `userId`, `principalId`, `version`, `disabled`, and `methods` with
`methodId`, `providerId`, and `subject`. Attach a verified positive decimal GitHub
user ID (1–20 digits, no leading zero) through
`POST /api/auth/accounts/:userId/providers/github` with
`{"subject":"12345678","expectedVersion":1}`, using the version just read.

Attachment preserves the user, Principal, and grants, advances the account version,
and invalidates existing sessions and pending proofs. Subjects owned by another
user, email association, signup, identity transfer, and self-service linking are
rejected. For unknown identities, follow the
[enrollment procedure](../guides/deploy/production-installation.md#enable-github-browser-sign-in).

`GET /api/auth/providers` returns `data: {"github": true}` when enabled. A
same-origin `POST /api/auth/providers/github/start` returns `data.url` and sets a
browser-binding cookie. Other provider names return `404`; callers cannot select
callback or return destinations. The [Console flow](../flows/platform-console.md#2-resolve-the-session-before-private-reads)
owns button and error display.

The callback consumes a short-lived, browser-bound attempt once before code
exchange and resolves the immutable numeric GitHub user ID's exact enrollment.
Unknown identities fail without signup. Success returns to `/console/`; failure
returns to `/console/?authError=github` without automatic retry.

### Session and recovery controls

Enabling this profile applies the same admission rules to password and GitHub
sessions: an eight-hour absolute lifetime without refresh, current account and
method checks, and required audit before a cookie is released or, on logout,
cleared. Existing sessions without the profile's account/method binding are
rejected; users sign in again. Activation is one-way: removing GitHub
configuration fails startup, and old binaries are unfenced and unsupported. There
is no rollback other than keeping the `OCC_AUTH_GITHUB_*` environment set.

The recovery user must already have a usable local password, the exact
Installation Principal, and native IAM Installation `administer` authority.
The designation is fixed, and account disablement refuses this user. Keep its
password in protected operator custody; out-of-band database or policy changes
can still remove recovery. Password login does not depend on GitHub availability.

Account reads and mutations require a human session, exact `Origin`, and
Installation `administer`; service keys are refused. State locks actor and target
accounts, rechecks the actor session, and requires the target's `expectedVersion`. A concurrent logout or revocation can invalidate
the actor; a stale target version returns `409 RESOURCE_CONFLICT`.

Send `{"expectedVersion":1}` with the version just read for these operations:

| Operation                                 | Effect                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/accounts/:userId/disable` | Disables the account and invalidates its sessions and pending authentication proofs; rejects the protected recovery user. |
| `POST /api/auth/accounts/:userId/revoke`  | Invalidates all account sessions and pending proofs while preserving fresh sign-in, including recovery password sign-in.  |

These operations serialize with session issuance and leave IAM grants unchanged.
An unknown administrative COMMIT returns `503 DEPENDENCY_UNAVAILABLE` with an explicit unknown-outcome message;
it never reports success or triggers automatic replay or compensation. An
account read shows present state, **not a receipt**: the original transaction may
still be running. Resolve uncertainty before choosing a new action and version.
Account reenablement, password reset, deletion, and recovery replacement remain
deferred.

The controller admits at most 30 password requests per minute with four active,
and 60 GitHub start/callback requests per minute with eight active. Invalid
callbacks consume that budget before parsing or provider work. State caps pending
attempt rows at 1,000 per Installation and removes at most 100 expired rows per
start. Token exchange and profile retrieval share a ten-second deadline, refuse
redirects, and accept at most 64 KiB per response. These process-local limits
require the single-controller topology.

## Native admin shared sessions

Agent native admin UI access starts from an ordinary controller browser session.
When the trusted-operator pilot is enabled, the server parses
`nativeAdmin.sharedCookieDomain` and configures the Better Auth session cookie
for that explicit shared OCE parent domain so the console host and derived Agent
hosts can use the same human session. Service API keys do not create browser
sessions and cannot open native admin UI access. When native admin is disabled,
leftover shared-cookie-domain configuration is ignored and Better Auth keeps the
legacy host-only `openclaw_occ` cookie prefix and scope.

The shared cookie parent domain is configured explicitly and validated against
the console origin and Agent host suffix on DNS-label boundaries. Public
suffixes, malformed domains, and hosts outside the configured parent are
rejected; OCC does not infer a broader parent domain from either host. A
domain-scoped cookie cannot use a host-only `__Host-` prefix. The shared-domain
session uses the Better Auth cookie prefix `openclaw_occ_shared`; on HTTPS its
cookie name is `__Secure-openclaw_occ_shared.session_token`. During migration,
successful sign-in/sign-out responses clear prior host-only `openclaw_occ` and
`openclaw_occ_shared` session-cookie names without a `Domain` attribute so
browsers do not choose between duplicate host-only and domain cookies.

Native-host requests authenticate the shared OCE session, resolve the exact
Agent represented by the requested host, authorize exact Agent `administer`, and
validate the current active revision and supported native configuration before
proxying. OCC strips browser cookies, `Authorization`, API keys, forwarded
identity, and native scope headers before forwarding upstream, so the native
gateway never receives the OCE session cookie. Native chat or other Agent-host
activity does not renew the console session.

## Account provisioning

Before GitHub activation, `POST /api/auth/accounts` requires a human session and
`administer` on the singleton Installation. After activation account creation is
frozen: the endpoint returns `409 RESOURCE_CONFLICT` before any account or IAM
write, and no other onboarding path exists yet. Provision accounts beforehand;
using an old binary to bypass the freeze is unsupported.

In the password-only profile, the endpoint creates a Better Auth account, its
explicit IAM Principal, and an AccessBinding to an existing Role. The request must supply `roleId`; it cannot
implicitly create a Role or infer a grant from the account's email or session.
Creating an account does not sign it in or issue a session.

A representative provisioning body is:

```json
{
  "email": "operator@example.invalid",
  "password": "<generated-random-password>",
  "roleId": "role-existing-operator"
}
```

Emails are normalized to lowercase. Passwords must contain 12–128 characters.
The backend provisions the account without a public email-verification or
signup flow. Duplicate accounts are rejected. General account management and
password reset endpoints are not exposed by the controller API.

## Authorization and failures

For each protected request, OCC resolves the session user or service-key
principal through the selected IAM Driver and authorizes the exact resource
operation. Each identity lookup
and authorization decision loads current IAM policy, so account and permission
changes are visible across controller instances. Caller-supplied identity
headers and bearer credentials are not authorization evidence.

| Condition                                                      | Result                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Missing or invalid session or service key on a protected route | `401 UNAUTHENTICATED`.                                                             |
| Valid credential without the required IAM grant                | `403 FORBIDDEN`.                                                                   |
| Duplicate account during provisioning                          | `409 RESOURCE_CONFLICT`.                                                           |
| Authentication or IAM dependency unavailable                   | The request fails closed; dependency failures return `503 DEPENDENCY_UNAVAILABLE`. |

The optional session-inspection route is not a protected resource operation:
anonymous inspection returns `200` with `data: null`.

## Automation credentials

Non-Agent automation uses `x-api-key` with an existing IAM ServicePrincipal. [Service API keys](authentication/service-api-keys.md) defines issuance, credential precedence, exact scope, revocation, audit behavior, and failures. Keys do not inherit their issuer’s permissions or create human sessions.

## Evidence and related references

The [authentication implementation](../../apps/controller/src/auth/index.ts)
owns session verification and safe responses; the
[HTTP routes](../../apps/controller/src/index.ts) own public endpoint exposure
and account-provisioning authorization.

- [Local authentication tests](../testing/local.md#authentication-and-authorization-coverage)
- [Service-key persistence tests](../testing/postgresql.md#service-key-persistence)
- [Service API key flow](../flows/service-api-keys.md)
- [Issue or rotate a service API key](authentication/service-api-keys.md#issue-a-service-key)
- [IAM overview](../guides/topics/iam.md)
- [Authorization](authorization.md)
- [Generated API reference](api.md)
- [Controller settings](settings.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-20 08:53: Replaced native-admin launch-code sessions with the shared OCE session cookie boundary and cookie-domain validation. (cody/01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 5e5f12f37842ae7239d73432e00609547627ded8)

- 2026-08-31 22:29: Define single-attempt bootstrap failure handling with retained artifacts, no automatic recovery, and manual operator repair. (01a05a3d-526f-7553-8cd8-070bd1847acb - 94a5440898bf331987148d7733f0075506af64a6)

- 2026-08-31 17:43: Document fresh human/service administrator bootstrap, private key delivery, and operator recovery. (codex/01a05a69-3fbe-7441-9e6d-20394758cf94 - 0797098646028ac00cb26cd4afcbc9b2cf8bcb24)

- [2026-08-28 20:17]: Allow IAM-authorized service administrators to issue and revoke keys; retain human-session account creation and bootstrap. (codex/01a04927-11d8-7083-a4b7-9f3124559d82 - d4b5b01d02cf68a89965f7c00a0fc7d0dcec18d8)

- [2026-08-28 17:54]: Reorganize as a current feature reference; move procedural setup to the shared guides. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
