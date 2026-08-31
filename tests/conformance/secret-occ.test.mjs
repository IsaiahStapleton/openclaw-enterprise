import assert from "node:assert/strict";
import test from "node:test";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  InMemoryPlatformState,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  OpenClawController,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const administrator = "principal-secret-administrator";
const deployer = "principal-secret-deployer";
const noSecretOperator = "principal-secret-without-operate";
const secretConsumer = "principal-secret-consumer";
const metadataReader = "principal-secret-metadata-reader";
const installation = Object.freeze({
  id: "installation-secret-occ",
  name: "Secret OCC conformance",
  createdAt: "2026-08-28T00:00:00.000Z",
});

function configurationValues() {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.example.test/v1",
          apiKey: { source: "env", provider: "model", id: "OPENAI_API_KEY" },
        },
      },
    },
    secrets: {
      providers: { model: { source: "env", allowlist: ["OPENAI_API_KEY"] } },
    },
  };
}

function adminPermissions() {
  return {
    namespace: ["create", "read", "delete"],
    configuration: ["create", "read", "update", "delete"],
    secret: ["create", "read", "update", "delete", "operate"],
    agent: ["create", "read", "update", "deploy", "operate"],
    agent_revision: ["read"],
  };
}

async function fixture(options = {}) {
  const iamState = {
    identities: [administrator, deployer, noSecretOperator, secretConsumer, metadataReader].map(
      (id) => ({
        kind: "principal",
        id,
        issuer: "secret-occ-conformance",
        subject: id,
      }),
    ),
    groups: [],
    memberships: [],
    roles: [
      {
        id: "secret-occ-administrator-role",
        permissions: Object.entries(adminPermissions()).flatMap(([resourceKind, actions]) =>
          actions.map((action) => ({ action, resourceKind })),
        ),
      },
      {
        id: "secret-occ-deployer-role",
        permissions: [
          { action: "read", resourceKind: "namespace" },
          { action: "read", resourceKind: "configuration" },
          { action: "read", resourceKind: "agent" },
          { action: "deploy", resourceKind: "agent" },
          { action: "operate", resourceKind: "secret" },
          { action: "read", resourceKind: "agent_revision" },
        ],
      },
      {
        id: "secret-occ-no-secret-role",
        permissions: [
          { action: "read", resourceKind: "namespace" },
          { action: "read", resourceKind: "configuration" },
          { action: "read", resourceKind: "agent" },
          { action: "deploy", resourceKind: "agent" },
          { action: "read", resourceKind: "agent_revision" },
        ],
      },
      {
        id: "secret-occ-agent-secret-role",
        permissions: [{ action: "operate", resourceKind: "secret" }],
      },
      {
        id: "secret-occ-metadata-reader-role",
        permissions: [
          { action: "read", resourceKind: "namespace" },
          { action: "create", resourceKind: "configuration" },
          { action: "read", resourceKind: "configuration" },
          { action: "update", resourceKind: "configuration" },
          { action: "create", resourceKind: "agent" },
          { action: "read", resourceKind: "agent" },
          { action: "update", resourceKind: "agent" },
          { action: "read", resourceKind: "secret" },
        ],
      },
    ],
    bindings: [
      {
        id: "secret-occ-administrator-binding",
        subjectKind: "identity",
        subjectId: administrator,
        roleId: "secret-occ-administrator-role",
      },
      {
        id: "secret-occ-deployer-binding",
        subjectKind: "identity",
        subjectId: deployer,
        roleId: "secret-occ-deployer-role",
      },
      {
        id: "secret-occ-no-secret-binding",
        subjectKind: "identity",
        subjectId: noSecretOperator,
        roleId: "secret-occ-no-secret-role",
      },
      {
        id: "secret-occ-secret-consumer-binding",
        subjectKind: "identity",
        subjectId: secretConsumer,
        roleId: "secret-occ-agent-secret-role",
      },
      {
        id: "secret-occ-metadata-reader-binding",
        subjectKind: "identity",
        subjectId: metadataReader,
        roleId: "secret-occ-metadata-reader-role",
      },
    ],
    restrictions: [],
  };
  const iam = new NativeIAMDriver(
    { loadNativeIAMState: async () => iamState },
    { id: "secret-occ-iam" },
  );
  const state = new InMemoryPlatformState();
  const controller = new OpenClawController(installation, { state });
  const compute = createDevelopmentComputeDriver({ id: "secret-occ-compute" });
  const configurationDriver = createTestConfigurationDriver({ id: "secret-occ-configuration" });
  const secretDriver = options.secretDriver ?? createTestSecretDriver();

  for (const driver of [iam, compute, configurationDriver, secretDriver]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }

  const namespace = await controller.createNamespace(administrator, {
    name: options.namespaceName ?? "Secret OCC tenant",
  });
  const baseConfiguration = options.skipAgent
    ? undefined
    : await controller.createConfiguration(administrator, {
        namespaceId: namespace.id,
        kind: "agent",
        values: {},
      });
  const agent =
    baseConfiguration === undefined
      ? undefined
      : await controller.createAgent(administrator, {
          namespaceId: namespace.id,
          name: "Secret owner agent",
          configurationId: baseConfiguration.id,
        });

  async function makeReady() {
    await controller.transact((transaction) =>
      transaction.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
    );
  }

  function grantAgentSecretOperate(targetAgent, secret) {
    iamState.identities.push({
      kind: "service_principal",
      id: targetAgent.servicePrincipalId,
      namespaceId: targetAgent.namespaceId,
      agentId: targetAgent.id,
    });
    iamState.bindings.push({
      id: `secret-occ-agent-binding-${targetAgent.id}-${secret.id}`,
      namespaceId: targetAgent.namespaceId,
      subjectKind: "identity",
      subjectId: targetAgent.servicePrincipalId,
      roleId: "secret-occ-agent-secret-role",
      resourceKind: "secret",
      resourceId: secret.id,
    });
  }

  return {
    agent,
    baseConfiguration,
    configurationDriver,
    controller,
    grantAgentSecretOperate,
    iamState,
    makeReady,
    namespace,
    secretDriver,
    state,
  };
}

