import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { createControllerApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const identifier = (prefix) => new RegExp(`^${prefix}_${uuidV4}$`);
const defaultControllerBodyLimit = 64 * 1024;
const syntheticSecretSentinel = "synthetic-secret-boundary:";

function jsonBodyBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function bodyAtJsonLimit(limit, buildBody) {
  const emptyBodyBytes = jsonBodyBytes(buildBody(""));
  const targetValueBytes = limit - emptyBodyBytes;
  assert.ok(targetValueBytes >= syntheticSecretSentinel.length);
  const value = `${syntheticSecretSentinel}${"x".repeat(
    targetValueBytes - syntheticSecretSentinel.length,
  )}`;
  assert.equal(Buffer.byteLength(value, "utf8"), targetValueBytes);

  const body = buildBody(value);
  assert.equal(jsonBodyBytes(body), limit);
  return { body, value };
}

function createTestComputeDriver() {
  return {
    id: "compute-secret-api",
    capability: "compute",
    implementation: "deterministic-test",
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

async function createFixture(options = {}) {
  const installationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
  const authFixture = await createTestAuthPrincipal({
    installationId,
    email: `admin-${randomUUID()}@example.com`,
    password: `generated-password-${randomUUID()}`,
    name: "Secret API Administrator",
  });
  const principal = authFixture.seed.principal;
  const state = {
    identities: [principal],
    groups: [],
    memberships: [],
    roles: authFixture.seed.roles.map((role) => ({ ...role, permissions: [...role.permissions] })),
    bindings: [
      {
        id: "binding-admin",
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: authFixture.seed.roles[0].id,
      },
    ],
    restrictions: [],
  };
  const iamDriver = new NativeIAMDriver(
    { loadNativeIAMState: async () => state },
    { id: "iam-secret-api" },
  );
  const auditSink = new InMemoryAuditSink();
  const secretDriver = options.secretDriver ?? createTestSecretDriver({ id: "secret-api-test" });
  let controller;
  const sessionsByPrincipalId = new Map();

  function createApp(identity = principal) {
    const app = createControllerApp({
      ...(controller
        ? { controller }
        : {
            createController(installation) {
              controller = new OpenClawController(installation, {
                state: new InMemoryPlatformState({ auditSink }),
                recordOperations: false,
              });
              return controller;
            },
          }),
      iamDriver,
      computeDriver: createTestComputeDriver(),
      configurationDriver: createTestConfigurationDriver({ id: "configuration-secret-api" }),
      secretDriver,
      resolveHarness: resolveApprovedDevelopmentHarness,
      auditSink,
      development: { enabled: true, installationId },
      auth: authFixture.auth,
    });
    app.defaultSession = sessionsByPrincipalId.get(identity.id);
    return app;
  }

  const app = createApp();
  sessionsByPrincipalId.set(principal.id, await signInToControllerApp(app, authFixture));
  app.defaultSession = sessionsByPrincipalId.get(principal.id);

  async function createPrincipal(name) {
    const email = `${name}-${randomUUID()}@example.com`;
    const password = `generated-password-${randomUUID()}`;
    const account = await authFixture.auth.createAccount({ email, password, name });
    const seed = authFixture.auth.principalSeed(account);
    state.identities.push(seed.principal);
    sessionsByPrincipalId.set(
      seed.principal.id,
      await signInToControllerApp(app, { email, password }),
    );
    return { principal: seed.principal, app: createApp(seed.principal) };
  }

  return {
    app,
    auditSink,
    controller: () => controller,
    createPrincipal,
    principal,
    secretDriver,
    state,
  };
}

async function request(app, method, pathname, options = {}) {
  const headers = {
    ...(options.identity === false
      ? {}
      : authenticatedHeaders(options.session ?? app.defaultSession)),
    ...options.headers,
  };
  const hasBody = Object.hasOwn(options, "body");
  if (hasBody) headers["content-type"] ??= "application/json";
  const response = await app.fetch(
    new Request(`http://127.0.0.1${pathname}`, {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    }),
  );
  const body = response.status === 204 ? undefined : await response.json();
  if (body !== undefined) {
    assert.match(body.meta?.requestId ?? "", identifier("req"));
  }
  return { status: response.status, body, data: body?.data };
}

async function bootstrapAgent(fixture) {
  const bootstrapped = await request(fixture.app, "POST", "/installation/bootstrap", {
    body: { name: "Secret API installation" },
  });
  assert.equal(bootstrapped.status, 201);

  const namespace = await request(fixture.app, "POST", "/namespaces", {
    body: { name: "secret-api-namespace" },
  });
  assert.equal(namespace.status, 201);
  await fixture
    .controller()
    .handleNamespaceLifecycle(fixture.principal.id, namespace.data.id, "ready");

  const configuration = await request(
    fixture.app,
    "POST",
    `/namespaces/${namespace.data.id}/configurations`,
    { body: { kind: "agent", values: {} } },
  );
  assert.equal(configuration.status, 201);

  const agent = await request(fixture.app, "POST", `/namespaces/${namespace.data.id}/agents`, {
    body: { name: "secret-api-agent", configurationId: configuration.data.id },
  });
  assert.equal(agent.status, 201);
  return { namespace: namespace.data, configuration: configuration.data, agent: agent.data };
}

test("Secret API stores values through the selected driver and returns metadata only", async () => {
  const fixture = await createFixture();
  const { namespace, agent } = await bootstrapAgent(fixture);
  const originalValue = `secret-value-${randomUUID()}`;
  const rotatedValue = `rotated-value-${randomUUID()}`;

  const removedOwnerField = await request(
    fixture.app,
    "POST",
    `/namespaces/${namespace.id}/secrets`,
    {
      body: { agentId: agent.id, name: "Removed owner key", value: `secret-value-${randomUUID()}` },
    },
  );
  assert.equal(removedOwnerField.status, 400);
  assert.equal(removedOwnerField.body.error.code, "INVALID_REQUEST");

  const created = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "Provider API key", value: originalValue },
  });
  assert.equal(created.status, 201);
  assert.match(created.data.id, identifier("sec"));
  assert.deepEqual(created.data, {
    id: created.data.id,
    namespaceId: namespace.id,
    name: "Provider API key",
    ref: { kind: "secret", namespaceId: namespace.id, id: created.data.id },
  });
  assert.equal(JSON.stringify(created.body).includes(originalValue), false);
  assert.equal(JSON.stringify(created.body).includes("backendRef"), false);
  assert.equal(JSON.stringify(created.body).includes("driverId"), false);
  assert.equal(fixture.secretDriver.valueFor(created.data), originalValue);

  const detail = await request(
    fixture.app,
    "GET",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
  );
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data, created.data);

  const updated = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
    { body: { value: rotatedValue } },
  );
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data, created.data);
  assert.equal(fixture.secretDriver.valueFor(created.data), rotatedValue);

  for (const invalid of ["", "bad\u0000value"]) {
    const rejected = await request(
      fixture.app,
      "PATCH",
      `/namespaces/${namespace.id}/secrets/${created.data.id}`,
      { body: { value: invalid } },
    );
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "INVALID_REQUEST");
  }
  const deleted = await request(
    fixture.app,
    "DELETE",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
  );
  assert.equal(deleted.status, 204);
  assert.equal(fixture.secretDriver.has(created.data), false);

  const missing = await request(
    fixture.app,
    "GET",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
  );
  assert.equal(missing.status, 404);

  const audit = JSON.stringify(fixture.auditSink.events);
  assert.equal(audit.includes(originalValue), false);
  assert.equal(audit.includes(rotatedValue), false);
  assert.deepEqual(
    fixture.auditSink.events
      .filter((event) => event.resource.kind === "secret" && event.kind === "mutation")
      .map((event) => event.action),
    ["openclaw.secrets.create", "openclaw.secrets.update", "openclaw.secrets.delete"],
  );
});

