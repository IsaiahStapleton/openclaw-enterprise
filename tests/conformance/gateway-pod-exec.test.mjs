import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildGatewayAdministrationHelperScript,
  gatewayAdministrationHelperInput,
  gatewayAdministrationSecretStringData,
  parseGatewayAdministrationCredential,
} from "../../apps/controller/src/drivers/compute/kubernetes/gateway-administration.ts";
import { KubernetesClientNodePodExecutor } from "../../apps/controller/src/drivers/compute/kubernetes/pod-exec.ts";

const pinnedIdentity = {
  deviceId: "device-1",
  privateKeyPem: "private-key",
  publicKeyPem: "public-key",
};
const pinnedPublicKey = "raw-public-key";

test("gateway administration helper polls for the exact pending device and approves once", async () => {
  const result = await runGatewayHelper({
    listResponses: [
      { pending: [], paired: [] },
      {
        pending: [
          {
            requestId: "other-request",
            deviceId: "other-device",
            publicKey: "other-public-key",
            role: "operator",
            scopes: ["operator.admin"],
          },
          pinnedPendingRequest("request-1"),
        ],
        paired: [],
      },
    ],
    approveResponse: {
      requestId: "request-1",
      device: { deviceId: pinnedIdentity.deviceId, publicKey: pinnedPublicKey },
    },
  });

  assert.deepEqual(
    result.calls.map((call) => call.slice(0, 3)),
    [
      ["devices", "list", "--json"],
      ["devices", "list", "--json"],
      ["devices", "approve", "request-1"],
    ],
  );
  assert.deepEqual(result.approvals, ["request-1"]);
});

test("gateway administration helper accepts an already paired exact device with the required grant", async () => {
  const result = await runGatewayHelper({
    listResponses: [
      {
        pending: [pinnedPendingRequest("request-that-must-not-be-approved")],
        paired: [
          {
            deviceId: pinnedIdentity.deviceId,
            publicKey: pinnedPublicKey,
            tokens: [{ role: "operator", scopes: ["operator.admin"] }],
          },
        ],
      },
    ],
  });

  assert.deepEqual(
    result.calls.map((call) => call.slice(0, 3)),
    [["devices", "list", "--json"]],
  );
  assert.deepEqual(result.approvals, []);
});

test("gateway administration helper rejects ambiguous exact pending requests without approval", async () => {
  const result = await runGatewayHelper(
    {
      listResponses: [
        {
          pending: [pinnedPendingRequest("request-1"), pinnedPendingRequest("request-2")],
          paired: [],
        },
      ],
    },
    { expectFailure: true },
  );

  assert.deepEqual(result.approvals, []);
  assert.equal(result.calls.filter((call) => call[1] === "approve").length, 0);
});

test("gateway administration credential parser rejects non-exact operator token scopes", () => {
  const credential = {
    state: "established",
    identity: pinnedIdentity,
    deviceToken: {
      token: "durable-device-token",
      scopes: ["operator.admin", "operator.read"],
    },
  };
  const stringData = gatewayAdministrationSecretStringData(credential);
  const secret = {
    data: Object.fromEntries(
      Object.entries(stringData).map(([key, value]) => [
        key,
        Buffer.from(value, "utf8").toString("base64"),
      ]),
    ),
  };

  assert.throws(
    () => parseGatewayAdministrationCredential(secret),
    /Gateway administration device token scopes must be exactly operator\.admin/,
  );
});

test("Kubernetes pod exec rejects a pre-aborted signal before creating a client", async () => {
  let createdClient = false;
  const executor = new KubernetesClientNodePodExecutor(
    { mode: "inCluster" },
    (message) => new Error(message),
    {
      async createClientConfiguration() {
        createdClient = true;
        return { sdk: {}, kubeConfig: {} };
      },
    },
  );
  const abort = new AbortController();
  abort.abort(new Error("raw caller reason"));

  await assert.rejects(
    executor.exec(baseExecInput({ signal: abort.signal })),
    /Kubernetes Pod exec aborted\./,
  );
  assert.equal(createdClient, false);
});

test("Kubernetes pod exec bounds output and terminates the websocket", async () => {
  const socket = new FakeSocket();
  const executor = createPodExecutor({
    exec(_namespace, _podName, _containerName, _command, stdout) {
      queueMicrotask(() => stdout.write("x".repeat(65_537)));
      return Promise.resolve(socket);
    },
  });

  await assert.rejects(
    executor.exec(baseExecInput()),
    /Kubernetes Pod exec output exceeded limit\./,
  );
  assert.equal(socket.terminations, 1);
});

