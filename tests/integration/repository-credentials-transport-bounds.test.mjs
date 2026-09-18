import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createServer, request } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import {
  fixtureAppId,
  fixtureInstallationId,
  fixtureRepository,
  fixtureRepositoryId,
  startGitHubFixture,
} from "../fixtures/repository-credentials/github.mjs";
import { createTlsMaterial, listen } from "../fixtures/repository-credentials/process.mjs";
import {
  appModule,
  createServiceConfiguration,
  eventually,
} from "../fixtures/repository-credentials/service.mjs";

const discovery = `/${fixtureRepository}.git/info/refs?service=git-upload-pack`;
const push = `/${fixtureRepository}.git/git-receive-pack`;
const replyHeaders = { "content-type": "application/x-git-upload-pack-advertisement" };
const pushReplyHeaders = { "content-type": "application/x-git-receive-pack-result" };
const inputLimit = 4096;
const responseLimit = 4096;

// The peer controls only application bytes and when it reads or writes them.
// The listener, route policy, credential ownership and TLS sender are production code.
async function startTransport(t, onRequest, limits = {}) {
  const cleanups = [];
  const resources = { after: (cleanup) => cleanups.push(cleanup) };
  t.after(async () => {
    const failures = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "transport cleanup failed");
  });
  const [
    { createSystemClock },
    { createCredentialService },
    { startListeners },
    { createGitHubDriverFactory },
    { createGitHubKeyOwner },
  ] = await Promise.all([
    appModule("clock"),
    appModule("service"),
    appModule("server"),
    appModule("backends/github/index"),
    appModule("backends/github/material"),
  ]);
  const clock = createSystemClock();
  const tls = await createTlsMaterial(resources);
  // One exchange slot makes leaked reservations visible to the following request.
  const base = await createServiceConfiguration(resources, {
    exchanges: 1,
    exchangesPerSession: 1,
    exchangeMs: 10000,
    firstHeaderMs: 5000,
    ...limits,
  });
  const config = { ...base, gateway: { ...base.gateway, listen: "127.0.0.1:0" } };
  const github = await startGitHubFixture(resources, { clock, tls });
  const received = [];
  const upstream = createServer(tls, (incoming, outgoing) => {
    incoming.on("error", () => {});
    if (!github.authorize(incoming.headers.authorization)) {
      outgoing.writeHead(401).end();
      return;
    }
    received.push({ method: incoming.method, path: incoming.url });
    onRequest(incoming, outgoing);
  });
  const origin = await listen(resources, upstream);
  const key = createGitHubKeyOwner({ privateKey: github.privateKey, appId: fixtureAppId, clock });
  resources.after(() => key.close());
  const factory = createGitHubDriverFactory({
    configuration: {
      kind: "github-app",
      providerInstanceId: "github-fixture",
      configVersion: "1",
      appId: fixtureAppId,
      installationId: fixtureInstallationId,
      repositoryId: fixtureRepositoryId,
      repository: fixtureRepository,
      privateKeyFile: "/unused-fixture-key.pem",
    },
    key,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    clock,
    trustedEndpoints: { apiOrigin: github.origin, gitOrigin: origin, ca: tls.ca },
  });
  const service = createCredentialService({ config, factory, clock });
  let listeners;
  resources.after(async () => {
    listeners?.stopAdmission();
    try {
      const summary = await service.shutdown(1000);
      assert.equal(summary.graceExpired, false);
      assert.equal(summary.disposedSessions, summary.closedSessions);
      assert.equal(summary.pendingActions, 0);
      assert.equal(summary.pendingCredentials, 0);
      assert.equal(summary.pendingAuxiliary, 0);
    } finally {
      await listeners?.close();
    }
  });
  listeners = await startListeners({
    config,
    tls,
    service,
    factory,
    clock,
    trustedUpstreamOrigins: new Set([origin, github.origin]),
    upstreamCa: tls.ca,
  });
  const opened = service.open({ durationSeconds: 300, profile: "git-write" });
  return { config, tls, service, listeners, opened, github, received, resources };
}

