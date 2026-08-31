import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const requiresPostgres = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
};

function installationPrincipal(state) {
  const administratorRoles = new Set(
    state.roles
      .filter(({ permissions }) =>
        [
          ["administer", "installation"],
          ["create", "namespace"],
          ["deploy", "agent"],
        ].every(([action, resourceKind]) =>
          permissions.some(
            (permission) =>
              permission.action === action && permission.resourceKind === resourceKind,
          ),
        ),
      )
      .map(({ id }) => id),
  );
  return state.identities.find(
    (identity) =>
      identity.kind === "principal" &&
      state.bindings.some(
        (binding) =>
          binding.subjectKind === "identity" &&
          binding.subjectId === identity.id &&
          binding.namespaceId === undefined &&
          binding.resourceKind === undefined &&
          administratorRoles.has(binding.roleId),
      ),
  );
}

async function fetchFromInjectedApp(app, request) {
  const url = new URL(request.url);
  const headers = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  headers.host = url.host;
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const result = await app.inject({
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers,
    ...(body === undefined ? {} : { payload: body }),
  });
  const convertedHeaders = new Headers();
  for (const [name, value] of Object.entries(result.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) convertedHeaders.append(name, entry);
    } else if (value !== undefined) {
      convertedHeaders.set(name, String(value));
    }
  }
  return new Response(result.statusCode === 204 ? null : new Uint8Array(result.rawPayload), {
    status: result.statusCode,
    headers: convertedHeaders,
  });
}

test(
  "PostgreSQL auth account provisioning is visible to another controller without rebuilding IAM Driver",
  requiresPostgres,
  async (context) => {
    const observerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    let appA;
    let appB;
    context.after(async () => {
      if (appB !== undefined) await appB.close();
      if (appA !== undefined) await appA.close();
      await observerPool.end();
    });

    const config = {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      adminEmail: "postgres-local-admin@openclaw.local",
      adminPassword: "postgres-local-development-password",
      authBaseURL: "http://127.0.0.1",
      authSecret: "openclaw-postgres-local-auth-secret-minimum-32-bytes",
    };
    appA = await composePostgresDevelopment(config, {
      configurationDriver: createTestConfigurationDriver(),
    });

    const session = await signInWithEmailPassword({
      fetch: (request) => fetchFromInjectedApp(appA, request),
      email: "postgres-local-admin@openclaw.local",
      password: "postgres-local-development-password",
    });
    const state = new PostgresPlatformState(observerPool);
    let installation = await state.loadInstallation();
    if (installation === undefined) {
      const bootstrap = await appA.inject({
        method: "POST",
        url: "/installation/bootstrap",
        headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
        payload: { name: "PostgreSQL account provisioning" },
      });
      assert.equal(bootstrap.statusCode, 201, bootstrap.body);
      installation = bootstrap.json().data;
    }

    // Controller B starts before the account exists. Its selected IAM Driver must observe
    // the later rows through live policy reads, not through a replacement from controller A.
    appB = await composePostgresDevelopment(config, {
      configurationDriver: createTestConfigurationDriver(),
    });

    const iamBefore = await state.loadNativeIAMState(installation.id);
    const role = iamBefore.roles.find((candidate) =>
      candidate.permissions.some(
        (permission) => permission.action === "read" && permission.resourceKind === "installation",
      ),
    );
    assert.ok(role, "the persisted Installation must have an account-bindable Role");

    const email = `postgres-account-${randomUUID()}@example.com`;
    const password = `generated-password-${randomUUID()}`;
    const beforeAudit = await observerPool.query(
      `SELECT count(*)::integer AS count
       FROM occ.audit_events
       WHERE action = 'openclaw.auth.accounts.create'`,
    );

    const created = await appA.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
      payload: { email, password, name: "Postgres Provisioned Operator", roleId: role.id },
    });
    assert.equal(created.statusCode, 201, created.body);
    const createdAccount = created.json().data;
    const principalId = createdAccount.principalId;

    // Server-side provisioning must not silently sign in the newly created operator.
    const accountSessions = await observerPool.query(
      "SELECT count(*)::integer AS count FROM occ.session WHERE user_id = $1",
      [createdAccount.id],
    );
    assert.equal(accountSessions.rows[0].count, 0);

    // A duplicate email is a conflict, never a synthetic identity or hidden active session.
    const duplicate = await appA.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
      payload: { email, password, name: "Duplicate Operator", roleId: role.id },
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    const iamAfterDuplicate = await state.loadNativeIAMState(installation.id);
    assert.equal(iamAfterDuplicate.identities.length, iamBefore.identities.length + 1);
    assert.equal(iamAfterDuplicate.bindings.length, iamBefore.bindings.length + 1);
    const sessionsAfterDuplicate = await observerPool.query(
      "SELECT count(*)::integer AS count FROM occ.session WHERE user_id = $1",
      [createdAccount.id],
    );
    assert.equal(sessionsAfterDuplicate.rows[0].count, 0);

    const provisionedSession = await signInWithEmailPassword({
      fetch: (request) => fetchFromInjectedApp(appB, request),
      email,
      password,
    });
    const authorized = await appB.inject({
      method: "GET",
      url: "/installation",
      headers: authenticatedHeaders(provisionedSession, { host: "127.0.0.1" }),
    });
    assert.equal(authorized.statusCode, 200, authorized.body);
    assert.equal(authorized.json().data.id, installation.id);

    const iamAfter = await state.loadNativeIAMState(installation.id);
    assert.equal(iamAfter.identities.length, iamBefore.identities.length + 1);
    assert.equal(iamAfter.bindings.length, iamBefore.bindings.length + 1);
    assert.ok(iamAfter.identities.some(({ id }) => id === principalId));
    assert.ok(
      iamAfter.bindings.some(
        (binding) =>
          binding.subjectKind === "identity" &&
          binding.subjectId === principalId &&
          binding.roleId === role.id &&
          binding.resourceKind === "installation" &&
          binding.resourceId === installation.id,
      ),
    );
    const persistedUser = await observerPool.query(
      `SELECT id, email FROM occ."user" WHERE email = $1`,
      [email],
    );
    assert.deepEqual(persistedUser.rows, [{ id: createdAccount.id, email }]);
    const afterAudit = await observerPool.query(
      `SELECT count(*)::integer AS count
       FROM occ.audit_events
       WHERE action = 'openclaw.auth.accounts.create'`,
    );
    assert.equal(afterAudit.rows[0].count, beforeAudit.rows[0].count + 1);
  },
);

