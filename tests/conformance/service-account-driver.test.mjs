import assert from "node:assert/strict";
import test from "node:test";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  DriverSelectionError,
  OpenClawController,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";

const administrator = "service-account-driver-administrator";
const reader = "service-account-driver-reader";
const installation = Object.freeze({
  id: "installation-service-account-driver",
  name: "ServiceAccount Driver OCC conformance",
  createdAt: "2026-08-24T00:00:00.000Z",
});

async function fixture() {
  const administrators = {
    namespace: ["create", "read"],
    service_account: ["create", "read", "update", "delete"],
    configuration: ["create", "read"],
    agent: ["create", "read", "deploy"],
  };
  const iam = new NativeIAMDriver(
    {
      loadNativeIAMState: async () => ({
        identities: [administrator, reader].map((id) => ({
          kind: "principal",
          id,
          issuer: "service-account-driver-conformance",
          subject: id,
        })),
        groups: [],
        memberships: [],
        roles: [
          {
            id: "service-account-driver-administrator-role",
            permissions: Object.entries(administrators).flatMap(([resourceKind, actions]) =>
              actions.map((action) => ({ action, resourceKind })),
            ),
          },
          {
            id: "service-account-driver-reader-role",
            permissions: [{ action: "read", resourceKind: "service_account" }],
          },
        ],
        bindings: ["administrator", "reader"].map((kind) => ({
          id: `service-account-driver-${kind}-binding`,
          subjectKind: "identity",
          subjectId: kind === "administrator" ? administrator : reader,
          roleId: `service-account-driver-${kind}-role`,
        })),
        restrictions: [],
      }),
    },
    { id: "service-account-driver-iam" },
  );
  const controller = new OpenClawController(installation);
  const compute = createDevelopmentComputeDriver();
  const configuration = createTestConfigurationDriver();
  const externalAccounts = new Set();
  const externalCredentials = new Set();
  const driver = {
    id: "service-account-driver-conformance",
    capability: "service_account",
    implementation: "occ-conformance-service-account",
    async create(account) {
      externalAccounts.add(account.id);
      controller.registerRollback(async () => {
        externalAccounts.delete(account.id);
      });
    },
    async createCredential(account) {
      externalCredentials.add(account.id);
      controller.registerRollback(async () => {
        externalCredentials.delete(account.id);
      });
      return {
        kind: "access_token",
        secretRef: { name: `account-${account.id.slice(3)}`, key: "token" },
      };
    },
    async delete(account) {
      externalCredentials.delete(account.id);
      externalAccounts.delete(account.id);
    },
  };
  for (const selected of [iam, compute, configuration, driver]) {
    controller.registerDriver(selected);
    controller.selectDriver(selected.capability, selected.id);
  }
  const namespace = await controller.createNamespace(administrator, {
    name: "ServiceAccount Driver conformance tenant",
  });

  return { controller, driver, externalAccounts, externalCredentials, namespace };
}

test("a selected ServiceAccount Driver owns authorized account and credential lifecycle", async () => {
  const { controller, driver, externalAccounts, externalCredentials, namespace } = await fixture();

  assert.equal(controller.selectedDriver("service_account"), driver);
  assert.throws(
    () =>
      controller.registerDriver({
        id: "service-account-driver-invalid",
        capability: "service_account",
        implementation: "invalid",
        create: async () => {},
        delete: async () => {},
      }),
    DriverSelectionError,
  );
  const account = await controller.createServiceAccount(administrator, {
    namespaceId: namespace.id,
    name: "provider-managed-account",
  });
  assert.equal(externalAccounts.has(account.id), true);

  // An exact account read grant cannot issue its credential or trigger Driver effects.
  await assert.rejects(
    controller.createServiceAccountCredential(reader, namespace.id, account.id),
    AuthorizationDeniedError,
  );
  assert.equal(externalCredentials.size, 0);

  const issued = await controller.createServiceAccountCredential(
    administrator,
    namespace.id,
    account.id,
  );
  assert.equal(issued.credential.kind, "access_token");
  assert.equal(externalCredentials.has(account.id), true);
  assert.deepEqual(
    await controller.getServiceAccount(administrator, namespace.id, account.id),
    issued,
  );
  await assert.rejects(
    controller.createServiceAccountCredential(administrator, namespace.id, account.id),
    ResourceConflictError,
  );
  await assert.rejects(
    controller.updateServiceAccountCredential(administrator, namespace.id, account.id, {
      kind: "api_key",
      secretRef: { name: "replacement-secret", key: "token" },
    }),
    ResourceConflictError,
  );

  await controller.deleteServiceAccount(administrator, namespace.id, account.id);
  assert.equal(externalAccounts.has(account.id), false);
  assert.equal(externalCredentials.has(account.id), false);
  await assert.rejects(
    controller.getServiceAccount(administrator, namespace.id, account.id),
    ScopeViolationError,
  );
});

