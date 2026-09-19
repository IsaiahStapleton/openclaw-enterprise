# Human account lifecycle

[Overview](../31-human-federated-sign-in.md) · [Administration contract](interfaces.md#account-administration)

One human account survives changes to how the person signs in. Administrators
manage authentication methods and explicit grants, while the account owner
preserves identity and invalidates stale sessions. The following lifecycle is
proposed and must be composed through the existing account, IAM, and State owners.

## Identity and method ownership

Better Auth `user.id` remains the immutable human subject under the
Installation-specific OCC issuer. Preserve legitimate existing account and
Principal IDs. The Principal is IAM's stable local identity for that human.
Changing a provider or method must not silently create another Principal.

Existing `account` rows represent authentication methods. Each exact
`(providerInstanceId, subject)` pair has one persisted owner. A human may own
several methods, including the selected Google and GitHub methods. The pair's
association is immutable. Repair replaces an incorrect association rather than
editing its ownership in place.

OCE contact email is manually supplied and remains unique. Provider email may be
absent. Never merge accounts or attach methods by matching email. Provider
instance identity uses the immutable
[trust tuple](interfaces.md#provider-configuration-and-identity), not display
labels or convenient profile claims.

Login resolves one existing active account and the selected IAM Driver resolves
its stable Principal. Login creates no Principal, Role, Namespace, repository
grant, or Agent credential. Every exact resource operation still requires IAM
authorization. The Agent's ServicePrincipal and repository credential authority
remain separate.

## Administration and currentness

Currentness records whether an account state is still the state on which a
session or authorization decision depends. Reuse retained account security with
a UUID incarnation, positive safe-integer version, active/disabled state, and
non-reusable deleted tombstones. Missing, orphan, provisioning, and deleted
accounts deny admission. External-only accounts need no password row.

A current human session with Installation `administer` can provision an account
with one password or external method and explicit grants. It can read safe
account/method details, look up exact contact email, attach/remove/repair methods,
enable/disable the account, revoke all sessions, and add/remove explicit grants.
Authentication retains password hashing and protocol verification. Bootstrap
administrator seeding remains an explicit operation.

Mutations carry an operation reference and expected account incarnation/version.
Method changes also verify the current owner. The lifecycle preserves these
effects:

- **Provision:** create the account, initial method, grant-free Principal, explicit
  grants, and activation in the original transaction with required evidence.
- **Attach or remove:** advance affected currentness and invalidate all affected
  sessions. Removing the final method atomically disables the account.
- **Repair:** atomically replace the immutable association with a new method ID.
  Invalidate both affected accounts, preserve both identities and their grants,
  and never merge accounts.
- **Disable or revoke all sessions:** invalidate browser and CLI sessions through
  the same account owner and original transaction.
- **Enable:** require a usable method and advance currentness. Do not create or
  restore sessions, grants, invocations, or authority generations.

Bind sessions to their exact method, account incarnation/version, and absolute
expiry. Insertion and admission must recheck active state, current method
ownership, currentness, and expiry. Constraints and write guards prevent a late
insert from reviving revoked access. Every retained password issuer, provider
issuer, CLI issuer, session display reader, API admission path, and logout path
participates. External-only consumers must not depend on a password row.

Ordinary logout revokes the selected stored session. Grant removal affects the
next IAM authorization decision. These are different effects from account-wide
session revocation, and neither proves physical Agent stop or provider-token
cleanup. The [session contract](interfaces.md#sessions-and-no-access) owns
lifetime and no-access behavior.

## Atomic policy and recovery

Account, method, grant-free Principal, explicit grants, activation, receipt,
mandatory audit, and required narrowing intent must share the original State
transaction. Narrowing means recording the reduction in previously usable
authority so its actual consumers can refuse further use. The account owner
supplies affected local identities and their old/new currentness. IAM owns policy
mutation and durable withdrawal.

The local account participant must obey the common original-State order. The
[RBAC proposal](https://github.com/openclaw/openclaw-enterprise/pull/245)
owns its shared policy prefix and the fixed catalog. Use explicit READ COMMITTED:

1. Acquire Installation authority with the required shared or exclusive guard.
2. Acquire all account and session guards in stable sorted order.
3. Acquire the complete policy barrier and policy head.
4. Acquire resource guards.
5. Finish retention and required audit work.

Every native policy writer participates. No late lock upgrade, secondary
connection, nested COMMIT, fabricated evidence, or post-transaction backfill may
substitute for the genuine original transaction. Failures poison acceptance, and
admitted work must drain before COMMIT. State owns SQL keys and enforcement.

Account evidence separates the operation target from the complete sorted set of
affected-account old/new transitions. Repair includes both owners. Additional
recovery guards do not belong to that changed set merely because they were
acquired. Reject omitted, extra, duplicate, unguarded, foreign, or expired
transition evidence. Narrow every accepted transition atomically with the
mutation, receipt, and audit.

This proposed protocol keeps account transitions, recovery guards, and original
authentication evidence distinct. The account owner must provide genuine evidence
under the original guards, consuming the RBAC proposal’s Original-State transaction
contract. The concrete SQL/account/session join still requires qualification.

Serialize account, grant, Group-membership, and Restriction changes to preserve
one enabled, usable local-password administrator. Evaluate its effective
Installation administration against the complete candidate policy, including
existing Groups and overriding Restrictions. An account called “administrator”
without usable login and effective permission does not satisfy recovery.

Failed or unknown COMMIT must never authorize destructive compensation or blind
replay. Authorized exact retained-receipt lookup recovers the original operation,
result, and revisions. Changed operation content conflicts. Missing retained
evidence stays unknown. This preserves the State owner's distinction between a
definite rollback and a commit whose acknowledgment was lost. The proposed
[account-operation digest](interfaces.md#account-administration) has an undecided
encoding and is distinct from the policy-command digest.

Required account/login facts use the common ledger and the original
retention-compatible transaction. Use closed local references and fixed outcomes,
without external profiles or an invented Agent subject. The
[observability proposal](https://github.com/openclaw/openclaw-enterprise/pull/250)
owns ledger and retention semantics. A History UI does not gate account changes,
but required fact persistence still gates their acceptance and session release.

## Console grants

IAM owns Namespace visibility, exact Namespace-parent creator permissions,
companion/revision grants, and administrator-approved creation profiles. Account
administration consumes that catalog. Selected creation-profile roles must be
granted on each newly created exact object atomically.

The browser delivery must enable the actual Console sequence:

1. See an authorized existing Namespace.
2. Create a Configuration and read that exact Configuration.
3. Create an Agent referring to the Configuration.
4. Perform a supported Agent lifecycle operation with any required revision and
   companion grants.

The current
[Console consumer](https://github.com/openclaw/openclaw-enterprise/blob/724dcb5cb80b5e76a62e8267a21185a2e91a85c2/apps/controller/src/console/agents/create.mjs#L327-L382)
saves a Configuration before an Agent. Creation alone does not deploy the Agent
or create an AgentRevision. Acceptance must record exact setup, routes, and grants
for the supported lifecycle operation rather than infer success from creation.

If the selected lifecycle operation includes deployment polling, require `read`
on the exact admitted AgentRevision. The
[current deployment-status contract](https://github.com/openclaw/openclaw-enterprise/blob/12fddc4805a1b090331af363ad10bf3b58ea5897/docs/reference/agents.md#deployment-status)
distinguishes `202` admission from saved `succeeded` as historical completion. Neither establishes
live workload health or grants protected History access.

Optional panels deny gracefully when their permissions are absent. Do not add
broad administration, Secret access, or content access merely to make Console
work. Cross-Namespace denial remains required. Repository assignment and use
remain separate authority, with execution-time authorization and credential
custody retained by their owners.
