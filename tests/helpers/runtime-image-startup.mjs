// Shared by the runtime image startup smoke tests, which CI runs in two lanes
// (runtime-image-startup.test.mjs and runtime-image-startup-probe.test.mjs).
import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { imageSmokeTimeoutMultiplier } from "./image-smoke-timeout.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { createHarnessConfiguration } from "./harness-configuration.mjs";

export const execute = promisify(execFile);
export const docker = process.env.OCC_DOCKER_BIN ?? "docker";
export const image = process.env.OCC_TEST_RUNTIME_IMAGE;
export const runtimeImageModel = defaultAgentModel;
export const imageTestOptions =
  image === undefined
    ? {
        skip: "Set OCC_TEST_RUNTIME_IMAGE to a locally built OpenClaw runtime image tag.",
      }
    : {};

export async function runDocker(args, options = {}, input) {
  const command = execute(docker, args, {
    timeout: 60_000 * imageSmokeTimeoutMultiplier,
    maxBuffer: 1_000_000,
    ...options,
  });
  if (input === undefined) {
    return command;
  }
  const inputComplete = new Promise((resolve, reject) => {
    command.child.stdin.once("error", reject);
    command.child.stdin.end(input, resolve);
  });
  const [result] = await Promise.all([command, inputComplete]);
  return result;
}

export async function waitForDockerLog(containerName, pattern) {
  const deadline = Date.now() + 20_000 * imageSmokeTimeoutMultiplier;
  let output = "";
  while (Date.now() < deadline) {
    const logs = await runDocker(["logs", containerName]).catch((error) => error);
    output = commandOutput(logs);
    if (pattern.test(output)) {
      return output;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${pattern} in ${containerName} logs.
${output}`);
}

export function commandOutput(error) {
  return `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
}

export async function temporaryGatewayConfiguration(t, harnessId) {
  const directory = await mkdtemp(join(tmpdir(), "oce-runtime-image-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const path = join(directory, "openclaw.json");
  await writeFile(path, JSON.stringify(createAdmittedRuntimeImageConfiguration(harnessId)));
  return path;
}

export function createRuntimeImageConfiguration(harnessId, providerModel, options = {}) {
  const configuration = createHarnessConfiguration(harnessId, providerModel);
  if (options.enableSlack !== true) {
    return configuration;
  }

  const plugins = configuration.plugins ?? {};
  const entries = plugins.entries ?? {};
  configuration.plugins = {
    ...plugins,
    allow: [...new Set([...(Array.isArray(plugins.allow) ? plugins.allow : []), "slack"])],
    entries: {
      ...entries,
      slack: {
        ...entries.slack,
        enabled: true,
      },
    },
  };
  configuration.channels = {
    ...configuration.channels,
    slack: {
      ...configuration.channels?.slack,
      enabled: true,
    },
  };

  return configuration;
}

export function createAdmittedRuntimeImageConfiguration(harnessId, options = {}) {
  return admitLoggingConfiguration(
    createRuntimeImageConfiguration(harnessId, runtimeImageModel, options),
    "info",
  );
}

export async function waitForGatewayReady(containerName) {
  let lastReadinessOutput = "";
  for (let attempt = 0; attempt < 60 * imageSmokeTimeoutMultiplier; attempt += 1) {
    const inspect = await runDocker([
      "inspect",
      containerName,
      "--format",
      "{{.State.Running}} {{.State.ExitCode}}",
    ]);
    const [running, exitCode] = inspect.stdout.trim().split(/\s+/);
    if (running !== "true") {
      throw new Error(`Gateway container exited before readiness with code ${exitCode}.`);
    }

    const ready = await runDocker([
      "exec",
      containerName,
      "node",
      "-e",
      'fetch("http://127.0.0.1:8080/readyz").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));',
    ]).catch((error) => {
      lastReadinessOutput = commandOutput(error);
      return undefined;
    });
    if (ready !== undefined) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Gateway readiness timed out.${lastReadinessOutput}`);
}

export async function listGatewayPlugins(containerName) {
  const { stdout } = await runDocker([
    "exec",
    containerName,
    "node",
    "/app/openclaw.mjs",
    "plugins",
    "list",
    "--json",
  ]);

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`OpenClaw plugin list output was not valid JSON.\n${stdout}`, {
      cause: error,
    });
  }
}

export function jsonLogEntries(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((entry) => entry !== undefined);
}

export async function runGatewaySmoke(t, harnessId, options = {}) {
  const {
    collectPlugins = harnessId === "codex",
    configuration = createAdmittedRuntimeImageConfiguration(harnessId, {
      enableSlack: harnessId === "openclaw",
    }),
    configurationPath,
    entrypoint = DOCKER_GATEWAY_RUNTIME_ENTRYPOINT,
    extraEnvironment = [],
    tmpfs = ["/home/node:size=1024m,uid=1000,gid=1000,mode=700"],
    volumes = [],
    waitUntilReady = true,
    withAppServer = true,
  } = options;
  const containerName = `oce-runtime-image-${harnessId}-${randomBytes(6).toString("hex")}`;
  t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));

  const environment = [
    `OPENCLAW_CONFIG_PATH=${configurationPath ?? "/home/node/.openclaw/openclaw.json"}`,
    ...(configurationPath === undefined
      ? [`OPENCLAW_CONFIG_JSON=${JSON.stringify(configuration)}`]
      : []),
    "OPENCLAW_GATEWAY_PORT=8080",
    "OPENCLAW_GATEWAY_PASSWORD=openclaw-runtime-image-smoke-password",
    "OPENCLAW_STATE_DIR=/home/node/.openclaw",
    ...(withAppServer
      ? [
          "APP_SERVER_URL=ws://127.0.0.1:9",
          "APP_SERVER_TOKEN=openclaw-runtime-image-app-server-token",
        ]
      : []),
    "HOME=/home/node",
    ...extraEnvironment,
  ];

  await runDocker(["rm", "-f", containerName]).catch(() => {});
  await runDocker([
    "run",
    "--name",
    containerName,
    "--detach",
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    ...tmpfs.flatMap((value) => ["--tmpfs", value]),
    "--tmpfs",
    "/tmp:size=64m,uid=1000,gid=1000,mode=1777",
    "--network",
    "none",
    ...volumes.flatMap((value) => ["--volume", value]),
    ...environment.flatMap((value) => ["-e", value]),
    "--entrypoint",
    "node",
    image,
    "-e",
    ...nodeProgramArguments(entrypoint),
  ]);
  if (!waitUntilReady) {
    return { containerName };
  }

  try {
    await waitForGatewayReady(containerName);
    const pluginList = collectPlugins ? await listGatewayPlugins(containerName) : undefined;
    const logs = await runDocker(["logs", containerName]);
    return {
      containerName,
      logs: `${logs.stdout}\n${logs.stderr}`,
      pluginList,
    };
  } catch (error) {
    const logs = await runDocker(["logs", containerName]).catch((logsError) => logsError);
    throw new Error(`${error.message}\n${commandOutput(logs)}`, { cause: error });
  }
}