test("Secret storage requires a ready Namespace and no Agent owner before any gateway deployment", async () => {
  const { controller, makeReady, namespace, secretDriver } = await fixture({ skipAgent: true });

  // Secret material can be stored only after Compute has made the Namespace ready.
  await assert.rejects(
    controller.createSecret(administrator, {
      namespaceId: namespace.id,
      name: "model-key-before-ready",
      value: "sk-test-before-ready",
    }),
    NamespaceNotReadyError,
  );
  assert.equal(secretDriver.calls.length, 0);

  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "model-key",
    value: "sk-test-original",
  });

  assert.deepEqual(Object.keys(secret).sort(), ["id", "name", "namespaceId", "ref"]);
  assert.deepEqual(secret.ref, { kind: "secret", namespaceId: namespace.id, id: secret.id });
  assert.equal(secretDriver.valueFor(secret), "sk-test-original");
  assert.deepEqual(await controller.readSecret(administrator, namespace.id, secret.id), secret);
  assert.equal(JSON.stringify(secret).includes("sk-test-original"), false);
});

test("Secret bindings freeze public refs in revisions while value-only updates keep bindings unchanged", async () => {
  const { agent, controller, grantAgentSecretOperate, makeReady, namespace, secretDriver } =
    await fixture();
  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "model-key",
    value: "sk-test-v1",
  });
  grantAgentSecretOperate(agent, secret);
  const secretBindings = {
    OPENAI_API_KEY: { source: secret.ref },
  };
  const configuration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings,
  });
  assert.deepEqual(configuration.secretBindings, {
    OPENAI_API_KEY: { source: secret.ref, delivery: { type: "env" } },
  });
  const preserved = await controller.updateConfiguration(administrator, {
    namespaceId: namespace.id,
    configurationId: configuration.id,
    values: { ...configurationValues(), marker: "preserved" },
  });
  assert.deepEqual(preserved.secretBindings, configuration.secretBindings);
  const cleared = await controller.updateConfiguration(administrator, {
    namespaceId: namespace.id,
    configurationId: configuration.id,
    values: { ...configurationValues(), marker: "cleared" },
    secretBindings: {},
  });
  assert.equal(cleared.secretBindings, undefined);
  const restored = await controller.updateConfiguration(administrator, {
    namespaceId: namespace.id,
    configurationId: configuration.id,
    values: configurationValues(),
    secretBindings,
  });
  assert.deepEqual(restored.secretBindings, configuration.secretBindings);
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: configuration.id,
  });
  const first = await controller.deployAgent(
    administrator,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );

  const updated = await controller.updateSecret(administrator, {
    namespaceId: namespace.id,
    secretId: secret.id,
    value: "sk-test-v2",
  });
  const second = await controller.deployAgent(
    administrator,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );

  assert.deepEqual(updated, secret);
  assert.equal(secretDriver.valueFor(secret), "sk-test-v2");
  assert.equal(first.secretDriverId, secretDriver.id);
  assert.equal(second.secretDriverId, secretDriver.id);
  assert.deepEqual(first.secretBindings, {
    OPENAI_API_KEY: { source: secret.ref, delivery: { type: "env" } },
  });
  assert.deepEqual(second.secretBindings, first.secretBindings);
  assert.equal(first.configurationGeneration, restored.generation);
  assert.equal(second.configurationGeneration, restored.generation);
  assert.equal(JSON.stringify([first, second]).includes("sk-test-v"), false);
  assert.equal(secretDriver.calls.filter(({ operation }) => operation === "update").length, 1);
});

