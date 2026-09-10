import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { PostgresWorkQueue } from "../../packages/occ/src/state/postgres-work-queue.ts";
import {
  productionBootstrapEnvironment,
  runBootstrapInstallation,
} from "../helpers/bootstrap-installation.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";

const run = promisify(execFile);
const databaseUrl = process.env.OCC_LIFECYCLE_CLI_DATABASE_URL;
const repository = fileURLToPath(new URL("../..", import.meta.url));
const fixtureRoot = join(
  repository,
  "tests/fixtures/driver-packages/lifecycle-configuration-driver",
);
const packageName = "@fixture/lifecycle-configuration-driver";
const migrationDatabaseUrl = process.env.OCC_LIFECYCLE_CLI_MIGRATION_DATABASE_URL;
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "host.docker.internal"]);

const requiresDatabase = {
  skip:
    databaseUrl && migrationDatabaseUrl
      ? false
      : "Set OCC_LIFECYCLE_CLI_DATABASE_URL and OCC_LIFECYCLE_CLI_MIGRATION_DATABASE_URL for real PostgreSQL lifecycle CLI proof.",
};

function validatedDatabaseUrl(name, value) {
  assert.ok(value, `${name} must be set.`);
  const parsed = new URL(value);
  assert.ok(
    parsed.protocol === "postgresql:" || parsed.protocol === "postgres:",
    `${name} must be a PostgreSQL URL.`,
  );
  assert.ok(loopbackHosts.has(parsed.hostname), `${name} must target loopback PostgreSQL.`);
  const database = parsed.pathname.replace(/^\//, "");
  assert.match(
    database,
    /^(openclaw_driver_|openclaw_ci_|.*driver.*|.*test.*|.*smoke.*)/i,
    `${name} must identify a disposable lifecycle test database.`,
  );
  return parsed;
}

function appDatabaseUrl() {
  validatedDatabaseUrl("OCC_LIFECYCLE_CLI_DATABASE_URL", databaseUrl);
  return databaseUrl;
}

function migratorDatabaseUrl() {
  const application = validatedDatabaseUrl("OCC_LIFECYCLE_CLI_DATABASE_URL", databaseUrl);
  const migration = validatedDatabaseUrl(
    "OCC_LIFECYCLE_CLI_MIGRATION_DATABASE_URL",
    migrationDatabaseUrl,
  );
  assert.equal(
    migration.hostname,
    application.hostname,
    "OCC_LIFECYCLE_CLI_MIGRATION_DATABASE_URL must target the same host as OCC_LIFECYCLE_CLI_DATABASE_URL.",
  );
  assert.equal(
    migration.port,
    application.port,
    "OCC_LIFECYCLE_CLI_MIGRATION_DATABASE_URL must target the same port as OCC_LIFECYCLE_CLI_DATABASE_URL.",
  );
  assert.equal(
    migration.pathname,
    application.pathname,
    "OCC_LIFECYCLE_CLI_MIGRATION_DATABASE_URL must target the same database as OCC_LIFECYCLE_CLI_DATABASE_URL.",
  );
  return migrationDatabaseUrl;
}

async function resetDatabase() {
  const client = new pg.Client({ connectionString: migratorDatabaseUrl() });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS occ CASCADE");
    await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  } finally {
    await client.end();
  }
  const migrated = spawnSync(
    process.execPath,
    [join(repository, "scripts/migrate-production.mjs")],
    {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        OCC_MIGRATION_DATABASE_URL: migratorDatabaseUrl(),
      },
    },
  );
  assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout || migrated.error?.message);
}

