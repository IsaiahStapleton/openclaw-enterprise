import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { composeProduction } from "../../apps/controller/src/composition/production.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const databaseUrl = process.env.OCC_PRODUCTION_WIREUP_DATABASE_URL;
const repository = fileURLToPath(new URL("../../", import.meta.url));
const run = promisify(execFile);
const requireControllerDependency = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const adminEmail = "admin@example.test";
const authSecret = "production-wireup-auth-secret-at-least-32-bytes";
const authBaseURL = "http://127.0.0.1:0";

function createPassiveComputeDriver() {
  return {
    id: "compute-production-wireup",
    capability: "compute",
    implementation: "production-wireup-memory-compute",
    async preflight() {},
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, status: "ready" };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, status: "deleted" };
    },
    async prepareRevision(revision) {
      return { revisionId: revision.id, ready: true };
    },
    async retireRevision() {},
  };
}

function productionDrivers() {
  const installation = createInstallationDriverConfiguration();
  installation.drivers.iam.id = "native-iam";
  return {
    installation,
    computeDriver: createPassiveComputeDriver(),
    configurationDriver: createTestConfigurationDriver({
      id: installation.drivers.configuration.id,
    }),
    secretDriver: createTestSecretDriver({
      id: installation.drivers.secret.id,
    }),
    createIAMDriver(state) {
      return new NativeIAMDriver(state, { id: "native-iam", implementation: "native" });
    },
  };
}