test("Secret bindings can be shared inside a Namespace and still deny cross-Namespace refs", async () => {
  const { agent, controller, makeReady, namespace } = await fixture();
  await makeReady();
  const siblingConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {},
  });
  const sibling = await controller.createAgent(administrator, {
    namespaceId: namespace.id,
    name: "Sibling agent",
    configurationId: siblingConfiguration.id,
  });
  const ownerSecret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "owner-model-key",
    value: "sk-test-owner",
  });
  const siblingSecret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "sibling-model-key",
    value: "sk-test-sibling",
  });

  const sharedConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings: { OPENAI_API_KEY: { source: ownerSecret.ref } },
  });
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: sibling.id,
    configurationId: sharedConfiguration.id,
  });

  const mixedConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings: {
      OPENAI_API_KEY: { source: ownerSecret.ref },
      MODEL_FALLBACK_KEY: { source: siblingSecret.ref },
    },
  });
  assert.deepEqual(mixedConfiguration.secretBindings, {
    OPENAI_API_KEY: { source: ownerSecret.ref, delivery: { type: "env" } },
    MODEL_FALLBACK_KEY: { source: siblingSecret.ref, delivery: { type: "env" } },
  });

  const foreign = await fixture({ namespaceName: "Foreign secret tenant" });
  await foreign.makeReady();
  const foreignSecret = await foreign.controller.createSecret(administrator, {
    namespaceId: foreign.namespace.id,
    name: "foreign-model-key",
    value: "sk-test-foreign",
  });
  await assert.rejects(
    controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values: configurationValues(),
      secretBindings: { OPENAI_API_KEY: { source: foreignSecret.ref } },
    }),
    ScopeViolationError,
  );

  const assignedConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {},
  });
  await controller.createAgent(administrator, {
    namespaceId: namespace.id,
    name: "Configuration holder",
    configurationId: assignedConfiguration.id,
  });
  const updatedAssigned = await controller.updateConfiguration(administrator, {
    namespaceId: namespace.id,
    configurationId: assignedConfiguration.id,
    values: configurationValues(),
    secretBindings: { OPENAI_API_KEY: { source: ownerSecret.ref } },
  });
  assert.deepEqual(updatedAssigned.secretBindings, {
    OPENAI_API_KEY: { source: ownerSecret.ref, delivery: { type: "env" } },
  });
});

test("Secret material, metadata, and binding permissions stay separate", async () => {
  const { agent, controller, makeReady, namespace } = await fixture();
  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "permission-boundary-key",
    value: "sk-test-boundary",
  });

  await assert.rejects(
    controller.updateSecret(secretConsumer, {
      namespaceId: namespace.id,
      secretId: secret.id,
      value: "sk-test-denied-update",
    }),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    controller.deleteSecret(secretConsumer, namespace.id, secret.id),
    AuthorizationDeniedError,
  );
  assert.deepEqual(await controller.readSecret(metadataReader, namespace.id, secret.id), secret);

  const secretBindings = { OPENAI_API_KEY: { source: secret.ref } };
  await assert.rejects(
    controller.createConfiguration(metadataReader, {
      namespaceId: namespace.id,
      kind: "agent",
      values: configurationValues(),
      secretBindings,
    }),
    AuthorizationDeniedError,
  );

  const retainedBindings = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings,
  });
  await assert.rejects(
    controller.updateConfiguration(metadataReader, {
      namespaceId: namespace.id,
      configurationId: retainedBindings.id,
      values: { ...configurationValues(), marker: "retained-bindings" },
    }),
    AuthorizationDeniedError,
  );

  const unboundConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {},
  });
  await assert.rejects(
    controller.updateConfiguration(metadataReader, {
      namespaceId: namespace.id,
      configurationId: unboundConfiguration.id,
      values: configurationValues(),
      secretBindings,
    }),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    controller.createAgent(metadataReader, {
      namespaceId: namespace.id,
      name: "unauthorized-bound-agent",
      configurationId: retainedBindings.id,
    }),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    controller.updateAgent(metadataReader, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: retainedBindings.id,
    }),
    AuthorizationDeniedError,
  );
});

