import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

const execute = promisify(execFile);
const docker = process.env.OCC_DOCKER_BIN ?? "docker";
const image = process.env.OCC_TEST_RUNTIME_IMAGE;
const imageTestOptions =
  image === undefined
    ? {
        skip: "Set OCC_TEST_RUNTIME_IMAGE to a locally built OpenClaw runtime image tag.",
      }
    : {};

async function runDocker(args, options = {}) {
  return execute(docker, args, {
    timeout: 60_000,
    maxBuffer: 1_000_000,
    ...options,
  });
}

function commandOutput(error) {
  return `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
}

function assertNoPackagingFailure(output) {
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/);
  assert.doesNotMatch(output, /ENOENT: no such file or directory/);
  assert.doesNotMatch(output, /TypeScript .* is not supported in strip-only mode/);
}

async function dockerGatewayEntrypoint() {
  const source = await readFile(
    join("apps", "controller", "src", "drivers", "compute", "docker", "index.ts"),
    "utf8",
  );
  const match = source.match(/const GATEWAY_RUNTIME_ENTRYPOINT = String\.raw`([\s\S]*?)`;/);
  assert.ok(match, "Docker gateway runtime entrypoint must remain discoverable");
  return match[1];
}

async function temporaryGatewayConfiguration(t, harnessId) {
  const directory = await mkdtemp(join(tmpdir(), "oce-runtime-image-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const path = join(directory, "openclaw.json");
  await writeFile(path, JSON.stringify(createRuntimeImageConfiguration(harnessId, "gpt-4.1")));
  return path;
}

function createRuntimeImageConfiguration(harnessId, providerModel, options = {}) {
  const configuration = createHarnessConfiguration(harnessId, providerModel);
  if (options.enableSlack !== true) return configuration;

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
      enabled: false,
    },
  };

  return configuration;
}

async function waitForGatewayReady(containerName) {
  let lastReadinessOutput = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
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
    if (ready !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Gateway readiness timed out.${lastReadinessOutput}`);
}

async function listGatewayPlugins(containerName) {
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
    throw new Error(`OpenClaw plugin list output was not valid JSON.\n${stdout}`);
  }
}

