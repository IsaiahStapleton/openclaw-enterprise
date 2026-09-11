# Agent deletion and revision teardown

**Status:** Proposed — revised after second review; awaiting approval.
**Issue:** [#94](https://github.com/openclaw/openclaw-enterprise/issues/94) (M3.4).
**Current reference this will change:** [Agents](../docs/reference/agents.md),
[Namespaces](../docs/reference/namespaces.md),
[Controller reconciliation](../docs/reference/controller.md),
[controller worker flow](../docs/flows/controller-worker.md), and the generated
[API reference](../docs/reference/api.md).

## Goal

Provide an authorized, retryable Agent deletion operation that removes the Agent
and its AgentRevisions, tears down OCC-owned runtime resources, and lets a
Namespace be offboarded after its last Agent is removed.

## Current state

There is no Agent deletion path at any layer. `packages/contracts/src/api/routes.ts`
defines `DELETE` for Namespaces, Configurations, Secrets, and ServiceAccounts but
no `deleteAgent` operation, and `packages/occ/src/index.ts` has no Agent deletion
method. The limitation is recorded in
[Agents](../docs/reference/agents.md#current-limitations).

`deleteNamespace` rejects any Namespace that still has an Agent through
`state.namespaces.hasAgents`, and `occ.validate_namespace_lifecycle`, as
redefined in `0013_secret_state.sql`, independently raises
`a nonempty namespace cannot be tombstoned` when an `occ.agents` row for the
Namespace still exists.

Every foreign key among the Agent relationships is
`ON UPDATE RESTRICT ON DELETE RESTRICT`, with no cascade, though cascades exist
elsewhere in the schema, for example
`service_account_driver_bindings_account_owner`. `occ_app` holds `SELECT`,
`INSERT`, and column-scoped `UPDATE` on the Agent tables, but no `DELETE`.

Two constraint cycles govern deletion order. `occ.agents.active_revision_id`
references `agent_revisions` immediately, while `agent_revisions.agent_id`
references `agents`. Separately, `agent_service_principal_owner` is
`DEFERRABLE INITIALLY DEFERRED`, while `iam_identities_agent_owner` is immediate.
`occ.audit_events` stores `resource_kind` and `resource_id` as plain text with no
foreign key, so audit history survives deletion.

Triggers, not only privileges, forbid deletion, and triggers are not
privilege-gated, so `SECURITY DEFINER` does not bypass them. Of the records this
operation touches, only `occ.agent_revisions` carries a `DELETE`-rejecting
trigger; `iam_group_memberships` carries one too, but needs no cleanup.

The teardown primitives exist. `ComputeDriver.retireRevision` is implemented by
all three bundled Drivers and, per the
[Compute contract](../docs/reference/drivers/compute.md), already delegates
provider-owned Sandbox cleanup during retirement. The Kubernetes implementation's
`removeRetiredGateway` deletes the Agent-owned gateway, its route, its private
state claim, and the dedicated shared workspace claim.

## Resolved decisions

1. **Row deletion, not a tombstone.** The acceptance criteria require the Agent
   and its revisions to be removed and state that internal revision retirement
   alone is insufficient. A tombstone also cannot satisfy Namespace offboarding:
   the lifecycle trigger rejects a Namespace tombstone while any `occ.agents` row
   remains, and `agents.configuration_id` is `NOT NULL`, so a retained Agent row
   would pin its Configuration and block Configuration deletion. Row deletion
   removes both obstacles and needs no trigger change.
2. **Workspace data and Agent credentials are destroyed with the Agent.**
   Workspace teardown already follows from the unconditional retirement path,
   which deletes the gateway private state claim and the dedicated shared
   workspace claim. Credentials need a new primitive; see below.
   Namespace-owned Secrets and Configurations are independently owned and survive.
3. **Name reuse follows automatically.** With the row deleted,
   `agents_namespace_id_name_unique` frees the name; no partial index is needed.
4. **Deletion accepts an active Agent directly.** Issue #94 requires deleting
   active as well as stopped Agents, and requiring a separate stop call first
   would add client choreography for no benefit. Deletion reuses the internal
   shutdown primitive from
   [#93](https://github.com/openclaw/openclaw-enterprise/issues/93) without
   making that issue's public endpoint a prerequisite.

## Design

### API

Add `operationId: "deleteAgent"`, `method: "DELETE"`,
`path: "/namespaces/:namespaceId/agents/:agentId"`,
`action: "openclaw.agents.delete"`, `iamAction: "delete"`,
`resourceKind: "agent"`, `authorizationTarget: "agent"`, responding `202`
with the Agent envelope plus the shared `mutationErrors`. `agent` is the
established target for exact Agent operations in the route catalog. IAM already
admits
`delete` on `agent`, so no authorization vocabulary changes. Regenerate the
contract and verify with `pnpm openapi:check`.

### Concurrency boundary

Deletion is asynchronous, so the Agent needs a transient `status` of `active` or
`deleting` on `occ.agents` and on the `Agent` contract. No `deleted_at` column is
required, because the row is removed.

Every Agent mutation must reject a `deleting` Agent before doing work: update,
deploy, runtime credential provisioning, and workspace file writes. Without this,
a revision could be admitted after the worker enumerated the revisions to retire,
leaving an orphaned workload behind. Reads may continue to return the Agent as
`deleting`. The existing `controller_work_one_claim_per_resource` index already
serializes work per Agent, but it does not gate the synchronous API, so the status
check is the boundary. Race coverage is required, not optional.

### Work item and queue changes

Relaxing the SQL check alone is insufficient; the queue rejects the shape at three
layers:

- `PlatformOperation` in `packages/occ/src/state/platform-state.ts` admits only
  `namespace` and `agent_revision`. Add an `agent` kind with
  `target: "deleted"`.
- `PostgresWorkQueue.enqueue` in `packages/occ/src/state/postgres-work-queue.ts`
  throws unless `agentId` and `revisionId` are both present or both absent. Permit
  an Agent-scoped item with no revision.
- Operation persistence in `packages/occ/src/state/postgres-state.ts` branches on
  the two existing kinds and must resolve and validate the Agent owner for the new
  kind.
- `controller_work_namespace_target_valid`, as redefined in
  `0003_agent_drafts.sql`, requires a non-null `revision_id` whenever `agent_id`
  is set. Admit the Agent-scoped, revision-less shape.

### Worker teardown

Add an Agent branch to `apps/controller/src/worker.ts`, which dispatches on
`claim.namespaceTarget` and `claim.agentId`. The handler retires every revision of
the Agent through the selected `ComputeDriver`, then deletes the Agent's runtime
credentials, and classifies failures as retryable or permanent the way
`handleNamespaceLifecycle` does.

### Agent credential cleanup

Revision retirement does not remove Agent runtime credentials.
`provisionAgentRuntimeCredentials` is rejected once any historical revision
exists, so credentials can only be provisioned before the first revision, but
they persist afterwards and survive deployment. Deletion therefore has to handle
both an Agent with credentials and no revision to retire and a deployed Agent
whose credentials outlived its revisions. The Compute contract has no
credential-deletion counterpart, and the Kubernetes implementation is documented
to never delete credentials.

Add `deleteAgentRuntimeCredentials?(binding: ComputeAgentBinding): Promise<void>`
to `ComputeDriver`, Agent-scoped and symmetric with the provisioning method. It
must be idempotent, succeeding when no credential exists, so retries and Agents
that never had credentials both converge. Implement it in the Kubernetes Driver
to remove the Agent-owned transport, model, and Slack Secrets; the Docker, SSH,
and plugin runtimes implement neither method and are unaffected.

A Driver that implements provisioning but not deletion must fail the deletion
closed rather than leave credentials behind. The worker invokes this primitive
after revision retirement and before database finalization, so a credential
failure leaves the Agent `deleting` and retryable rather than deleting the rows
that identify the leaked Secrets.

Removing credentials contradicts the current documented Kubernetes behavior, so
[Compute](../docs/reference/drivers/compute.md) must be corrected in the
implementing PR.

The worker must not call `SandboxDriver.cleanup` itself. `retireRevision` already
delegates Sandbox cleanup, and a second call would run teardown twice. Sandbox
cleanup stays owned by Compute.

Retirement must be idempotent so a retry after partial failure converges; the SSH
conformance suite already asserts repeated `retireRevision` calls are safe.

### Ordered deletion and privilege model

Granting `occ_app` blanket `DELETE` on the Agent and IAM tables would widen the
application role well beyond this operation. Deletion is therefore a single
migrator-owned `SECURITY DEFINER` function with `EXECUTE` granted to `occ_app`
and revoked from `PUBLIC`, `SET search_path` fixed to `pg_catalog, occ`, and an
exact signature taking the Namespace, Agent, idempotency key, and claim token.
`occ_app` receives no `DELETE` grant on any Agent, IAM, or work table, so the
function is the only deletion path. It resolves the ServicePrincipal internally
rather than accepting it as an argument, locks the Agent row and verifies its
status is `deleting`, and validates the claim token and unexpired lease before
mutating anything.

Inside one transaction, the function:

1. Clears `agents.active_revision_id`, satisfying the immediate
   `agent_active_revision_owner`.
2. Deletes `iam_access_bindings` whose subject is the ServicePrincipal, and
   `iam_access_bindings` and `iam_restrictions` whose `(resource_kind,
   resource_id)` names the Agent or one of its revisions. Those resource columns
   are textual with no foreign key, so nothing else removes them and the
   authorization state would otherwise be orphaned.
3. Deletes the Agent's `agent_revisions`.
4. Deletes the ServicePrincipal `iam_identities` row, then the `occ.agents` row.
   The deferred `agent_service_principal_owner` permits this order; the reverse
   fails on the immediate `iam_identities_agent_owner`.
5. Deletes `occ.apikey` rows whose `reference_id` is the ServicePrincipal, which
   also has no foreign key.
6. Records success evidence and deletes the Agent's `controller_work` rows last,
   including the completing item.

`iam_group_memberships` needs no cleanup. `validate_group_membership` requires
`identity_kind = 'principal'`, so a ServicePrincipal can never be a member.

### Revision immutability exception

`agent_revisions_are_immutable` rejects every revision `DELETE`, and the definer
function cannot bypass it. Recreate the trigger as `BEFORE UPDATE ON
occ.agent_revisions`, preserving content immutability, and let deletion be gated
by privilege instead: `occ_app` holds no `DELETE` on the table, so only the
migrator-owned function can remove a revision. If review prefers a trigger-level
guard as well, the alternative is to keep the `DELETE` arm and admit it only when
a transaction-local flag set inside the function is present. Leave
`audit_events_are_append_only` and `installation_cannot_be_deleted` untouched.

### Work item finalization

The Agent branch must not call the generic `PostgresWorkQueue.complete`. That
method updates the claimed `controller_work` row to `succeeded`, inserts success
evidence, and throws `WorkClaimLostError` when no row matches — which is exactly
what happens once the deletion function has removed the row.

Add a specialized finalizer to the queue that performs claim validation, success
evidence, and deletion as one atomic step, and have the Agent branch call it in
place of `complete`. Its claim-token and unexpired-lease predicates must match
`complete`'s, so a lost or expired lease still fails closed and no deletion
occurs. Every other worker branch keeps using `complete` unchanged.

### Database changes

One new migration, `0016_agent_deletion.sql`, following `0015_agent_plugins.sql`:
add `status` to `occ.agents` with a check constraint and
`GRANT UPDATE (status)`; relax `controller_work_namespace_target_valid`; recreate
`agent_revisions_are_immutable` as `UPDATE`-only; and create the deletion
function, revoking `EXECUTE` from `PUBLIC` and granting it to `occ_app`.
`occ.validate_namespace_lifecycle` needs no change, because no Agent row
survives, and no new table-level `DELETE` grant is issued.

Author the SQL by hand, as the existing migrations are. Grants, triggers,
`SECURITY DEFINER` functions, and these check constraints are not expressible in
`packages/occ/src/state/postgres-schema.ts`, and `migrations/meta/` holds
snapshots for only `0000` and `0002`, so generated diffs are not the authoring
path. Add the matching `_journal.json` entry with `idx: 16` and
`when: 1787000000016`, continuing the existing sequential timestamps.

The journal timestamp is load-bearing. The PostgreSQL migrator in drizzle-orm
0.45.2 selects the newest `created_at` from `drizzle.__drizzle_migrations` and
applies only migrations whose journal `when` exceeds it; the stored file hash is
never compared. Editing an already-applied migration in place is therefore
skipped silently, leaving the schema diverged from the SQL with no error. Add new
files rather than amending applied ones.

Per the repository validation boundary, keep persisted invariants in constraints
and mirror them in the in-memory adapter rather than duplicating them in
application logic. No data backfill, compatibility shim, or rollout choreography
is in scope; the platform has no production consumers, and this specification
adds no migration rollout guidance to the documentation set.

## Work breakdown

1. Migration, `Agent` status field, repository methods, and in-memory adapter
   parity.
2. `PlatformOperation` kind, queue enqueue relaxation, and operation persistence.
3. `deleteAgent` route, OpenAPI regeneration, and the controller method with
   authorization, status transition, and audit.
4. Status rejection in every Agent mutation path.
5. Deletion function, the revision immutability change, and the queue finalizer.
6. `deleteAgentRuntimeCredentials` on the Compute contract and in the Kubernetes
   Driver, with the corrected Compute reference.
7. Worker teardown branch with retryable failure classification, reusing the
   internal shutdown primitive, then credential cleanup and the finalizer.
8. `hasAgents` and Namespace offboarding coverage.
9. Documentation: remove the deletion limitation from Agents, correct the
   Namespace statement, update the controller worker flow, and record completion
   here.

Console coverage is [#95](https://github.com/openclaw/openclaw-enterprise/issues/95)
and is out of scope.

## Verification

- Conformance: delete an Agent with no revisions, with an admitted but undeployed
  revision, and with a deployed active revision. Assert `202`, the audit events,
  idempotent repeat deletion, and denial without the `delete` permission.
- Credentials: provision runtime credentials on a zero-revision Agent, delete it,
  and assert the credential Secrets are gone; repeat for a deployed Agent. Assert
  credential cleanup on an Agent that never had credentials succeeds, and that a
  provisioning Driver without the deletion method fails the deletion closed.
- Race: attempt update, deploy, credential provisioning, and a workspace write
  against a `deleting` Agent and assert each is rejected; assert no revision can
  be admitted after teardown enumerates revisions.
- Retry: fail `retireRevision` once, then assert the retry completes and the rows
  are gone.
- Isolation: assert a sibling Agent, its revisions, and its ServicePrincipal
  survive, and that the Namespace's Configurations and Secrets are untouched.
- Privilege and immutability: assert `occ_app` cannot delete an Agent, revision,
  or identity directly, that revision `UPDATE` is still rejected after the
  trigger change, and that `EXECUTE` on the function is denied to `PUBLIC`.
- Finalization: assert an expired or stolen lease deletes nothing, and that
  success evidence is recorded even though the work row is removed.
- Orphan checks: assert no `iam_access_bindings` or `iam_restrictions` rows
  reference the deleted Agent or its revisions, and no `occ.apikey` row
  references its ServicePrincipal.
- Namespace: delete the last Agent and its Configurations, then assert
  `deleteNamespace` reaches the tombstone through the lifecycle trigger.
- PostgreSQL integration per [database setup](../docs/testing/postgresql.md),
  migrating with the migrator role and running as the limited application role, to
  prove the privilege model is sufficient.
- Real-runtime Kubernetes teardown per
  [cluster setup](../docs/testing/kubernetes.md), asserting the workload, gateway,
  route, and claims are gone while operator-owned Namespace resources remain.

## Dependencies

[#93](https://github.com/openclaw/openclaw-enterprise/issues/93) owns the
internal shutdown primitive this work reuses; its public stop endpoint is not a
prerequisite, so the two can land in either order.
[#99](https://github.com/openclaw/openclaw-enterprise/issues/99) owns upgrade
handling for the new lifecycle state. A dedicated rollback API stays out of
scope; tested recovery is owned by
[#100](https://github.com/openclaw/openclaw-enterprise/issues/100).
