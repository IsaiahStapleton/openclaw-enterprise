import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import {
  alternateWorkspaceId,
  availablePort,
  createAccessTokenServiceAccount,
  createBootstrappedProviderState,
  createProviderController,
  createProviderFixture,
  providerDefinition,
  providerId,
  requiresPostgres,
  seedProviderBinding,
  serviceAccountDriverId,
  startProviderlessDevelopmentServer,
  stopProcess,
  waitFor,
  workspaceId,
} from "../helpers/postgres-provider-state.mjs";

async function request(origin, session, method, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...authenticatedHeaders(session),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  return { response, payload: await response.json() };
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
  "development API starts with stale Provider references and permits repair through Agent update",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const email = "postgres-admin@openclaw.local";
    const password = "postgres-development-password";
    const authSecret = "openclaw-provider-repair-auth-secret-minimum-32-bytes";
    const fixture = await createBootstrappedProviderState(context, {
      email,
      password,
      authSecret,
      origin,
      installationName: "PostgreSQL Provider repair integration",
    });
    let server = await startProviderlessDevelopmentServer(context, {
      port,
      origin,
      authSecret,
      configurationRoot: fixture.configurationRoot,
    });
    let session = await signInWithEmailPassword({ fetch, origin, email, password });

    const namespace = await request(origin, session, "POST", "/namespaces", {
      name: `provider-repair-${randomUUID()}`,
    });
    assert.equal(namespace.response.status, 201);
    fixture.track(namespace.payload.data);
    await fixture.state.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(namespace.payload.data.id, "provisioning", "ready"),
    );
    const configuration = await request(
      origin,
      session,
      "POST",
      `/namespaces/${namespace.payload.data.id}/configurations`,
      {
        kind: "agent",
        values: createHarnessConfiguration("codex", "gpt-4.1"),
      },
    );
    assert.equal(configuration.response.status, 201);
    const agent = await request(
      origin,
      session,
      "POST",
      `/namespaces/${namespace.payload.data.id}/agents`,
      {
        name: `provider-repair-${randomUUID()}`,
        configurationId: configuration.payload.data.id,
        executionMode: "dedicated",
      },
    );
    assert.equal(agent.response.status, 201);

    await stopProcess(server.child);
    await fixture.pool.query(
      "UPDATE occ.agents SET provider_id = $1 WHERE namespace_id = $2 AND id = $3",
      [providerId, namespace.payload.data.id, agent.payload.data.id],
    );

    server = await startProviderlessDevelopmentServer(context, {
      port,
      origin,
      authSecret,
      configurationRoot: fixture.configurationRoot,
    });
    session = await signInWithEmailPassword({ fetch, origin, email, password });
    const visible = await request(
      origin,
      session,
      "GET",
      `/namespaces/${namespace.payload.data.id}/agents/${agent.payload.data.id}`,
    );
    assert.equal(visible.response.status, 200, JSON.stringify(visible.payload));
    assert.equal(visible.payload.data.providerId, providerId);

    // Startup must allow API repair. Deploying a stale Provider reference is rejected
    // through the API's canonical unknown-reference response before admission.
    const deploy = await request(
      origin,
      session,
      "POST",
      `/namespaces/${namespace.payload.data.id}/agents/${agent.payload.data.id}/deploy`,
    );
    assert.equal(deploy.response.status, 404, JSON.stringify(deploy.payload));
    assert.equal(deploy.payload.error.code, "NOT_FOUND");
    await assertNoRevision(
      fixture.pool,
      namespace.payload.data.id,
      agent.payload.data.id,
      "stale Provider deployment must be rejected before an AgentRevision is persisted",
    );

    const repaired = await request(
      origin,
      session,
      "PATCH",
      `/namespaces/${namespace.payload.data.id}/agents/${agent.payload.data.id}`,
      {
        configurationId: configuration.payload.data.id,
        providerId: null,
        serviceAccountId: null,
        executionMode: "dedicated",
      },
    );
    assert.equal(repaired.response.status, 200);
    assert.equal(repaired.payload.data.providerId, null);

    const persisted = await fixture.pool.query(
      "SELECT provider_id, service_account_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [namespace.payload.data.id, agent.payload.data.id],
    );
    assert.deepEqual(persisted.rows, [{ provider_id: null, service_account_id: null }]);
  },
);

test(
  "PostgreSQL Provider ownership persists exact Agent associations and admits only matching managed bindings",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createProviderFixture(context);
    const controller = createProviderController(fixture);

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
    const account = await createAccessTokenServiceAccount(
      fixture.state,
      exactNamespace.id,
      "exact",
    );
    await seedProviderBinding(fixture.pool, account);

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
              r.provider_id AS revision_provider_id,
              r.admitted_spec ? 'provider_id' AS admitted_spec_has_provider_id
       FROM occ.agents AS a
       JOIN occ.agent_revisions AS r
         ON r.namespace_id = a.namespace_id AND r.agent_id = a.id
       WHERE a.namespace_id = $1 AND a.id = $2 AND r.id = $3`,
      [exactNamespace.id, dedicated.id, admitted.id],
    );
    assert.deepEqual(persistedRevision.rows, [
      {
        agent_provider_id: providerId,
        revision_provider_id: providerId,
        admitted_spec_has_provider_id: false,
      },
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

    const sameIdentity = createProviderController(fixture, {
      providers: [
        providerDefinition({
          apiKeyPath: "/etc/openclaw/chatgpt/rotated-admin-key",
          credentialTtlSeconds: 60,
        }),
      ],
    });
    await sameIdentity.validateProviderConfiguration();

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
    await createProviderController(fixture, { providers: [] }).validateProviderConfiguration();

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
        fixture.state,
        namespace.id,
        scenario.label,
      );
      await seedProviderBinding(fixture.pool, brokenAccount, scenario.binding);
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
      createAccessTokenServiceAccount(fixture.state, sourceNamespace.id, "cross-source"),
    ]);
    await seedProviderBinding(fixture.pool, sourceAccount);
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