test("outer transaction failure compensates selected Driver account and credential effects", async () => {
  const { controller, externalAccounts, externalCredentials, namespace } = await fixture();
  let abortedAccount;

  // HTTP audit append runs after the inner OCC mutation in this same outer transaction.
  await assert.rejects(
    controller.transact(async () => {
      abortedAccount = await controller.createServiceAccount(administrator, {
        namespaceId: namespace.id,
        name: "aborted-account",
      });
      throw new Error("transactional audit append failed");
    }),
    /transactional audit append failed/,
  );
  assert.equal(externalAccounts.has(abortedAccount.id), false);
  await assert.rejects(
    controller.getServiceAccount(administrator, namespace.id, abortedAccount.id),
    ScopeViolationError,
  );

  const account = await controller.createServiceAccount(administrator, {
    namespaceId: namespace.id,
    name: "aborted-credential",
  });
  await assert.rejects(
    controller.transact(async () => {
      await controller.createServiceAccountCredential(administrator, namespace.id, account.id);
      throw new Error("credential audit append failed");
    }),
    /credential audit append failed/,
  );
  assert.equal(externalAccounts.has(account.id), true);
  assert.equal(externalCredentials.has(account.id), false);
  assert.equal(
    (await controller.getServiceAccount(administrator, namespace.id, account.id)).credential,
    undefined,
  );
});

test("access-token account revisions admit dedicated Codex and reject embedded OpenClaw", async () => {
  const { controller, namespace } = await fixture();
  const account = await controller.createServiceAccount(administrator, {
    namespaceId: namespace.id,
    name: "codex-access-token-account",
  });
  const issued = await controller.createServiceAccountCredential(
    administrator,
    namespace.id,
    account.id,
  );
  const embeddedConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {},
  });
  const embedded = await controller.createAgent(administrator, {
    namespaceId: namespace.id,
    name: "embedded-access-token-agent",
    configurationId: embeddedConfiguration.id,
    serviceAccountId: account.id,
  });
  const dedicatedConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {
      agents: {
        defaults: {
          model: "codex/gpt-4.1",
          models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
        },
      },
    },
  });
  const dedicated = await controller.createAgent(administrator, {
    namespaceId: namespace.id,
    name: "dedicated-access-token-agent",
    configurationId: dedicatedConfiguration.id,
    serviceAccountId: account.id,
    executionMode: "dedicated",
  });
  await controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );

  // An unsupported embedded runtime must fail before creating an immutable revision.
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: embedded.id },
      resolveApprovedDevelopmentHarness,
    ),
    ResourceConflictError,
  );
  const revision = await controller.deployAgent(
    administrator,
    { namespaceId: namespace.id, agentId: dedicated.id },
    resolveApprovedDevelopmentHarness,
  );
  assert.deepEqual(revision.harness, { id: "codex", version: "1.0.0", mode: "dedicated" });
  assert.deepEqual(revision.serviceAccount, { id: account.id, credential: issued.credential });
  assert.equal(Object.isFrozen(revision.serviceAccount), true);
  assert.equal(Object.isFrozen(revision.serviceAccount.credential), true);
});