function startRequest(
  fixture,
  { method = "GET", path = discovery, headers = {}, onResponse } = {},
) {
  let incoming;
  let bytes = 0;
  let timer;
  const hash = createHash("sha256");
  const { promise: result, resolve } = Promise.withResolvers();
  const finish = (kind) => {
    clearTimeout(timer);
    resolve({ kind, status: incoming?.statusCode, bytes, complete: incoming?.complete ?? false });
  };
  const outgoing = request(
    {
      hostname: "127.0.0.1",
      port: fixture.listeners.address.port,
      path,
      method,
      ca: fixture.tls.ca,
      agent: false,
      headers: {
        host: new URL(fixture.config.gateway.publicOrigin).host,
        authorization: `Basic ${Buffer.from(
          `${fixture.opened.client.gitUsername}:${fixture.opened.bearer}`,
        ).toString("base64")}`,
        ...headers,
      },
    },
    (response) => {
      incoming = response;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        hash.update(chunk);
      });
      response.once("end", () => finish("completed"));
      response.once("error", () => finish("closed"));
      response.once("close", () => {
        if (!response.complete) finish("closed");
      });
      onResponse?.(response);
    },
  );
  const closed = new Promise((resolveClose) => outgoing.once("close", resolveClose));
  outgoing.on("error", () => finish("closed"));
  timer = setTimeout(() => {
    finish("timeout");
    outgoing.destroy();
  }, 8000);
  fixture.resources.after(async () => {
    clearTimeout(timer);
    incoming?.destroy();
    outgoing.destroy();
    await closed;
  });
  return { outgoing, result, digest: () => hash.digest("hex") };
}

async function readDiscovery(fixture) {
  const client = startRequest(fixture);
  client.outgoing.end();
  return client.result;
}

const declaredInputCases = [
  {
    name: "a declared request exactly at the wire limit is accepted",
    bytes: inputLimit,
    expected: { status: 200, upstreamRequests: 1, issuedCredentials: 1, receivedBytes: inputLimit },
  },
  {
    name: "an oversized declared request is refused before acquisition or upstream dispatch",
    bytes: inputLimit + 1,
    expected: { status: 413, upstreamRequests: 0, issuedCredentials: 0, receivedBytes: 0 },
  },
];

for (const scenario of declaredInputCases) {
  test(scenario.name, { timeout: 15000 }, async (t) => {
    let receivedBytes = 0;
    const fixture = await startTransport(
      t,
      (incoming, outgoing) => {
        incoming.on("data", (chunk) => (receivedBytes += chunk.length));
        incoming.once("end", () => outgoing.writeHead(200, pushReplyHeaders).end("0000"));
      },
      { gitPushInputBytes: inputLimit },
    );
    const client = startRequest(fixture, {
      method: "POST",
      path: push,
      headers: {
        "content-type": "application/x-git-receive-pack-request",
        "content-length": scenario.bytes,
      },
    });
    client.outgoing.end(Buffer.alloc(scenario.bytes, 42));
    const result = await client.result;
    assert.equal(result.kind, "completed");
    assert.equal(result.complete, true);
    assert.equal(result.status, scenario.expected.status);
    assert.equal(fixture.received.length, scenario.expected.upstreamRequests);
    assert.equal(fixture.github.issuesOfTokens.length, scenario.expected.issuedCredentials);
    assert.equal(receivedBytes, scenario.expected.receivedBytes);
  });
}

test(
  "chunked gzip enforces the wire limit even when decoded input fits",
  { timeout: 15000 },
  async (t) => {
    let receivedBytes = 0;
    let incompleteRequestClosed = false;
    const fixture = await startTransport(
      t,
      (incoming, outgoing) => {
        incoming.on("data", (chunk) => (receivedBytes += chunk.length));
        incoming.once("close", () => {
          if (!incoming.complete) incompleteRequestClosed = true;
        });
        incoming.once("end", () =>
          outgoing
            .writeHead(200, incoming.method === "POST" ? pushReplyHeaders : replyHeaders)
            .end("0000"),
        );
      },
      { gitPushInputBytes: inputLimit },
    );
    // Stored deflate keeps decoded bytes within the limit while gzip overhead
    // exceeds the independent wire allowance. No Content-Length precheck can help.
    const encoded = gzipSync(Buffer.alloc(inputLimit, 42), { level: 0 });
    assert.ok(encoded.length > inputLimit);
    const client = startRequest(fixture, {
      method: "POST",
      path: push,
      headers: {
        "content-type": "application/x-git-receive-pack-request",
        "content-encoding": "gzip",
        "transfer-encoding": "chunked",
      },
    });
    client.outgoing.write(encoded.subarray(0, 1024));
    await eventually(() => receivedBytes > 0);
    client.outgoing.end(encoded.subarray(1024));
    assert.equal((await client.result).kind, "closed");
    await eventually(
      () =>
        incompleteRequestClosed &&
        fixture.service.status(fixture.opened.session.sessionId).activeUses === 0,
    );
    assert.ok(receivedBytes < inputLimit);
    assert.deepEqual(fixture.received, [{ method: "POST", path: push }]);
    assert.equal(fixture.github.issuesOfTokens.length, 1);
    assert.deepEqual(await readDiscovery(fixture), {
      kind: "completed",
      status: 200,
      bytes: 4,
      complete: true,
    });
    assert.equal(fixture.received.filter((entry) => entry.method === "POST").length, 1);
  },
);

