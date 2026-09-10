import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  DriverLifecycleAbortedError,
  DriverLifecycleConnectionLostError,
  DriverLifecycleTimeoutError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import {
  applyDriverLifecycle,
  recordExistingDriverLifecycle,
  uninstallDriverLifecycle,
} from "../../packages/occ/src/state/driver-lifecycle.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { PostgresWorkQueue } from "../../packages/occ/src/state/postgres-work-queue.ts";
import {
  createAccessTokenServiceAccount,
  ensureInstallation,
  seedProviderBinding,
} from "../helpers/postgres-provider-state.mjs";

const databaseUrl = process.env.OCC_LIFECYCLE_STATE_DATABASE_URL;
const requiresPostgres = {
  skip: databaseUrl
    ? false
    : "Set OCC_LIFECYCLE_STATE_DATABASE_URL to a fresh disposable database.",
};

function target(options = {}) {
  const id = options.id ?? `driver-${randomUUID()}`;
  return {
    capability: options.capability ?? "compute",
    id,
    implementationFamily: options.implementationFamily ?? "@fixture/test-compute-driver",
    version: options.version ?? "1.0.0",
    ...(options.lifecycleHooks === undefined ? {} : { lifecycleHooks: options.lifecycleHooks }),
  };
}

async function closePool(pool) {
  await pool.query("DELETE FROM occ.driver_lifecycle_receipts");
  await pool.end();
}

async function setup(context) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  context.after(() => closePool(pool));
  const state = new PostgresPlatformState(pool);
  const installation = await ensureInstallation(state, "driver-lifecycle");
  await pool.query("DELETE FROM occ.driver_lifecycle_receipts");
  return { pool, installation, state };
}

async function receipts(pool) {
  return (
    await pool.query(
      `SELECT capability, driver_id, implementation_family, version
       FROM occ.driver_lifecycle_receipts
       ORDER BY capability, driver_id`,
    )
  ).rows;
}

