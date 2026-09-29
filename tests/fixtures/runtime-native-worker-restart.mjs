import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

// Runs inside a runtime image Gateway container. It drives the same
// `connect --target-file --ephemeral` contract as the dedicated native worker.
const execute = promisify(execFile);
const cli = "/app/openclaw.mjs";
const displayName = "runtime-native-worker-proof";

async function prepareState(state) {
  await mkdir(state, { recursive: true, mode: 0o700 });
  const config = `${state}/openclaw.json`;
  await writeFile(
    config,
    JSON.stringify({
      agents: { defaults: { workspace: "/home/node/workspace" } },
      plugins: {
        allow: ["file-transfer"],
        slots: { memory: "none" },
        entries: { "file-transfer": { enabled: true } },
      },
      nodeHost: {
        workerRuns: { enabled: true, capacity: 1, isolation: "none" },
        skills: { enabled: false },
      },
    }),
    { mode: 0o600 },
  );
  return {
    PATH: process.env.PATH,
    HOME: "/home/node",
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_NO_AUTO_UPDATE: "1",
  };
}

async function call(method, params = {}) {
  const { stdout } = await execute(
    process.execPath,
    [
      cli,
      "gateway",
      "call",
      method,
      "--url",
      "ws://127.0.0.1:8080",
      "--password",
      process.env.OPENCLAW_GATEWAY_PASSWORD,
      "--params",
      JSON.stringify(params),
      "--json",
    ],
    { timeout: 30_000, maxBuffer: 1_000_000 },
  );
  return JSON.parse(stdout);
}

// Simulate a Pod restart after the controller-minted setup code aged out.
function expireSetupCode(setupCode) {
  const payload = JSON.parse(Buffer.from(setupCode, "base64url").toString("utf8"));
  assert.equal(typeof payload.expiresAtMs, "number", "minted setup codes must carry an expiry");
  return Buffer.from(
    JSON.stringify({ ...payload, expiresAtMs: Date.now() - 60_000 }),
    "utf8",
  ).toString("base64url");
}

let child;
let childLog = "";
async function start(state, setupCode) {
  const environment = await prepareState(state);
  const targetFile = `${state}/connect-target`;
  await writeFile(targetFile, setupCode, { mode: 0o600 });
  childLog = "";
  child = spawn(
    process.execPath,
    [cli, "connect", "--target-file", targetFile, "--ephemeral", "--display-name", displayName],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (data) => {
    childLog += data;
  });
  child.stderr.on("data", (data) => {
    childLog += data;
  });
  return targetFile;
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const killTimer = globalThis.setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(killTimer);
}
async function waitForNode(expectedId) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`Native worker exited: ${childLog}`);
    }
    const result = await call("node.list");
    const node = result.nodes.find((item) => item.connected && item.displayName === displayName);
    if (node) {
      if (expectedId) {
        assert.equal(node.nodeId, expectedId);
      }
      return node.nodeId;
    }
    await setTimeout(500);
  }
  throw new Error(`Native worker did not connect: ${childLog}`);
}
async function waitForDisconnect(nodeId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await call("node.list");
    if (!result.nodes.some((item) => item.nodeId === nodeId && item.connected)) {
      return;
    }
    await setTimeout(500);
  }
  throw new Error("Stopped native worker remained connected.");
}
async function waitForExit() {
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      once(child, "exit"),
      setTimeout(60_000).then(() => {
        throw new Error(`Native worker kept running with an expired code: ${childLog}`);
      }),
    ]);
  }
  return child.exitCode;
}

try {
  const setup = await call("device.pair.setupCode", {
    publicUrl: "ws://127.0.0.1:8080",
    bootstrapProfile: "node",
    includeQr: false,
  });
  const expiredSetupCode = expireSetupCode(setup.setupCode);
  const state = "/home/node/native-worker-node";

  // First enrollment redeems the fresh code and consumes the private target file.
  const targetFile = await start(state, setup.setupCode);
  const nodeId = await waitForNode();
  await assert.rejects(access(targetFile), { code: "ENOENT" });
  const completed = await call("device.pair.setupStatus", { setupId: setup.setupId });
  assert.equal(completed.completion?.deviceId, nodeId);
  await stop();
  await waitForDisconnect(nodeId);

  // A restart replays the same, now expired, code. The saved device token must
  // reconnect the same identity without another bootstrap completion.
  await start(state, expiredSetupCode);
  await waitForNode(nodeId);
  const reconnected = await call("device.pair.setupStatus", { setupId: setup.setupId });
  assert.deepEqual(reconnected.completion, completed.completion);
  assert.equal(childLog.includes("Pairing setup code has expired."), false);
  await stop();
  await waitForDisconnect(nodeId);

  // Without saved node credentials, the expired code is still refused.
  await start("/home/node/native-worker-unpaired", expiredSetupCode);
  const exitCode = await waitForExit();
  assert.notEqual(exitCode, 0);
  assert.match(childLog, /Pairing setup code has expired\./);

  console.log(
    JSON.stringify({
      sameIdentityAfterExpiredReplay: true,
      singleBootstrapCompletion: true,
      unpairedExpiredRejected: true,
    }),
  );
} finally {
  await stop();
}
