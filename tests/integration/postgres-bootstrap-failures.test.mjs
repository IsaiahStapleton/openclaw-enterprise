import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { installPostgresCommitAcknowledgementFault } from "../fixtures/postgres-commit-ack-fault.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";

const failureDatabaseUrl = process.env.OCC_BOOTSTRAP_FAILURE_DATABASE_URL;
const repository = fileURLToPath(new URL("../../", import.meta.url));
const commitAcknowledgementFaultFixture = fileURLToPath(
  new URL("../fixtures/postgres-commit-ack-fault.mjs", import.meta.url),
);
const run = promisify(execFile);
const requiresFailurePostgres = {
  skip: failureDatabaseUrl
    ? false
    : "Set OCC_BOOTSTRAP_FAILURE_DATABASE_URL to a migrated disposable PostgreSQL failure database.",
};
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

const RESET_TABLES = [
  "occ.session",
  "occ.account",
  "occ.apikey",
  "occ.verification",
  'occ."user"',
  "occ.controller_work",
  "occ.audit_events",
  "occ.agent_revisions",
  "occ.agents",
  "occ.configurations",
  "occ.secrets",
  "occ.service_account_driver_bindings",
  "occ.service_accounts",
  "occ.namespaces",
  "occ.iam_access_bindings",
  "occ.iam_group_memberships",
  "occ.iam_groups",
  "occ.iam_restrictions",
  "occ.iam_roles",
  "occ.iam_identities",
  "occ.installation",
].join(", ");

function migratorDatabaseUrl() {
  const application = validatedFailureDatabaseUrl();
  const explicit = process.env.OCC_BOOTSTRAP_FAILURE_MIGRATION_DATABASE_URL;
  if (explicit !== undefined && explicit.trim().length > 0) {
    const migration = new URL(explicit);
    if (
      migration.hostname !== application.hostname ||
      migration.port !== application.port ||
      migration.pathname !== application.pathname
    ) {
      throw new Error(
        "OCC_BOOTSTRAP_FAILURE_MIGRATION_DATABASE_URL must target the same host, port, and database as OCC_BOOTSTRAP_FAILURE_DATABASE_URL.",
      );
    }
    return explicit;
  }
  const parsed = new URL(application);
  if (parsed.username !== "occ_app") {
    throw new Error(
      "OCC_BOOTSTRAP_FAILURE_MIGRATION_DATABASE_URL must be set when the failure database URL does not use the local occ_app role.",
    );
  }
  parsed.username = "occ_migrator";
  parsed.password = "occ-migrator-local";
  return parsed.toString();
}

function validatedFailureDatabaseUrl() {
  const parsed = new URL(failureDatabaseUrl);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("OCC_BOOTSTRAP_FAILURE_DATABASE_URL must be a PostgreSQL URL.");
  }
  if (!loopbackHosts.has(parsed.hostname)) {
    throw new Error("OCC_BOOTSTRAP_FAILURE_DATABASE_URL must target loopback PostgreSQL.");
  }
  const database = parsed.pathname.replace(/^\//, "");
  if (!database.startsWith("openclaw_failures_")) {
    throw new Error(
      "OCC_BOOTSTRAP_FAILURE_DATABASE_URL must target a dedicated openclaw_failures_* database.",
    );
  }
  return parsed;
}

async function withPool(databaseUrl, operation) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}

async function resetFailureDatabase() {
  validatedFailureDatabaseUrl();
  await withPool(migratorDatabaseUrl(), async (pool) => {
    await pool.query("DROP TRIGGER IF EXISTS bootstrap_failure_delay ON occ.installation");
    await pool.query("DROP FUNCTION IF EXISTS occ.bootstrap_failure_delay()");
    await pool.query(`TRUNCATE ${RESET_TABLES} RESTART IDENTITY CASCADE`);
  });
}

