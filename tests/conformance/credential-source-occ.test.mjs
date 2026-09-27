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

const administrator = "principal-source-administrator";
const deployer = "principal-source-deployer";
const installation = Object.freeze({
  id: "installation-credential-source-occ",
  name: "Credential source OCC conformance",
  createdAt: "2026-09-26T00:00:00.000Z",
});

/**
 * Test-only Credential Gateway: records what OCC hands it. These cases prove OCC admission,
 * authorization, and lifecycle; injection itself is proved by the real OpenShell integration.
 */
function createTestCredentialGateway(options = {}) {
  const calls = [];
  const stored = new Map();
  return {
    id: "credential-gateway-test",
    capability: "credential_gateway",
    implementation: "test-recording-gateway",
    calls,
    stored,
    async listSourceTypes() {
      return [
        {
          type: "openai",
          config: [],
          secrets: [{ name: "api_key", required: true }],
          rotation: "none",
          harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
        },
        {
          type: "registry",
          config: [{ name: "host", required: true }],
          secrets: [],
          rotation: "none",
        },
      ];
    },
    async registerSource(context, input) {
      calls.push({
        operation: "registerSource",
        sourceId: context.source.id,
        namespaceName: context.namespace.name,
        input,
      });
      if (options.registerError !== undefined) {
        throw options.registerError;
      }
      stored.set(context.source.id, input.secrets);
      return { state: "ready" };
    },
    async updateSource() {
      throw new Error("not exercised");
    },
    async rotateSource() {
      throw new Error("not exercised");
    },
    async sourceStatus(context) {
      return stored.has(context.source.id) ? { state: "ready" } : { state: "absent" };
    },
    async removeSource(context) {
      calls.push({ operation: "removeSource", sourceId: context.source.id });
      if (options.removeError?.() !== undefined) {
        throw options.removeError();
      }
      stored.delete(context.source.id);
    },
    async attachForRevision(context) {
      return context.sources.map((source) => ({ sourceId: source.id, ref: `ref-${source.id}` }));
    },
    async attachmentStatus(context) {
      return context.sources.map((source) => ({ sourceId: source.id, state: "ready" }));
    },
    async withdraw() {
      throw new Error("not exercised");
    },
  };
}

function createTestSandbox() {
  return {
    id: "sandbox-test",
    capability: "sandbox",
    implementation: "test-sandbox",
    facets: ["networking", "filesystem", "process"],
    async cleanup() {},
  };
}