async function bootstrapInstallation(t, pool) {
  const directory = await mkdtemp(join(tmpdir(), "occ-driver-lifecycle-bootstrap-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const result = await runBootstrapInstallation(
    productionBootstrapEnvironment({
      databaseUrl: appDatabaseUrl(),
      directory,
      email: `driver-lifecycle-${randomUUID()}@example.test`,
      authSecret: "driver-lifecycle-cli-auth-secret-at-least-32-bytes",
      installationName: "Driver lifecycle CLI test",
    }),
  );
  assert.equal(result.ok, true, result.stderr || result.stdout || result.message);
  const installation = await pool.query("SELECT id FROM occ.installation");
  assert.equal(installation.rows.length, 1);
  return installation.rows[0].id;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function linkDependencyPackage(destination, packageName, source) {
  const target = packageName.startsWith("@")
    ? join(destination, ...packageName.split("/"))
    : join(destination, packageName);
  try {
    await lstat(target);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(target), { recursive: true });
  await symlink(source, target, "dir");
}

async function findInstalledDependency(packageName) {
  const direct = join(repository, "node_modules", ...packageName.split("/"));
  if (await exists(direct)) return direct;
  const encoded = packageName.startsWith("@")
    ? `${packageName.replace("/", "+")}@`
    : `${packageName}@`;
  const store = join(repository, "node_modules/.pnpm");
  const matches = (await readdir(store)).filter((entry) => entry.startsWith(encoded)).sort();
  assert.ok(matches.length > 0, `missing installed dependency ${packageName}`);
  return join(store, matches.at(-1), "node_modules", ...packageName.split("/"));
}

async function controllerDependencyNames() {
  const manifest = JSON.parse(
    await readFile(join(repository, "apps/controller/package.json"), "utf8"),
  );
  return Object.keys(manifest.dependencies ?? {}).filter(
    (dependency) => !dependency.startsWith("@openclaw-enterprise/") && dependency !== packageName,
  );
}

async function linkNodeModules(owner) {
  const source = join(repository, "node_modules");
  const destination = join(owner, "node_modules");
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name.startsWith("@")) continue;
    const target = join(destination, entry.name);
    try {
      await lstat(target);
      continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await symlink(join(source, entry.name), target, entry.isDirectory() ? "dir" : "file");
  }

  for (const dependency of await controllerDependencyNames()) {
    await linkDependencyPackage(destination, dependency, await findInstalledDependency(dependency));
  }

  for (const name of ["audit", "contracts", "iam", "occ", "utils"]) {
    await linkDependencyPackage(
      destination,
      `@openclaw-enterprise/${name}`,
      join(repository, "packages", name),
    );
  }
}

async function createCliWorkspace(t) {
  const root = await mkdtemp(join(tmpdir(), "occ-driver-lifecycle-cli-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "apps/controller"), { recursive: true });
  await mkdir(join(root, "packages"), { recursive: true });
  await cp(
    join(repository, "scripts/driver-lifecycle.mjs"),
    join(root, "scripts/driver-lifecycle.mjs"),
  );
  await cp(join(repository, "apps/controller/src"), join(root, "apps/controller/src"), {
    recursive: true,
  });
  for (const name of ["audit", "contracts", "iam", "occ", "utils"]) {
    await symlink(join(repository, "packages", name), join(root, "packages", name), "dir");
  }
  const owner = join(root, "apps/controller");
  await writeFile(
    join(owner, "package.json"),
    `${JSON.stringify({ name: "lifecycle-cli-owner", version: "1.0.0", type: "module", dependencies: {} })}\n`,
    "utf8",
  );
  await writeFile(join(root, "empty.npmrc"), "", "utf8");
  await mkdir(join(root, "xdg-config"));
  return { root, owner, store: join(root, "store") };
}

async function packFixtureVersion(workspace, version) {
  const staging = join(workspace.root, `package-${version}-${randomUUID()}`);
  await mkdir(staging);
  await cp(fixtureRoot, join(staging, "package"), { recursive: true });
  const manifestPath = join(staging, "package/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  const archive = join(workspace.root, `lifecycle-configuration-driver-${version}.tgz`);
  const packed = spawnSync("tar", ["-czf", archive, "-C", staging, "package"], {
    cwd: workspace.root,
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr || packed.error?.message);
  return archive;
}

async function installDriverVersion(workspace, version) {
  const archive = await packFixtureVersion(workspace, version);
  const manifestPath = join(workspace.owner, "package.json");
  const pendingManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete pendingManifest.dependencies[packageName];
  await writeFile(manifestPath, `${JSON.stringify(pendingManifest)}\n`, "utf8");
  await rm(join(workspace.owner, "pnpm-lock.yaml"), { force: true });
  await rm(join(workspace.owner, "node_modules"), { recursive: true, force: true });
  await rm(workspace.store, { recursive: true, force: true });
  const installed = spawnSync(
    "pnpm",
    [
      "add",
      "--offline",
      "--ignore-scripts",
      "--save-exact",
      "--lockfile-dir",
      workspace.owner,
      "--store-dir",
      workspace.store,
      archive,
    ],
    {
      cwd: workspace.owner,
      encoding: "utf8",
      env: {
        ...process.env,
        COREPACK_ENABLE_AUTO_PIN: "0",
        XDG_CONFIG_HOME: join(workspace.root, "xdg-config"),
        npm_config_userconfig: join(workspace.root, "empty.npmrc"),
        npm_config_globalconfig: join(workspace.root, "empty.npmrc"),
      },
    },
  );
  assert.equal(
    installed.status,
    0,
    installed.stderr || installed.stdout || installed.error?.message,
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies[packageName] = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  await linkNodeModules(workspace.owner);
  await linkNodeModules(workspace.root);
}

async function startupPath(workspace, options) {
  const configuration = createInstallationDriverConfiguration();
  configuration.drivers.configuration = {
    id: options.driverId,
    package: packageName,
    configuration: {
      effectsPath: options.effectsPath,
      mode: options.mode,
      ...(options.childPidPath === undefined ? {} : { childPidPath: options.childPidPath }),
    },
  };
  const path = join(workspace.root, `startup-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(configuration), "utf8");
  return path;
}

function cliEnvironment(configPath) {
  return {
    ...process.env,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: configPath,
    OCC_DATABASE_URL: appDatabaseUrl(),
  };
}

async function runCli(workspace, args, configPath, timeout = 20_000) {
  try {
    const result = await run(
      process.execPath,
      [join(workspace.root, "scripts/driver-lifecycle.mjs"), ...args],
      {
        cwd: workspace.root,
        env: cliEnvironment(configPath),
        timeout,
        maxBuffer: 1024 * 1024,
      },
    );
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status: typeof error.code === "number" ? error.code : 1,
      signal: error.signal,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function lines(text) {
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function completed(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const event = lines(result.stdout).find((line) => line.event === "driver-lifecycle.completed");
  assert.ok(event, result.stdout);
  return event.results;
}

function failed(result) {
  assert.notEqual(result.status, 0, result.stdout);
  return lines(result.stderr).find((line) => line.event === "driver-lifecycle.failed");
}

async function effectEvents(path) {
  try {
    return lines(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function receiptRows(pool) {
  return (
    await pool.query(
      `SELECT capability, driver_id AS "driverId", implementation_family AS "implementationFamily", version
       FROM occ.driver_lifecycle_receipts
       ORDER BY capability, driver_id`,
    )
  ).rows;
}

async function receiptVersion(pool, driverId) {
  const result = await pool.query(
    `SELECT version FROM occ.driver_lifecycle_receipts
     WHERE capability = 'configuration' AND driver_id = $1`,
    [driverId],
  );
  return result.rows[0]?.version;
}

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (process.platform === "linux") {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        if (stat.split(" ")[2] === "Z") return;
      }
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") return;
      throw error;
    }
    await delay(25);
  }
  assert.fail(`process ${pid} remained alive after lifecycle interruption`);
}

function spawnLifecycleCli(workspace, configPath) {
  const child = spawn(
    process.execPath,
    [join(workspace.root, "scripts/driver-lifecycle.mjs"), "apply"],
    {
      cwd: workspace.root,
      env: cliEnvironment(configPath),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return { child, output: () => ({ stdout, stderr }) };
}

async function spawnedHookPid(childPidPath) {
  let spawnedPid;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pids = await effectEvents(childPidPath);
    if (pids.length > 0) {
      spawnedPid = Number(pids.at(-1).pid);
      break;
    }
    await delay(25);
  }
  assert.ok(Number.isSafeInteger(spawnedPid), "fixture hook must spawn a child process");
  return spawnedPid;
}

async function interruptingCli(workspace, configPath, childPidPath) {
  const { child, output } = spawnLifecycleCli(workspace, configPath);
  const spawnedPid = await spawnedHookPid(childPidPath);
  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");
  await waitForProcessExit(spawnedPid);
  return { status: code ?? 1, signal, ...output(), spawnedPid };
}

async function timeoutCli(workspace, configPath, childPidPath) {
  const { child, output } = spawnLifecycleCli(workspace, configPath);
  const spawnedPid = await spawnedHookPid(childPidPath);
  const [code, signal] = await once(child, "exit");
  await waitForProcessExit(spawnedPid);
  return { status: code ?? 1, signal, ...output(), spawnedPid };
}

test(
  "driver lifecycle CLI applies receipts, replays crashes, and cleans interrupted subprocesses",
  requiresDatabase,
  async (t) => {
    await resetDatabase();
    const workspace = await createCliWorkspace(t);
    const pool = new pg.Pool({ connectionString: appDatabaseUrl(), max: 1 });
    t.after(async () => pool.end());
    const installationId = await bootstrapInstallation(t, pool);
    const effectsPath = join(workspace.root, "effects.jsonl");
    const driverId = "configuration-lifecycle-cli";

    await installDriverVersion(workspace, "1.0.0");
    let configPath = await startupPath(workspace, {
      driverId,
      effectsPath,
      mode: "normal",
    });
    assert.deepEqual(
      completed(await runCli(workspace, ["apply", "--record-existing"], configPath)).map(
        ({ kind }) => kind,
      ),
      ["recorded", "recorded", "recorded", "recorded"],
    );
    assert.deepEqual(await effectEvents(effectsPath), []);
    assert.deepEqual(
      (await receiptRows(pool)).map(
        ({ capability, driverId: id, implementationFamily, version }) => ({
          capability,
          driverId: id,
          implementationFamily,
          version,
        }),
      ),
      [
        {
          capability: "compute",
          driverId: "compute-kubernetes",
          implementationFamily: "occ/kubernetes",
          version: "0.1.0",
        },
        {
          capability: "configuration",
          driverId,
          implementationFamily: packageName,
          version: "1.0.0",
        },
        {
          capability: "iam",
          driverId: "native-iam",
          implementationFamily: "occ/native-iam",
          version: "0.1.0",
        },
        {
          capability: "secret",
          driverId: "secret-kubernetes",
          implementationFamily: "occ/kubernetes-secret",
          version: "0.1.0",
        },
      ],
    );
    assert.equal(
      failed(await runCli(workspace, ["apply", "--record-existing"], configPath)).code,
      "DRIVER_LIFECYCLE_FAILED",
    );
    assert.deepEqual(
      completed(await runCli(workspace, ["apply"], configPath)).map(({ kind }) => kind),
      ["unchanged", "unchanged", "unchanged", "unchanged"],
    );
    assert.deepEqual(await effectEvents(effectsPath), []);

    await installDriverVersion(workspace, "2.0.0");
    configPath = await startupPath(workspace, { driverId, effectsPath, mode: "normal" });
    assert.deepEqual(
      completed(await runCli(workspace, ["apply"], configPath)).map(({ kind }) => kind),
      ["updated", "unchanged", "unchanged", "unchanged"],
    );
    assert.deepEqual((await effectEvents(effectsPath)).at(-1), {
      hook: "onUpdate",
      installationId,
      capability: "configuration",
      driverId,
      version: "2.0.0",
      previousVersion: "1.0.0",
      aborted: false,
    });
    assert.equal(await receiptVersion(pool, driverId), "2.0.0");

    configPath = await startupPath(workspace, { driverId, effectsPath, mode: "normal" });
    assert.deepEqual(
      completed(await runCli(workspace, ["apply"], configPath)).map(({ kind }) => kind),
      ["unchanged", "unchanged", "unchanged", "unchanged"],
    );
    assert.equal((await effectEvents(effectsPath)).length, 1);

    await installDriverVersion(workspace, "1.0.0");
    configPath = await startupPath(workspace, { driverId, effectsPath, mode: "normal" });
    assert.deepEqual(completed(await runCli(workspace, ["apply"], configPath))[0], {
      kind: "updated",
      capability: "configuration",
      driverId,
      implementationFamily: packageName,
      version: "1.0.0",
      previousVersion: "2.0.0",
    });
    assert.equal(await receiptVersion(pool, driverId), "1.0.0");

    await installDriverVersion(workspace, "2.0.0");
    configPath = await startupPath(workspace, { driverId, effectsPath, mode: "fail-update" });
    assert.equal(
      failed(await runCli(workspace, ["apply"], configPath)).code,
      "DRIVER_LIFECYCLE_FAILED",
    );
    assert.equal(await receiptVersion(pool, driverId), "1.0.0");
    assert.equal((await effectEvents(effectsPath)).at(-1).hook, "onUpdate");

    configPath = await startupPath(workspace, { driverId, effectsPath, mode: "normal" });
    assert.equal(completed(await runCli(workspace, ["apply"], configPath))[0].kind, "updated");
    assert.equal(await receiptVersion(pool, driverId), "2.0.0");

    const effectsBeforeBlockedUninstall = await effectEvents(effectsPath);
    assert.equal(
      failed(
        await runCli(
          workspace,
          ["uninstall", "--id", driverId, "--capability", "configuration"],
          configPath,
        ),
      ).code,
      "DRIVER_LIFECYCLE_FAILED",
    );
    assert.equal(await receiptVersion(pool, driverId), "2.0.0");
    assert.deepEqual(await effectEvents(effectsPath), effectsBeforeBlockedUninstall);

    // This fixture has no external Compute resources. Settle the bootstrap Namespace
    // through the state/queue interfaces so successful uninstall has no pending work.
    const queue = new PostgresWorkQueue(pool);
    const bootstrapWork = await queue.claim();
    assert.ok(bootstrapWork);
    assert.equal(bootstrapWork.namespaceTarget, "ready");
    const state = new PostgresPlatformState(pool);
    await state.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(bootstrapWork.namespaceId, "provisioning", "ready"),
    );
    await queue.complete(bootstrapWork);

    assert.deepEqual(
      completed(
        await runCli(
          workspace,
          ["uninstall", "--id", driverId, "--capability", "configuration"],
          configPath,
        ),
      ),
      [
        {
          kind: "uninstalled",
          capability: "configuration",
          driverId,
          implementationFamily: packageName,
          version: "2.0.0",
        },
      ],
    );
    assert.equal(await receiptVersion(pool, driverId), undefined);
    assert.deepEqual(
      completed(
        await runCli(
          workspace,
          ["uninstall", "--capability", "configuration", "--id", driverId],
          configPath,
        ),
      ),
      [{ kind: "noop", capability: "configuration", driverId }],
    );

    await installDriverVersion(workspace, "1.0.0");
    configPath = await startupPath(workspace, { driverId, effectsPath, mode: "normal" });
    assert.equal(completed(await runCli(workspace, ["apply"], configPath))[0].kind, "installed");
    assert.equal(await receiptVersion(pool, driverId), "1.0.0");

    const crashDriverId = "configuration-lifecycle-crash";
    configPath = await startupPath(workspace, {
      driverId: crashDriverId,
      effectsPath,
      mode: "crash-install",
    });
    const crashed = await runCli(workspace, ["apply"], configPath);
    assert.equal(crashed.status, 86);
    assert.equal(await receiptVersion(pool, crashDriverId), undefined);
    configPath = await startupPath(workspace, {
      driverId: crashDriverId,
      effectsPath,
      mode: "normal",
    });
    assert.equal(completed(await runCli(workspace, ["apply"], configPath))[0].kind, "installed");
    assert.equal(await receiptVersion(pool, crashDriverId), "1.0.0");
    assert.equal(
      (await effectEvents(effectsPath)).filter(
        (event) => event.driverId === crashDriverId && event.hook === "onInstall",
      ).length,
      2,
    );

    const childPidPath = join(workspace.root, "child-pids.jsonl");
    const subprocessDriverId = "configuration-lifecycle-subprocess";
    configPath = await startupPath(workspace, {
      driverId: subprocessDriverId,
      effectsPath,
      childPidPath,
      mode: "spawn-hang-install",
    });
    const interrupted = await interruptingCli(workspace, configPath, childPidPath);
    assert.equal(interrupted.status, 1, interrupted.stderr || interrupted.stdout);
    assert.equal(failed(interrupted).code, "INTERRUPTED");
    assert.equal(await receiptVersion(pool, subprocessDriverId), undefined);

    const timeoutChildPidPath = join(workspace.root, "timeout-child-pids.jsonl");
    const timeoutDriverId = "configuration-lifecycle-timeout";
    configPath = await startupPath(workspace, {
      driverId: timeoutDriverId,
      effectsPath,
      childPidPath: timeoutChildPidPath,
      mode: "spawn-hang-install",
    });
    const timedOut = await timeoutCli(workspace, configPath, timeoutChildPidPath);
    assert.equal(timedOut.status, 1, timedOut.stderr || timedOut.stdout);
    assert.equal(failed(timedOut).code, "TIMEOUT");
    assert.equal(await receiptVersion(pool, timeoutDriverId), undefined);
  },
);