test("Kubernetes pod exec terminates the websocket exactly once across late lifecycle races", async () => {
  const cases = [
    {
      name: "abort before websocket opens",
      async run() {
        const socket = new FakeSocket();
        let resolveExec;
        const executor = createPodExecutor({
          exec() {
            return new Promise((resolve) => {
              resolveExec = () => resolve(socket);
            });
          },
        });
        const abort = new AbortController();
        const result = executor.exec(baseExecInput({ signal: abort.signal }));
        abort.abort(new Error("raw caller reason"));

        await assert.rejects(result, /Kubernetes Pod exec aborted\./);
        resolveExec();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(socket.terminations, 1, "abort before open should terminate exactly once");
      },
    },
    {
      name: "completion before late abort",
      async run() {
        const socket = new FakeSocket();
        const executor = createPodExecutor({
          exec(
            _namespace,
            _podName,
            _containerName,
            _command,
            stdout,
            stderr,
            _stdin,
            _tty,
            status,
          ) {
            stdout.write("ok");
            stderr.write("warn");
            status({ status: "Success" });
            return Promise.resolve(socket);
          },
        });
        const abort = new AbortController();

        const result = await executor.exec(baseExecInput({ signal: abort.signal }));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(result, { stdout: "ok", stderr: "warn" });
        assert.equal(socket.terminations, 1, "successful completion should terminate exactly once");

        abort.abort(new Error("late abort"));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(socket.terminations, 1, "late abort should not terminate again");
      },
    },
  ];

  for (const lifecycleCase of cases) {
    await lifecycleCase.run();
  }
});

function pinnedPendingRequest(requestId) {
  return {
    requestId,
    deviceId: pinnedIdentity.deviceId,
    publicKey: pinnedPublicKey,
    role: "operator",
    scopes: ["operator.admin"],
  };
}

async function runGatewayHelper(state, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "occ-gateway-helper-"));
  const statePath = join(directory, "state.json");
  const callsPath = join(directory, "openclaw");
  await writeFile(
    statePath,
    JSON.stringify({ approvals: [], calls: [], listResponses: [], ...state }),
    "utf8",
  );
  await writeFile(callsPath, fakeOpenClawExecutable(), "utf8");
  await chmod(callsPath, 0o755);
  const input = JSON.parse(
    gatewayAdministrationHelperInput({
      url: "ws://127.0.0.1:8080",
      gatewayToken: "bootstrap-token",
      identity: pinnedIdentity,
      publicKey: pinnedPublicKey,
      timeoutMs: 5_000,
    }),
  );
  input.pollIntervalMs = 10;

  try {
    const run = () =>
      execFileSync(process.execPath, ["-e", buildGatewayAdministrationHelperScript()], {
        encoding: "utf8",
        env: {
          ...process.env,
          OCC_TEST_STATE_PATH: statePath,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
        },
        input: JSON.stringify(input),
        stdio: ["pipe", "pipe", "pipe"],
      });
    if (options.expectFailure === true) {
      assert.throws(run);
    } else {
      run();
    }
    return JSON.parse(await readFile(statePath, "utf8"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function fakeOpenClawExecutable() {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = process.env.OCC_TEST_STATE_PATH;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
if (args[0] === "devices" && args[1] === "list") {
  const listCalls = state.calls.filter((call) => call[0] === "devices" && call[1] === "list").length;
  const responses = Array.isArray(state.listResponses) ? state.listResponses : [];
  const response = responses[Math.min(listCalls - 1, Math.max(0, responses.length - 1))] || {};
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write(JSON.stringify(response));
} else if (args[0] === "devices" && args[1] === "approve") {
  state.approvals.push(args[2]);
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write(JSON.stringify(state.approveResponse || { requestId: args[2], device: {} }));
} else {
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.error("unexpected openclaw args: " + JSON.stringify(args));
  process.exit(2);
}
`;
}

function createPodExecutor({ exec }) {
  return new KubernetesClientNodePodExecutor(
    { mode: "inCluster" },
    (message) => new Error(message),
    {
      async createClientConfiguration() {
        return { sdk: {}, kubeConfig: {} };
      },
      createExec() {
        return { exec };
      },
    },
  );
}

function baseExecInput(overrides = {}) {
  return {
    namespace: "tenant",
    podName: "gateway-0",
    containerName: "gateway",
    command: ["node", "-e", "process.exit(0)"],
    stdin: "fixed-stdin",
    timeoutMs: 1_000,
    ...overrides,
  };
}

class FakeSocket extends EventEmitter {
  terminations = 0;

  close() {
    this.emit("close");
  }

  terminate() {
    this.terminations += 1;
    this.emit("close");
  }
}