async function fixture(options = {}) {
  const iamState = {
    identities: [administrator, deployer].map((id) => ({
      kind: "principal",
      id,
      issuer: "credential-source-occ",
      subject: id,
    })),
    groups: [],
    memberships: [],
    roles: [
      {
        id: "source-administrator-role",
        permissions: [
          { action: "administer", resourceKind: "installation" },
          ...["create", "read", "delete"].map((action) => ({ action, resourceKind: "namespace" })),
          ...["create", "read", "update", "delete"].map((action) => ({
            action,
            resourceKind: "configuration",
          })),
          ...["create", "read", "delete", "operate"].map((action) => ({
            action,
            resourceKind: "secret",
          })),
          ...["create", "read", "delete", "operate"].map((action) => ({
            action,
            resourceKind: "credential_source",
          })),
          ...["create", "read", "update", "delete", "deploy"].map((action) => ({
            action,
            resourceKind: "agent",
          })),
          { action: "read", resourceKind: "agent_revision" },
        ],
      },
      {
        // May create sources and deploy, but may not operate on the Secret material.
        id: "source-deployer-role",
        permissions: [
          { action: "read", resourceKind: "namespace" },
          { action: "create", resourceKind: "credential_source" },
          { action: "read", resourceKind: "credential_source" },
        ],
      },
      {
        id: "source-agent-role",
        permissions: [{ action: "operate", resourceKind: "credential_source" }],
      },
    ],
    bindings: [
      {
        id: "source-administrator-binding",
        subjectKind: "identity",
        subjectId: administrator,
        roleId: "source-administrator-role",
      },
      {
        id: "source-deployer-binding",
        subjectKind: "identity",
        subjectId: deployer,
        roleId: "source-deployer-role",
      },
    ],
    restrictions: [],
  };
  const iam = new NativeIAMDriver(
    { loadNativeIAMState: async () => iamState },
    { id: "credential-source-iam" },
  );
  const controller = new OpenClawController(installation, { state: new InMemoryPlatformState() });
  const secretDriver = createTestSecretDriver();
  const gateway = createTestCredentialGateway(options.gateway);
  // Compute owns runtime placement; the gateway must see the same name as the paired Sandbox.
  const compute = {
    ...createDevelopmentComputeDriver({ id: "credential-source-compute" }),
    async resolveSandboxNamespace(namespace) {
      return { ...namespace, name: `placed-${namespace.id.slice(-12)}` };
    },
  };
  const drivers = [
    iam,
    compute,
    createTestConfigurationDriver({ id: "credential-source-configuration" }),
    secretDriver,
    ...(options.withoutGateway ? [] : [gateway]),
    ...(options.withoutSandbox ? [] : [createTestSandbox()]),
  ];
  for (const driver of drivers) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  const namespace = await controller.createNamespace(administrator, { name: "Source tenant" });

  async function makeReady() {
    await controller.handleNamespaceLifecycle(administrator, namespace.id, "ready");
  }

  async function modelSecret() {
    return controller.createSecret(administrator, {
      namespaceId: namespace.id,
      name: `model-key-${crypto.randomUUID()}`,
      value: "synthetic-model-key",
    });
  }

  async function dedicatedAgent() {
    const configuration = await controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values: {
        agents: {
          defaults: {
            model: "codex/gpt-5.6-sol",
            models: { "codex/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        },
      },
    });
    return controller.createAgent(administrator, {
      namespaceId: namespace.id,
      name: `dedicated-${crypto.randomUUID()}`,
      configurationId: configuration.id,
      executionMode: "dedicated",
    });
  }

  function grantAgentSourceOperate(agent, source) {
    iamState.identities.push({
      kind: "service_principal",
      id: agent.servicePrincipalId,
      namespaceId: agent.namespaceId,
      agentId: agent.id,
    });
    iamState.bindings.push({
      id: `source-agent-binding-${agent.id}`,
      namespaceId: agent.namespaceId,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: "source-agent-role",
      resourceKind: "credential_source",
      resourceId: source.id,
    });
  }

  return {
    controller,
    dedicatedAgent,
    gateway,
    grantAgentSourceOperate,
    makeReady,
    modelSecret,
    namespace,
    secretDriver,
  };
}

test("registration validates the catalog and hands the gateway values OCC never stores", async () => {
  const { controller, gateway, makeReady, modelSecret, namespace } = await fixture();
  await assert.rejects(
    controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "before-ready",
      type: "openai",
    }),
    NamespaceNotReadyError,
  );
  await makeReady();
  const secret = await modelSecret();

  // Unknown types, missing required inputs, and unknown fields fail before any gateway effect.
  for (const [input, expected] of [
    [{ type: "unknown" }, /does not support this source type/],
    [{ type: "openai" }, /secrets field api_key is required/],
    [
      { type: "openai", secrets: { api_key: secret.ref, extra: secret.ref } },
      /extra is not supported/,
    ],
    [{ type: "registry" }, /config field host is required/],
  ]) {
    await assert.rejects(
      controller.createCredentialSource(administrator, {
        namespaceId: namespace.id,
        name: "invalid",
        ...input,
      }),
      expected,
    );
  }
  assert.equal(gateway.calls.length, 0);

  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  assert.equal(source.state, "ready");
  assert.deepEqual(source.status, { state: "ready" });
  assert.deepEqual(source.ref, {
    kind: "credential_source",
    namespaceId: namespace.id,
    id: source.id,
  });
  assert.deepEqual(source.secrets, { api_key: secret.ref });
  // The gateway receives the resolved value; OCC metadata only carries the Secret reference.
  assert.deepEqual(gateway.stored.get(source.id), { api_key: "synthetic-model-key" });
  // The gateway receives Compute's placement, not the Namespace display name.
  assert.equal(
    gateway.calls.find(({ operation }) => operation === "registerSource").namespaceName,
    `placed-${namespace.id.slice(-12)}`,
  );
  assert.equal(JSON.stringify(source).includes("synthetic-model-key"), false);
  const listed = await controller.listCredentialSources(administrator, namespace.id);
  assert.equal(JSON.stringify(listed).includes("synthetic-model-key"), false);
});

test("registration requires operate on every referenced Secret before reading it", async () => {
  const { controller, gateway, makeReady, modelSecret, namespace, secretDriver } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  await assert.rejects(
    controller.createCredentialSource(deployer, {
      namespaceId: namespace.id,
      name: "unauthorized",
      type: "openai",
      secrets: { api_key: secret.ref },
    }),
    AuthorizationDeniedError,
  );
  assert.equal(secretDriver.calls.filter(({ operation }) => operation === "withValue").length, 0);
  assert.equal(gateway.calls.length, 0);
});