function jsonLogEntries(output) {
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

function assertBundledCodexPluginLoaded(pluginList) {
  const codexPlugin = assertBundledPluginLoaded(pluginList, "codex");
  assert.match(
    codexPlugin.source,
    /\/app\/node_modules\/openclaw\/dist\/extensions\/codex\/dist\/index\.js$/,
  );
  assert.deepEqual(codexPlugin.providerIds, ["codex"]);
  assert.equal(codexPlugin.dependencyStatus?.requiredInstalled, true);
  assert.deepEqual(codexPlugin.dependencyStatus?.missing, []);
}

function assertBundledSlackPluginLoaded(pluginList) {
  const slackPlugin = assertBundledPluginLoaded(pluginList, "slack");
  assert.match(
    slackPlugin.source,
    /\/app\/node_modules\/openclaw\/dist\/extensions\/slack\/dist\/index\.js$/,
  );
  assert.equal(slackPlugin.dependencyStatus?.requiredInstalled, true);
  assert.deepEqual(slackPlugin.dependencyStatus?.missing, []);
}

function assertBundledPluginLoaded(pluginList, pluginId) {
  const plugin = pluginList.plugins?.find((entry) => entry.id === pluginId);

  assert.ok(plugin, `${pluginId} plugin must be present in OpenClaw plugin discovery output`);
  assert.equal(plugin.origin, "bundled");
  assert.equal(plugin.enabled, true);
  assert.equal(plugin.status, "loaded");
  return plugin;
}

async function assertCodexAppServerHandshake(containerName) {
  const { stdout } = await runDocker(
    [
      "exec",
      containerName,
      "node",
      "--input-type=module",
      "-e",
      `
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pluginDist = "/app/node_modules/openclaw/dist/extensions/codex/dist";
const sharedClientChunk = readdirSync(pluginDist).find((name) =>
  /^shared-client-.*\\.js$/.test(name)
);
if (sharedClientChunk === undefined) {
  throw new Error("Bundled Codex shared-client chunk was not found under " + pluginDist);
}

const sharedClientExports = await import(pathToFileURL(join(pluginDist, sharedClientChunk)));
const { createIsolatedCodexAppServerClient } = Object.values(sharedClientExports).find(
  (value) => typeof value?.createIsolatedCodexAppServerClient === "function"
) ?? {};
if (createIsolatedCodexAppServerClient === undefined) {
  throw new Error("Bundled Codex shared-client export did not expose createIsolatedCodexAppServerClient.");
}
const configChunk = readdirSync(pluginDist).find((name) => /^config-.*\\.js$/.test(name));
if (configChunk === undefined) {
  throw new Error("Bundled Codex config chunk was not found under " + pluginDist);
}
const configExports = await import(pathToFileURL(join(pluginDist, configChunk)));
const resolveCodexAppServerRuntimeOptions = Object.values(configExports).find(
  (value) => typeof value === "function" && value.name === "resolveCodexAppServerRuntimeOptions"
);
if (resolveCodexAppServerRuntimeOptions === undefined) {
  throw new Error("Bundled Codex config export did not expose resolveCodexAppServerRuntimeOptions.");
}
const versionOutput = execFileSync("codex", ["--version"], { encoding: "utf8" });
const installedVersion = versionOutput.match(/\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
if (installedVersion === undefined) {
  throw new Error("Unable to parse installed Codex version from: " + versionOutput);
}

const agentDir = mkdtempSync(join(tmpdir(), "openclaw-codex-agent-"));
const codexHome = join(agentDir, "codex-home");
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
const runtime = resolveCodexAppServerRuntimeOptions({
  env: {
    OPENCLAW_CODEX_APP_SERVER_BIN: "codex",
    OPENCLAW_CODEX_APP_SERVER_ARGS: "app-server --listen stdio://",
  },
});
const client = await createIsolatedCodexAppServerClient({
  agentDir,
  authProfileId: null,
  timeoutMs: 10_000,
  startOptions: {
    ...runtime.start,
    env: {
      CODEX_HOME: codexHome,
      HOME: "/home/node",
    },
    clearEnv: ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"],
  },
});

try {
  const serverVersion = client.getServerVersion();
  if (serverVersion !== installedVersion) {
    throw new Error(
      \`Codex app-server initialized as \${serverVersion}, but codex --version reported \${installedVersion}.\`
    );
  }
  process.stdout.write(JSON.stringify({ installedVersion, serverVersion }));
} finally {
  client.close();
}
`,
    ],
    { timeout: 20_000 },
  );

  const result = JSON.parse(stdout);
  assert.equal(result.serverVersion, result.installedVersion);
}

async function runGatewaySmoke(t, harnessId, options = {}) {
  const {
    collectPlugins = harnessId === "codex",
    configuration = createRuntimeImageConfiguration(harnessId, "gpt-4.1", {
      enableSlack: harnessId === "openclaw",
    }),
    configurationPath,
    entrypoint = await dockerGatewayEntrypoint(),
    extraEnvironment = [],
    tmpfs = ["/home/node:size=1024m,uid=1000,gid=1000,mode=700"],
    volumes = [],
  } = options;
  const containerName = `oce-runtime-image-${harnessId}-${randomBytes(6).toString("hex")}`;
  t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));

  const environment = [
    `OPENCLAW_CONFIG_PATH=${configurationPath ?? "/home/node/.openclaw/openclaw.json"}`,
    ...(configurationPath === undefined
      ? [`OPENCLAW_CONFIG_JSON=${JSON.stringify(configuration)}`]
      : []),
    "OPENCLAW_GATEWAY_PORT=8080",
    "OPENCLAW_GATEWAY_TOKEN=openclaw-runtime-image-smoke-token",
    "OPENCLAW_STATE_DIR=/home/node/.openclaw",
    "APP_SERVER_URL=ws://127.0.0.1:9",
    "APP_SERVER_TOKEN=openclaw-runtime-image-app-server-token",
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
    entrypoint,
  ]);

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
    throw new Error(`${error.message}\n${commandOutput(logs)}`);
  }
}

