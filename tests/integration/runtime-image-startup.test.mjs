import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
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
    timeout: 20_000,
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

function assertBundledCodexPluginLoaded(pluginList) {
  const codexPlugin = pluginList.plugins?.find((plugin) => plugin.id === "codex");

  assert.ok(codexPlugin, "Codex plugin must be present in OpenClaw plugin discovery output");
  assert.equal(codexPlugin.origin, "bundled");
  assert.equal(codexPlugin.enabled, true);
  assert.equal(codexPlugin.status, "loaded");
  assert.match(
    codexPlugin.source,
    /\/app\/node_modules\/openclaw\/dist\/extensions\/codex\/dist\/index\.js$/,
  );
  assert.deepEqual(codexPlugin.providerIds, ["codex"]);
  assert.equal(codexPlugin.dependencyStatus?.requiredInstalled, true);
  assert.deepEqual(codexPlugin.dependencyStatus?.missing, []);
}

async function runGatewaySmoke(t, harnessId) {
  const containerName = `oce-runtime-image-${harnessId}-${randomBytes(6).toString("hex")}`;
  t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));

  const configuration = createHarnessConfiguration(harnessId, "gpt-4.1");
  const environment = [
    "OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json",
    `OPENCLAW_CONFIG_JSON=${JSON.stringify(configuration)}`,
    "OPENCLAW_GATEWAY_PORT=8080",
    "OPENCLAW_GATEWAY_TOKEN=openclaw-runtime-image-smoke-token",
    "OPENCLAW_STATE_DIR=/home/node/.openclaw",
    "APP_SERVER_URL=ws://127.0.0.1:9",
    "APP_SERVER_TOKEN=openclaw-runtime-image-app-server-token",
    "HOME=/home/node",
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
    "--tmpfs",
    "/home/node:size=1024m,uid=1000,gid=1000,mode=700",
    "--tmpfs",
    "/tmp:size=64m,uid=1000,gid=1000,mode=1777",
    "--network",
    "none",
    ...environment.flatMap((value) => ["-e", value]),
    "--entrypoint",
    "node",
    image,
    "-e",
    await dockerGatewayEntrypoint(),
  ]);

  try {
    await waitForGatewayReady(containerName);
    const pluginList = harnessId === "codex" ? await listGatewayPlugins(containerName) : undefined;
    const logs = await runDocker(["logs", containerName]);
    return {
      logs: `${logs.stdout}\n${logs.stderr}`,
      pluginList,
    };
  } catch (error) {
    const logs = await runDocker(["logs", containerName]).catch((logsError) => logsError);
    throw new Error(`${error.message}\n${commandOutput(logs)}`);
  }
}

test(
  "runtime image starts an embedded OpenClaw gateway with the Docker driver entrypoint",
  imageTestOptions,
  async (t) => {
    const { logs } = await runGatewaySmoke(t, "openclaw");

    assert.match(logs, /\[gateway\] ready/);
    assert.match(logs, /agent model: openai\/gpt-4\.1/);
    assertNoPackagingFailure(logs);
  },
);

test(
  "runtime image discovers the bundled Codex plugin from a fresh gateway home",
  imageTestOptions,
  async (t) => {
    const { logs, pluginList } = await runGatewaySmoke(t, "codex");

    assert.match(logs, /\[gateway\] ready/);
    assert.match(logs, /agent model: codex\/gpt-4\.1/);
    assertBundledCodexPluginLoaded(pluginList);
    assertNoPackagingFailure(logs);
  },
);