async function installInstallationDelay() {
  validatedFailureDatabaseUrl();
  await withPool(migratorDatabaseUrl(), async (pool) => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION occ.bootstrap_failure_delay() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.35);
        RETURN NEW;
      END;
      $$
    `);
    await pool.query("DROP TRIGGER IF EXISTS bootstrap_failure_delay ON occ.installation");
    await pool.query(`
      CREATE TRIGGER bootstrap_failure_delay
      BEFORE INSERT ON occ.installation
      FOR EACH ROW EXECUTE FUNCTION occ.bootstrap_failure_delay()
    `);
  });
}

async function rowCounts() {
  return withPool(failureDatabaseUrl, async (pool) => {
    const result = await pool.query(`
      SELECT
        (SELECT count(*)::integer FROM occ.installation) AS installations,
        (SELECT count(*)::integer FROM occ.audit_events WHERE kind = 'bootstrap') AS bootstrap_audits,
        (SELECT count(*)::integer FROM occ.iam_identities WHERE kind = 'principal') AS principals,
        (SELECT count(*)::integer FROM occ.iam_identities WHERE kind = 'service_principal') AS service_principals,
        (SELECT count(*)::integer FROM occ.iam_access_bindings) AS bindings,
        (SELECT count(*)::integer FROM occ.apikey) AS service_keys,
        (SELECT count(*)::integer FROM occ."user") AS users
    `);
    return result.rows[0];
  });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function privateOutputDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  return directory;
}

function productionEnvironment({ databaseUrl = failureDatabaseUrl, directory, email, name }) {
  return {
    ...process.env,
    OCC_DATABASE_URL: databaseUrl,
    OCC_AUTH_SECRET: "bootstrap-failure-auth-secret-at-least-32-bytes",
    OCC_AUTH_BASE_URL: "http://127.0.0.1:0",
    OCC_BOOTSTRAP_ADMIN_EMAIL: email,
    OCC_BOOTSTRAP_PASSWORD_FILE: join(directory, "initial-admin-password"),
    OCC_BOOTSTRAP_SERVICE_KEY_FILE: join(directory, "initial-admin-service-key.json"),
    OCC_BOOTSTRAP_INSTALLATION_NAME: name,
  };
}

function developmentConfiguration({ directory, email, name }) {
  return {
    mode: "development",
    host: "127.0.0.1",
    databaseUrl: failureDatabaseUrl,
    poolMax: 2,
    adminEmail: email,
    adminPassword: "postgres-local-development-password",
    authBaseURL: "http://127.0.0.1",
    authSecret: "openclaw-postgres-local-auth-secret-minimum-32-bytes",
    bootstrapInstallationName: name,
    bootstrapServiceKeyFile: join(directory, "initial-admin-service-key.json"),
  };
}

async function runProductionBootstrap(environment) {
  try {
    const result = await run(process.execPath, ["scripts/bootstrap-production.mjs"], {
      cwd: repository,
      env: environment,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      message: error instanceof Error ? error.message : "bootstrap failed",
    };
  }
}

function jsonLines(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
}

function passiveComputeDriver() {
  return {
    id: "compute-bootstrap-failure-passive",
    capability: "compute",
    implementation: "bootstrap-failure-passive",
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

for (const sharedOutput of [false, true]) {
  test(
    `concurrent production bootstrap subprocesses ${sharedOutput ? "with shared output paths" : "with separate output paths"} commit at most one seed`,
    requiresFailurePostgres,
    async (context) => {
      await resetFailureDatabase();
      await installInstallationDelay();
      const directories = [
        await privateOutputDirectory("openclaw-bootstrap-race-a-"),
        sharedOutput ? undefined : await privateOutputDirectory("openclaw-bootstrap-race-b-"),
      ];
      directories[1] ??= directories[0];
      context.after(async () => {
        await resetFailureDatabase();
        await Promise.all(
          [...new Set(directories)].map((directory) =>
            rm(directory, { recursive: true, force: true }),
          ),
        );
      });

      const environments = directories.map((directory, index) =>
        productionEnvironment({
          directory,
          email: `bootstrap-race-${index}-${randomUUID()}@example.test`,
          name: `Bootstrap race ${index}`,
        }),
      );

      const results = await Promise.all(environments.map((env) => runProductionBootstrap(env)));
      const successful = results.filter(
        (result) =>
          result.ok &&
          jsonLines(result.stdout).some((line) => line.event === "installation.bootstrapped"),
      );
      const failed = results.filter((result) => !successful.includes(result));
      assert.equal(successful.length, 1, JSON.stringify(results));
      assert.equal(failed.length, 1, JSON.stringify(results));
      assert.match(failed[0].stderr, /installation\.bootstrap-failed/);

      const winner = jsonLines(successful[0].stdout).find(
        (line) => line.event === "installation.bootstrapped",
      );
      assert.ok(winner);
      const counts = await rowCounts();
      assert.deepEqual(counts, {
        installations: 1,
        bootstrap_audits: 1,
        principals: 1,
        service_principals: 1,
        bindings: 2,
        service_keys: 1,
        users: 1,
      });

      const winnerIndex = environments.findIndex(
        (environment) => environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE === winner.serviceKeyFile,
      );
      assert.notEqual(winnerIndex, -1);
      assert.equal(await exists(environments[winnerIndex].OCC_BOOTSTRAP_PASSWORD_FILE), true);
      assert.equal(await exists(environments[winnerIndex].OCC_BOOTSTRAP_SERVICE_KEY_FILE), true);
      const output = JSON.parse(
        await readFile(environments[winnerIndex].OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8"),
      );
      assert.equal(output.meta.installationId, winner.installationId);
      assert.equal(output.data.servicePrincipalId, winner.servicePrincipalId);
      assert.equal(output.data.id, winner.serviceKeyId);

      for (const [index, environment] of environments.entries()) {
        if (index === winnerIndex || sharedOutput) continue;
        assert.equal(await exists(environment.OCC_BOOTSTRAP_PASSWORD_FILE), false);
        assert.equal(await exists(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE), false);
      }
    },
  );
}

test(
  "concurrent development bootstrap compositions reject the loser and reload the committed winner",
  requiresFailurePostgres,
  async (context) => {
    await resetFailureDatabase();
    await installInstallationDelay();
    const directories = [
      await privateOutputDirectory("openclaw-development-race-a-"),
      await privateOutputDirectory("openclaw-development-race-b-"),
    ];
    const apps = [];
    context.after(async () => {
      await Promise.all(apps.map((app) => app.close()));
      await resetFailureDatabase();
      await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
      );
    });

    const configurations = directories.map((directory, index) =>
      developmentConfiguration({
        directory,
        email: `development-race-${index}-${randomUUID()}@openclaw.local`,
        name: `Development bootstrap race ${index}`,
      }),
    );
    const results = await Promise.allSettled(
      configurations.map((config) =>
        composePostgresDevelopment(config, {
          computeDriver: passiveComputeDriver(),
          configurationDriver: createTestConfigurationDriver(),
        }),
      ),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1, JSON.stringify(results));
    assert.equal(rejected.length, 1, JSON.stringify(results));
    assert.equal(rejected[0].reason.name, "DevelopmentBootstrapFailure");
    assert.match(rejected[0].reason.message, /HTTP 409/);

    const winnerApp = fulfilled[0].value;
    apps.push(winnerApp);
    const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winnerOutputBytes = await readFile(
      configurations[winnerIndex].bootstrapServiceKeyFile,
      "utf8",
    );
    const winnerOutput = JSON.parse(winnerOutputBytes);
    assert.equal(await exists(configurations[loserIndex].bootstrapServiceKeyFile), false);

    const counts = await rowCounts();
    assert.deepEqual(counts, {
      installations: 1,
      bootstrap_audits: 1,
      principals: 1,
      service_principals: 1,
      bindings: 2,
      service_keys: 1,
      users: 1,
    });

    const reloaded = await composePostgresDevelopment(configurations[winnerIndex], {
      computeDriver: passiveComputeDriver(),
      configurationDriver: createTestConfigurationDriver(),
    });
    apps.push(reloaded);
    assert.equal(
      await readFile(configurations[winnerIndex].bootstrapServiceKeyFile, "utf8"),
      winnerOutputBytes,
    );
    const installation = await reloaded.inject({
      method: "GET",
      url: "/installation",
      headers: { "x-api-key": winnerOutput.data.key, host: "127.0.0.1" },
    });
    assert.equal(installation.statusCode, 200, installation.body);
    assert.equal(installation.json().data.id, winnerOutput.meta.installationId);
  },
);

test(
  "production bootstrap preserves committed credentials when COMMIT acknowledgement is lost",
  requiresFailurePostgres,
  async (context) => {
    await resetFailureDatabase();
    const directory = await privateOutputDirectory("openclaw-bootstrap-unknown-production-");
    context.after(async () => {
      await resetFailureDatabase();
      await rm(directory, { recursive: true, force: true });
    });

    const environment = productionEnvironment({
      directory,
      email: `bootstrap-unknown-${randomUUID()}@example.test`,
      name: "Bootstrap unknown production",
    });
    environment.NODE_OPTIONS = [
      process.env.NODE_OPTIONS,
      `--import=${commitAcknowledgementFaultFixture}`,
    ]
      .filter(Boolean)
      .join(" ");
    environment.OCC_TEST_POSTGRES_COMMIT_ACK_FAULT = "installation-bootstrap";
    const result = await runProductionBootstrap(environment);
    assert.equal(result.ok, false);
    const failure = jsonLines(result.stderr).find(
      (line) => line.event === "installation.bootstrap-outcome-uncertain",
    );
    assert.ok(failure, result.stderr);
    assert.equal(failure.attempt.passwordFile, environment.OCC_BOOTSTRAP_PASSWORD_FILE);
    assert.equal(failure.attempt.serviceKeyFile, environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE);

    assert.equal(await exists(environment.OCC_BOOTSTRAP_PASSWORD_FILE), true);
    assert.equal(await exists(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE), true);
    const serviceKeyOutput = JSON.parse(
      await readFile(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8"),
    );
    assert.equal(serviceKeyOutput.meta.installationId, failure.attempt.installationId);
    assert.equal(serviceKeyOutput.data.id, failure.attempt.serviceKeyId);

    const counts = await rowCounts();
    assert.deepEqual(counts, {
      installations: 1,
      bootstrap_audits: 1,
      principals: 1,
      service_principals: 1,
      bindings: 2,
      service_keys: 1,
      users: 1,
    });
  },
);

test(
  "development bootstrap preserves credentials on a 5xx response from an unknown COMMIT outcome",
  requiresFailurePostgres,
  async (context) => {
    await resetFailureDatabase();
    const directory = await privateOutputDirectory("openclaw-bootstrap-unknown-development-");
    const restoreCommitFault = installPostgresCommitAcknowledgementFault();
    context.after(async () => {
      restoreCommitFault();
      await resetFailureDatabase();
      await rm(directory, { recursive: true, force: true });
    });

    const bootstrapServiceKeyFile = join(directory, "initial-admin-service-key.json");
    await assert.rejects(
      composePostgresDevelopment(
        {
          mode: "development",
          host: "127.0.0.1",
          databaseUrl: failureDatabaseUrl,
          poolMax: 2,
          adminEmail: `bootstrap-development-${randomUUID()}@openclaw.local`,
          adminPassword: "postgres-local-development-password",
          authBaseURL: "http://127.0.0.1",
          authSecret: "openclaw-postgres-local-auth-secret-minimum-32-bytes",
          bootstrapInstallationName: "Bootstrap unknown development",
          bootstrapServiceKeyFile,
        },
        {
          computeDriver: passiveComputeDriver(),
          configurationDriver: createTestConfigurationDriver(),
        },
      ),
      (error) => {
        assert.equal(error.name, "DevelopmentBootstrapFailure");
        assert.match(error.message, /HTTP 503/);
        return true;
      },
    );

    assert.equal(await exists(bootstrapServiceKeyFile), true);
    const serviceKeyOutput = JSON.parse(await readFile(bootstrapServiceKeyFile, "utf8"));
    const counts = await rowCounts();
    assert.deepEqual(counts, {
      installations: 1,
      bootstrap_audits: 1,
      principals: 1,
      service_principals: 1,
      bindings: 2,
      service_keys: 1,
      users: 1,
    });
    assert.match(serviceKeyOutput.data.key, /^occ_/);
    assert.equal(serviceKeyOutput.data.name, "bootstrap-admin");
  },
);
