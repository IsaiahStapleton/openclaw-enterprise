import assert from "node:assert/strict";
import test from "node:test";
import {
  NODE_SETUP_POLL_MS,
  observeNodeSetup,
} from "../../apps/controller/src/gateway/node-enrollment-client.ts";

const COMMANDS = [
  "file.fetch",
  "file.stat",
  "file.write",
  "file.create",
  "dir.list",
  "workspace.memory",
  "workspace.skills",
];

// A Gateway whose setup completes on the `pairedAt`-th status read and whose
// node reports connected from the `connectedAt`-th describe.
function gateway({ pairedAt = Infinity, connectedAt = 1, completion } = {}) {
  const calls = [];
  let statusReads = 0;
  let describes = 0;
  const request = async (method, params) => {
    calls.push(method);
    if (method === "device.pair.setupStatus") {
      statusReads++;
      if (statusReads < pairedAt) {
        return { setupId: params.setupId };
      }
      return {
        completion: completion ?? { setupId: params.setupId, access: "node", deviceId: "node-1" },
      };
    }
    if (method === "node.describe") {
      describes++;
      return { nodeId: params.nodeId, connected: describes >= connectedAt, commands: COMMANDS };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { request, calls };
}

test("a setup observation without a wait reads the Gateway once", async () => {
  const { request, calls } = gateway();
  assert.equal(await observeNodeSetup(request, "setup-1", AbortSignal.timeout(5_000)), undefined);
  assert.deepEqual(calls, ["device.pair.setupStatus"]);
});

test("a waiting setup observation returns as soon as the node pairs and connects", async () => {
  const { request, calls } = gateway({ pairedAt: 3, connectedAt: 2 });
  const started = Date.now();
  assert.deepEqual(await observeNodeSetup(request, "setup-1", AbortSignal.timeout(5_000), 5_000), {
    deviceId: "node-1",
    connected: true,
  });
  // Two unpaired reads, the pairing, one describe before the node connects, then one after.
  assert.deepEqual(calls, [
    "device.pair.setupStatus",
    "device.pair.setupStatus",
    "device.pair.setupStatus",
    "node.describe",
    "node.describe",
  ]);
  assert.ok(Date.now() - started < 5_000, "it does not wait out its budget");
});

test("a waiting setup observation returns the last reading when its time is up", async () => {
  const unpaired = gateway();
  const started = Date.now();
  assert.equal(
    await observeNodeSetup(unpaired.request, "setup-1", AbortSignal.timeout(5_000), 600),
    undefined,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 600 - NODE_SETUP_POLL_MS && elapsed < 600 + NODE_SETUP_POLL_MS * 4);
  // A node that paired but never connected is reported with its device, as before.
  const disconnected = gateway({ pairedAt: 1, connectedAt: Infinity });
  assert.deepEqual(
    await observeNodeSetup(disconnected.request, "setup-1", AbortSignal.timeout(5_000), 600),
    { deviceId: "node-1", connected: false },
  );
  // The completion is read once; only presence is re-read.
  assert.equal(
    disconnected.calls.filter((method) => method === "device.pair.setupStatus").length,
    1,
  );
});

test("waiting does not relax setup completion validation", async () => {
  const { request } = gateway({
    pairedAt: 2,
    completion: { setupId: "another-setup", access: "node", deviceId: "node-1" },
  });
  await assert.rejects(
    observeNodeSetup(request, "setup-1", AbortSignal.timeout(5_000), 5_000),
    /invalid node setup completion/,
  );
});

test("a waiting setup observation stops when its owner aborts", async () => {
  const { request } = gateway();
  const owner = new AbortController();
  setTimeout(() => owner.abort(new Error("claim lost")), 50);
  await assert.rejects(observeNodeSetup(request, "setup-1", owner.signal, 5_000), /claim lost/);
});