async function createNamespace(state, label) {
  const namespace = {
    id: `ns_${randomUUID()}`,
    name: `driver-lifecycle-${label}-${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  await state.transact((unit) => unit.namespaces.createNamespace(namespace));
  return namespace;
}

async function deleteNamespace(state, namespaceId) {
  await state.transact(async (unit) => {
    await unit.namespaces.transitionNamespaceStatus(namespaceId, "ready", "deleting");
    await unit.namespaces.markNamespaceDeleted(namespaceId, new Date().toISOString());
  });
}

async function assertBlockedUninstallKeepsReceipt({
  pool,
  capability,
  id,
  implementationFamily,
  providerIds = [],
}) {
  let called = false;
  const selected = target({
    capability,
    id,
    implementationFamily,
    lifecycleHooks: {
      async onUninstall() {
        called = true;
      },
    },
  });
  await recordExistingDriverLifecycle({ pool, targets: [selected] });
  const before = await receipts(pool);

  await assert.rejects(
    uninstallDriverLifecycle({
      pool,
      targets: [selected],
      capability,
      driverId: id,
      providerIds,
    }),
    ResourceConflictError,
  );
  assert.equal(called, false);
  assert.deepEqual(await receipts(pool), before);
}

test(
  "Driver lifecycle receipts follow install, update, no-op, uninstall, and reinstall",
  requiresPostgres,
  async (context) => {
    const { pool, installation } = await setup(context);
    const events = [];
    const hooks = {
      async onInstall(value) {
        events.push({
          hook: "onInstall",
          installationId: value.installationId,
          capability: value.capability,
          driverId: value.driverId,
          version: value.version,
          previousVersion: value.previousVersion,
          frozen: Object.isFrozen(value),
          signal: value.signal instanceof AbortSignal,
        });
      },
      async onUpdate(value) {
        events.push({
          hook: "onUpdate",
          driverId: value.driverId,
          version: value.version,
          previousVersion: value.previousVersion,
        });
      },
      async onUninstall(value) {
        events.push({
          hook: "onUninstall",
          driverId: value.driverId,
          version: value.version,
          previousVersion: value.previousVersion,
        });
      },
    };
    const selected = target({ id: "compute-lifecycle", lifecycleHooks: hooks });

    assert.deepEqual(await applyDriverLifecycle({ pool, targets: [selected] }), [
      {
        kind: "installed",
        capability: "compute",
        driverId: "compute-lifecycle",
        implementationFamily: "@fixture/test-compute-driver",
        version: "1.0.0",
      },
    ]);
    assert.equal(events[0].installationId, installation.id);
    assert.equal(events[0].frozen, true);
    assert.equal(events[0].signal, true);
    assert.deepEqual(await receipts(pool), [
      {
        capability: "compute",
        driver_id: "compute-lifecycle",
        implementation_family: "@fixture/test-compute-driver",
        version: "1.0.0",
      },
    ]);

    assert.deepEqual(await applyDriverLifecycle({ pool, targets: [selected] }), [
      {
        kind: "unchanged",
        capability: "compute",
        driverId: "compute-lifecycle",
        implementationFamily: "@fixture/test-compute-driver",
        version: "1.0.0",
      },
    ]);
    assert.equal(events.length, 1);

    const upgraded = target({
      id: "compute-lifecycle",
      version: "1.1.0",
      lifecycleHooks: hooks,
    });
    assert.deepEqual(await applyDriverLifecycle({ pool, targets: [upgraded] }), [
      {
        kind: "updated",
        capability: "compute",
        driverId: "compute-lifecycle",
        implementationFamily: "@fixture/test-compute-driver",
        version: "1.1.0",
        previousVersion: "1.0.0",
      },
    ]);
    assert.deepEqual(events[1], {
      hook: "onUpdate",
      driverId: "compute-lifecycle",
      version: "1.1.0",
      previousVersion: "1.0.0",
    });

    assert.deepEqual(
      await uninstallDriverLifecycle({
        pool,
        targets: [upgraded],
        capability: "compute",
        driverId: "compute-lifecycle",
      }),
      [
        {
          kind: "uninstalled",
          capability: "compute",
          driverId: "compute-lifecycle",
          implementationFamily: "@fixture/test-compute-driver",
          version: "1.1.0",
        },
      ],
    );
    assert.deepEqual(events[2], {
      hook: "onUninstall",
      driverId: "compute-lifecycle",
      version: "1.1.0",
      previousVersion: undefined,
    });
    assert.deepEqual(await receipts(pool), []);

    assert.equal((await applyDriverLifecycle({ pool, targets: [upgraded] }))[0].kind, "installed");
  },
);

test("external command abort skips hooks and receipt writes", requiresPostgres, async (context) => {
  const { pool } = await setup(context);
  let called = false;
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    applyDriverLifecycle({
      pool,
      targets: [
        target({
          id: "externally-aborted-driver",
          lifecycleHooks: {
            async onInstall() {
              called = true;
            },
          },
        }),
      ],
      signal: controller.signal,
    }),
    DriverLifecycleAbortedError,
  );
  assert.equal(called, false);
  assert.deepEqual(await receipts(pool), []);
});

test("record-existing writes only once and never runs hooks", requiresPostgres, async (context) => {
  const { pool } = await setup(context);
  let called = false;
  const selected = target({
    id: "recorded-driver",
    lifecycleHooks: {
      async onInstall() {
        called = true;
      },
    },
  });

  assert.deepEqual(await recordExistingDriverLifecycle({ pool, targets: [selected] }), [
    {
      kind: "recorded",
      capability: "compute",
      driverId: "recorded-driver",
      implementationFamily: "@fixture/test-compute-driver",
      version: "1.0.0",
    },
  ]);
  assert.equal(called, false);
  await assert.rejects(
    recordExistingDriverLifecycle({ pool, targets: [selected] }),
    ResourceConflictError,
  );
});

test(
  "later hook failure preserves earlier successful receipts",
  requiresPostgres,
  async (context) => {
    const { pool } = await setup(context);
    const first = target({
      capability: "configuration",
      id: "configuration-lifecycle",
      implementationFamily: "@fixture/test-configuration-driver",
    });
    const second = target({
      id: "failing-compute",
      lifecycleHooks: {
        async onInstall() {
          throw new Error("must not be surfaced");
        },
      },
    });

    await assert.rejects(
      applyDriverLifecycle({ pool, targets: [first, second] }),
      /Driver lifecycle hook failed/,
    );
    assert.deepEqual(await receipts(pool), [
      {
        capability: "configuration",
        driver_id: "configuration-lifecycle",
        implementation_family: "@fixture/test-configuration-driver",
        version: "1.0.0",
      },
    ]);
  },
);

test(
  "family changes require explicit uninstall before install",
  requiresPostgres,
  async (context) => {
    const { pool } = await setup(context);
    const selected = target({ id: "family-change" });
    await applyDriverLifecycle({ pool, targets: [selected] });
    await assert.rejects(
      applyDriverLifecycle({
        pool,
        targets: [target({ id: "family-change", implementationFamily: "@fixture/other-driver" })],
      }),
      ScopeViolationError,
    );
    assert.equal((await receipts(pool))[0].implementation_family, "@fixture/test-compute-driver");
  },
);

test(
  "timeout aborts the hook and leaves the receipt unchanged",
  requiresPostgres,
  async (context) => {
    const { pool } = await setup(context);
    let observedAbort = false;
    const selected = target({
      id: "timeout-driver",
      lifecycleHooks: {
        async onInstall({ signal }) {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
            },
            { once: true },
          );
          await new Promise(() => {});
        },
      },
    });

    await assert.rejects(
      applyDriverLifecycle({
        pool,
        targets: [selected],
        timeoutMs: 20,
        connectionCheckIntervalMs: 5,
      }),
      DriverLifecycleTimeoutError,
    );
    assert.equal(observedAbort, true);
    assert.deepEqual(await receipts(pool), []);
  },
);

test(
  "database session loss aborts the hook and leaves the receipt unchanged",
  requiresPostgres,
  async (context) => {
    const { pool } = await setup(context);
    const selected = target({
      id: "connection-loss-driver",
      lifecycleHooks: {
        async onInstall() {
          const activity = await pool.query(
            `SELECT pid
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND usename = current_user
             AND pid <> pg_backend_pid()
             AND application_name = 'openclaw-driver-lifecycle'
           ORDER BY backend_start DESC
           LIMIT 1`,
          );
          const pid = activity.rows[0]?.pid;
          assert.equal(typeof pid, "number");
          const terminated = await pool.query("SELECT pg_terminate_backend($1) AS terminated", [
            pid,
          ]);
          assert.equal(terminated.rows[0]?.terminated, true);
          await new Promise(() => {});
        },
      },
    });

    await assert.rejects(
      applyDriverLifecycle({
        pool,
        targets: [selected],
        timeoutMs: 5_000,
        connectionCheckIntervalMs: 5,
      }),
      DriverLifecycleConnectionLostError,
    );
    assert.deepEqual(await receipts(pool), []);
  },
);

test(
  "session advisory lock contention rejects another lifecycle command",
  requiresPostgres,
  async (context) => {
    const { pool, installation } = await setup(context);
    const lockClient = await pool.connect();
    const key = `openclaw-enterprise:driver-lifecycle:${installation.id}`;
    await lockClient.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    try {
      await assert.rejects(
        applyDriverLifecycle({ pool, targets: [target({ id: "locked-driver" })] }),
        ResourceConflictError,
      );
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      lockClient.release();
    }
  },
);

test(
  "uninstall blocks Drivers that still have conservative platform references",
  requiresPostgres,
  async (context) => {
    const { pool } = await setup(context);
    const selected = target({
      capability: "iam",
      id: "iam-lifecycle",
      implementationFamily: "@fixture/test-iam-driver",
    });
    await recordExistingDriverLifecycle({ pool, targets: [selected] });

    await assert.rejects(
      uninstallDriverLifecycle({
        pool,
        targets: [selected],
        capability: "iam",
        driverId: "iam-lifecycle",
      }),
      ResourceConflictError,
    );
  },
);

test(
  "configuration rows block Configuration Driver uninstall before hooks",
  requiresPostgres,
  async (context) => {
    const { pool, state } = await setup(context);
    const namespace = await createNamespace(state, "configuration");
    const configuration = {
      id: `cfg_${randomUUID()}`,
      namespaceId: namespace.id,
      kind: "agent",
      generation: 1,
      createdAt: new Date().toISOString(),
    };
    try {
      await state.transact((unit) => unit.configurations.createConfiguration(configuration));

      await assertBlockedUninstallKeepsReceipt({
        pool,
        capability: "configuration",
        id: "configuration-blocked",
        implementationFamily: "@fixture/test-configuration-driver",
      });
    } finally {
      await state.transact((unit) =>
        unit.configurations.deleteConfiguration(namespace.id, configuration.id),
      );
      await deleteNamespace(state, namespace.id);
    }
  },
);

test(
  "Secret ownership blocks Secret Driver uninstall before hooks",
  requiresPostgres,
  async (context) => {
    const { pool, state } = await setup(context);
    const namespace = await createNamespace(state, "secret");
    const secret = {
      id: `sec_${randomUUID()}`,
      namespaceId: namespace.id,
      name: `driver-lifecycle-secret-${randomUUID()}`,
      driverId: "secret-blocked",
      backendRef: {
        namespaceName: "driver-lifecycle",
        name: `secret-${randomUUID()}`,
        key: "token",
        uid: randomUUID(),
      },
      createdAt: new Date().toISOString(),
    };
    try {
      await state.transact((unit) => unit.secrets.createSecret(secret));

      await assertBlockedUninstallKeepsReceipt({
        pool,
        capability: "secret",
        id: "secret-blocked",
        implementationFamily: "@fixture/test-secret-driver",
      });
    } finally {
      await state.transact((unit) => unit.secrets.deleteSecret(namespace.id, secret.id));
      await deleteNamespace(state, namespace.id);
    }
  },
);

test(
  "ServiceAccount Provider bindings block ServiceAccount Driver uninstall before hooks",
  requiresPostgres,
  async (context) => {
    const { pool, state } = await setup(context);
    const namespace = await createNamespace(state, "service-account");
    const account = await createAccessTokenServiceAccount(state, namespace.id, "driver-lifecycle");
    try {
      await seedProviderBinding(pool, account, {
        driverId: "service-account-blocked",
        providerId: "provider-lifecycle",
      });

      await assertBlockedUninstallKeepsReceipt({
        pool,
        capability: "service_account",
        id: "service-account-blocked",
        implementationFamily: "@fixture/test-service-account-driver",
        providerIds: ["provider-lifecycle"],
      });
    } finally {
      await state.transact((unit) =>
        unit.serviceAccounts.deleteServiceAccount(namespace.id, account.id),
      );
      await deleteNamespace(state, namespace.id);
    }
  },
);

test("retained AgentRevisions block uninstall before hooks", requiresPostgres, async (context) => {
  const { pool, state } = await setup(context);
  const namespace = await createNamespace(state, "revision");
  const configuration = {
    id: `cfg_${randomUUID()}`,
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
  };
  const agent = {
    id: `agt_${randomUUID()}`,
    namespaceId: namespace.id,
    name: `driver-lifecycle-agent-${randomUUID()}`,
    configurationId: configuration.id,
    providerId: null,
    executionMode: "embedded",
    servicePrincipalId: `service-agent-${randomUUID()}`,
    createdAt: new Date().toISOString(),
  };
  const revision = {
    id: `rev_${randomUUID()}`,
    namespaceId: namespace.id,
    agentId: agent.id,
    revision: 1,
    providerId: null,
    configuration: { test: "retained revision" },
    configurationId: configuration.id,
    configurationKind: "agent",
    configurationGeneration: 1,
    harness: { id: "test-harness", version: "1.0.0", mode: "embedded" },
    compute: { id: "other-compute", implementation: "test" },
    secretDriverId: "secret-retained-revision",
    servicePrincipalId: agent.servicePrincipalId,
    createdAt: new Date().toISOString(),
  };
  await state.transact(async (unit) => {
    await unit.configurations.createConfiguration(configuration);
    await unit.agents.createAgent(agent);
    await unit.revisions.createRevision(revision);
  });

  await assertBlockedUninstallKeepsReceipt({
    pool,
    capability: "secret",
    id: "secret-retained-revision",
    implementationFamily: "@fixture/test-secret-driver",
  });
});

test(
  "failed-permanent controller work blocks uninstall before hooks",
  requiresPostgres,
  async (context) => {
    const { pool, state } = await setup(context);
    const namespace = await createNamespace(state, "work");
    const queue = new PostgresWorkQueue(pool, { maxAttempts: 1, leaseDurationMs: 30_000 });
    const idempotencyKey = `namespace:${namespace.id}:driver-lifecycle`;
    await queue.enqueue({
      idempotencyKey,
      namespaceId: namespace.id,
      namespaceTarget: "ready",
      actorId: `principal-${randomUUID()}`,
    });
    const claim = await queue.claim();
    assert.ok(claim);
    assert.equal(claim.idempotencyKey, idempotencyKey);
    await queue.fail(claim, { code: "driver_lifecycle_blocker" });

    await assertBlockedUninstallKeepsReceipt({
      pool,
      capability: "secret",
      id: "secret-work-blocked",
      implementationFamily: "@fixture/test-secret-driver",
    });
  },
);