async function assertDedicatedRuntimeAssets(containerName) {
  const { stdout } = await runDocker([
    "exec",
    containerName,
    "node",
    "-e",
    `
const { lstatSync, readdirSync } = require("node:fs");
const appSkills = lstatSync("/app/skills");
if (!appSkills.isDirectory() || appSkills.isSymbolicLink()) {
  throw new Error("/app/skills must be a real directory in the runtime image.");
}
const bundled = readdirSync("/home/node/openclaw-runtime-assets/bundled-skills");
if (bundled.length === 0) {
  throw new Error("Kubernetes gateway entrypoint did not publish bundled skills.");
}
const plugin = lstatSync("/home/node/openclaw-runtime-assets/plugin-skills");
	if (!plugin.isDirectory()) {
	  throw new Error("Kubernetes gateway entrypoint did not publish plugin skills directory.");
	}
	const slack = lstatSync("/home/node/openclaw-runtime-assets/plugin-skills/slack/SKILL.md");
	if (!slack.isFile()) {
	  throw new Error("Kubernetes gateway entrypoint did not publish Slack plugin skills.");
	}
	process.stdout.write(JSON.stringify({ bundledCount: bundled.length, slackSkill: true }));
	`,
  ]);

  assert.ok(JSON.parse(stdout).bundledCount > 0);
}

test(
  "runtime image gateway ignores inherited OPENCLAW_LOG_LEVEL in favor of native configuration",
  imageTestOptions,
  async (t) => {
    const configuration = createRuntimeImageConfiguration("openclaw", "gpt-4.1", {
      enableSlack: true,
    });
    configuration.logging = {
      level: "info",
      consoleLevel: "info",
      consoleStyle: "json",
      redactSensitive: "tools",
    };
    configuration.diagnostics = { otel: { logs: false } };

    const { logs } = await runGatewaySmoke(t, "openclaw", {
      collectPlugins: false,
      configuration,
      extraEnvironment: ["OPENCLAW_LOG_LEVEL=error"],
    });

    const entries = jsonLogEntries(logs);
    assert.ok(
      entries.some(
        (entry) =>
          entry.subsystem === "gateway" &&
          entry.level === "info" &&
          entry.message === "gateway ready",
      ),
    );
    assert.ok(
      entries.some(
        (entry) =>
          entry.subsystem === "gateway" &&
          entry.level === "info" &&
          /agent model: openai\/gpt-4\.1/.test(entry.message),
      ),
    );
    assertNoPackagingFailure(logs);
  },
);

test(
  "runtime image starts an embedded OpenClaw gateway with the Docker driver entrypoint",
  imageTestOptions,
  async (t) => {
    const { logs, pluginList } = await runGatewaySmoke(t, "openclaw", {
      collectPlugins: true,
    });

    assert.match(logs, /\[gateway\] ready/);
    assert.match(logs, /agent model: openai\/gpt-4\.1/);
    assertBundledSlackPluginLoaded(pluginList);
    assertNoPackagingFailure(logs);
  },
);

test(
  "runtime image discovers the bundled Codex plugin from a fresh gateway home",
  imageTestOptions,
  async (t) => {
    const { logs, containerName, pluginList } = await runGatewaySmoke(t, "codex");

    assert.match(logs, /\[gateway\] ready/);
    assert.match(logs, /agent model: codex\/gpt-4\.1/);
    assertBundledCodexPluginLoaded(pluginList);
    await assertCodexAppServerHandshake(containerName);
    assertNoPackagingFailure(logs);
  },
);

test(
  "runtime image publishes dedicated assets with the Kubernetes gateway entrypoint",
  imageTestOptions,
  async (t) => {
    const configurationPath = await temporaryGatewayConfiguration(t, "codex");
    const { logs, containerName } = await runGatewaySmoke(t, "codex", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      extraEnvironment: ["OPENCLAW_WORKSPACE_DIR=/home/node/workspace", "OPENCLAW_LOG_LEVEL=error"],
      tmpfs: [
        "/home/node:size=1024m,uid=1000,gid=1000,mode=700",
        "/home/node/workspace:size=1024m,uid=1000,gid=1000,mode=700",
      ],
      volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
    });

    assert.match(logs, /\[gateway\] ready/);
    assert.match(logs, /agent model: codex\/gpt-4\.1/);
    await assertDedicatedRuntimeAssets(containerName);
    assertNoPackagingFailure(logs);
  },
);
