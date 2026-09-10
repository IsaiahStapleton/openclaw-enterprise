import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const serviceKey = "sk-test-secret-value";
const matchingInstallationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
const mismatchedInstallationId = "ins_9ce0e58a-415d-485e-90c2-20c3c5572505";
const defaultRuntimeImage = "openclaw-enterprise-runtime:quickstart";

async function writeExecutable(path, body) {
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function createFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-dev-up-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeExecutable(
    join(bin, "docker"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const log = process.env.DEV_UP_DOCKER_LOG;
if (log) {
  fs.appendFileSync(log, JSON.stringify({
    args,
    env: {
      OCC_DOCKER_RUNTIME_IMAGE: process.env.OCC_DOCKER_RUNTIME_IMAGE || "",
      OCC_DOCKER_GATEWAY_IMAGE: process.env.OCC_DOCKER_GATEWAY_IMAGE || "",
      OCC_DOCKER_AGENT_IMAGE: process.env.OCC_DOCKER_AGENT_IMAGE || "",
    },
  }) + "\\n");
}
const scenario = process.env.DEV_UP_FAKE_SCENARIO || "success";
const defaultRuntime = ${JSON.stringify(defaultRuntimeImage)};
const installationId = ${JSON.stringify(matchingInstallationId)};
const key = ${JSON.stringify(serviceKey)};
function exit(code, message = "") {
  if (message) process.stderr.write(message + "\\n");
  process.exit(code);
}
function composeCommandIndex() {
  return args.findIndex((arg, index) => index > 0 && ["config", "up", "ps", "cp", "exec"].includes(arg));
}
function delegateComposeConfig() {
  const realDocker = process.env.DEV_UP_REAL_DOCKER;
  if (!realDocker) exit(99, "DEV_UP_REAL_DOCKER is required");
  const delegated = spawnSync(realDocker, ["compose", ...args.slice(1)], {
    cwd: process.env.DEV_UP_REPOSITORY,
    env: {
      ...process.env,
      PATH: process.env.DEV_UP_REAL_PATH || process.env.PATH,
      OPENAI_API_KEY: "",
      OCC_DOCKER_RUNTIME_IMAGE: process.env.OCC_DOCKER_RUNTIME_IMAGE || "",
      OCC_DOCKER_GATEWAY_IMAGE: process.env.OCC_DOCKER_GATEWAY_IMAGE || "",
      OCC_DOCKER_AGENT_IMAGE: process.env.OCC_DOCKER_AGENT_IMAGE || "",
    },
    encoding: "utf8",
  });
  if (delegated.stdout) process.stdout.write(delegated.stdout);
  if (delegated.stderr) process.stderr.write(delegated.stderr);
  process.exit(delegated.status ?? 1);
}
if (args[0] === "image" && args[1] === "inspect") {
  exit(args[2] === defaultRuntime ? 1 : 0);
}
if (args[0] === "build") exit(0);
if (args[0] !== "compose") exit(99, "unexpected docker command: " + args.join(" "));
if (args[1] === "version") exit(0);
const commandIndex = composeCommandIndex();
if (commandIndex === -1) exit(99, "missing compose command");
const command = args[commandIndex];
if (command === "config") delegateComposeConfig();
if (command === "up") exit(0);
if (command === "ps") {
  const serviceNames = ["migrate", "bootstrap", "driver-lifecycle", "controller", "worker"];
  const requested = serviceNames.includes(args[args.length - 1])
    ? [args[args.length - 1]]
    : serviceNames;
  const entries = requested.map((service) => {
    let serviceState = "running";
    let exitCode = 0;
    let health = "";
    if (service === "migrate" || service === "bootstrap" || service === "driver-lifecycle") {
      serviceState = "exited";
    }
    if (service === "bootstrap" && scenario === "bootstrap-failed") exitCode = 1;
    if (service === "driver-lifecycle" && scenario === "driver-lifecycle-failed") {
      exitCode = 1;
    }
    if (service === "controller") health = "healthy";
    if (service === "worker" && scenario === "worker-exited") {
      serviceState = "exited";
      exitCode = 1;
    }
    return { Service: service, State: serviceState, ExitCode: exitCode, Health: health };
  });
  process.stdout.write(entries.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n");
  exit(0);
}
if (command === "cp") {
  const destination = args[args.length - 1];
  fs.writeFileSync(destination, JSON.stringify({
    data: { id: "key_3033697e-6397-4cc6-9b04-8ec17af78cf1", key },
    meta: { installationId },
  }));
  exit(0);
}
if (command === "exec") {
  exit(
    scenario === "worker-timeout" ? 42 : 0,
    scenario === "worker-timeout" ? "worker marker missing" : "",
  );
}
exit(99, "unhandled docker compose command: " + command);
`,
  );
  await writeExecutable(
    join(bin, "curl"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.DEV_UP_CURL_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ args }) + "\\n");
const scenario = process.env.DEV_UP_FAKE_SCENARIO || "success";
const outputIndex = args.indexOf("--output");
const output = outputIndex === -1 ? undefined : args[outputIndex + 1];
let payload;
let status = "200";
let exitCode = 0;
if (scenario === "api-unauthorized") {
  status = "401";
  exitCode = 22;
  payload = { error: { code: "UNAUTHENTICATED", message: "A valid service API key is required." }, meta: { requestId: "req_1" } };
} else {
  payload = {
    data: { id: scenario === "api-mismatch" ? ${JSON.stringify(mismatchedInstallationId)} : ${JSON.stringify(matchingInstallationId)} },
    meta: { requestId: "req_1" },
  };
}
if (output) fs.writeFileSync(output, JSON.stringify(payload));
process.stdout.write(status);
process.exit(exitCode);
`,
  );

  const emptyEnv = join(directory, "empty.env");
  await writeFile(
    emptyEnv,
    [
      "OPENAI_API_KEY=",
      "OCC_DOCKER_RUNTIME_IMAGE=",
      "OCC_DOCKER_GATEWAY_IMAGE=",
      "OCC_DOCKER_AGENT_IMAGE=",
      "",
    ].join("\n"),
  );
  const dockerLog = join(directory, "docker.log");
  const curlLog = join(directory, "curl.log");
  const realDocker = spawnSync("bash", ["-lc", "command -v docker"], {
    encoding: "utf8",
    env: process.env,
  }).stdout.trim();
  assert.ok(realDocker, "docker must be available so the fixture can use real Compose config");
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    OPENAI_API_KEY: "",
    OCC_DOCKER_RUNTIME_IMAGE: "",
    OCC_DOCKER_GATEWAY_IMAGE: "",
    OCC_DOCKER_AGENT_IMAGE: "",
    DEV_UP_DOCKER_LOG: dockerLog,
    DEV_UP_CURL_LOG: curlLog,
    DEV_UP_FAKE_SCENARIO: options.scenario ?? "success",
    DEV_UP_REAL_DOCKER: realDocker,
    DEV_UP_REAL_PATH: process.env.PATH ?? "",
    DEV_UP_REPOSITORY: repository,
  };

  return {
    directory,
    emptyEnv,
    dockerLog,
    curlLog,
    env,
  };
}

async function writeOverride(fixture, name, lines) {
  const path = join(fixture.directory, name);
  await writeFile(path, [...lines, ""].join("\n"));
  return path;
}

async function customRuntimeOverride(fixture) {
  return writeOverride(fixture, "compose.custom-runtime.yaml", [
    "services:",
    "  worker:",
    "    environment:",
    "      OCC_DOCKER_RUNTIME_IMAGE: custom-runtime:local",
    '      OCC_DOCKER_GATEWAY_IMAGE: ""',
    '      OCC_DOCKER_AGENT_IMAGE: ""',
  ]);
}

async function perImageOverride(fixture) {
  return writeOverride(fixture, "compose.per-image.yaml", [
    "services:",
    "  worker:",
    "    environment:",
    "      OCC_DOCKER_RUNTIME_IMAGE: shared-runtime:local",
    "      OCC_DOCKER_GATEWAY_IMAGE: custom-gateway:local",
    '      OCC_DOCKER_AGENT_IMAGE: ""',
  ]);
}

async function publicControllerOverride(fixture) {
  return writeOverride(fixture, "compose.public-controller.yaml", [
    "services:",
    "  controller:",
    "    ports:",
    '      - "0.0.0.0:3999:3000"',
  ]);
}

function composeOptions(fixture, overridePath) {
  const options = [
    "--env-file",
    fixture.emptyEnv,
    "-f",
    "compose.yaml",
    "--project-name",
    "oce-dev-up-test",
  ];
  if (overridePath) {
    options.splice(4, 0, "-f", overridePath);
  }
  return options;
}

function runDevUp(args, env) {
  return spawnSync("bash", ["scripts/dev-up", ...args], {
    cwd: repository,
    encoding: "utf8",
    env,
  });
}

async function readJsonLines(path) {
  try {
    const content = await readFile(path, "utf8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function composeInvocations(logs) {
  return logs.filter((entry) => entry.args[0] === "compose" && entry.args[1] !== "version");
}

export {
  composeInvocations,
  composeOptions,
  createFixture,
  customRuntimeOverride,
  defaultRuntimeImage,
  matchingInstallationId,
  mismatchedInstallationId,
  perImageOverride,
  publicControllerOverride,
  readJsonLines,
  runDevUp,
  serviceKey,
};