test("a failed registration leaves no source and compensates a possibly stored copy", async () => {
  const { controller, gateway, makeReady, modelSecret, namespace } = await fixture({
    gateway: { registerError: new Error("gateway unavailable") },
  });
  await makeReady();
  const secret = await modelSecret();
  await assert.rejects(
    controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    }),
    DependencyUnavailableError,
  );
  assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
  assert.deepEqual(
    gateway.calls.map(({ operation }) => operation),
    ["registerSource", "removeSource"],
  );
});

test("deletion is refused while referenced, retried while the gateway fails, and gates the Namespace", async () => {
  let failRemove = false;
  const { controller, dedicatedAgent, gateway, makeReady, modelSecret, namespace } = await fixture({
    gateway: { removeError: () => (failRemove ? new Error("gateway unavailable") : undefined) },
  });
  await makeReady();
  const secret = await modelSecret();
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  const agent = await dedicatedAgent();
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    harnessAuth: { method: "credential_source", sourceId: source.id },
  });

  // A bound source and its Secret cannot be removed out from under the Agent.
  await assert.rejects(
    controller.deleteCredentialSource(administrator, namespace.id, source.id),
    ResourceConflictError,
  );
  await assert.rejects(controller.deleteSecret(administrator, namespace.id, secret.id));
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    harnessAuth: null,
  });

  // A gateway failure keeps the record `deleting` so the caller can retry.
  failRemove = true;
  await assert.rejects(
    controller.deleteCredentialSource(administrator, namespace.id, source.id),
    DependencyUnavailableError,
  );
  const deleting = await controller.readCredentialSource(administrator, namespace.id, source.id);
  assert.equal(deleting.state, "deleting");
  // A deleting source cannot be bound again, and it still makes the Namespace nonempty.
  await assert.rejects(
    controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      harnessAuth: { method: "credential_source", sourceId: source.id },
    }),
    ScopeViolationError,
  );

  failRemove = false;
  await controller.deleteCredentialSource(administrator, namespace.id, source.id);
  assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
  assert.equal(gateway.stored.has(source.id), false);
});

test("a Namespace with a credential source cannot be deleted", async () => {
  const { controller, makeReady, modelSecret, namespace } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  await assert.rejects(
    controller.deleteNamespace(administrator, namespace.id),
    NamespaceNotEmptyError,
  );
});

test("deploy admission freezes the source and requires the Agent principal to operate it", async () => {
  const {
    controller,
    dedicatedAgent,
    gateway,
    grantAgentSourceOperate,
    makeReady,
    modelSecret,
    namespace,
  } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  const agent = await dedicatedAgent();
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    harnessAuth: { method: "credential_source", sourceId: source.id },
  });
  const deploy = () =>
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );

  await assert.rejects(deploy(), AuthorizationDeniedError);
  grantAgentSourceOperate(agent, source);
  const revision = await deploy();
  assert.deepEqual(revision.harnessAuth, {
    method: "credential_source",
    sourceId: source.id,
    credentialGatewayId: gateway.id,
    sourceType: "openai",
    loginMode: "api_key",
  });
});

test("Namespace IAM delegates operate on an exact credential source to an Agent principal", async () => {
  const { controller, dedicatedAgent, makeReady, modelSecret, namespace } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  const agent = await dedicatedAgent();
  // Operators grant deployment access through the Namespace IAM API, so the policy surface
  // must accept credential_source Roles and exact source targets like other Namespace kinds.
  const role = await controller.createIAMRole(administrator, {
    namespaceId: namespace.id,
    name: "Use a credential source",
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  const binding = await controller.createIAMAccessBinding(administrator, {
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "credential_source",
    resourceId: source.id,
  });
  assert.equal(binding.resourceId, source.id);
  // A target outside the Namespace's credential sources is refused before policy is written.
  await assert.rejects(
    controller.createIAMAccessBinding(administrator, {
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: role.id,
      resourceKind: "credential_source",
      resourceId: "cs_00000000-0000-4000-8000-000000000000",
    }),
    ScopeViolationError,
  );
});

test("a selected Credential Gateway rejects Secret-backed Harness authentication", async () => {
  const { controller, dedicatedAgent, makeReady, modelSecret, namespace } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  const agent = await dedicatedAgent();
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    harnessAuth: { method: "api_key", source: secret.ref },
  });
  // There is no environment-delivery fallback once a gateway owns model credentials.
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    /requires credential-source Harness authentication/,
  );
});
