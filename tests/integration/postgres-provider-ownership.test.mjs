import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { NativeIAMDriver, createAuthPrincipalSeed } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createDevelopmentIAMState } from "../helpers/development-iam-state.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const requiresPostgres = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
};
const workspaceId = "11111111-1111-4111-8111-111111111111";
const alternateWorkspaceId = "22222222-2222-4222-8222-222222222222";
const providerId = "openai";
const serviceAccountDriverId = "chatgpt-service-accounts";
const apiKeyPath = "/etc/openclaw/chatgpt/admin-key";

function providerDefinition(options = {}) {
  return {
    id: providerId,
    type: "chatgpt",
    configuration: {
      workspaceId: options.workspaceId ?? workspaceId,
      apiKeyPath: options.apiKeyPath ?? apiKeyPath,
      ...(options.credentialTtlSeconds === undefined
        ? {}
        : { credentialTtlSeconds: options.credentialTtlSeconds }),
    },
    drivers: { service_account: options.serviceAccountDriverId ?? serviceAccountDriverId },
  };
}

function authorizedPrincipal(iam) {
  const required = [
    ["create", "configuration"],
    ["create", "agent"],
    ["update", "agent"],
    ["deploy", "agent"],
    ["read", "configuration"],
    ["read", "service_account"],
    ["read", "agent_revision"],
  ];
  const roles = new Set(
    iam.roles
      .filter(({ permissions }) =>
        required.every(([action, resourceKind]) =>
          permissions.some(
            (permission) =>
              permission.action === action && permission.resourceKind === resourceKind,
          ),
        ),
      )
      .map(({ id }) => id),
  );
  return iam.identities.find(
    ({ id, kind }) =>
      kind === "principal" &&
      iam.bindings.some(
        (binding) =>
          binding.subjectKind === "identity" &&
          binding.subjectId === id &&
          binding.namespaceId === undefined &&
          binding.resourceKind === undefined &&
          roles.has(binding.roleId),
      ),
  );
}

