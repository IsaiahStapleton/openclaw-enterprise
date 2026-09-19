# Federated sign-in architecture

[Overview](../31-human-federated-sign-in.md)

The proposal connects provider verification to the existing human account and
session owners. Authentication establishes who signed in. IAM decides what that
human may do. A successful provider exchange alone satisfies neither account
admission nor permission to use an Agent.

## Components and dependencies

Better Auth remains the controller's account and session persistence owner.
Its `user` identifies the human, `account` records represent authentication
methods, and ordinary stored sessions supply cookies. Existing verification
storage holds short-lived login attempts. There is no second identity or session
store and no enrollment service.

The controller hosts internal OIDC and GitHub adapters. They perform remote
protocol work and return identity-only evidence to the account owner. They do
not choose the local account or mutate policy. The selected dependency is
`openid-client@6.8.8`, as declared by the proposal. The
[adapter contracts](interfaces.md#browser-operations) retain that proposal status.

The selected IAM Driver resolves the stable human Principal and authorizes each
exact resource operation. A Principal is the local identity to which IAM grants
apply. The Agent's ServicePrincipal and runtime authority remain independent.
Repository credential owners keep token custody and execution-time authorization.
Repository assignment and repository use are distinct permissions.

State owns the original PostgreSQL transaction and acknowledgment of its commit.
Account changes, policy changes, required audit facts, and narrowing intent must
join that transaction. Audit facts are closed descriptions of local events, not
copies of provider claims. These owners can participate in one process without
becoming separate network services. The account participant consumes the
[shared transaction protocol](account-lifecycle.md#atomic-policy-and-recovery)
through the selected Driver, with no alternate native writer.

Console consumes the ordinary authenticated OCC APIs. The later human CLI also
uses the normal resource client after obtaining its independent stored session.
Both depend on the same account-currentness rules. Their user interfaces do not
create a parallel authorization path.

## Request lifecycle

![Proposed browser sign-in through controller, provider, original State transaction, and authorized Console operations](request-lifecycle.svg)

Proposed lifecycle. Time flows downward. Solid sequence arrows are requests and
dashed arrows are replies. Existing session infrastructure does not establish
these proposed joins or installed federation. [Editable Mermaid source](request-lifecycle.mmd).

1. **Reserve a browser attempt.** A trusted-origin start selects a configured
   provider and a permitted local return. The controller persists the bound,
   short-lived attempt before directing the browser to the provider. The
   [browser contract](interfaces.md#browser-operations) defines its fields and
   bounds. Failure to establish the attempt stops the sign-in.
2. **Consume before verification.** The exact callback must match the browser,
   provider, configuration, and attempt. Atomically consume the attempt and
   acknowledge that consumption before exchanging the code. Replay, expiry, or
   uncertain consumption denies the callback. A consumed callback cannot later
   retry successfully.
3. **Verify outside State locks.** The controller performs bounded remote token
   and identity verification after consumption. It does not hold account or
   policy locks while waiting for the provider. Exchange failure stops issuance.
   A successful adapter returns only verified provider-instance and subject
   evidence with an optional safe profile.
4. **Resolve and commit locally.** In a short guarded transaction, the account
   owner resolves the method's current association. It rechecks active state,
   ownership, incarnation, version, and expiry before inserting a fresh ordinary
   session and required login evidence. Constraints prevent late insertion from
   restoring revoked access. The original State owner must acknowledge this
   commit before a credential leaves custody.
5. **Return the allowed outcome.** An unknown verified identity receives the
   [no-access result](interfaces.md#sessions-and-no-access) without a session.
   Uncertain session persistence returns no cookie and permits no blind replay.
   Only acknowledged issuance returns the ordinary cookie, after which IAM
   evaluates every requested Console operation.

The ordinary Console workflow is Configuration creation, exact Configuration
read, Agent creation, and a supported lifecycle operation. It requires the
[specific creation and companion grants](account-lifecycle.md#console-grants).
Agent creation alone does not deploy an Agent or create an AgentRevision.

## Availability and tradeoffs

Operators configure a finite set of trusted providers. The browser selects from
that set, rather than introducing a new issuer or endpoint. A selected-provider
failure stays a failure. It must not silently choose another identity or fall
back to a more privileged credential.

An empty provider list preserves local-password login, the explicitly provisioned
development administrator, and service API keys. Provider outage preserves
independently selected local administrator recovery. The account lifecycle keeps
that recovery path usable under the full candidate policy, including Group
membership and overriding Restrictions.

The browser path requires only its account and selected-IAM capability. If a
required capability is unavailable, administration fails closed. It does not
switch to native IAM or add an OIDC-specific writer. Supported account-client
authentication survives migration through internal composition, without a
caller-selectable bypass.

Protected model execution, workload identity, egress, active authority withdrawal,
and History serving have separate qualification gates. They are not prerequisites
for obtaining an authorized browser session. Required login facts still commit
through the common retention-compatible ledger before cookie release. A History
UI is not required to produce those facts.

## Current source and proposed joins

At immutable review baseline `724dcb5`,
[stored-session admission](https://github.com/openclaw/openclaw-enterprise/blob/724dcb5cb80b5e76a62e8267a21185a2e91a85c2/apps/controller/src/auth/index.ts#L292-L364)
supports existing password sessions and service keys.
[Provisioning](https://github.com/openclaw/openclaw-enterprise/blob/724dcb5cb80b5e76a62e8267a21185a2e91a85c2/apps/controller/src/index.ts#L2531-L2563)
performs separate authentication and IAM writes with compensation. The proposed
joint transaction must replace that separation for this delivery. Existing code
is not evidence of connected federation or method-bound issuance.

The separate historical integration supplier at `6538069` is not merged main. Its
[account-security records](https://github.com/openclaw/openclaw-enterprise/blob/65380694085693d6edb5218372ccddbc2ba493d9/migrations/0032_account_security_records.sql#L9-L44)
retain incarnation and version, but their active shape requires a credential
pointer and has no disabled state. The account owner must generalize that actual
supplier for external-only accounts. Dummy passwords and a second currentness
authority do not satisfy the requirement.

The selected [policy administration contract](interfaces.md#account-administration)
and [original-State account protocol](account-lifecycle.md#atomic-policy-and-recovery)
are proposed obligations. The RBAC proposal owns the common policy and transaction
contracts. The concrete account, SQL, session, and real-consumer join remains
unqualified. The
[delivery gates](delivery.md#acceptance-evidence) distinguish source evidence
from composed, installed, provider, and release acceptance.
