import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import {
  buildGatewayAdministrationHelperScript,
  gatewayAdministrationHelperInput,
  parseGatewayAdministrationCredential,
} from "../../apps/controller/src/drivers/compute/kubernetes/gateway-administration.ts";
import { KubernetesClientNodePodExecutor } from "../../apps/controller/src/drivers/compute/kubernetes/pod-exec.ts";
import {
  createOpenClawGatewayNativeDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../apps/controller/src/gateway/native-client.ts";

const requireController = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const requireGateway = createRequire(requireController.resolve("@openclaw/gateway-client"));
const { WebSocket, WebSocketServer } = requireGateway("ws");

/** Real native/Kubernetes boundaries with faults injected only after genuine effects. */
export async function runGatewayAdministrationFailureProofs(topology, callbacks) {
  const decoded = await callbacks.readGatewayAdministrationCredentialSecret(topology);
  const credential = parseGatewayAdministrationCredential({
    data: Object.fromEntries(
      Object.entries(decoded).map(([key, value]) => [key, Buffer.from(value).toString("base64")]),
    ),
  });
  assert.equal(credential.state, "established");
  await proveLostResponse(topology, callbacks);
  await proveLostPersistenceAcknowledgment(topology, callbacks, credential);
  await proveExecBoundaries(topology, callbacks, credential);
}

async function proveLostResponse(topology, callbacks) {
  const driver = topology.apiComputeDriver;
  const original = driver.withGatewayPodProxy;
  const hadOwn = Object.hasOwn(driver, "withGatewayPodProxy");
  const content = "OCC lost native response " + randomUUID() + "\n";
  const stats = { requests: 0, dropped: 0 };
  // Preserve production ownership resolution, authentication, and Pod proxy.
  // The relay withholds only the actual native success response for this write.
  driver.withGatewayPodProxy = function (target, signal, operation) {
    return original.call(this, target, signal, async (url) => {
      const relay = await lostResponseRelay(url, content, stats, signal);
      try {
        return await operation(relay.url);
      } finally {
        await relay.close();
      }
    });
  };
  try {
    const result = await callbacks.dispatchOccGatewayCommand(topology, "agents.files.set", {
      agentId: "main",
      name: "USER.md",
      content,
    });
    assert.equal(result.status, 503);
    assert.equal(result.error?.code, "UNKNOWN_OUTCOME");
  } finally {
    if (hadOwn) driver.withGatewayPodProxy = original;
    else delete driver.withGatewayPodProxy;
  }
  assert.equal(stats.requests, 1, "a sent mutation must not be replayed");
  assert.equal(stats.dropped, 1, "the relay must drop one genuine native success");
  const read = callbacks.assertOccGatewaySuccess(
    await callbacks.dispatchOccGatewayCommand(topology, "agents.files.get", {
      agentId: "main",
      name: "USER.md",
    }),
    "agents.files.get",
  );
  assert.equal(read.file.content, content, "native execution survives its lost response");
  callbacks.diagnostic(
    "PASS real native lost response: UNKNOWN_OUTCOME, one dispatch, persisted file",
  );
}

async function lostResponseRelay(url, content, stats, signal) {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const sockets = new Set();
  const targets = new Set();
  let closing;
  const close = () => {
    if (closing) return closing;
    signal.removeEventListener("abort", close);
    for (const socket of sockets) socket.terminate();
    closing = new Promise((resolve) => wss.close(() => server.close(() => resolve())));
    return closing;
  };
  wss.on("connection", (downstream) => {
    const upstream = new WebSocket(url);
    const queued = [];
    for (const socket of [upstream, downstream]) {
      sockets.add(socket);
      socket.on("error", () => socket.terminate());
      socket.once("close", () => {
        sockets.delete(socket);
        (socket === upstream ? downstream : upstream).terminate();
      });
    }
    upstream.once("open", () => {
      for (const [data, binary] of queued) upstream.send(data, { binary });
    });
    downstream.on("message", (data, binary) => {
      const frame = parseFrame(data, binary);
      if (
        frame?.type === "req" &&
        frame.method === "agents.files.set" &&
        frame.params?.name === "USER.md" &&
        frame.params?.content === content
      ) {
        stats.requests += 1;
        targets.add(frame.id);
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      else if (upstream.readyState === WebSocket.CONNECTING) queued.push([data, binary]);
    });
    upstream.on("message", (data, binary) => {
      const frame = parseFrame(data, binary);
      if (frame?.type === "res" && frame.ok === true && targets.has(frame.id)) {
        targets.delete(frame.id);
        stats.dropped += 1;
        downstream.terminate();
        upstream.terminate();
      } else if (downstream.readyState === WebSocket.OPEN) {
        downstream.send(data, { binary });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) {
    await close();
    signal.throwIfAborted();
  }
  return { url: "ws://127.0.0.1:" + server.address().port, close };
}

function parseFrame(data, binary) {
  if (binary) return undefined;
  try {
    return JSON.parse(data.toString());
  } catch {
    return undefined;
  }
}

async function proveLostPersistenceAcknowledgment(topology, callbacks, credential) {
  const driver = topology.workerComputeDriver;
  const clients = await driver.clients();
  const original = clients.core.replaceNamespacedSecret;
  let writes = 0;
  // Kubernetes really commits the token. Only the SDK acknowledgement is
  // replaced with an error; production persistence must read back the result.
  clients.core.replaceNamespacedSecret = async function (request) {
    writes += 1;
    await original.call(this, request);
    throw new Error("Injected post-commit Kubernetes SDK acknowledgement loss.");
  };
  try {
    const recovered = await driver.storeGatewayAdministrationToken(
      { controllerNamespace: topology.platformNamespace },
      { namespaceId: topology.agent.namespaceId, agentId: topology.agent.id },
      credential.identity,
      credential.deviceToken,
    );
    assert.equal(recovered.state, "established");
    assert.equal(recovered.identity.deviceId, credential.identity.deviceId);
    assert.equal(
      recovered.deviceToken.token === credential.deviceToken.token,
      true,
      "readback must recover the exact persisted token without printing it",
    );
  } finally {
    clients.core.replaceNamespacedSecret = original;
  }
  assert.equal(writes, 1, "an uncertain mutating Kubernetes request must not be replayed");
  callbacks.assertOccGatewaySuccess(
    await callbacks.dispatchOccGatewayCommand(topology, "status"),
    "status",
  );
  callbacks.diagnostic(
    "PASS real Kubernetes token write/readback with injected post-commit SDK error",
  );
}

async function proveExecBoundaries(topology, callbacks, credential) {
  const before = await callbacks.readGatewayAdministrationCredentialSecret(topology);
  const port = topology.gatewayPod.spec.containers
    .find((item) => item.name === "gateway")
    .ports.find((item) => item.name === "http").containerPort;
  const input = (identity, timeoutMs) =>
    gatewayAdministrationHelperInput({
      url: "ws://127.0.0.1:" + port,
      gatewayToken: topology.gatewayToken,
      identity: { deviceId: identity.deviceId },
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      timeoutMs,
    });
  const execute = (authentication, stdin) =>
    new KubernetesClientNodePodExecutor(authentication, (message) => new Error(message)).exec({
      namespace: topology.placement,
      podName: topology.gatewayPod.metadata.name,
      containerName: "gateway",
      command: ["node", "-e", buildGatewayAdministrationHelperScript()],
      stdin,
      timeoutMs: 8_000,
    });
  // The API's otherwise working identity has no pods/exec. The worker control
  // proves the fixed helper and native CLI work in this exact Pod before timeout.
  await assert.rejects(execute(topology.apiAuthentication, input(credential.identity, 5_000)), {
    message: "Kubernetes Pod exec failed to start.",
  });
  await execute(topology.workerAuthentication, input(credential.identity, 5_000));
  const absent = createOpenClawGatewayNativeDeviceIdentity();
  const started = Date.now();
  await assert.rejects(execute(topology.workerAuthentication, input(absent, 2_000)), {
    message: "Kubernetes Pod exec failed.",
  });
  assert.ok(Date.now() - started < 8_000, "the helper must exit before the outer exec deadline");
  const after = await callbacks.readGatewayAdministrationCredentialSecret(topology);
  assert.equal(
    JSON.stringify(after) === JSON.stringify(before),
    true,
    "exec denial and helper timeout must not change credentials",
  );
  const devices = await callbacks.gatewayCall(topology, "device.pair.list", {});
  assert.equal(
    devices.pending.some((device) => device.deviceId === absent.deviceId),
    false,
  );
  assert.equal(
    devices.paired.some((device) => device.deviceId === absent.deviceId),
    false,
  );
  assert.equal(
    devices.paired.some((device) => device.deviceId === credential.identity.deviceId),
    true,
  );
  callbacks.diagnostic(
    "PASS real denied exec and helper-local deadline without pairing or credential changes",
  );
}