test(
  "PostgreSQL auth account audit failure rolls back IAM and Better Auth account state",
  requiresPostgres,
  async (context) => {
    const auditId = `aud_${randomUUID()}`;
    const observerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    let app;
    context.after(async () => {
      if (app !== undefined) await app.close();
      await observerPool.end();
    });

    app = await composePostgresDevelopment(
      {
        mode: "development",
        host: "127.0.0.1",
        databaseUrl,
        adminEmail: "postgres-local-admin@openclaw.local",
        adminPassword: "postgres-local-development-password",
        authBaseURL: "http://127.0.0.1",
        authSecret: "openclaw-postgres-local-auth-secret-minimum-32-bytes",
      },
      {
        auditEventFactory: new AuditEventFactory({ idGenerator: () => auditId }),
        configurationDriver: createTestConfigurationDriver(),
      },
    );

    const session = await signInWithEmailPassword({
      fetch: (request) => fetchFromInjectedApp(app, request),
      email: "postgres-local-admin@openclaw.local",
      password: "postgres-local-development-password",
    });
    const state = new PostgresPlatformState(observerPool);
    let installation = await state.loadInstallation();
    if (installation === undefined) {
      const bootstrap = await app.inject({
        method: "POST",
        url: "/installation/bootstrap",
        headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
        payload: { name: "PostgreSQL account audit rollback" },
      });
      assert.equal(bootstrap.statusCode, 201, bootstrap.body);
      installation = bootstrap.json().data;
    }

    const iamBefore = await state.loadNativeIAMState(installation.id);
    const role = iamBefore.roles.find((candidate) =>
      candidate.permissions.some(
        (permission) => permission.action === "read" && permission.resourceKind === "installation",
      ),
    );
    assert.ok(role, "the persisted Installation must have an account-bindable Role");
    const actor = installationPrincipal(iamBefore);
    assert.ok(actor, "the persisted Installation requires an administrator Principal");
    await observerPool.query(
      `INSERT INTO occ.audit_events
       (id, occurred_at, kind, actor_id, action, namespace_id, resource_kind, resource_id,
        outcome, details)
       VALUES ($1, now(), 'mutation', $2, 'test.account.audit.duplicate', NULL,
        'installation', $3, 'success', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [auditId, actor.id, installation.id],
    );

    const email = `postgres-audit-rollback-${randomUUID()}@example.com`;
    const password = `generated-password-${randomUUID()}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: authenticatedHeaders(session, { host: "127.0.0.1" }),
      payload: { email, password, name: "Postgres Audit Rollback", roleId: role.id },
    });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error.code, "DEPENDENCY_UNAVAILABLE");

    await assert.rejects(
      signInWithEmailPassword({
        fetch: (request) => fetchFromInjectedApp(app, request),
        email,
        password,
      }),
      /HTTP 401/,
    );
    const iamAfter = await state.loadNativeIAMState(installation.id);
    assert.equal(iamAfter.identities.length, iamBefore.identities.length);
    assert.equal(iamAfter.bindings.length, iamBefore.bindings.length);
    assert.deepEqual(
      iamAfter.identities.map(({ id }) => id).sort(),
      iamBefore.identities.map(({ id }) => id).sort(),
    );
    const persistedUser = await observerPool.query(`SELECT id FROM occ."user" WHERE email = $1`, [
      email,
    ]);
    assert.deepEqual(persistedUser.rows, []);
    const duplicateAuditRows = await observerPool.query(
      `SELECT id FROM occ.audit_events WHERE id = $1`,
      [auditId],
    );
    assert.equal(duplicateAuditRows.rowCount, 1);
  },
);