test("Secret API accepts the largest default JSON body and rejects one byte over", async () => {
  const fixture = await createFixture();
  const { namespace } = await bootstrapAgent(fixture);

  const createEnvelope = bodyAtJsonLimit(defaultControllerBodyLimit, (value) => ({
    name: "HTTP body boundary key",
    value,
  }));
  const created = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    body: createEnvelope.body,
  });
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(created.body).includes(syntheticSecretSentinel), false);
  assert.equal(fixture.secretDriver.valueFor(created.data), createEnvelope.value);

  const oversizedCreateBody = {
    ...createEnvelope.body,
    value: `${createEnvelope.value}x`,
  };
  assert.equal(jsonBodyBytes(oversizedCreateBody), defaultControllerBodyLimit + 1);
  const oversizedCreate = await request(
    fixture.app,
    "POST",
    `/namespaces/${namespace.id}/secrets`,
    {
      body: oversizedCreateBody,
    },
  );
  assert.equal(oversizedCreate.status, 413);
  assert.equal(oversizedCreate.body.error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(JSON.stringify(oversizedCreate.body).includes(syntheticSecretSentinel), false);

  const updateEnvelope = bodyAtJsonLimit(defaultControllerBodyLimit, (value) => ({ value }));
  const updated = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
    { body: updateEnvelope.body },
  );
  assert.equal(updated.status, 200);
  assert.equal(JSON.stringify(updated.body).includes(syntheticSecretSentinel), false);
  assert.equal(fixture.secretDriver.valueFor(created.data), updateEnvelope.value);

  const oversizedUpdateBody = { value: `${updateEnvelope.value}x` };
  assert.equal(jsonBodyBytes(oversizedUpdateBody), defaultControllerBodyLimit + 1);
  const oversizedUpdate = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
    { body: oversizedUpdateBody },
  );
  assert.equal(oversizedUpdate.status, 413);
  assert.equal(oversizedUpdate.body.error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(JSON.stringify(oversizedUpdate.body).includes(syntheticSecretSentinel), false);
  assert.equal(fixture.secretDriver.valueFor(created.data), updateEnvelope.value);
  assert.equal(JSON.stringify(fixture.auditSink.events).includes(syntheticSecretSentinel), false);
});

