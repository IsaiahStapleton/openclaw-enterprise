import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import {
  adminEmail,
  createDurableController,
  databaseUrl,
  parseJsonLines,
  pollUntil,
  request,
  requiresPostgres,
  spawnWorker,
  startController,
  verifyPlatformStateStoreContract,
} from "../helpers/postgres-platform-state.mjs";

test(
  "PostgreSQL rejects platform writes until the singleton Installation is bootstrapped",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { PostgresPlatformState }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    if ((await state.loadInstallation()) !== undefined) {
      context.skip("The configured PostgreSQL database has already been bootstrapped.");
      return;
    }

    const prematureWorker = await spawnWorker(context);
    const [prematureExit] = await once(prematureWorker.child, "exit", {
      signal: AbortSignal.timeout(10_000),
    });
    assert.notEqual(prematureExit, 0);
    const startupFailure = parseJsonLines(prematureWorker.output()).find(
      (line) => line.event === "worker.startup-error",
    );
    assert.ok(startupFailure, prematureWorker.output());
    assert.deepEqual(
      {
        severity: startupFailure.severity,
        service: startupFailure.service,
        event: startupFailure.event,
        code: startupFailure.code,
      },
      {
        severity: "ERROR",
        service: "occ-worker",
        event: "worker.startup-error",
        code: "WORKER_STARTUP_FAILED",
      },
    );

    const namespaceId = `ns_${randomUUID()}`;
    const agentId = `agt_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const namespace = { id: namespaceId, name: "Uninitialized", status: "provisioning", createdAt };
    const agent = {
      id: agentId,
      namespaceId,
      name: "Uninitialized agent",
      configurationId: `cfg_${randomUUID()}`,
      providerId: null,
      draft_spec: {},
      executionMode: "embedded",
      servicePrincipalId: `service-agent-${randomUUID()}`,
      createdAt,
    };
    const revision = {
      id: `rev_${randomUUID()}`,
      namespaceId,
      agentId,
      revision: 1,
      providerId: null,
      configurationId: `cfg_${randomUUID()}`,
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: {},
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
      compute: {
        id: "compute-local-development",
        implementation: "deterministic-local-development",
      },
      servicePrincipalId: agent.servicePrincipalId,
      createdAt,
    };
    const operation = {
      kind: "namespace",
      action: "reconcile",
      target: "ready",
      namespaceId,
      resourceId: namespaceId,
      actorId: "principal-uninitialized",
    };
    const stateCounts = `SELECT
         (SELECT count(*)::integer FROM occ.installation) AS installations,
         (SELECT count(*)::integer FROM occ.namespaces) AS namespaces,
         (SELECT count(*)::integer FROM occ.agents) AS agents,
         (SELECT count(*)::integer FROM occ.agent_revisions) AS revisions,
         (SELECT count(*)::integer FROM occ.controller_work) AS work`;
    const baseline = await pool.query(stateCounts);
    assert.equal(baseline.rows[0].installations, 0);

    for (const write of [
      (transaction) => transaction.namespaces.createNamespace(namespace),
      (transaction) => transaction.agents.createAgent(agent),
      (transaction) => transaction.revisions.createRevision(revision),
      (transaction) => transaction.operations.append(operation),
      (transaction) => transaction.operations.list(),
    ]) {
      await assert.rejects(state.transact(write), { name: "ScopeViolationError" });
    }

    const persisted = await pool.query(stateCounts);
    assert.deepEqual(persisted.rows[0], baseline.rows[0]);
  },
);

test(
  "real OCC Namespace lifecycle persists provisioning, readiness, deletion, and its tombstone",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const process = await startController(context);
    const installation = await request(process, "GET", "/installation");
    if (installation.status === 404) {
      const bootstrapped = await request(process, "POST", "/installation/bootstrap", {
        name: "PostgreSQL namespace lifecycle integration",
      });
      assert.equal(bootstrapped.status, 201);
    } else {
      assert.equal(installation.status, 200);
    }
    const { controller } = await createDurableController(pool);
    const actor = await pool.query(
      `SELECT identity.id
       FROM occ.iam_identities AS identity
       JOIN occ."user" AS auth_user ON auth_user.id = identity.subject
       WHERE auth_user.email = $1`,
      [adminEmail],
    );
    assert.equal(actor.rowCount, 1);
    const principalId = actor.rows[0].id;

    const created = await request(process, "POST", "/namespaces", {
      name: `durable-lifecycle-${randomUUID()}`,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.status, "provisioning");
    const namespaceId = created.data.id;

    const provisioning = await request(process, "GET", `/namespaces/${namespaceId}`);
    assert.equal(provisioning.status, 200);
    assert.deepEqual(provisioning.data, created.data);

    const persistedProvisioning = await pool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespaceId],
    );
    assert.deepEqual(persistedProvisioning.rows, [{ status: "provisioning", deleted_at: null }]);
    const provisionWork = await pool.query(
      "SELECT namespace_target FROM occ.controller_work WHERE namespace_id = $1",
      [namespaceId],
    );
    assert.deepEqual(provisionWork.rows, [{ namespace_target: "ready" }]);

    const reconciled = await controller.handleNamespaceLifecycle(principalId, namespaceId, "ready");
    assert.equal(reconciled?.status, "ready");
    const ready = await request(process, "GET", `/namespaces/${namespaceId}`);
    assert.equal(ready.status, 200);
    assert.equal(ready.data.status, "ready");
    const persistedReady = await pool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespaceId],
    );
    assert.deepEqual(persistedReady.rows, [{ status: "ready", deleted_at: null }]);

    const deleting = await request(process, "DELETE", `/namespaces/${namespaceId}`);
    assert.equal(deleting.status, 202);
    assert.equal(deleting.data.status, "deleting");
    const visibleDeletion = await request(process, "GET", `/namespaces/${namespaceId}`);
    assert.equal(visibleDeletion.status, 200);
    assert.equal(visibleDeletion.data.status, "deleting");
    const persistedDeleting = await pool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespaceId],
    );
    assert.deepEqual(persistedDeleting.rows, [{ status: "deleting", deleted_at: null }]);

    const lifecycleWork = await pool.query(
      `SELECT idempotency_key, namespace_target
       FROM occ.controller_work WHERE namespace_id = $1 ORDER BY namespace_target`,
      [namespaceId],
    );
    assert.deepEqual(
      lifecycleWork.rows.map(({ namespace_target }) => namespace_target),
      ["deleted", "ready"],
    );
    assert.notEqual(lifecycleWork.rows[0].idempotency_key, lifecycleWork.rows[1].idempotency_key);

    const tombstoned = await controller.handleNamespaceLifecycle(
      principalId,
      namespaceId,
      "deleted",
    );
    assert.equal(tombstoned?.status, "deleting");
    assert.equal(typeof tombstoned?.deletedAt, "string");
    const persistedTombstone = await pool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespaceId],
    );
    assert.equal(persistedTombstone.rowCount, 1);
    assert.equal(persistedTombstone.rows[0].status, "deleting");
    assert.ok(persistedTombstone.rows[0].deleted_at instanceof Date);
    assert.equal(persistedTombstone.rows[0].deleted_at.toISOString(), tombstoned.deletedAt);

    const hidden = await request(process, "GET", `/namespaces/${namespaceId}`);
    assert.equal(hidden.status, 404);
    const listed = await request(process, "GET", "/namespaces");
    assert.equal(listed.status, 200);
    assert.ok(listed.data.every(({ id }) => id !== namespaceId));

    const audits = await pool.query(
      "SELECT action, outcome FROM occ.audit_events WHERE resource_id = $1",
      [namespaceId],
    );
    assert.deepEqual(
      audits.rows.map(({ action }) => action).sort(),
      [
        "openclaw.namespaces.create",
        "openclaw.namespaces.delete",
        "openclaw.namespaces.lifecycle.delete",
        "openclaw.namespaces.lifecycle.ensure",
      ].sort(),
    );
    assert.ok(audits.rows.every(({ outcome }) => outcome === "success"));
  },
);

test(
  "PostgreSQL platform state satisfies memory adapter ownership, immutability, and atomicity",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { PostgresPlatformState }, { NativeIAMDriver }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../packages/iam/src/index.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const installation = await state.loadInstallation();
    assert.ok(installation, "the prior API integration must bootstrap the sole Installation");

    const fixture = await verifyPlatformStateStoreContract(state, { installation });
    const durable = await pool.query(
      `SELECT
       (SELECT count(*)::integer FROM occ.agent_revisions WHERE id = $1) AS revisions,
       (SELECT count(*)::integer FROM occ.audit_events WHERE id = $2) AS audit_events,
       (SELECT count(*)::integer FROM occ.controller_work WHERE revision_id = $1) AS operations,
       (SELECT count(*)::integer FROM occ.namespaces
         WHERE id = $3 AND deleted_at IS NOT NULL) AS tombstones`,
      [fixture.revision.id, fixture.audit.id, fixture.lifecycleNamespace.id],
    );
    assert.deepEqual(durable.rows[0], {
      revisions: 1,
      audit_events: 1,
      operations: 1,
      tombstones: 1,
    });
    const durableAccount = await pool.query(
      "SELECT id, namespace_id, name, credential " + "FROM occ.service_accounts WHERE id = $1",
      [fixture.serviceAccount.id],
    );
    assert.deepEqual(durableAccount.rows, [
      {
        id: fixture.serviceAccount.id,
        namespace_id: fixture.serviceAccountNamespace.id,
        name: fixture.serviceAccount.name,
        credential: fixture.serviceAccount.credential,
      },
    ]);

    const sandboxDriverId = "openshell-sandbox";
    const sandboxRevision = await state.transact((unit) =>
      unit.revisions.createRevision({
        ...fixture.revision,
        id: `rev_${randomUUID()}`,
        revision: fixture.revision.revision + 1,
        sandboxDriverId,
      }),
    );
    const reloadedSandboxRevision = await state.read((unit) =>
      unit.revisions.findRevision(
        sandboxRevision.namespaceId,
        sandboxRevision.agentId,
        sandboxRevision.id,
      ),
    );
    assert.ok(reloadedSandboxRevision);
    assert.equal(reloadedSandboxRevision.sandboxDriverId, sandboxDriverId);
    assert.equal(Object.isFrozen(reloadedSandboxRevision), true);
    const durableSandboxRevision = await pool.query(
      "SELECT admitted_spec FROM occ.agent_revisions WHERE id = $1",
      [sandboxRevision.id],
    );
    assert.equal(durableSandboxRevision.rows[0].admitted_spec.sandbox_driver_id, sandboxDriverId);
    assert.equal(Object.hasOwn(durableSandboxRevision.rows[0].admitted_spec, "sandbox"), false);

    // The database accepts only a nonempty SandboxDriver identity, not descriptors or blank values.
    for (const [offset, invalid] of [null, "", " ", 1, { id: sandboxDriverId }].entries()) {
      await assert.rejects(
        pool.query(
          `INSERT INTO occ.agent_revisions
             (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at)
           SELECT $2, namespace_id, agent_id, $3,
                  jsonb_set(admitted_spec, '{sandbox_driver_id}', $1::jsonb, true), admitted_at
           FROM occ.agent_revisions WHERE id = $4`,
          [
            JSON.stringify(invalid),
            `rev_${randomUUID()}`,
            sandboxRevision.revision + 100 + offset,
            sandboxRevision.id,
          ],
        ),
        ({ code, constraint }) =>
          code === "23514" && constraint === "agent_revisions_admitted_snapshot",
      );
    }

    // The database, not adapter-only validation, rejects malformed or cross-scope credential JSON.
    for (const invalid of [
      null,
      {},
      { kind: "api_key", secretRef: { name: "valid-source" } },
      { kind: "bearer", secretRef: { name: "valid-source", key: "api-key" } },
      { kind: "api_key", secretRef: { name: "INVALID", key: "api-key" } },
      ...["../token", ".", ".."].map((key) => ({
        kind: "api_key",
        secretRef: { name: "valid-source", key },
      })),
      {
        kind: "api_key",
        secretRef: { name: "valid-source", key: "api-key", namespace: "another-tenant" },
      },
      {
        kind: "api_key",
        secretRef: { name: "valid-source", key: "api-key" },
        token: "plaintext-must-not-persist",
      },
    ]) {
      await assert.rejects(
        pool.query("UPDATE occ.service_accounts SET credential = $1::jsonb WHERE id = $2", [
          JSON.stringify(invalid),
          fixture.serviceAccount.id,
        ]),
        ({ code, constraint }) =>
          code === "23514" && constraint === "service_accounts_credential_valid",
      );
    }

    const accountPrivileges = await pool.query(
      "SELECT " +
        "has_table_privilege(current_user, 'occ.service_accounts', 'SELECT') AS can_read, " +
        "has_table_privilege(current_user, 'occ.service_accounts', 'INSERT') AS can_insert, " +
        "has_table_privilege(current_user, 'occ.service_accounts', 'DELETE') AS can_delete, " +
        "has_column_privilege(current_user, 'occ.service_accounts', 'credential', 'UPDATE') " +
        "AS can_update_credential, " +
        "has_column_privilege(current_user, 'occ.service_accounts', 'id', 'UPDATE') " +
        "AS can_update_identity, " +
        "has_column_privilege(current_user, 'occ.service_accounts', 'namespace_id', 'UPDATE') " +
        "AS can_update_owner",
    );
    assert.deepEqual(accountPrivileges.rows, [
      {
        can_read: true,
        can_insert: true,
        can_delete: true,
        can_update_credential: true,
        can_update_identity: false,
        can_update_owner: false,
      },
    ]);

    const principalId = `principal-${randomUUID()}`;
    const groupId = `group-${randomUUID()}`;
    const roleId = `role-${randomUUID()}`;
    const sharedRoleId = `role-${randomUUID()}`;
    const bindingId = `binding-${randomUUID()}`;
    const agentBindingId = `binding-${randomUUID()}`;
    const restrictionId = `restriction-${randomUUID()}`;
    const accountRoleId = "role-" + randomUUID();
    const accountBindingId = "binding-" + randomUUID();
    const accountCreationBindingId = "binding-" + randomUUID();
    const accountRestrictionId = "restriction-" + randomUUID();
    const platformActions = [
      "create",
      "read",
      "update",
      "delete",
      "deploy",
      "operate",
      "administer",
    ];
    const siblingId = `agt_${randomUUID()}`;
    const sibling = await state.transact((unit) =>
      unit.agents.createAgent({
        id: siblingId,
        namespaceId: fixture.namespace.id,
        name: `Sibling ${randomUUID()}`,
        configurationId: fixture.configuration.id,
        providerId: null,
        executionMode: "embedded",
        servicePrincipalId: `service-agent-${siblingId}`,
        createdAt: new Date().toISOString(),
      }),
    );
    await state.seedNativeIAM({
      identities: [
        {
          id: principalId,
          kind: "principal",
          issuer: `postgres-platform-${randomUUID()}`,
          subject: `principal-${randomUUID()}`,
        },
      ],
      groups: [
        {
          id: groupId,
          namespaceId: fixture.namespace.id,
          name: `Operators ${randomUUID()}`,
        },
      ],
      memberships: [
        {
          namespaceId: fixture.namespace.id,
          groupId,
          principalId,
        },
      ],
      roles: [
        {
          id: roleId,
          namespaceId: fixture.namespace.id,
          name: `Reader ${randomUUID()}`,
          permissions: [{ action: "read", resourceKind: "agent" }],
        },
        {
          id: sharedRoleId,
          namespaceId: fixture.namespace.id,
          name: `Agent operators ${randomUUID()}`,
          permissions: platformActions.map((action) => ({ action, resourceKind: "agent" })),
        },
        {
          id: accountRoleId,
          namespaceId: fixture.serviceAccountNamespace.id,
          name: "Exact account access " + randomUUID(),
          permissions: [
            { action: "create", resourceKind: "service_account" },
            { action: "read", resourceKind: "service_account" },
            { action: "update", resourceKind: "service_account" },
          ],
        },
      ],
      bindings: [
        {
          id: bindingId,
          namespaceId: fixture.namespace.id,
          subjectKind: "group",
          subjectId: groupId,
          roleId,
          resourceKind: "agent",
          resourceId: fixture.agent.id,
        },
        {
          id: `binding-${randomUUID()}`,
          namespaceId: fixture.namespace.id,
          subjectKind: "identity",
          subjectId: principalId,
          roleId: sharedRoleId,
        },
        {
          id: accountBindingId,
          namespaceId: fixture.serviceAccountNamespace.id,
          subjectKind: "identity",
          subjectId: principalId,
          roleId: accountRoleId,
          resourceKind: "service_account",
          resourceId: fixture.serviceAccount.id,
        },
        {
          id: accountCreationBindingId,
          namespaceId: fixture.serviceAccountNamespace.id,
          subjectKind: "identity",
          subjectId: principalId,
          roleId: accountRoleId,
          resourceKind: "service_account",
          resourceId: fixture.serviceAccountNamespace.id,
        },
      ],
      restrictions: [
        {
          id: restrictionId,
          namespaceId: fixture.namespace.id,
          action: "deploy",
          resourceKind: "agent",
          resourceId: fixture.agent.id,
          effect: "deny",
        },
        {
          id: accountRestrictionId,
          namespaceId: fixture.serviceAccountNamespace.id,
          action: "update",
          resourceKind: "service_account",
          resourceId: fixture.serviceAccount.id,
          effect: "deny",
        },
      ],
    });
    await pool.query(
      `INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, role_id)
       VALUES ($1, $2, $3, $4)`,
      [agentBindingId, fixture.namespace.id, fixture.agent.servicePrincipalId, sharedRoleId],
    );

    const reopened = new PostgresPlatformState(pool);
    await reopened.read(async (view) => {
      const revision = await view.revisions.findRevision(
        fixture.namespace.id,
        fixture.agent.id,
        fixture.revision.id,
      );
      assert.deepEqual(revision, fixture.revision);
    });
    const reloadedIAM = await reopened.loadNativeIAMState(installation.id);
    assert.deepEqual(
      reloadedIAM.identities.find(({ id }) => id === fixture.agent.servicePrincipalId),
      {
        id: fixture.agent.servicePrincipalId,
        kind: "service_principal",
        namespaceId: fixture.namespace.id,
        agentId: fixture.agent.id,
      },
      "The Agent service principal and its exact owner survive a PostgreSQL restart.",
    );
    assert.ok(
      reloadedIAM.identities.every((identity) => !Object.hasOwn(identity, "installationId")),
    );
    assert.ok(reloadedIAM.groups.some(({ id }) => id === groupId));
    assert.ok(
      reloadedIAM.memberships.some(
        ({ groupId: storedGroupId, principalId: storedPrincipalId }) =>
          storedGroupId === groupId && storedPrincipalId === principalId,
      ),
    );
    assert.ok(
      reloadedIAM.bindings.some(
        ({ id, subjectKind }) => id === bindingId && subjectKind === "group",
      ),
    );
    assert.ok(
      reloadedIAM.bindings.some(
        ({ id, subjectId }) =>
          id === agentBindingId && subjectId === fixture.agent.servicePrincipalId,
      ),
    );
    assert.ok(reloadedIAM.restrictions.some(({ id }) => id === restrictionId));
    assert.ok(
      reloadedIAM.bindings.some(
        ({ id, resourceKind, resourceId }) =>
          id === accountBindingId &&
          resourceKind === "service_account" &&
          resourceId === fixture.serviceAccount.id,
      ),
    );
    assert.ok(
      reloadedIAM.bindings.some(
        ({ id, resourceKind, resourceId }) =>
          id === accountCreationBindingId &&
          resourceKind === "service_account" &&
          resourceId === fixture.serviceAccountNamespace.id,
      ),
    );
    assert.ok(
      reloadedIAM.restrictions.some(
        ({ id, resourceKind }) => id === accountRestrictionId && resourceKind === "service_account",
      ),
    );

    const iam = new NativeIAMDriver(reopened);
    assert.equal(
      (
        await iam.authorize({
          principalId,
          action: "create",
          resource: {
            kind: "service_account",
            id: fixture.serviceAccountNamespace.id,
            namespaceId: fixture.serviceAccountNamespace.id,
          },
        })
      ).allowed,
      true,
      "An exact persisted collection binding authorizes ServiceAccount creation.",
    );
    assert.equal(
      (
        await iam.authorize({
          principalId,
          action: "read",
          resource: {
            kind: "service_account",
            id: fixture.serviceAccount.id,
            namespaceId: fixture.serviceAccountNamespace.id,
          },
        })
      ).allowed,
      true,
      "An exact persisted account binding grants only the named account.",
    );
    assert.equal(
      (
        await iam.authorize({
          principalId,
          action: "update",
          resource: {
            kind: "service_account",
            id: fixture.serviceAccount.id,
            namespaceId: fixture.serviceAccountNamespace.id,
          },
        })
      ).allowed,
      false,
      "An exact persisted account Restriction overrides its granted update.",
    );
    for (const identityId of [principalId, fixture.agent.servicePrincipalId]) {
      for (const action of platformActions) {
        const ownAgentDecision = await iam.authorize({
          principalId: identityId,
          action,
          resource: {
            kind: "agent",
            id: fixture.agent.id,
            namespaceId: fixture.namespace.id,
          },
        });
        assert.equal(
          ownAgentDecision.allowed,
          action !== "deploy",
          `${identityId} should receive its granted ${action} action unless an exact Restriction denies it`,
        );

        const siblingDecision = await iam.authorize({
          principalId: identityId,
          action,
          resource: { kind: "agent", id: sibling.id, namespaceId: fixture.namespace.id },
        });
        assert.equal(
          siblingDecision.allowed,
          true,
          `${identityId} should receive its granted ${action} action for a same-Namespace sibling`,
        );
      }

      const foreignNamespaceDecision = await iam.authorize({
        principalId: identityId,
        action: "read",
        resource: {
          kind: "agent",
          id: `agt_${randomUUID()}`,
          namespaceId: `ns_${randomUUID()}`,
        },
      });
      assert.equal(foreignNamespaceDecision.allowed, false);
    }
  },
);

test(
  "the PostgreSQL worker reloads exact Namespace restrictions and never dispatches revoked provisioning",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { createControllerWorker }, { createDevelopmentComputeDriver }] =
      await Promise.all([
        import("pg"),
        import("../../apps/controller/src/worker.ts"),
        import("../helpers/development.mjs"),
      ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const api = await startController(context);

    const installation = await request(api, "GET", "/installation");
    if (installation.status === 404) {
      const created = await request(api, "POST", "/installation/bootstrap", {
        name: "Revoked provisioning integration",
      });
      assert.equal(created.status, 201);
    } else {
      assert.equal(installation.status, 200);
    }
    const actor = await pool.query(
      `SELECT identity.id
       FROM occ.iam_identities AS identity
       JOIN occ."user" AS auth_user ON auth_user.id = identity.subject
       WHERE auth_user.email = $1`,
      [adminEmail],
    );
    assert.equal(actor.rowCount, 1);
    const principalId = actor.rows[0].id;

    const namespace = await request(api, "POST", "/namespaces", {
      name: `revoked-before-dispatch-${randomUUID()}`,
    });
    assert.equal(namespace.status, 201);
    const authorizedNamespace = await request(api, "POST", "/namespaces", {
      name: `authorized-positive-control-${randomUUID()}`,
    });
    assert.equal(authorizedNamespace.status, 201);

    const restrictionId = `restriction-worker-${randomUUID()}`;
    await pool.query(
      `INSERT INTO occ.iam_restrictions
       (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'create', 'namespace', $2, 'deny')`,
      [restrictionId, namespace.data.id],
    );

    const observedComputeEffects = [];
    const developmentCompute = createDevelopmentComputeDriver();
    const worker = createControllerWorker({
      pool: new Pool({ connectionString: databaseUrl }),
      pollIntervalMs: 20,
      computeDriver: {
        ...developmentCompute,
        async ensureNamespace(candidate) {
          observedComputeEffects.push(candidate.id);
          return developmentCompute.ensureNamespace(candidate);
        },
      },
      emit() {},
    });
    context.after(() => worker.stop());
    await worker.start();

    const rejected = await pollUntil(
      `revoked provisioning for Namespace ${namespace.data.id} to fail permanently`,
      async () => {
        const rows = await pool.query(
          `SELECT state, attempt_count FROM occ.controller_work
           WHERE namespace_id = $1 AND namespace_target = 'ready'`,
          [namespace.data.id],
        );
        assert.equal(rows.rowCount, 1);
        return rows.rows[0].state === "failed_permanent" ? rows.rows[0] : undefined;
      },
    );
    assert.equal(rejected.attempt_count, 1);

    await pollUntil(
      `authorized positive-control Namespace ${authorizedNamespace.data.id} to become ready`,
      async () => {
        const rows = await pool.query("SELECT status FROM occ.namespaces WHERE id = $1", [
          authorizedNamespace.data.id,
        ]);
        assert.equal(rows.rowCount, 1);
        return rows.rows[0].status === "ready" ? rows.rows[0] : undefined;
      },
    );
    assert.ok(
      observedComputeEffects.includes(authorizedNamespace.data.id),
      "the positive-control Namespace must invoke the injected ComputeDriver",
    );
    assert.ok(
      !observedComputeEffects.includes(namespace.data.id),
      "denied provisioning must not invoke the injected ComputeDriver",
    );

    const persistedNamespace = await pool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespace.data.id],
    );
    assert.deepEqual(persistedNamespace.rows, [{ status: "failed", deleted_at: null }]);

    const lifecycleEffects = await pool.query(
      `SELECT action, outcome, actor_id FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'openclaw.namespaces.lifecycle.ensure'
         AND outcome = 'success'`,
      [namespace.data.id],
    );
    assert.equal(lifecycleEffects.rowCount, 0);

    const denial = await pool.query(
      `SELECT actor_id, outcome, details FROM occ.audit_events
       WHERE resource_id = $1 AND actor_id = $2 AND outcome IN ('denied', 'failure')`,
      [namespace.data.id, principalId],
    );
    assert.ok(denial.rowCount > 0, "revocation must produce attributable durable failure evidence");
  },
);
