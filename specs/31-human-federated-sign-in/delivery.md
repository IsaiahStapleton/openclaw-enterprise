# Federated sign-in delivery

[Overview](../31-human-federated-sign-in.md) · [Known interfaces and decisions](interfaces.md)

The browser checkpoint has a complete user outcome, but enterprise providers and
human CLI remain part of the selected goal.

## Increments and qualification

Land the RFC first, then deliver the connected account foundation, both-provider
browser journey, enterprise profiles, and human CLI in independently reviewable
increments.

### Account, IAM, and State foundation

The account, IAM, and State owners deliver an actual administrator consumer for
manual provisioning, method management, repair, explicit grants, and local
revocation. Fresh and upgrade migrations preserve legitimate account and
Principal IDs. Generalize the actual account-security supplier for external-only
currentness and disabled state. A migration reservation is not a shipping journal
position or acceptance.

Completion requires method uniqueness, both-owner repair, final-method disablement,
and last-usable-local-administrator protection under concurrent account, grant,
Group, and Restriction changes. Prove retained receipt recovery and unknown COMMIT
without compensation. The foundation must preserve supported account-client
authentication through internal composition.

### Both-provider browser delivery

Authentication and Console owners connect Google and GitHub to the same human
account and Principal. The actual Console must show an authorized Namespace,
create and read a Configuration, create an Agent, and perform a supported
lifecycle operation. Record exact setup, routes, grants, and required revision or
companion access. Optional panels deny gracefully. Cross-Namespace access denies,
and Agent creation alone does not count as deployment.

Manual administration and repair, explicit grants, and local revocation are part
of this browser delivery. Its smallest required account and selected-IAM
capability does not depend on protected invocation, model execution, workload
identity, egress, active withdrawal qualification, or a History UI. Required
account and login evidence still commits through the common ledger.

### Enterprise provider delivery

The protocol owner delivers issuer-pinned standards-based OIDC and Okta, concrete
tenant-bound Entra, and trusted enterprise GitHub with required S256. These are
already selected subsequent deliveries. They need no new product-selection
trigger. Complete [profile contracts](interfaces.md#enterprise-profiles) retain
distinct Okta issuers, exact Entra claims, and unsupported-version refusal.

Close issuer, tenant, origin, and S256 negative cases through real routes and
persistence. Qualify the actual selected provider registrations independently
from the Google/GitHub browser delivery.

### Human CLI delivery

Go CLI, controller, and session owners deliver `occ auth login/status/logout`
through the [request, approval, and exchange contract](interfaces.md#human-cli).
The real Go CLI, controller, migrated PostgreSQL, loopback listener, and protected
file must participate. Browser approval must produce an independent, bounded
ordinary OCE session.

Prove approving-session and account-currentness races, restart behavior, file
custody across aliases, origin mismatch, and failed logout retaining the file.
Enterprise or CLI qualification does not become a prerequisite for the separately
qualified browser delivery.

## Acceptance evidence

Each behavior change includes its actual consumer and focused integration proof.
Use the controller, Console, selected IAM, State/audit, and migrated PostgreSQL
with separate migrator and application roles. Controlled provider endpoints may
replace only the external identity provider. They must not replace OCE grants,
admission, transactions, or persistence with fixtures that assume success.

Inventory every human session issuer and reader, including password login.
Acceptance must cover the consequential cases below:

- **Protocol and browser binding:** login CSRF, injection, replay, malformed
  callbacks and tokens, missing ID tokens, issuer/nonce/PKCE mismatches, duplicate
  parameters, concurrent callbacks, unsafe discovery, and redirects.
- **Identity and authority:** email-linking refusal, bootstrap escalation
  prevention, session fixation, method uniqueness, complete repair, stale
  currentness, cross-Namespace denial, grant removal, and usable local recovery.
- **State and issuance:** rollback, restart persistence, two-controller
  issuance/revocation races, append failure, and uncertain acknowledgment before
  credential release. Include fresh/upgrade migrations and external-only accounts.
- **Credential custody:** provider-token nonretention in persistence, controller
  logs, installed ingress/access logs, and failure paths. Exercise logout and
  account-wide revocation through actual session owners.
- **Selected CLI:** real listener and proof exchange, approving-session expiry,
  eight-hour cap, unsafe file rejection, credential conflict, origin mismatch,
  and failed server revocation. Uncertain exchange must not become blind replay.

Each increment needs independent SQL review and a complete security-boundary
review. Resolve defects, polish the composed implementation, and update affected
living references, operator guides, and source-backed flows before publication.
Refresh main and actual required supplier heads before the final review stack.

Record evidence at the boundary it establishes:

| Evidence                     | What it can establish                                       |
| ---------------------------- | ----------------------------------------------------------- |
| Exact source revision        | Definitions and implemented local behavior                  |
| Composed integration         | Connected real owners under the tested dependencies         |
| Installed HTTPS behavior     | Intended origin, ingress, persistence, and logging behavior |
| Actual provider registration | The selected live identity profile and exchange             |
| Release decision             | Acceptance of that delivery against all its gates           |

Source definitions, controlled-provider results, and installed runtime results are
not interchangeable. Qualify intended HTTPS installation and real registrations
separately for each delivery. Preserve exact revisions, setup, routes, grants,
results, and material gaps with the evidence. Documentation validation does not
establish any of these product outcomes.

## Decisions and follow-ups

Authentication and account owners must select concrete operation routes and DTOs
without changing the known semantics. Account and State owners must settle the
proposed operation-digest encoding and exact receipt recovery. Session, product,
and operator owners must settle browser clock, configurable ceiling, default-only
exposure, and existing-session effects. Authentication, Console, and product
owners must decide the proposed direct no-access presentation or a constrained
alternative. The [interface decisions](interfaces.md#owner-decisions) retain these
open choices and their required outcomes. Close them with recorded decisions and
real issuer/reader evidence, not an editorial assumption.

Account narrowing commits intent now. IAM, runtime, and credential owners
separately owe protected refusal and final bytes within **30 seconds** of the
authority-owner event, including renewal loss. Preserve the scoped five-second
contracts. The [identity proposal](https://github.com/openclaw/openclaw-enterprise/pull/247)
owns the shared currentness deadline contract, while actual receivers enforce
refusal and transport closure. Owners must define evidence age, clock/skew,
deadlines, cadence, and closure reserve, then qualify installed measurements.
Session denial, credential closure, physical stop, cleanup, and unknown provider
effects remain distinct facts. Those gates are separate from browser login.

Signup, invitations, self-service linking, automatic workspaces, SAML,
SCIM/directory synchronization, continuous provider offboarding, and
provider-derived repository grants remain excluded. Any new product selection
must name the existing account/IAM, protocol, or repository owner and prove
association, authority, recovery, and withdrawal. This is distinct from the
already-selected enterprise and CLI deliveries. No second identity/session store,
enrollment service, or general policy editor is needed for the selected release.
