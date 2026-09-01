import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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
      NODE_ENV: "production",
      OCC_DATABASE_URL: databaseUrl,
      OCC_AUTH_SECRET: authSecret,
      OCC_AUTH_BASE_URL: authBaseURL,
      OCC_BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      OCC_BOOTSTRAP_PASSWORD_FILE: join(
        await mkdtemp(join(tmpdir(), "openclaw-enterprise-bootstrap-password-")),
        "admin-password",
      ),
      OCC_BOOTSTRAP_SERVICE_KEY_FILE: "",
      OCC_BOOTSTRAP_INSTALLATION_NAME: "openclaw-enterprise",
    };
    const passwordDirectory = dirname(environment.OCC_BOOTSTRAP_PASSWORD_FILE);
    environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE = join(
      passwordDirectory,
      "initial-admin-service-key.json",
    );
    let app;
    let endpoint;
    let pool;
    try {
      // Run the actual production Job; the generated credential is handed off only via the
      // protected operator-selected file.
      const bootstrapped = await run(process.execPath, ["scripts/bootstrap-installation.mjs"], {
        cwd: repository,
        env: environment,
      });
      assert.match(bootstrapped.stdout, /installation\.bootstrapped/);

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
      const passwordDigest = sha256(password);
      assert.match(password, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(password, adminEmail);
      assert.notEqual(password, authSecret);
      const serviceKeyStat = await stat(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE);
      assert.equal(serviceKeyStat.mode & 0o777, 0o600);
      const serviceKeyBytes = await readFile(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8");
      const serviceKeyDigest = sha256(serviceKeyBytes);
      const serviceKeyOutput = JSON.parse(serviceKeyBytes);
      assert.equal(serviceKeyOutput.data.name, "bootstrap-admin");
      assert.match(serviceKeyOutput.data.servicePrincipalId, /^spn_/);
      assert.match(serviceKeyOutput.data.key, /^occ_/);
      assert.equal(serviceKeyOutput.meta.installationId.startsWith("ins_"), true);
      assert.equal(
        bootstrapped.stdout.includes(password),
        false,
        "stdout must not contain password",
      );
      assert.equal(
        bootstrapped.stdout.includes(serviceKeyOutput.data.key),
        false,
        "stdout must not contain service key",
      );
      assert.equal(
        bootstrapped.stderr.includes(password),
        false,
        "stderr must not contain password",
      );
      assert.equal(
        bootstrapped.stderr.includes(serviceKeyOutput.data.key),
        false,
        "stderr must not contain service key",
      );

      // Helm upgrades and Job retries must not rotate the bootstrap credential.
      const repeated = await run(process.execPath, ["scripts/bootstrap-installation.mjs"], {
        cwd: repository,
        env: environment,
      });
      assert.match(repeated.stdout, /installation\.already-bootstrapped/);
      assert.equal(
        sha256((await readFile(environment.OCC_BOOTSTRAP_PASSWORD_FILE, "utf8")).trim()),
        passwordDigest,
      );
      assert.equal(
        sha256(await readFile(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8")),
        serviceKeyDigest,
      );
      const {
        OCC_BOOTSTRAP_INSTALLATION_NAME,
        OCC_BOOTSTRAP_PASSWORD_FILE,
        OCC_BOOTSTRAP_SERVICE_KEY_FILE,
        ...existingOnlyEnvironment
      } = environment;
      assert.equal(OCC_BOOTSTRAP_INSTALLATION_NAME.length > 0, true);
      assert.equal(OCC_BOOTSTRAP_PASSWORD_FILE.length > 0, true);
      assert.equal(OCC_BOOTSTRAP_SERVICE_KEY_FILE.length > 0, true);
      const existingOnly = await run(process.execPath, ["scripts/bootstrap-installation.mjs"], {
        cwd: repository,
        env: existingOnlyEnvironment,
      });
      assert.match(existingOnly.stdout, /installation\.already-bootstrapped/);
      assert.equal(
        sha256((await readFile(environment.OCC_BOOTSTRAP_PASSWORD_FILE, "utf8")).trim()),
        passwordDigest,
      );
      assert.equal(
        sha256(await readFile(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8")),
        serviceKeyDigest,
      );

      // A different configured administrator must not silently adopt the existing Installation.
      await assert.rejects(
        run(process.execPath, ["scripts/bootstrap-installation.mjs"], {
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
      assert.equal(serviceKeyOutput.meta.installationId, installation.rows[0].id);
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
      const bootstrapServicePrincipal = await pool.query(
        `SELECT identity.id, binding.role_id
         FROM occ.iam_identities identity
         JOIN occ.iam_access_bindings binding ON binding.identity_subject_id = identity.id
         WHERE identity.id = $1
           AND identity.kind = 'service_principal'
           AND identity.namespace_id IS NULL
           AND identity.agent_id IS NULL`,
        [serviceKeyOutput.data.servicePrincipalId],
      );
      assert.equal(bootstrapServicePrincipal.rowCount, 1);
      const humanBinding = await pool.query(
        `SELECT role_id FROM occ.iam_access_bindings WHERE identity_subject_id = $1`,
        [identity.rows[0].id],
      );
      assert.equal(bootstrapServicePrincipal.rows[0].role_id, humanBinding.rows[0].role_id);
      const storedServiceKey = await pool.query(
        `SELECT key, reference_id, name, metadata
         FROM occ.apikey WHERE id = $1`,
        [serviceKeyOutput.data.id],
      );
      assert.equal(storedServiceKey.rowCount, 1);
      assert.notEqual(storedServiceKey.rows[0].key, serviceKeyOutput.data.key);
      assert.equal(storedServiceKey.rows[0].reference_id, serviceKeyOutput.data.servicePrincipalId);
      assert.equal(storedServiceKey.rows[0].name, "bootstrap-admin");
      assert.deepEqual(JSON.parse(storedServiceKey.rows[0].metadata), {
        installationId: installation.rows[0].id,
      });
      const leakedAudit = await pool.query(
        `SELECT count(*)::integer AS count
         FROM occ.audit_events
         WHERE details::text LIKE $1 OR details::text LIKE $2 OR details::text LIKE $3`,
        [`%${password}%`, `%${account.rows[0].password}%`, `%${serviceKeyOutput.data.key}%`],
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
      const serviceAuthorized = await fetch(`${endpoint}/installation`, {
        headers: { "x-api-key": serviceKeyOutput.data.key },
      });
      assert.equal(serviceAuthorized.status, 200);
      assert.equal((await serviceAuthorized.json()).data.id, installation.rows[0].id);

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
      const serviceNamespace = await fetch(`${endpoint}/namespaces`, {
        method: "POST",
        headers: {
          "x-api-key": serviceKeyOutput.data.key,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: `bootstrap-admin-key-${randomUUID()}` }),
      });
      assert.equal(serviceNamespace.status, 201);

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