const declaredResponseCases = [
  {
    name: "a response exactly at the limit is delivered completely",
    bytes: responseLimit,
    expected: { kind: "completed", status: 200, bytes: responseLimit, complete: true },
  },
  {
    name: "an oversized declared response is refused before client headers or bytes",
    bytes: responseLimit + 1,
    expected: { kind: "closed", status: undefined, bytes: 0, complete: false },
  },
];

for (const scenario of declaredResponseCases) {
  test(scenario.name, { timeout: 15000 }, async (t) => {
    const fixture = await startTransport(
      t,
      (incoming, outgoing) => {
        incoming.resume();
        outgoing.writeHead(200, { ...replyHeaders, "content-length": scenario.bytes });
        outgoing.end(Buffer.alloc(scenario.bytes, 42));
      },
      { gitResponseBytes: responseLimit },
    );
    assert.deepEqual(await readDiscovery(fixture), scenario.expected);
    await eventually(
      () => fixture.service.status(fixture.opened.session.sessionId).activeUses === 0,
    );
    assert.deepEqual(fixture.received, [{ method: "GET", path: discovery }]);
  });
}

test(
  "a chunked response overflow truncates the exchange without replay",
  { timeout: 15000 },
  async (t) => {
    let upstreamResponse;
    const fixture = await startTransport(
      t,
      (incoming, outgoing) => {
        incoming.resume();
        upstreamResponse = outgoing;
        outgoing.writeHead(200, replyHeaders);
        outgoing.write(Buffer.alloc(2048, 42));
      },
      { gitResponseBytes: responseLimit },
    );
    let delivered = 0;
    const client = startRequest(fixture, {
      onResponse: (incoming) => incoming.on("data", (chunk) => (delivered += chunk.length)),
    });
    client.outgoing.end();
    await eventually(() => delivered === 2048);
    // The client has a successful prefix, so an overflow must terminate that
    // exchange rather than append a service error or retry it as a new request.
    upstreamResponse.end(Buffer.alloc(2049, 42));
    assert.deepEqual(await client.result, {
      kind: "closed",
      status: 200,
      bytes: 2048,
      complete: false,
    });
    await eventually(
      () => fixture.service.status(fixture.opened.session.sessionId).activeUses === 0,
    );
    assert.deepEqual(fixture.received, [{ method: "GET", path: discovery }]);
  },
);

const streamBytes = 64 * 1024 * 1024;
const streamChunk = Buffer.alloc(64 * 1024, 42);
const producerAllowance = 16 * 1024 * 1024;

function writePayload(outgoing) {
  let producedBytes = 0;
  const write = () => {
    while (producedBytes < streamBytes) {
      producedBytes += streamChunk.length;
      if (!outgoing.write(streamChunk)) {
        outgoing.once("drain", write);
        return;
      }
    }
    outgoing.end();
  };
  outgoing.once("close", () => outgoing.off("drain", write));
  write();
  return () => producedBytes;
}

function payloadDigest() {
  const hash = createHash("sha256");
  for (let offset = 0; offset < streamBytes; offset += streamChunk.length) hash.update(streamChunk);
  return hash.digest("hex");
}

async function assertProducerBlocked(producedBytes) {
  // Allow TLS and socket buffers to fill, then observe the peer's progress.
  // This deliberately generous allowance is not a claim about Node buffer sizes.
  await delay(300);
  const before = producedBytes();
  assert.ok(
    before > 0 && before <= producerAllowance,
    `producer advanced ${before} bytes while consumer was paused`,
  );
  await delay(200);
  assert.equal(producedBytes(), before, "producer kept advancing while consumer was paused");
  return before;
}

