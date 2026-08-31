# IAMDriver contract

`IAMDriver` resolves provisioned identities and decides whether an identity may
perform an exact resource operation. Authentication establishes an issuer and
subject; IAM resolves that identity and evaluates its authority. OCC owns
request admission, resource scope, state mutation, and audit emission.

The [authorization reference](../authorization.md) owns policy semantics. The
exported interface is in [shared contracts](../../../packages/contracts/src/index.ts).

## Identity and authorization operations

| Operation               | Input and result                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `lookupIdentity(input)` | Receives an authenticated `issuer`, `subject`, and optional Namespace scope; returns one provisioned Identity or `undefined`. |
| `authorize(request)`    | Receives `principalId`, an exact action, and a server-owned resource reference; returns an allow or deny decision.            |

An authorization decision includes `allowed`, `reason`, `driverId`, and evidence
identifying the contributing identity, Groups, AccessBindings, Roles, and
Restrictions. These identifiers let OCC attribute audit evidence to the selected
Driver and the policy it evaluated. Identity lookup does not provision an
account or grant a Role.

## Native IAM behavior

The [bundled native IAM Driver](../../../packages/iam/src/index.ts) loads
controller-owned IAM state for every lookup and authorization decision.
It accepts only an empty startup configuration object. Policy is persisted
platform state, not operator YAML or cached startup configuration.

Identity lookup returns no identity for an absent or ambiguous match, an invalid
scope, or invalid policy. Authorization denies invalid requests or policy,
unknown identities, cross-Namespace identity use, and operations without an
explicit applicable binding. Applicable Restrictions override grants. A
storage failure propagates as an error rather than becoming permission.

Principal Group membership can contribute a grant. ServicePrincipals use their
own scoped identity bindings; they do not acquire a human Principal's Group
membership. Changing persisted policy affects the next decision, including a
worker's reauthorization of queued work.

## Installed Driver boundary

Installed IAM factories receive the controller-owned `platformState` object.
They must read current policy through `loadNativeIAMState()` for lookup and
authorization. Tenants and Installation YAML cannot supply that object.

Installed code executes with control-plane authority. Startup can validate its
interface and identity, but cannot prove that arbitrary code honors persisted
policy. Operator review of the package remains necessary; see
[Driver selection and package trust](selection.md).

For session and password behavior, see [authentication](../authentication.md).
