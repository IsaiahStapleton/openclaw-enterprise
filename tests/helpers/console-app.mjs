import assert from "node:assert/strict";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { providerSummariesFromDefinitions } from "../../apps/controller/src/composition/installation-config.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInWithEmailPassword } from "./auth-session.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.mjs";

export const providerFixtures = Object.freeze([
  Object.freeze({
    id: "openai-primary",
    type: "chatgpt",
    configuration: Object.freeze({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      apiKeyPath: "/var/run/secrets/openclaw/providers/openai-primary/api-key",
      credentialTtlSeconds: 3600,
    }),
    drivers: Object.freeze({ service_account: "chatgpt-provider-service-account" }),
  }),
]);

function computeDriver() {
  return {
    id: "console-compute",
    capability: "compute",
    implementation: "test-memory-lifecycle",
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async retireRevision() {},
  };
}

async function availableLoopbackPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

export async function createConsoleAppFixture(t, options = {}) {
  const installationId = `ins_${randomUUID()}`;
  const port = await availableLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  // CUA fault-injection keeps Better Auth on the trusted browser origin.
  const authBaseURL = options.authBaseURL ?? origin;
  const authMode = options.authMode ?? "development";
  const memoryDatabase = { user: [], account: [], session: [], verification: [], apikey: [] };
  const auth = createControllerAuth({
    installationId,
    mode: authMode,
    baseURL: authBaseURL,
    secret: `console-test-secret-${randomUUID()}-${randomUUID()}`,
    memoryDatabase,
  });
  const credentials = {
    email: `console-admin-${randomUUID()}@example.com`,
    password: `console-password-${randomUUID()}`,
    name: "Console Administrator",
  };
  const account = await auth.createAccount(credentials);
  const seed = auth.principalSeed(account);
  const policy = {
    identities: [seed.principal],
    groups: [],
    memberships: [],
    roles: seed.roles.map((role) => ({
      ...role,
      permissions: role.permissions.map((item) => ({ ...item })),
    })),
    bindings: seed.bindings.map((binding) => ({ ...binding })),
    restrictions: [],
  };
  const auditSink = new InMemoryAuditSink();
  const iamDriver = new NativeIAMDriver(
    { loadNativeIAMState: async () => policy },
    { id: "console-native-iam" },
  );
  const providers = options.providers ?? providerFixtures;
  const providerSummaries = Object.hasOwn(options, "providerSummaries")
    ? options.providerSummaries
    : providerSummariesFromDefinitions(providers);
  let controller;
  const appOptions = {
    auth,
    iamDriver,
    auditSink,
    development: options.development ?? { enabled: true, installationId },
    computeDriver: computeDriver(),
    configurationDriver: createTestConfigurationDriver({ id: "console-configuration" }),
    resolveHarness: () => ({ id: "console-harness", version: "test" }),
    createController(installation) {
      controller = new OpenClawController(installation, {
        state: new InMemoryPlatformState({ auditSink }),
        recordOperations: false,
        providers,
      });
      if (providers.length > 0) {
        const unexpectedProviderCall = async () =>
          assert.fail("Console read tests must not call Provider clients or provision accounts.");
        for (const provider of providers) {
          controller.registerDriver({
            id: provider.drivers.service_account,
            capability: "service_account",
            implementation: "provider-read-test",
            providerId: provider.id,
            create: unexpectedProviderCall,
            createCredential: unexpectedProviderCall,
            delete: unexpectedProviderCall,
          });
        }
        controller.selectDriver("service_account", providers[0].drivers.service_account);
      }
      return controller;
    },
  };
  if (providerSummaries !== undefined) appOptions.providerSummaries = providerSummaries;
  const app = createFastifyApp(appOptions);
  await app.listen({ host: "127.0.0.1", port });
  t.after(() => app.close());

  async function rawRequest(method, path, { headers = {}, body, timeout = 5000 } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    return { response, text };
  }

  function parseJson(result) {
    assert.match(result.response.headers.get("content-type") ?? "", /application\/json/i);
    const payload = JSON.parse(result.text);
    assert.match(payload.meta?.requestId ?? "", /^req_[0-9a-f-]+$/);
    assert.equal(result.response.headers.get("x-request-id"), payload.meta.requestId);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
    return payload;
  }

  async function signIn(overrides = {}) {
    return signInWithEmailPassword({ origin, ...credentials, ...overrides });
  }

  const adminSession = await signIn();

  async function request(method, path, { session = adminSession, headers = {}, body } = {}) {
    const result = await rawRequest(method, path, {
      headers: session === null ? headers : authenticatedHeaders(session, headers),
      body,
    });
    const payload = parseJson(result);
    return {
      status: result.response.status,
      headers: result.response.headers,
      body: payload,
      data: payload.data,
    };
  }

  async function bootstrap(name = "Console test Installation") {
    const result = await request("POST", "/installation/bootstrap", { body: { name } });
    assert.equal(result.status, 201);
    return result.data;
  }

  async function createNamespace(name, { ready = false } = {}) {
    const result = await request("POST", "/namespaces", { body: { name } });
    assert.equal(result.status, 201);
    if (ready) await makeNamespaceReady(result.data.id);
    return ready ? (await request("GET", `/namespaces/${result.data.id}`)).data : result.data;
  }

  async function makeNamespaceReady(namespaceId) {
    assert.ok(controller, "bootstrap must create the controller before Namespace lifecycle runs");
    const updated = await controller.handleNamespaceLifecycle(
      seed.principal.id,
      namespaceId,
      "ready",
    );
    assert.equal(updated?.status, "ready");
    return updated;
  }

  async function createAgent(namespaceId, name, values = {}) {
    const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
      body: { kind: "agent", values },
    });
    assert.equal(configuration.status, 201);
    const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
      body: { name, configurationId: configuration.data.id },
    });
    assert.equal(agent.status, 201);
    return agent.data;
  }

  async function createAccountWithPolicy(label, configurePolicy) {
    const accountCredentials = {
      email: `${label}-${randomUUID()}@example.com`,
      password: `console-password-${randomUUID()}`,
      name: label,
    };
    const created = await auth.createAccount(accountCredentials);
    const createdSeed = auth.principalSeed(created, { roleId: seed.roles[0].id });
    policy.identities.push(createdSeed.principal);
    configurePolicy(createdSeed.principal);
    return { credentials: accountCredentials, principal: createdSeed.principal };
  }

  return {
    origin,
    credentials,
    memoryDatabase,
    policy,
    rawRequest,
    request,
    signIn,
    bootstrap,
    createNamespace,
    createAgent,
    createAccountWithPolicy,
  };
}
