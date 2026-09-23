# Federated sign-in security

[Overview](../31-human-federated-sign-in.md) · [Lifecycle](architecture.md#request-lifecycle)

These controls are requirements of the proposed GitHub increment, not claims of
installed protection.

## Assets, actors, and trust

Protect stable human identity, immutable method ownership, session credentials,
provider secrets, and local mutation/audit integrity. Treat browser, callback,
profile, CLI, and workload inputs as untrusted. Deployment and database
administrators remain trusted; their compromise is outside containment.

Provider email, domain, UPN, display name, groups, GitHub login, and repository
membership confer neither association nor authority. IAM authorizes exact resource
operations. Agent ServicePrincipals and repository credential custody remain
independent of human authentication.

## Protocol validation

Reserve an unpredictable-state attempt for **at most ten minutes**, bound to
purpose, Installation, immutable provider instance, exact callback, S256 PKCE
verifier, initiating browser-cookie digest, and permitted local return. PKCE binds
the code exchange to its private verifier. Use Secure, HttpOnly, host-only attempt
cookies with the qualified SameSite policy; session-cookie sharing must not widen
the attempt cookie.

Acknowledge reservation before redirect. Reject duplicate or ambiguous callback
parameters, replay, expiry, browser/provider/configuration/purpose mismatch, and
unsafe returns. Atomically consume the matched attempt, including valid
provider-error callbacks, and acknowledge consumption **before remote work**.
Uncertain consumption stops exchange; consumed failures require a new start.
For the single-controller profile, bound start/callback admission, concurrent work,
and rate-limit key storage locally. Apply admission limits to invalid callbacks
before remote work. Bound persisted pending attempts and cleanup work so restart
cannot bypass storage limits. A distributed quota service is outside this profile.

Exchange the code and call authenticated `/user` for the exact numeric subject,
using only necessary identity permissions. No email enrichment is required.
Perform remote work outside account/policy locks. Reuse qualified Better Auth
request construction and token parsing with **scoped bounded transport for both
calls**: server-owned endpoints, full-operation cancellation through body reads,
finite response bytes, refused redirects, and fixed sanitized errors. A direct
helper call, outer promise timeout, or process-global fetch replacement is not
proof of those bounds.

The first application kind is an OAuth App. A login GitHub App is deferred; if
selected later, qualify a separate identity-only registration and refuse unknown
or expanded repository/organization permissions. OAuth scopes cannot narrow a
[GitHub App's user-token permission profile](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app). Never reuse the Agent repository App.

## Session and credential custody

Provider access, refresh, and ID tokens remain transient controller inputs and
are discarded after verification. Avoid unnecessary offline access. No provider
credential reaches OCE session/account cookies, persistence, the CLI, or Agents.
Provider tokens, OCE session credentials, and external subjects must not enter
redirect URLs. OAuth authorization responses still use the protocol's
code/state or error parameters.

[Guarded issuance](architecture.md#request-lifecycle) prevents stale sessions from
restoring revoked access and requires acknowledged session/fact persistence before
cookie release. Fixed nonsensitive errors may include request IDs. Redact raw
provider errors, claims, codes, tokens, cookies, and secrets before responses,
controller logs, ingress/access logs, audit, or telemetry.

Required facts use closed local account, Principal, method, operation, and
currentness references with fixed outcomes, never an invented Agent subject.
Exclude external subjects, email, profiles, and raw claims from durable audit and
History. External identity details are limited to authorized management and the
documented [administrator verification procedure](interfaces.md#sessions-and-no-access).
Current-state inspection must meet the same privacy constraints.

## Future OIDC controls

If a future OIDC provider is selected, retain [the original nonce, token, claim,
and endpoint-validation contract](https://github.com/openclaw/openclaw-enterprise/blob/085610f971591221b0f9c6e036e1cd7a4de89e0d/specs/31-human-federated-sign-in/security.md#protocol-validation)
and qualify the actual provider independently. This is conditional scope.

## Accepted limits and closure

The proposed local disable and revoke operations provide local offboarding; provider suspension does not
continuously revoke OCE sessions. The protected usable password administrator
and [recovery transaction](account-lifecycle.md#atomic-policy-and-recovery) remain
mandatory. A failed selected identity never falls back to another credential. Existing tools retain explicit service-key precedence, credential-conflict rejection, TLS verification, and redirect restrictions; new browser-assisted CLI approval remains deferred.
Unfulfilled controls are not accepted residual risk.

Local session denial does not prove repository transport closure, physical Agent
stop, cleanup, or resolution of unknown provider effects. Those receivers retain
their separately qualified withdrawal contracts. Human login adds no runtime
identity dependency. [Acceptance](delivery.md#acceptance-evidence) separately
requires composed, installed HTTPS/logging, live-registration, and release proof.