test(
  "a paused upstream bounds upload producer progress and resumes without data loss",
  { timeout: 15000 },
  async (t) => {
    let upstreamRequest;
    let receivedBytes = 0;
    const hash = createHash("sha256");
    const fixture = await startTransport(t, (incoming, outgoing) => {
      upstreamRequest = incoming;
      incoming.pause();
      incoming.on("data", (chunk) => {
        receivedBytes += chunk.length;
        hash.update(chunk);
      });
      incoming.once("end", () => outgoing.writeHead(200, pushReplyHeaders).end("0000"));
    });
    const client = startRequest(fixture, {
      method: "POST",
      path: push,
      headers: {
        "content-type": "application/x-git-receive-pack-request",
        "content-length": streamBytes,
      },
    });
    const producedBytes = writePayload(client.outgoing);
    await eventually(() => upstreamRequest !== undefined);
    const pausedBytes = await assertProducerBlocked(producedBytes);
    t.diagnostic(
      `Upload producer stopped at ${pausedBytes} of ${streamBytes} bytes before upstream resumed.`,
    );
    assert.equal(receivedBytes, 0);
    upstreamRequest.resume();
    assert.deepEqual(await client.result, {
      kind: "completed",
      status: 200,
      bytes: 4,
      complete: true,
    });
    assert.equal(producedBytes(), streamBytes);
    assert.equal(receivedBytes, streamBytes);
    assert.equal(hash.digest("hex"), payloadDigest());
    assert.deepEqual(fixture.received, [{ method: "POST", path: push }]);
  },
);

test(
  "a paused client bounds response producer progress and resumes without data loss",
  { timeout: 15000 },
  async (t) => {
    let producedBytes;
    const fixture = await startTransport(t, (incoming, outgoing) => {
      incoming.resume();
      outgoing.writeHead(200, replyHeaders);
      producedBytes = writePayload(outgoing);
    });
    let incomingResponse;
    const client = startRequest(fixture, {
      onResponse(incoming) {
        incoming.pause();
        incomingResponse = incoming;
      },
    });
    client.outgoing.end();
    await eventually(() => incomingResponse !== undefined);
    const pausedBytes = await assertProducerBlocked(producedBytes);
    t.diagnostic(
      `Response producer stopped at ${pausedBytes} of ${streamBytes} bytes before client resumed.`,
    );
    incomingResponse.resume();
    assert.deepEqual(await client.result, {
      kind: "completed",
      status: 200,
      bytes: streamBytes,
      complete: true,
    });
    assert.equal(producedBytes(), streamBytes);
    assert.equal(client.digest(), payloadDigest());
    assert.deepEqual(fixture.received, [{ method: "GET", path: discovery }]);
  },
);

test(
  "control close interrupts a live response and releases its credential and exchange slot",
  { timeout: 15000 },
  async (t) => {
    let upstreamCancelled = false;
    let requests = 0;
    const fixture = await startTransport(t, (incoming, outgoing) => {
      incoming.resume();
      outgoing.writeHead(200, replyHeaders);
      if (++requests === 1) {
        outgoing.once("close", () => (upstreamCancelled = !outgoing.writableFinished));
        outgoing.write("0000");
      } else outgoing.end("0000");
    });
    let delivered = 0;
    const client = startRequest(fixture, {
      onResponse: (incoming) => incoming.on("data", (chunk) => (delivered += chunk.length)),
    });
    client.outgoing.end();
    await eventually(() => delivered === 4);
    const sessionId = fixture.opened.session.sessionId;
    assert.equal(fixture.service.status(sessionId).activeUses, 1);
    const { callControl } = await appModule("client/operator");
    const closed = await callControl(fixture.config.gateway.controlSocket, {
      method: "POST",
      path: `/v1/sessions/${sessionId}/close`,
    });
    assert.equal(closed.state, "CLOSED");
    // Closure must cancel active I/O before the independent five-second stall
    // timer could do so; eventual timeout is not proof of session cancellation.
    await eventually(
      () => upstreamCancelled && fixture.service.status(sessionId).state === "DISPOSED",
      { timeoutMs: 1000 },
    );
    assert.deepEqual(await client.result, {
      kind: "closed",
      status: 200,
      bytes: 4,
      complete: false,
    });
    const status = fixture.service.status(sessionId);
    assert.equal(status.activeUses, 0);
    assert.deepEqual(status.cleanup, {
      active: 0,
      pending: 0,
      revoked: 1,
      expired: 0,
      uncertain: 0,
      auxiliaryPending: false,
    });
    assert.equal(fixture.github.tokenState()[0].revoked, true);
    assert.equal((await readDiscovery(fixture)).status, 401);
    assert.equal(fixture.received.length, 1);
    assert.equal(fixture.github.issuesOfTokens.length, 1);
    // A new session uses the sole exchange slot after the cancelled I/O settles.
    fixture.opened = fixture.service.open({ durationSeconds: 300, profile: "git-write" });
    assert.deepEqual(await readDiscovery(fixture), {
      kind: "completed",
      status: 200,
      bytes: 4,
      complete: true,
    });
    assert.equal(fixture.received.length, 2);
  },
);
