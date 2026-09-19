# Federated sign-in interfaces

[Overview](../31-human-federated-sign-in.md) · [Request lifecycle](architecture.md#request-lifecycle)

This page defines the complete known contracts in the
[published proposal](https://github.com/openclaw/openclaw-enterprise/blob/15ecf3ad27757900227bb1982b2e600468482303/specs/31-human-federated-sign-in.md).
Current source supplies ordinary password sessions and service keys. Browser
federation, joint administration, enterprise profiles, and human CLI are proposed
consumers. Known operation names below are not newly selected HTTP routes or
exported TypeScript types. Unspecified shapes remain owner decisions.

## Provider configuration and identity

Operator-owned `authentication.providers` selects a finite trusted set.
Client secrets come from absolute mounted file paths. Validate the public origin,
exact callbacks, immutable trust tuples, and allowed HTTPS endpoint origins.
Permit HTTP only for explicit loopback development fixtures. Empty configuration
preserves existing local-password and service-key behavior.

A provider instance identifies one immutable trust configuration, rather than its
display label. Derive its identity from a versioned tuple:

| Provider                | Immutable tuple                                           | Verified subject                                 |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| Google or ordinary OIDC | Exact issuer, client ID, fixed subject policy             | Validated `sub`                                  |
| GitHub                  | Exact web origin, API origin, client ID, application kind | Authenticated numeric user ID                    |
| Entra                   | OIDC trust configuration plus the pinned tenant           | Validated immutable object ID within that tenant |

Google uses its canonical issuer. Labels, route names, and secret rotation do not
change provider identity. Changing issuer, client, tenant, or subject rule creates
a different instance. Persisted methods use the exact provider-instance/subject
pair, with one owner per pair. Multiple methods may identify one human.

The adapter's trusted result is an opaque, server-created provider-instance and
subject pair with an optional safe profile. It contains no provider tokens, raw
claims, local account selection, or authority. Email, domain, UPN, display name,
groups, GitHub login, and repository membership cannot confer OCE authority.
Provider email may be absent. Account association follows
[immutable method ownership](account-lifecycle.md#identity-and-method-ownership).

## Browser operations

Expose curated provider-list, trusted-origin start, and exact provider callback
operations. Never mount an unrestricted authentication-library handler. The known
start input is `{ providerId, returnTo? }`, and its result is an authorization URL.
The optional return must be a permitted local destination. Concrete route names,
DTO exports, response envelopes, and error codes remain unselected.

Controller authentication uses declared `openid-client@6.8.8` and internal OIDC
and GitHub adapter families. Their selected signatures are:

```text
authorizationURL(attempt)
verifyCallback(consumedAttempt, callbackURL)
```

The first builds a redirect from the bound attempt. The second accepts an already
consumed attempt and returns the identity-only result above after full protocol
validation. These are proposal signatures, not claims of exported source types.
Adapters never mutate policy.

Reserve an unpredictable-state, browser-bound attempt in existing verification
storage for **at most ten minutes**. It binds purpose, provider instance, exact
callback, S256 verifier, OIDC nonce, browser-cookie digest, and permitted local
return. The callback must match that stored configuration and browser.

1. Reject duplicate parameters, replay, configuration/browser/provider mismatch,
   expiry, and unsafe redirects.
2. Atomically consume the attempt and acknowledge persistence before exchanging
   the authorization code. Uncertain consumption fails closed. A consumed
   callback cannot retry successfully.
3. Perform remote verification outside State locks. Bound discovery, token,
   signing-key, and UserInfo timeouts, response sizes, and redirects. Pin discovery
   issuer and endpoint origins. Exchange failure releases no session.
4. Resolve current method ownership, then insert a fresh ordinary session and
   mandatory login evidence in a short guarded transaction. Recheck active state,
   ownership, currentness, and expiry. Return a credential only after acknowledged
   persistence. An uncertain result releases none and permits no blind replay.

Apply shared start/callback rate limits and pending-attempt caps across
browser/provider and Installation. Bounded cleanup expires attempts. Exact rate,
cap, and remote-call bound values are not supplied by this proposal.

OIDC requires an ID token and complete
[protocol validation](security.md#protocol-validation). GitHub exchanges the code
and calls authenticated `/user`. Discard all login provider tokens after
verification. Failures expose fixed nonsensitive errors and request IDs, with
provider text and credentials redacted before responses, logs, or audit.

For example, a valid Google callback for a provisioned active method can produce
one fresh cookie after session and login-fact commit. The same callback repeated
after consumption cannot issue another session. A valid identity without a local
method receives the no-access outcome below. These are behavioral examples, not
wire exchanges or executed tests.

## Account administration

A current human session with Installation `administer` authorizes all selected
account administration operations. Authentication owns password hashing and
protocol verification. Bootstrap administrator seeding remains explicit.

| Operation                 | Known inputs and checks                                       | Required effect or result                                                              |
| ------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Provision                 | One initial password or external method and explicit grants   | Account, method, grant-free Principal, selected grants, and activation commit together |
| Read or contact lookup    | Authorized account reference or exact contact email           | Safe account and method details                                                        |
| Attach, remove, or repair | Expected account incarnation/version and current method owner | Apply the method transition and invalidate affected sessions                           |
| Enable or disable         | Expected current account state                                | Apply the lifecycle rules without inventing grants                                     |
| Revoke all sessions       | Current target account                                        | Invalidate browser and CLI sessions                                                    |
| Add or remove grants      | Selected IAM catalog and expected policy revision             | Apply the authorized explicit policy change                                            |

Mutations carry an operation reference and expected incarnation/version. Repair
checks both affected owners and replaces the immutable method association with a
new method ID. All account, method, Principal, policy, receipt, audit, and required
narrowing effects share the original State transaction. Full transition and
recovery behavior belongs to [account lifecycle](account-lifecycle.md#atomic-policy-and-recovery).

The selected IAM administration capability owns its fixed role/action catalog,
four grant-target forms, bounded ordered command batches, expected policy revision,
and durable withdrawal. Account administration consumes this contract without an
OIDC-specific role, policy writer, or native fallback. Unsupported selected
capabilities fail closed. The
[RBAC proposal](https://github.com/openclaw/openclaw-enterprise/pull/245)
owns the complete shared catalog and transaction protocol.

The selected proposed `IAMPolicyAdministrationV1` contract has a `bindPolicy`
operation that accepts an original-State read or write transaction token and
returns the corresponding read or write unit. This Driver contract differs from
OCC facades. Read units expose `readPolicy` and `authorizeCurrent`. Write units
also prepare a candidate, authorize that candidate, and accept it with local
administrator evidence. A prepared receipt is not commit acknowledgment. The
result union distinguishes committed, conflict, denied, unavailable, and unknown
outcomes. RBAC’s Policy administration and Policy outcomes and recovery sections
own these proposed contracts. They do not establish connected federation.

The account participant consumes the proposed `IAMPolicyAccountChangeV1`.
Its complete known members are `kind: "human_account"`, `operationRef`,
`expectedPolicyRevision`, owner-issued `account` evidence, `enrollPrincipal`, and
`grants`. Enrollment ensures the canonical account-to-Principal mapping without
implicit grants. Each grant selects either a fixed catalog role with a supported
grant target or an existing role with an exact resource target. Account evidence,
local-administrator evidence, transaction tokens, and candidates are nominal
owner-created values, not caller-supplied authority DTOs. The
[RBAC proposal](https://github.com/openclaw/openclaw-enterprise/pull/245) owns the
full type family in its Policy administration section.

Failed or unknown COMMIT never authorizes destructive compensation or blind
replay. Authorized exact receipt lookup recovers the original operation, result,
and revisions. Changed content conflicts. Missing evidence remains unknown.

**Proposal, account/State owner review required:** retain an owner-issued,
nonempty account-operation digest of at most 200 characters unchanged. It is
distinct from the policy-command digest. Its encoding remains undecided.

For example, repair of a wrongly associated method preserves both human identities
and their grants while invalidating both accounts' sessions. If commit
acknowledgment is lost, recover by the original operation reference. Do not delete
either account to compensate. No administrative route or DTO is implied.

## Sessions and no access

Use the existing Better Auth stored-session and cookie owner. Bind each session
to its exact method, account incarnation/version, and absolute expiry. Insertion
and admission recheck active account, current method owner, currentness, and
expiry. Password, provider, and CLI issuers, session display, API admission, and
logout all share these checks. Constraints and original-transaction guards must
prevent a late insert from restoring revoked access.

The common browser lifetime has an **eight-hour absolute default**, with sliding
refresh disabled. Eight hours is not a universal browser maximum. Ordinary logout
revokes the selected stored session. Disablement or account-wide revocation
invalidates browser and CLI sessions. Grant removal affects the next IAM decision.
Provider suspension does not continuously revoke local sessions.

**Proposal, session/product/operator decision required:** initially expose only
that default, without a lifetime settings UI. Issuing clock, configurability or
ceiling, and effects on existing sessions remain unresolved. Qualification must
cover every affected issuer and reader.

An unknown verified person receives the actionable provider-instance/subject pair
and no OCE session. **Proposal, Auth/Console decision required:** render escaped
inert text directly to the verified initiating browser in a same-origin,
no-store, referrer-protected response. It includes no third-party assets,
persistent storage, tickets, or retrieval endpoint. Identity details must not
enter URLs, logs, telemetry, or durable audit.

Replaying that response requires fresh sign-in. A copied subject does not expire.
Any redirect or retrieval alternative needs an approved finite, browser-bound,
one-use design. Never put identity or credentials in redirect URLs.

## Enterprise profiles

These are selected deliveries after the browser increment, not optional future
scope. Standards-based and Okta profiles use the issuer-pinned OIDC adapter.
Okta organization and custom authorization servers are distinct issuers.

Entra requires a concrete tenant GUID and tenant-specific v2 issuer. Validate
token version `ver`, tenant `tid`, immutable object ID `oid`, and subject `sub`.
The configured tenant bounds the object identity. Reject browser-selected issuers
and multitenant issuer templates.

Enterprise GitHub binds exact web and API origins. S256 is required. Unsupported
enterprise versions remain unavailable, with no downgrade. Each actual provider
profile needs its own registration and installed-origin qualification.

## Human CLI

The selected CLI delivery uses an OCE request, approval, and exchange flow:

1. The CLI opens a loopback listener and creates S256 proof and client state. It
   requests browser authorization lasting **five minutes**.
2. A current signed-in person explicitly approves the displayed OCE origin and
   account. Approval atomically consumes the request. Store a **60-second one-use**
   code digest with exact origin, approving-session, and proof bindings.
3. Deliver the code only to the recorded
   `http://127.0.0.1:<port>/oauth/callback`. Require a single code and matching
   client state. Close the listener after a terminal outcome.
4. Exchange directly over HTTPS, rechecking proof, current account, and approving
   session. Acknowledged issuance creates an independent ordinary OCE CLI session.
   Its expiry is capped by both **eight hours** and the approving session's expiry.
   Uncertain exchange permits no blind replay or unacknowledged credential release.

Provide `occ auth login`, `occ auth status`, and `occ auth logout`. The normal OCC
resource client uses the signed session cookie from an origin-bound, owner-only
file. Atomic file operations reject unsafe permissions and symlinks. Cross-process
ownership serializes access even through aliases.

Preserve explicit service-key selection and reject conflicting credentials.
Verify TLS, prohibit unsafe redirects, and never fall back after selected
credential failure. No provider credential reaches the CLI. Status checks the
stored account. Logout deletes the protected file only after acknowledged absence
of the actual stored session. Failed server revocation retains the file for a
later logout attempt.

A successful flow leaves a separate bounded CLI session, not the browser cookie
or a provider token. A failed logout leaves the existing file protected so that
the same stored session can be revoked later. Full wire shapes and filesystem
encoding are not selected here.

## Owner decisions

Authentication and account owners must select concrete route names, DTOs, response
and error envelopes, and unspecified bound values before implementation acceptance.
They must preserve the known checks and outcomes above. Public signatures or
examples must not invent those choices.

Account and State owners must close account-operation digest encoding and exact
receipt recovery. Session, product, and operator owners must decide browser clock,
lifetime exposure, configurability, and existing-session effects. Authentication,
Console, and product owners must select and qualify the no-access presentation.
The published default-only and direct-response proposals remain proposals.

The [delivery gates](delivery.md#decisions-and-follow-ups) require recorded owner
decisions and real-consumer evidence. A missing shape does not waive its required
behavior or turn a later selected enterprise or CLI delivery into an option.