async function waitFor(description, read, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

async function ensureInstallation(state) {
  const existing = await state.loadInstallation();
  if (existing !== undefined) return existing;

  const installation = {
    id: `ins_${randomUUID()}`,
    name: "Provider ownership PostgreSQL integration",
    createdAt: new Date().toISOString(),
  };
  state.setBootstrapNativeIAM(
    createDevelopmentIAMState(
      createAuthPrincipalSeed(installation.id, "provider-ownership-integration", {
        id: `account-provider-ownership-${randomUUID()}`,
      }),
    ),
  );
  await state.transact((unit) => unit.installations.createInstallation(installation));
  return installation;
}

async function cleanupNamespaces(pool, namespaceIds) {
  if (namespaceIds.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE occ.controller_work
       SET state = 'failed_permanent',
           completed_at = clock_timestamp(),
           claim_token = NULL,
           lease_expires_at = NULL,
           updated_at = clock_timestamp()
       WHERE namespace_id = ANY($1::text[]) AND state IN ('queued', 'claimed')`,
      [namespaceIds],
    );
    await client.query(
      `UPDATE occ.agents
       SET provider_id = NULL,
           service_account_id = NULL,
           active_revision_id = NULL
       WHERE namespace_id = ANY($1::text[])`,
      [namespaceIds],
    );
    await client.query("DELETE FROM occ.service_accounts WHERE namespace_id = ANY($1::text[])", [
      namespaceIds,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function registerCoreDrivers(controller, state, options = {}) {
  const iam = new NativeIAMDriver(state, { id: "native-iam", implementation: "native" });
  const compute = createDevelopmentComputeDriver();
  const configuration = createTestConfigurationDriver();
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  controller.registerDriver(compute);
  controller.selectDriver("compute", compute.id);
  controller.registerDriver(configuration);
  controller.selectDriver("configuration", configuration.id);
  if (options.serviceAccountProviderId !== undefined) {
    const driver = {
      id: options.serviceAccountDriverId ?? serviceAccountDriverId,
      capability: "service_account",
      implementation: "chatgpt",
      providerId: options.serviceAccountProviderId,
      async create() {
        assert.fail("The provider ownership sidecar seeds external account bindings directly.");
      },
      async createCredential() {
        assert.fail("The provider ownership sidecar seeds external credentials directly.");
      },
      async delete() {
        assert.fail("The provider ownership sidecar does not delete upstream accounts.");
      },
    };
    controller.registerDriver(driver);
    controller.selectDriver("service_account", driver.id);
  }
  return { compute, configuration };
}

function createController(fixture, options = {}) {
  const providers = options.providers ?? [providerDefinition()];
  const controller = new OpenClawController(fixture.installation, {
    state: fixture.state,
    providers,
  });
  registerCoreDrivers(controller, fixture.state, {
    serviceAccountProviderId: providers.length === 0 ? undefined : providerId,
    serviceAccountDriverId: providers[0]?.drivers.service_account,
  });
  return controller;
}

async function createFixture(context) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  const workerPool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  const state = new PostgresPlatformState(pool);
  const namespaceIds = new Set();
  let worker;

  context.after(async () => {
    if (worker === undefined) await workerPool.end();
    else await worker.stop();
    await cleanupNamespaces(pool, [...namespaceIds]);
    await pool.end();
  });

  const installation = await ensureInstallation(state);
  const actor = authorizedPrincipal(await state.loadNativeIAMState());
  assert.ok(actor, "persisted IAM must contain an unrestricted provider-ownership Principal");

  function track(namespace) {
    namespaceIds.add(namespace.id);
    return namespace;
  }

  async function cleanup(...namespaces) {
    const ids = namespaces.filter(Boolean).map(({ id }) => id);
    await cleanupNamespaces(pool, ids);
    for (const id of ids) namespaceIds.delete(id);
  }

  function startWorker(options = {}) {
    const calls = [];
    const compute = createDevelopmentComputeDriver();
    const providers = options.providers ?? [providerDefinition()];
    const installation = createInstallationDriverConfiguration();
    installation.provider = providers;
    installation.drivers.compute.id = compute.id;
    installation.drivers.service_account = {
      id: providers[0]?.drivers.service_account ?? serviceAccountDriverId,
    };
    worker = createControllerWorker({
      pool: workerPool,
      drivers: {
        installation,
        computeDriver: {
          ...compute,
          async prepareRevision(revision, operationContext) {
            calls.push({
              action: "prepare",
              revisionId: revision.id,
              providerId: revision.providerId,
            });
            return compute.prepareRevision(revision, operationContext);
          },
          async retireRevision(revision) {
            calls.push({
              action: "retire",
              revisionId: revision.id,
              providerId: revision.providerId,
            });
            return compute.retireRevision(revision);
          },
        },
        configurationDriver: createTestConfigurationDriver({
          id: installation.drivers.configuration.id,
        }),
        secretDriver: createTestSecretDriver({ id: installation.drivers.secret.id }),
        createIAMDriver(platformState) {
          return new NativeIAMDriver(platformState, {
            id: installation.drivers.iam.id,
            implementation: "native",
          });
        },
      },
      pollIntervalMs: 15,
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      emit: () => {},
    });
    return { worker, calls };
  }

  return { pool, state, workerPool, installation, actor, track, cleanup, startWorker };
}

async function createReadyNamespace(fixture, label) {
  const namespace = {
    id: `ns_${randomUUID()}`,
    name: `provider-owner-${label}-${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
  return fixture.track(namespace);
}

async function createConfiguration(fixture, controller, namespace, harness = "codex") {
  return controller.createConfiguration(fixture.actor.id, {
    namespaceId: namespace.id,
    kind: "agent",
    values: createHarnessConfiguration(harness, "gpt-4.1"),
  });
}

async function createAccessTokenServiceAccount(fixture, namespace, label) {
  const id = `sa_${randomUUID()}`;
  const credential = {
    kind: "access_token",
    secretRef: {
      name: `provider-${label}-${randomUUID()}`,
      key: "OPENAI_API_KEY",
    },
  };
  return fixture.state.transact(async (unit) => {
    await unit.serviceAccounts.createServiceAccount({
      id,
      namespaceId: namespace.id,
      name: `provider-${label}-${randomUUID()}`,
    });
    return unit.serviceAccounts.updateCredential(namespace.id, id, credential);
  });
}

async function seedProviderBinding(fixture, account, options = {}) {
  await fixture.pool.query(
    `INSERT INTO occ.service_account_driver_bindings
       (service_account_id, namespace_id, provider_id, driver_id, external_account_id,
        external_credential_id, workspace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      account.id,
      account.namespaceId,
      options.providerId ?? providerId,
      options.driverId ?? serviceAccountDriverId,
      `external-account-${randomUUID()}`,
      options.credentialIssued === false ? null : `external-credential-${randomUUID()}`,
      options.workspaceId ?? workspaceId,
    ],
  );
}

async function waitForWork(pool, revisionId, expected) {
  const idempotencyKey = `agent_revision:${revisionId}:reconcile`;
  return waitFor(`controller work ${idempotencyKey} to become ${expected}`, async () => {
    const result = await pool.query(
      "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    return result.rows[0]?.state === expected ? result.rows[0] : undefined;
  });
}

async function assertNoRevision(pool, namespaceId, agentId, label) {
  const result = await pool.query(
    "SELECT count(*)::integer AS count FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2",
    [namespaceId, agentId],
  );
  assert.equal(result.rows[0].count, 0, label);
}

async function assertNoAgentNamed(pool, namespaceId, name, label) {
  const result = await pool.query(
    "SELECT count(*)::integer AS count FROM occ.agents WHERE namespace_id = $1 AND name = $2",
    [namespaceId, name],
  );
  assert.equal(result.rows[0].count, 0, label);
}

async function expectProviderConflict(operation, pattern) {
  await assert.rejects(
    operation,
    (error) =>
      error?.name === "ResourceConflictError" &&
      (pattern === undefined || pattern.test(error.message)),
  );
}

test(
  "PostgreSQL Provider ownership persists exact Agent associations and admits only matching managed bindings",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createFixture(context);
    const controller = createController(fixture);

    const draftNamespace = await createReadyNamespace(fixture, "drafts");
    const draftConfiguration = await createConfiguration(fixture, controller, draftNamespace);
    const providerless = await controller.createAgent(fixture.actor.id, {
      namespaceId: draftNamespace.id,
      name: `providerless-${randomUUID()}`,
      configurationId: draftConfiguration.id,
    });
    assert.equal(providerless.providerId, null);
    const selected = await controller.updateAgent(fixture.actor.id, {
      namespaceId: draftNamespace.id,
      agentId: providerless.id,
      configurationId: draftConfiguration.id,
      providerId,
    });
    assert.equal(selected.providerId, providerId);
    const cleared = await controller.updateAgent(fixture.actor.id, {
      namespaceId: draftNamespace.id,
      agentId: providerless.id,
      configurationId: draftConfiguration.id,
      providerId: null,
    });
    assert.equal(cleared.providerId, null);
    const draftRows = await fixture.pool.query(
      "SELECT provider_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [draftNamespace.id, providerless.id],
    );
    assert.deepEqual(draftRows.rows, [{ provider_id: null }]);

    const exactNamespace = await createReadyNamespace(fixture, "exact");
    const dedicatedConfiguration = await createConfiguration(fixture, controller, exactNamespace);
    const embeddedConfiguration = await createConfiguration(
      fixture,
      controller,
      exactNamespace,
      "openclaw",
    );
    const account = await createAccessTokenServiceAccount(fixture, exactNamespace, "exact");
    await seedProviderBinding(fixture, account);

    const binding = await fixture.state.read((view) =>
      view.serviceAccounts.findServiceAccountProviderBinding(exactNamespace.id, account.id),
    );
    assert.deepEqual(binding, {
      providerId,
      driverId: serviceAccountDriverId,
      workspaceId,
      credentialIssued: true,
    });

    const dedicated = await controller.createAgent(fixture.actor.id, {
      namespaceId: exactNamespace.id,
      name: `dedicated-${randomUUID()}`,
      configurationId: dedicatedConfiguration.id,
      providerId,
      serviceAccountId: account.id,
      executionMode: "dedicated",
    });
    const admitted = await controller.deployAgent(
      fixture.actor.id,
      { namespaceId: exactNamespace.id, agentId: dedicated.id },
      resolveApprovedHarness,
    );
    assert.equal(admitted.providerId, providerId);
    assert.deepEqual(admitted.serviceAccount, {
      id: account.id,
      credential: account.credential,
    });

    const { worker, calls } = fixture.startWorker();
    await worker.start();
    await waitForWork(fixture.pool, admitted.id, "succeeded");
    assert.deepEqual(calls, [{ action: "prepare", revisionId: admitted.id, providerId }]);
    const persistedRevision = await fixture.pool.query(
      `SELECT a.provider_id AS agent_provider_id,
              r.admitted_spec->>'provider_id' AS revision_provider_id
       FROM occ.agents AS a
       JOIN occ.agent_revisions AS r
         ON r.namespace_id = a.namespace_id AND r.agent_id = a.id
       WHERE a.namespace_id = $1 AND a.id = $2 AND r.id = $3`,
      [exactNamespace.id, dedicated.id, admitted.id],
    );
    assert.deepEqual(persistedRevision.rows, [
      { agent_provider_id: providerId, revision_provider_id: providerId },
    ]);

    const embedded = await controller.createAgent(fixture.actor.id, {
      namespaceId: exactNamespace.id,
      name: `embedded-${randomUUID()}`,
      configurationId: embeddedConfiguration.id,
      providerId,
      serviceAccountId: account.id,
      executionMode: "embedded",
    });
    await expectProviderConflict(
      () =>
        controller.deployAgent(
          fixture.actor.id,
          { namespaceId: exactNamespace.id, agentId: embedded.id },
          resolveApprovedHarness,
        ),
      /dedicated Codex Harness/,
    );
    await assertNoRevision(
      fixture.pool,
      exactNamespace.id,
      embedded.id,
      "embedded OpenClaw must be denied before a managed-account revision is persisted",
    );

    const sameIdentity = createController(fixture, {
      providers: [
        providerDefinition({
          apiKeyPath: "/etc/openclaw/chatgpt/rotated-admin-key",
          credentialTtlSeconds: 60,
        }),
      ],
    });
    await sameIdentity.validateProviderConfiguration();
    await assert.rejects(
      () => createController(fixture, { providers: [] }).validateProviderConfiguration(),
      /Persisted Provider reference does not match a configured Provider/,
    );
    await assert.rejects(
      () =>
        createController(fixture, {
          providers: [providerDefinition({ workspaceId: alternateWorkspaceId })],
        }).validateProviderConfiguration(),
      /Persisted ServiceAccount Provider binding does not match configuration/,
    );
    await assert.rejects(
      () =>
        createController(fixture, {
          providers: [providerDefinition({ serviceAccountDriverId: "retargeted-service-account" })],
        }).validateProviderConfiguration(),
      /Persisted ServiceAccount Provider binding does not match configuration/,
    );

    await controller.updateAgent(fixture.actor.id, {
      namespaceId: exactNamespace.id,
      agentId: embedded.id,
      configurationId: embeddedConfiguration.id,
      providerId: null,
      serviceAccountId: null,
      executionMode: "embedded",
    });
    const independentConfiguration = await createConfiguration(fixture, controller, exactNamespace);
    const independent = await controller.updateAgent(fixture.actor.id, {
      namespaceId: exactNamespace.id,
      agentId: dedicated.id,
      configurationId: independentConfiguration.id,
      providerId: null,
      serviceAccountId: null,
      executionMode: "dedicated",
    });
    assert.equal(independent.providerId, null);
    assert.equal(independent.serviceAccountId, undefined);
    const replacement = await controller.deployAgent(
      fixture.actor.id,
      { namespaceId: exactNamespace.id, agentId: dedicated.id },
      resolveApprovedHarness,
    );
    assert.equal(replacement.providerId, null);
    assert.equal(replacement.serviceAccount, undefined);
    await waitForWork(fixture.pool, replacement.id, "succeeded");
    assert.deepEqual(calls, [
      { action: "prepare", revisionId: admitted.id, providerId },
      { action: "prepare", revisionId: replacement.id, providerId: null },
      { action: "retire", revisionId: admitted.id, providerId },
    ]);

    const deletedAccount = await fixture.state.transact((unit) =>
      unit.serviceAccounts.deleteServiceAccount(exactNamespace.id, account.id),
    );
    assert.equal(deletedAccount, true);
    const oldRevision = await fixture.state.read((view) =>
      view.revisions.findRevision(exactNamespace.id, dedicated.id, admitted.id),
    );
    assert.equal(oldRevision?.providerId, providerId);
    const activeReplacement = await fixture.pool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [exactNamespace.id, dedicated.id],
    );
    assert.deepEqual(activeReplacement.rows, [{ active_revision_id: replacement.id }]);
    await createController(fixture, { providers: [] }).validateProviderConfiguration();

    await fixture.cleanup(draftNamespace, exactNamespace);

    for (const scenario of [
      {
        label: "providerless",
        agentProviderId: null,
        binding: {},
        message: /no Provider binding/,
      },
      {
        label: "provider-mismatch",
        agentProviderId: providerId,
        binding: { providerId: "other-provider" },
        message: /does not match its Provider/,
      },
      {
        label: "driver-mismatch",
        agentProviderId: providerId,
        binding: { driverId: "other-service-account-driver" },
        message: /does not match its Provider/,
      },
      {
        label: "workspace-mismatch",
        agentProviderId: providerId,
        binding: { workspaceId: alternateWorkspaceId },
        message: /does not match its Provider/,
      },
      {
        label: "credential-not-issued",
        agentProviderId: providerId,
        binding: { credentialIssued: false },
        message: /does not match its Provider/,
      },
    ]) {
      const namespace = await createReadyNamespace(fixture, scenario.label);
      const configuration = await createConfiguration(fixture, controller, namespace);
      const brokenAccount = await createAccessTokenServiceAccount(
        fixture,
        namespace,
        scenario.label,
      );
      await seedProviderBinding(fixture, brokenAccount, scenario.binding);
      const agent = await controller.createAgent(fixture.actor.id, {
        namespaceId: namespace.id,
        name: `${scenario.label}-${randomUUID()}`,
        configurationId: configuration.id,
        providerId: scenario.agentProviderId,
        serviceAccountId: brokenAccount.id,
        executionMode: "dedicated",
      });
      await expectProviderConflict(
        () =>
          controller.deployAgent(
            fixture.actor.id,
            { namespaceId: namespace.id, agentId: agent.id },
            resolveApprovedHarness,
          ),
        scenario.message,
      );
      await assertNoRevision(
        fixture.pool,
        namespace.id,
        agent.id,
        `${scenario.label} must be rejected before an AgentRevision is persisted`,
      );
      await fixture.cleanup(namespace);
    }

    const targetNamespace = await createReadyNamespace(fixture, "cross-namespace-target");
    const sourceNamespace = await createReadyNamespace(fixture, "cross-namespace-source");
    const [targetConfiguration, sourceAccount] = await Promise.all([
      createConfiguration(fixture, controller, targetNamespace),
      createAccessTokenServiceAccount(fixture, sourceNamespace, "cross-source"),
    ]);
    await seedProviderBinding(fixture, sourceAccount);
    assert.equal(
      await fixture.state.read((view) =>
        view.serviceAccounts.findServiceAccountProviderBinding(
          targetNamespace.id,
          sourceAccount.id,
        ),
      ),
      undefined,
      "the private Provider binding view must not resolve bindings across Namespaces",
    );
    const crossNamespaceAgentName = `cross-namespace-${randomUUID()}`;
    await assert.rejects(
      () =>
        controller.createAgent(fixture.actor.id, {
          namespaceId: targetNamespace.id,
          name: crossNamespaceAgentName,
          configurationId: targetConfiguration.id,
          providerId,
          serviceAccountId: sourceAccount.id,
          executionMode: "dedicated",
        }),
      (error) =>
        error?.name === "ScopeViolationError" &&
        /ServiceAccount does not belong to the exact Namespace/.test(error.message),
    );
    await assertNoAgentNamed(
      fixture.pool,
      targetNamespace.id,
      crossNamespaceAgentName,
      "cross-Namespace account ownership must be rejected before an Agent is persisted",
    );
    await fixture.cleanup(targetNamespace, sourceNamespace);
  },
);
