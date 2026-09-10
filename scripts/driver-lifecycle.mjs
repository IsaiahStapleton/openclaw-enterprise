import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const timeoutMs = 300_000;
const shutdownGraceMs = 1_000;

function fail(code) {
  process.stderr.write(`${JSON.stringify({ event: "driver-lifecycle.failed", code })}\n`);
}

function parseArguments(args) {
  if (args.length === 1 && args[0] === "apply") return { operation: "apply" };
  if (args.length === 2 && args[0] === "apply" && args[1] === "--record-existing") {
    return { operation: "record-existing" };
  }
  if (args.length === 5 && args[0] === "uninstall") {
    const options = new Map();
    for (let index = 1; index < args.length; index += 2) {
      const name = args[index];
      const value = args[index + 1];
      if (!["--capability", "--id"].includes(name) || options.has(name) || !value?.trim()) {
        throw new Error("Invalid arguments.");
      }
      options.set(name, value);
    }
    const capability = options.get("--capability");
    if (
      !["iam", "compute", "configuration", "service_account", "secret", "sandbox"].includes(
        capability,
      )
    ) {
      throw new Error("Invalid capability.");
    }
    return { operation: "uninstall", capability, driverId: options.get("--id") };
  }
  throw new Error("Invalid arguments.");
}

async function selectedServiceAccountDriver(drivers, installation, state) {
  const selected = drivers.installation.drivers.service_account;
  if (selected === undefined) return undefined;
  const compute = drivers.computeDriver;
  if (
    typeof compute.storeServiceAccountCredential !== "function" ||
    typeof compute.deleteServiceAccountCredential !== "function"
  ) {
    throw new Error("The selected Compute Driver cannot manage ServiceAccount credentials.");
  }
  const definition = drivers.installation.provider.find(
    (provider) => provider.drivers.service_account === selected.id,
  );
  if (definition === undefined) throw new Error("An owning Provider is required.");
  const configuration = definition.configuration;
  const adminKey = (await readFile(configuration.apiKeyPath, "utf8")).trim();
  if (!adminKey) throw new Error("The Provider credential is empty.");
  const { ChatGPTClient } = await import("../apps/controller/src/providers/chatgpt.ts");
  const { ChatGPTServiceAccountDriver } =
    await import("../apps/controller/src/drivers/service-account/chatgpt.ts");
  const { OpenClawController } = await import("../packages/occ/src/index.ts");
  const client = new ChatGPTClient({
    workspaceId: configuration.workspaceId,
    adminKey,
    ...(configuration.credentialTtlSeconds === undefined
      ? {}
      : {
          credentialTtlSeconds: configuration.credentialTtlSeconds,
        }),
  });
  const controller = new OpenClawController(installation, {
    state,
    providers: drivers.installation.provider,
  });
  return new ChatGPTServiceAccountDriver(
    { id: definition.id, drivers: definition.drivers, client },
    controller,
    state,
    compute,
  );
}

async function run(options, signal) {
  const mode = process.env.NODE_ENV;
  if (mode !== "production" && mode !== "development")
    throw new Error("Explicit mode is required.");
  const databaseUrl = process.env.OCC_DATABASE_URL;
  if (!databaseUrl || !["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol)) {
    throw new Error("A PostgreSQL database is required.");
  }
  const { loadInstallationConfiguration } =
    await import("../apps/controller/src/composition/installation-config.ts");
  const drivers = await loadInstallationConfiguration({ mode });
  signal.throwIfAborted();
  const requireDependency = createRequire(new URL("../packages/occ/package.json", import.meta.url));
  const { Pool } = requireDependency("pg");
  const { PostgresPlatformState } = await import("../packages/occ/src/index.ts");
  const lifecycle = await import("../packages/occ/src/state/driver-lifecycle.ts");
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
  });
  // Idle errors must not print a driver-supplied or credential-bearing exception.
  pool.on("error", () => {
    fail("DATABASE_SESSION_LOST");
    process.exit(1);
  });
  try {
    const state = new PostgresPlatformState(pool);
    const installation = await state.loadInstallation();
    if (installation === undefined) throw new Error("Bootstrap is required.");
    const serviceAccountDriver =
      drivers === undefined
        ? undefined
        : await selectedServiceAccountDriver(drivers, installation, state);
    const selected =
      drivers?.createLifecycleDrivers({
        iamState: state,
        ...(serviceAccountDriver === undefined ? {} : { serviceAccountDriver }),
      }) ?? [];
    signal.throwIfAborted();
    const targets = selected.map(
      ({ capability, driverId, implementationFamily, version, driver }) => ({
        capability,
        id: driverId,
        implementationFamily,
        version,
        ...(driver.lifecycleHooks === undefined ? {} : { lifecycleHooks: driver.lifecycleHooks }),
      }),
    );
    const common = { pool, targets, signal };
    let results;
    if (options.operation === "apply") results = await lifecycle.applyDriverLifecycle(common);
    else if (options.operation === "record-existing") {
      if (targets.length === 0) throw new Error("An explicit outgoing selection is required.");
      results = await lifecycle.recordExistingDriverLifecycle(common);
    } else {
      results = await lifecycle.uninstallDriverLifecycle({
        ...common,
        capability: options.capability,
        driverId: options.driverId,
        providerIds:
          drivers?.installation.provider
            .filter((provider) => provider.drivers.service_account === options.driverId)
            .map((provider) => provider.id) ?? [],
      });
    }
    signal.throwIfAborted();
    process.stdout.write(`${JSON.stringify({ event: "driver-lifecycle.completed", results })}\n`);
  } finally {
    await pool.end();
  }
}

async function supervise(args) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--lifecycle-child", ...args],
    {
      detached: true,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  let stopped = false;
  let forced;
  const killOwnedProcesses = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const stop = (code) => {
    if (stopped) return;
    stopped = true;
    fail(code);
    if (child.connected) child.send({ type: "abort" }, () => {});
    forced = setTimeout(killOwnedProcesses, shutdownGraceMs);
  };
  const deadline = setTimeout(() => stop("TIMEOUT"), timeoutMs);
  const interrupted = () => stop("INTERRUPTED");
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    return stopped ? 1 : code;
  } finally {
    clearTimeout(deadline);
    clearTimeout(forced);
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    // A hook cannot leave background children behind, including after success or a crash.
    killOwnedProcesses();
  }
}

const isChild = process.argv[2] === "--lifecycle-child" && typeof process.send === "function";
try {
  const args = process.argv.slice(isChild ? 3 : 2);
  const options = parseArguments(args);
  if (isChild) {
    const cancellation = new AbortController();
    const fatal = () => {
      cancellation.abort();
      fail("DRIVER_LIFECYCLE_FAILED");
      process.exit(1);
    };
    process.on("uncaughtException", fatal);
    process.on("unhandledRejection", fatal);
    process.on("message", (message) => {
      if (message?.type === "abort")
        cancellation.abort(new Error("Lifecycle invocation cancelled."));
    });
    process.on("disconnect", () => {
      cancellation.abort();
      process.exit(1);
    });
    await run(options, cancellation.signal);
    process.exit(0);
  } else {
    if (process.platform === "win32")
      throw new Error("The lifecycle command requires POSIX process groups.");
    process.exit(await supervise(args));
  }
} catch {
  fail("DRIVER_LIFECYCLE_FAILED");
  process.exit(1);
}
