# Federated sign-in architecture

[Overview](../31-human-federated-sign-in.md)

The proposed GitHub path connects existing owners inside OCC. Authentication
verifies evidence, Account resolves the stable human, State commits local effects,
and IAM authorizes resource use. These boundaries do not require new services.

## Components and dependencies

| Owner                        | Reuse and proposed responsibility                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Better Auth / Authentication | Existing password verification, token generation, signed cookies, and provider request/parsing machinery; curated OCE endpoints control admission.   |
| Account / original State     | Existing user, method, session, and verification storage; add one currentness authority and guarded attempt, administration, and session operations. |
| Selected IAM                 | Exact Principal lookup and per-resource decisions; attachment changes no policy.                                                                     |
| Console                      | Existing session, Namespace, and Agent APIs; clear protected content when admission expires.                                                         |

Provider proof is a controller-private value, not a caller-manufactured authority
object. It carries the verified instance/subject and optional safe profile, never
provider credentials, raw claims, a local-account choice, or grants. Password
verification likewise occurs outside locks and supplies a captured credential and
currentness snapshot to guarded issuance.

Use a curated Better Auth plugin and request-scoped adapter. The adapter returns
State-authoritative session dates to the library; cookie age derives from that
deadline, with a final expiry check after commit. Disable refresh, cookie caching,
and secondary session storage. A generic callback, library transaction, or later
audit hook does not establish the required original-State transaction. The
[transport contract](security.md#protocol-validation) applies to both GitHub calls.

## Request lifecycle

![Proposed GitHub lifecycle with acknowledged attempt consumption and session commit](request-lifecycle.svg)

This entire sequence is proposed. Solid sequence arrows mean requests and dashed
arrows mean replies; they do not classify implementation. State and PostgreSQL are
shown together as the original persistence owner. Source checks do not establish
composed, installed, or live-provider proof. [Editable source](request-lifecycle.mmd).

1. Reserve the [bound attempt](security.md#protocol-validation) in existing
   verification storage and acknowledge persistence before redirecting.
2. Match and atomically consume it, including valid provider-error callbacks.
   Uncertain consumption stops remote exchange. A consumed failure needs a fresh
   start.
3. Outside account/policy locks, perform bounded code exchange and authenticated
   `/user` lookup. Verify the numeric identity and discard provider tokens.
4. In one short original State unit, resolve the exact current method and
   Principal, recheck active account/currentness, and insert a fresh ordinary
   session plus required login facts. Constraints and guards prevent late
   insertion from restoring revoked access.
5. Release the cookie only after acknowledged completion and the final expiry
   check. Unknown identity follows the [no-access contract](interfaces.md#sessions-and-no-access).
   Failed audit or unknown commit returns no credential and permits no replay.

State retains transaction lifetime and acknowledgment authority; no raw client or
second COMMIT crosses to Authentication. Use READ COMMITTED and the shared lock
order: Installation authority, sorted account/session guards, applicable
policy/head and resource guards, then retention/audit. No late lock upgrade,
nested COMMIT, fabricated evidence, or post-commit backfill is permitted. Drain
admitted work before committing; failure prevents acceptance. Account supplies
old/new currentness; IAM retains policy and runtime-withdrawal ownership.

The initial fixed-policy profile does **not** assert transaction-bound IAM reads.
Main's IAM independently reloads policy. Qualify its bounded writer set and
preservation of effective Installation authority as described under
[recovery](account-lifecycle.md#atomic-policy-and-recovery). Joint policy mutation
requires its own genuine IAM/State participation if later selected.

## Availability and tradeoffs

[Activation and supported consumers](account-lifecycle.md#activation-and-supported-consumers)
define the maintenance transition, creator compatibility gap, and startup refusal
when required configuration disappears. Provider failure never selects another
provider, development identity, or more privileged credential. Unsupported IAM
capability refuses activation without native fallback. Required facts remain
mandatory even without optional export or a History UI.

## Current source and proposed joins

At pinned main `311bc23`, the following are source facts, not federation proof:

| Exact source                                                                                                                                                                                                                                                                                                                                 | Consequence                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Auth and production composition](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/apps/controller/src/composition/production.ts#L79-L97)                                                                                                                                                       | Better Auth exists; the guarded Account/State join must be connected.                       |
| [Existing auth tables](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/packages/occ/src/state/postgres-schema.ts#L974-L1069)                                                                                                                                                                   | Reuse storage; sessions do not yet carry method/incarnation/version binding.                |
| [State transaction](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/packages/occ/src/state/postgres-state.ts#L896-L909) and [audit append](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/packages/occ/src/state/postgres-state.ts#L2406-L2429) | Auth writes must join this original unit and its acknowledgment boundary.                   |
| [Password-account creation](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/apps/controller/src/index.ts#L3502-L3558)                                                                                                                                                                          | Separate auth/IAM writes with compensation are unsuitable for the new attachment operation. |

The separate [historical integration record](https://github.com/openclaw/openclaw-enterprise/blob/65380694085693d6edb5218372ccddbc2ba493d9/migrations/0032_account_security_records.sql#L9-L44)
has a password-dependent active shape. It is reference material, not merged-main
or external-only-account support. Canonical migration and composition remain
[acceptance work](delivery.md#acceptance-evidence).

## Identity and method ownership

Better Auth `user.id` remains the immutable human subject under the
Installation-specific OCC issuer. Preserve account and Principal IDs, the genuine
password method, unique manually supplied contact email, and grants. Provider
email may be absent and never selects the local owner.

Persist one immutable owner for each exact provider-instance/subject pair in the
existing method store. Several methods may identify one account. Attachment
cannot retarget an existing pair or merge people. A future repair must replace
an association with a new method ID; broad repair is outside this increment.

## Administration and currentness

Use one account-security record: UUID incarnation, positive safe-integer version,
and active/disabled state. Preserve non-reusable deleted tombstones. Missing,
orphaned, provisioning, deleted, or disabled state denies admission. Sessions bind
the exact method, account incarnation/version, and absolute expiry. All retained
issuers and readers recheck those values and current ownership.

The minimal administrator surface is safe target read, exact GitHub attachment,
disable, and account-wide revoke. Require a trusted origin, a current **human
session**, and effective `administer` on the server-owned
Installation through the qualified IAM profile. A service key or explicit
development identity cannot substitute. Accept no caller-selected Principal or
grant. Authentication retains password hashing and provider verification.

Mutations require the expected account incarnation and `expectedVersion`.
Under original-State guards, recheck those values, the actor's current session,
target, exact Principal, method owner, and recovery protection. Persist the complete
local effect and required facts in that unit. Currentness changes serialize with
issuance and actor logout/revocation; stale snapshots cannot restore access.

| Operation           | Required effect                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attach GitHub       | Add the unique immutable method, advance target currentness, invalidate affected sessions; identity, password, and grants remain unchanged.                       |
| Disable             | Advance currentness and invalidate existing sessions; fresh login also denies.                                                                                    |
| Revoke all sessions | Advance currentness and invalidate existing sessions; fresh authentication remains possible.                                                                      |
| Ordinary logout     | Revoke only the selected stored credential, including an expired/stale row; clear its cookie only after acknowledged absence. Persistence failure is not success. |

Grant removal takes effect at the next IAM decision; sessions cache no grant
authority. Provider suspension does not automatically revoke local sessions.
Broader method management remains outside this increment.

## Atomic policy and recovery

Designate an existing enabled, usable local-password administrator with its exact
Principal and effective native Installation permission. A role label is
insufficient. Protect that recovery path against every exposed account or policy
write; prove password sign-in and an authorized administration operation during
a GitHub outage.

The initial proposal qualifies native IAM with a bounded writer set and fixed
Installation authority. Its [exposed deletion predicates](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/packages/occ/src/state/postgres-state.ts#L2290-L2305)
are Namespace-scoped; this supports the bounded profile but is not a complete
writer audit. Cover or exclude bootstrap/seeding, account provisioning, external
policy writers, and every recovery-affecting write. Independently mutable IAM
requires an enforceable preservation
contract or activation refuses it, without fallback. Calling ordinary IAM inside
an auth transaction does not make its separate reads transaction-bound.

Preserve committed, conflict, denied, unavailable, and unknown outcomes. Failed or
unknown COMMIT permits neither destructive compensation nor automatic replay.
Return explicit outcome-unknown; never silently refresh the expected version. A
separately authorized, guarded read shows current account/method state, not the
result or attribution of the original request. Unresolved transactions may require
waiting or an unavailable response; an absent visible effect does not prove
rollback. After inspection, the operator may deliberately issue a new action.
Exact per-request result retrieval is outside this increment. Required local facts
share the retention-compatible ledger and acknowledged transaction. Optional
export and History serving cannot substitute for that persistence.

## Activation and supported consumers

These are **proposed first-profile choices**, not claims of existing support:

| Surface                                                 | Profile contract / acceptance condition                                                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Password and GitHub sessions                            | Same guarded issuer/reader, State-derived eight-hour absolute deadline, no refresh/cache/secondary storage. Expiry equality denies; cookie age follows persisted expiry.                               |
| Account-client login, inspection, API admission, logout | Preserve through the common currentness owner; inventory and qualify every retained caller.                                                                                                            |
| Shared-cookie/native administration                     | Outside the initial host-only Console profile; refuse activation when enabled. Existing consumer compatibility remains open.                                                                           |
| Password-account creation                               | Provision accounts before activation; refuse `POST /api/auth/accounts` before any user/password/IAM write once active. Safe creation remains an open compatibility obligation, not a permanent waiver. |
| Service keys and explicit development mode              | Preserve their existing separate behavior and explicit credential precedence; neither supplies human attachment authority or failed-login fallback.                                                    |

The supported topology has **one serving controller**, one Installation, Native
IAM, restricted-role PostgreSQL, one canonical HTTPS Console origin, and host-only
cookies. Additional auth readers and custom IAM are outside this profile. Use existing ingress,
deployment, and process controls to close admission, drain or terminate admitted
work, stop every old controller, and prevent automatic restart. In one acknowledged
maintenance transition, validate the existing account/Principal/recovery population,
establish currentness and protected recovery, invalidate unbound legacy sessions,
and persist activation. Preserve legitimate accounts/passwords/grants. Start only
the selected compatible controller and configuration; check password recovery and
guarded admission before reopening ingress.

Qualify the actual installed procedure, including exclusion of old replicas and
in-flight work. If existing controls cannot guarantee exclusion, do not activate.
Startup checks alone are insufficient. Mixed-version serving, rolling upgrades,
and reverting to an old binary after activation are unsupported. This profile
requires no new controller supervisor or database version-fencing subsystem.

Never-activated installations retain the existing password profile when GitHub is
unconfigured. Once active, removing required profile configuration refuses
startup until restored, with controller unavailability explicitly expected.
Provider outage with valid configuration must preserve password recovery. Missing
configuration cannot restore pre-profile admission. Creator and retained-consumer
gaps remain visible until implementation proof or explicit scope disposition.

## Provider configuration and identity

The first profile proposes one operator-configured github.com **OAuth App**.
Derive immutable provider-instance identity from a fixed domain-separated tuple
of exact web origin, API origin, client ID, and application kind. Use the authenticated numeric
GitHub user ID as the exact subject. Secret rotation and display labels preserve
the instance; changing a trust field creates a different instance and cannot
reinterpret persisted methods or in-flight attempts. A helper's fixed provider
name is insufficient.

Secrets come from absolute mounted file paths and remain in controller custody.
Validate the public origin, exact callback, and allowed HTTPS endpoint origins;
HTTP is limited to explicitly selected loopback fixtures. Browsers cannot supply
issuers or endpoints. The [account owner](#identity-and-method-ownership)
owns unique association; provider proof contains no credentials or local authority.

## Sessions and no access

[Currentness and expiry](#activation-and-supported-consumers)
apply to password and GitHub sessions alike. Unknown verified identities receive
**no OCE session**.

Return a generic denial. Provide a usable administrator procedure to verify the
exact numeric github.com subject and independently confirm the explicitly chosen
existing OCE account before attachment. Email, GitHub login names, and copied
subjects alone do not establish local ownership. No handoff store or new callback
display is required. Identity stays out of URLs, logs, telemetry, and durable audit;
authorized management retains only the exact association it needs.