test("deploying a bound Secret requires both the caller and Agent service principal to operate it", async () => {
  const { agent, controller, grantAgentSecretOperate, makeReady, namespace } = await fixture();
  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "model-key",
    value: "sk-test-authorized",
  });
  const configuration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings: { OPENAI_API_KEY: { source: secret.ref } },
  });
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: configuration.id,
  });

  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    AuthorizationDeniedError,
  );
  grantAgentSecretOperate(agent, secret);
  await assert.rejects(
    controller.deployAgent(
      noSecretOperator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    AuthorizationDeniedError,
  );
  const revision = await controller.deployAgent(
    deployer,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );
  assert.equal(revision.agentId, agent.id);
  assert.equal(revision.servicePrincipalId, agent.servicePrincipalId);
  assert.deepEqual(revision.secretBindings, {
    OPENAI_API_KEY: { source: secret.ref, delivery: { type: "env" } },
  });
});

test("Secret binding admission fails closed for missing selection and backend identity drift", async () => {
  const { agent, controller, grantAgentSecretOperate, makeReady, namespace, secretDriver } =
    await fixture();
  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "model-key",
    value: "sk-test-backend",
  });
  grantAgentSecretOperate(agent, secret);
  const configuration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings: { OPENAI_API_KEY: { source: secret.ref } },
  });
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: configuration.id,
  });

  const unselected = createTestSecretDriver({ id: "secret-unselected" });
  controller.registerDriver(unselected);
  controller.selectDriver("secret", unselected.id);
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    DependencyUnavailableError,
  );
  controller.selectDriver("secret", secretDriver.id);
  secretDriver.setResolveOverride((stored) => ({ ...stored.backendRef, uid: "uid-foreign" }));
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    DependencyUnavailableError,
  );
  assert.deepEqual(await controller.listRevisions(administrator, namespace.id, agent.id), []);
});

test("bound Secrets block deletion across current Configuration and admitted deployment dependencies", async () => {
  const { agent, controller, grantAgentSecretOperate, makeReady, namespace, secretDriver } =
    await fixture();
  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "model-key",
    value: "sk-test-delete",
  });
  grantAgentSecretOperate(agent, secret);
  const configuration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings: { OPENAI_API_KEY: { source: secret.ref } },
  });

  await assert.rejects(
    controller.deleteSecret(administrator, namespace.id, secret.id),
    ResourceConflictError,
  );
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: configuration.id,
  });
  const revision = await controller.deployAgent(
    administrator,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );
  await controller.updateConfiguration(administrator, {
    namespaceId: namespace.id,
    configurationId: configuration.id,
    values: configurationValues(),
    secretBindings: {},
  });
  await controller.transact((transaction) =>
    transaction.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id),
  );
  await assert.rejects(
    controller.deleteSecret(administrator, namespace.id, secret.id),
    ResourceConflictError,
  );
  await assert.rejects(
    controller.deleteNamespace(administrator, namespace.id),
    NamespaceNotEmptyError,
  );
  assert.equal(secretDriver.has(secret), true);
});

test("failed Secret updates do not roll back or leak the old value", async () => {
  const secretDriver = createTestSecretDriver({
    updateError: new Error("backend printed sk-test-v2"),
  });
  const { agent, controller, makeReady, namespace } = await fixture({ secretDriver });
  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "model-key",
    value: "sk-test-v1",
  });

  await assert.rejects(
    controller.updateSecret(administrator, {
      namespaceId: namespace.id,
      secretId: secret.id,
      value: "sk-test-v2",
    }),
    (error) =>
      error instanceof DependencyUnavailableError &&
      !error.message.includes("sk-test-v1") &&
      !error.message.includes("sk-test-v2"),
  );
  assert.equal(secretDriver.valueFor(secret), "sk-test-v1");
  assert.equal(JSON.stringify(secretDriver.calls.at(-1).secret).includes("sk-test-v1"), false);
  assert.equal(JSON.stringify(secretDriver.calls.at(-1).secret).includes("sk-test-v2"), false);
});