test(
  "production bootstrap creates a generated-password administrator that can authenticate",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_PRODUCTION_WIREUP_DATABASE_URL for real PostgreSQL production bootstrap proof.",
  },
  async () => {
    const environment = {
      ...process.env,
      OCC_DATABASE_URL: databaseUrl,
      OCC_AUTH_SECRET: authSecret,
      OCC_AUTH_BASE_URL: authBaseURL,
      OCC_BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      OCC_BOOTSTRAP_PASSWORD_FILE: join(
        await mkdtemp(join(tmpdir(), "openclaw-enterprise-bootstrap-password-")),
        "admin-password",
      ),
      OCC_BOOTSTRAP_INSTALLATION_NAME: "openclaw-enterprise",
    };
    const passwordDirectory = dirname(environment.OCC_BOOTSTRAP_PASSWORD_FILE);
    let app;
    let endpoint;
    let pool;
    try {
      // Run the actual production Job; the generated credential is handed off only via the
      // protected operator-selected file.
      const bootstrapped = await run(process.execPath, ["scripts/bootstrap-production.mjs"], {
        cwd: repository,
        env: environment,
      });
      assert.match(bootstrapped.stdout, /installation\.bootstrapped/);
      assert.doesNotMatch(bootstrapped.stdout, /password|secret|credential/i);
      assert.doesNotMatch(bootstrapped.stderr, /password|secret|credential/i);

      const pg = requireControllerDependency("pg");
      pool = new pg.Pool({ connectionString: databaseUrl });
      // Creating an administrator is not signing in: no usable session may exist yet.
      const bootstrapSessions = await pool.query(
        "SELECT count(*)::integer AS count FROM occ.session",
      );
      assert.equal(bootstrapSessions.rows[0].count, 0);

      const passwordStat = await stat(environment.OCC_BOOTSTRAP_PASSWORD_FILE);
      assert.equal(passwordStat.mode & 0o777, 0o600);
      const password = (await readFile(environment.OCC_BOOTSTRAP_PASSWORD_FILE, "utf8")).trim();
      assert.match(password, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(password, adminEmail);
      assert.notEqual(password, authSecret);

      // Helm upgrades and Job retries must not rotate the bootstrap credential.
      const repeated = await run(process.execPath, ["scripts/bootstrap-production.mjs"], {
        cwd: repository,
        env: environment,
      });
      assert.match(repeated.stdout, /installation\.already-bootstrapped/);
      assert.equal(
        (await readFile(environment.OCC_BOOTSTRAP_PASSWORD_FILE, "utf8")).trim(),
        password,
      );

      // A different configured administrator must not silently adopt the existing Installation.
      await assert.rejects(
        run(process.execPath, ["scripts/bootstrap-production.mjs"], {
          cwd: repository,
          env: { ...environment, OCC_BOOTSTRAP_ADMIN_EMAIL: "different-admin@example.test" },
        }),
        ({ stderr }) => /configured administrator account/.test(stderr),
      );

      // Verify persisted Better Auth ownership, the real IAM Principal, and bootstrap audit evidence.
      const installation = await pool.query(
        "SELECT id, count(*) OVER()::integer AS count FROM occ.installation",
      );
      assert.equal(installation.rows.length, 1);
      assert.equal(installation.rows[0].count, 1);
      const user = await pool.query(
        `SELECT id, email, email_verified
         FROM occ."user" WHERE email = $1`,
        [adminEmail],
      );
      assert.equal(user.rows.length, 1);
      assert.equal(user.rows[0].email_verified, true);
      const account = await pool.query(
        `SELECT provider_id, account_id, password
         FROM occ.account WHERE user_id = $1`,
        [user.rows[0].id],
      );
      assert.equal(account.rows.length, 1);
      assert.equal(account.rows[0].provider_id, "credential");
      assert.equal(account.rows[0].account_id, user.rows[0].id);
      assert.equal(typeof account.rows[0].password, "string");
      assert.notEqual(account.rows[0].password, password);
      const identity = await pool.query(
        "SELECT id, kind, issuer, subject FROM occ.iam_identities WHERE subject = $1",
        [user.rows[0].id],
      );
      assert.equal(identity.rows.length, 1);
      assert.equal(identity.rows[0].kind, "principal");
      assert.match(identity.rows[0].issuer, /^occ:installation:/);
      const audit = await pool.query(
        "SELECT kind, actor_id FROM occ.audit_events WHERE kind = 'bootstrap' AND actor_id = $1",
        [identity.rows[0].id],
      );
      assert.deepEqual(audit.rows, [{ kind: "bootstrap", actor_id: identity.rows[0].id }]);
      const leakedAudit = await pool.query(
        `SELECT count(*)::integer AS count
         FROM occ.audit_events
         WHERE details::text LIKE $1 OR details::text LIKE $2`,
        [`%${password}%`, `%${account.rows[0].password}%`],
      );
      assert.equal(leakedAudit.rows[0].count, 0);

      // The application role cannot gain schema ownership through authentication or bootstrap.
      const privileges = await pool.query(
        "SELECT has_schema_privilege(current_user, 'occ', 'CREATE') AS can_create_schema",
      );
      assert.equal(privileges.rows[0].can_create_schema, false);

      app = await composeProduction({
        mode: "production",
        host: "127.0.0.1",
        databaseUrl,
        authSecret,
        authBaseURL,
        drivers: productionDrivers(),
      });
      endpoint = await app.listen({ port: 0, host: "127.0.0.1" });

      await assert.rejects(
        signInWithEmailPassword({
          origin: endpoint,
          path: "/api/auth/sign-in/email",
          email: adminEmail,
          password: `${password}-wrong`,
        }),
        /HTTP 401/,
      );
      const session = await signInWithEmailPassword({
        origin: endpoint,
        path: "/api/auth/sign-in/email",
        email: adminEmail,
        password,
      });
      assert.ok(session.cookie.includes("openclaw_occ"));

      const anonymousSession = await fetch(`${endpoint}/api/auth/session`);
      assert.equal(anonymousSession.status, 200);
      assert.equal((await anonymousSession.json()).data, null);

      // The optional session endpoint must never turn its HttpOnly cookie into a readable bearer token.
      const sessionResponse = await fetch(`${endpoint}/api/auth/session`, {
        headers: authenticatedHeaders(session),
      });
      assert.equal(sessionResponse.status, 200);
      const visibleSession = await sessionResponse.text();
      const activeSession = await pool.query("SELECT token FROM occ.session WHERE user_id = $1", [
        user.rows[0].id,
      ]);
      assert.equal(activeSession.rows.length, 1);
      assert.doesNotMatch(visibleSession, /token|password|credential/i);
      assert.equal(visibleSession.includes(activeSession.rows[0].token), false);
      assert.equal(visibleSession.includes(session.cookie), false);

      const authorized = await fetch(`${endpoint}/installation`, {
        headers: authenticatedHeaders(session),
      });
      assert.equal(authorized.status, 200);
      assert.equal((await authorized.json()).data.id, installation.rows[0].id);

      // Prove all production ServiceAccount grants through the real cookie-authenticated HTTP boundary.
      async function request(method, path, payload) {
        const response = await fetch(`${endpoint}${path}`, {
          method,
          headers: authenticatedHeaders(
            session,
            payload === undefined ? {} : { "content-type": "application/json" },
          ),
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        return {
          status: response.status,
          ...(response.status === 204 ? {} : { data: (await response.json()).data }),
        };
      }
      const namespace = await request("POST", "/namespaces", {
        name: `production-service-account-${randomUUID()}`,
      });
      assert.equal(namespace.status, 201);
      const accountsPath = `/namespaces/${namespace.data.id}/service-accounts`;
      const createdAccount = await request("POST", accountsPath, {
        name: "production-model-provider",
      });
      assert.equal(createdAccount.status, 201);
      const accountPath = `${accountsPath}/${createdAccount.data.id}`;
      assert.deepEqual((await request("GET", accountPath)).data, createdAccount.data);
      const credential = {
        kind: "api_key",
        secretRef: { name: "production-model-source", key: "provider-api-key" },
      };
      const updatedAccount = await request("PATCH", `${accountPath}/credential`, credential);
      assert.equal(updatedAccount.status, 200);
      assert.deepEqual(updatedAccount.data.credential, credential);
      assert.equal((await request("DELETE", accountPath)).status, 204);
      assert.equal((await request("GET", accountPath)).status, 404);

      const bearer = await fetch(`${endpoint}/installation`, {
        headers: { authorization: "Bearer no-longer-supported" },
      });
      assert.equal(bearer.status, 401);

      const publicSignup = await fetch(`${endpoint}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "public@example.test",
          password: "public-signup-disabled",
          name: "Public",
        }),
      });
      assert.equal(publicSignup.status, 404);
    } finally {
      if (app !== undefined) await app.close();
      if (pool !== undefined) await pool.end();
      await rm(passwordDirectory, { recursive: true, force: true });
    }
  },
);
