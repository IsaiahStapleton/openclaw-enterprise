# Federated sign-in security

[Overview](../31-human-federated-sign-in.md) · [Request lifecycle](architecture.md#request-lifecycle)

The proposal protects a person's stable OCE identity while admitting only an
existing active account. Provider authentication must not create resource
authority, revive revoked sessions, or expose provider credentials. The controls
below remain requirements for the selected delivery, not claims of installed
protection.

## Assets, actors, and trust

The protected assets are human identity, immutable method ownership, local
session credentials, provider client secrets, and the integrity of account and
policy changes. Confusing a provider identity with a local account could admit
the wrong person. Confusing sign-in with authorization could grant that person
access that an administrator never selected.

Treat browsers, CLI clients, callbacks, provider profiles, and Agent workloads as
untrusted inputs. A signed-in human still needs the exact IAM permission for a
resource operation. Configuration selects which providers may establish identity
evidence. It does not grant provider claims authority over OCE resources.

Privileged deployment and database administrators are trusted by this design.
Compromise of those administrators is outside its containment guarantee. That
recorded assumption does not waive protocol checks, currentness, transaction
integrity, or qualification within the supported boundary.

Authentication owns protocol verification and password hashing. The account
owner resolves current method association. IAM owns resource authority. The Agent
retains its independent ServicePrincipal, and repository credential owners retain
custody and execution-time permission checks. No provider email, domain, UPN,
display name, groups, GitHub login, or repository membership conveys OCE authority.

## Protocol validation

Browser binding prevents a callback for one sign-in from authorizing another.
The attempt binds unpredictable state, provider instance, exact callback,
S256 proof key, OIDC nonce, browser-cookie digest, purpose, and permitted return.
S256 uses a hash of a private proof value so possession of the authorization code
alone is insufficient. The nonce binds the ID token to the initiating attempt.

The controller rejects duplicate callback parameters, replay, mismatched browser
or configuration, provider confusion, and unsafe redirects. It atomically consumes
and acknowledges the attempt before remote verification. Expired attempts,
exchange failure, and uncertain persistence fail closed. Shared rate limits and
pending caps cover the browser/provider and Installation, rather than only one
controller process. These controls address login CSRF and concurrent callbacks.

OIDC means OpenID Connect, the identity layer used here with an authorization-code
exchange. Require the ID token and complete
[token-response validation](https://openid.net/specs/openid-connect-core-1_0.html#TokenResponseValidation):

- Validate required claim types and the signature using a permitted algorithm.
- Require the exact configured issuer, the intended audience, and a valid
  authorized-party claim where required.
- Check issued-at and expiry using bounded clock skew. Enforce not-before when
  present.
- Validate nonce and immutable subject. If UserInfo is consulted, its subject
  must match the validated ID token.

Discovery remains pinned to the configured issuer. Restrict every remote
discovery, token, signing-key, and UserInfo endpoint to the allowed origins and
bound timeouts, response sizes, and redirects. Validate public origin and exact
callbacks. HTTP is allowed only for explicit loopback development fixtures.
These rules prevent endpoint selection from becoming arbitrary server-side
network access.

Google uses its canonical issuer. GitHub exchanges the authorization code, then
calls authenticated `/user` for the numeric user ID. An OAuth App requests only
necessary identity permissions. A GitHub App uses a separate identity-only
registration without additional repository or organization permissions, and
expanded registrations are rejected.
[OAuth scopes cannot narrow GitHub App user-token permissions](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).
Repository App and installation-token issuance remain separate capabilities.

Immutable provider-instance identity and exact subject matching prevent automatic
account association by convenient profile fields. Email may be absent. Matching
email must never merge accounts or attach a method. See the
[identity contract](interfaces.md#provider-configuration-and-identity).

## Session and credential custody

Adapters discard all login provider tokens after verification and avoid
unnecessary offline access. Their result contains no tokens, raw claims, account
choice, or authority. Provider credentials never reach the human CLI. No identity
or credential belongs in a redirect URL.

The session owner must prevent late insertion from restoring revoked access.
Security changes invalidate sessions in the same original transaction. Every
issuer and reader must follow the [session contract](interfaces.md#sessions-and-no-access)
and [account transitions](account-lifecycle.md#administration-and-currentness).

Required session persistence and login facts must receive commit acknowledgment
before credential release. An uncertain acknowledgment releases no credential and
authorizes no blind replay. State retains responsibility for distinguishing
rollback, committed outcome, and uncertainty.

Protocol failures expose fixed nonsensitive errors and request IDs. Redact raw
provider errors, claims, codes, tokens, cookies, and secrets before they reach
responses, logs, or audit. Account audit uses closed local account, Principal,
method, operation, and currentness references with fixed outcomes. It joins the
common ledger without inventing an Agent subject. Durable audit and History must
exclude external subjects, email, profiles, raw claims, and provider error text.

External identity details appear only in authorized account management or the
direct no-access response. They must not appear in URLs or telemetry. The
[proposed same-origin response](interfaces.md#sessions-and-no-access) confines
disclosure to the verified initiating browser without persistence or third-party
assets. Its exact presentation remains an owner decision.

CLI cookie custody uses an origin-bound owner-only file. Atomic file operations
reject unsafe permissions and symlinks, while cross-process serialization covers
aliases for the same file. TLS verification, redirect restrictions, explicit
credential selection, and failed-logout retention follow the complete
[CLI contract](interfaces.md#human-cli).

## Accepted limits and closure

The recorded trust and scope limits are specific. Provider suspension does not
continuously revoke OCE sessions. Local logout, disablement, and account-wide
revocation provide the selected local controls. Deployment or database
administrator compromise is outside containment. Continuous provider offboarding
requires a new product selection. None of these statements accepts a defect in
the required controls.

The last usable local-password administrator must remain enabled and authorized
under the complete candidate policy, including Groups and overriding
Restrictions. Independent local recovery is an invariant, not permission to fall
back after a failed selected identity. Its transaction and concurrency rules
belong to [account lifecycle](account-lifecycle.md#atomic-policy-and-recovery).

Required but unfulfilled evidence includes real controller and PostgreSQL
composition, protocol negatives, two-controller revocation races, token
nonretention, independent SQL review, and complete security-boundary review.
Lifetime exposure and no-access presentation remain explicit proposals. Their
missing decisions are not accepted residual risks.

Protected credential closure, physical runtime stop, cleanup, and unknown provider
effects remain separate outcomes from local session denial. Their owners retain
the independently qualified withdrawal deadlines described in
[delivery](delivery.md#decisions-and-follow-ups). The browser delivery cannot claim
those outcomes from a local account transaction. Installed HTTPS and actual
provider registrations need separate qualification for each delivery.