test("Secret API denial and storage failures return value-free errors", async () => {
  const fixture = await createFixture();
  const { namespace } = await bootstrapAgent(fixture);
  const value = `private-denied-value-${randomUUID()}`;
  const created = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "Denied metadata key", value },
  });
  assert.equal(created.status, 201);

  const { principal: reader, app: readerApp } = await fixture.createPrincipal("secret-reader");
  fixture.state.roles.push({
    id: "role-secret-reader-without-secret",
    namespaceId: namespace.id,
    permissions: [{ action: "read", resourceKind: "namespace" }],
  });
  fixture.state.bindings.push({
    id: "binding-secret-reader-without-secret",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: reader.id,
    roleId: "role-secret-reader-without-secret",
  });

  const denied = await request(
    readerApp,
    "GET",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");
  const denial = fixture.auditSink.events.at(-1);
  assert.equal(denial.kind, "authorization_denial");
  assert.deepEqual(denial.authorization, {
    principalId: reader.id,
    action: "read",
    resource: { kind: "secret", id: created.data.id, namespaceId: namespace.id },
  });
  assert.equal(JSON.stringify(denial).includes(value), false);

  const leakedBackendValue = `backend-leak-${randomUUID()}`;
  const failingFixture = await createFixture({
    secretDriver: createTestSecretDriver({
      id: "secret-api-failing",
      createError: new Error(`must not leak ${leakedBackendValue}`),
    }),
  });
  const failing = await bootstrapAgent(failingFixture);
  const failed = await request(
    failingFixture.app,
    "POST",
    `/namespaces/${failing.namespace.id}/secrets`,
    {
      body: {
        name: "Backend failure key",
        value: leakedBackendValue,
      },
    },
  );
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(JSON.stringify(failed.body).includes(leakedBackendValue), false);
  assert.equal(JSON.stringify(failingFixture.auditSink.events).includes(leakedBackendValue), false);
});
