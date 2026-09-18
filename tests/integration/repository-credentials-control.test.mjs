import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createServer as createNetServer, connect } from "node:net";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import { createServer as createTlsServer, request as tlsRequest } from "node:https";
import { chmod, lstat, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAlternateDriverFactory,
  startAlternateUpstream,
} from "../fixtures/repository-credentials/alternate.mjs";
import {
  startGitHubFixture,
  fixtureAppId,
  fixtureInstallationId,
  fixtureRepository,
  fixtureRepositoryId,
} from "../fixtures/repository-credentials/github.mjs";
import {
  createTlsMaterial,
  listen,
  temporaryDirectory,
  run,
} from "../fixtures/repository-credentials/process.mjs";
import {
  credentialDriverModule,
  githubProviderModule,
  credentialClientPath,
  createServiceConfiguration,
  eventually,
} from "../fixtures/repository-credentials/service.mjs";

function control(socketPath, method, path, value, extra = {}) {
  const body = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        socketPath,
        method,
        path,
        headers: {
          host: "localhost",
          ...(path === "/v1/sessions" ? { "x-admission-id": `${Date.now()}-${randomUUID()}` } : {}),
          "content-type": "application/json",
          "content-length": body.length,
          ...extra,
        },
        agent: false,
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.once("error", reject);
        incoming.once("end", () =>
          resolve({
            status: incoming.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

// The relay consumes the real listener's response but disconnects its caller,
// reproducing ambiguous loss after admission without replacing control behavior.
async function dropControlResponse(t, target) {
  const directory = await temporaryDirectory(t, "rcs-loss-");
  const socketPath = join(directory, "relay.sock");
  const sockets = new Set();
  let admitted;
  const receipt = new Promise((resolve) => {
    admitted = resolve;
  });
  const relay = createNetServer((caller) => {
    const upstream = connect(target);
    for (const socket of [caller, upstream]) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
    }
    const chunks = [];
    upstream.on("data", (chunk) => {
      chunks.push(chunk);
      caller.destroy();
    });
    upstream.once("end", () => {
      const response = Buffer.concat(chunks).toString();
      admitted(JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4)));
    });
    caller.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => relay.close(resolve));
  });
  return { socketPath, receipt };
}

async function admissionFixture(t, onCreate) {
  const resources = createResourceScope();
  t.after(() => resources.close());
  const [{ createCredentialService }, { startListeners }, { callControl }] = await Promise.all([
    credentialDriverModule("service"),
    credentialDriverModule("server"),
    credentialDriverModule("client/operator"),
  ]);
  const clock = createControlledClock();
  const tls = await createTlsMaterial(resources);
  const base = await createServiceConfiguration(resources, { sessions: 1 });
  const config = { ...base, gateway: { ...base.gateway, listen: "127.0.0.1:0" } };
  const upstream = await startAlternateUpstream(resources, { clock, tls });
  const driverFactory = createAlternateDriverFactory({
    origin: upstream.origin,
    gatewayOrigin: config.gateway.publicOrigin,
    clock,
    accepted: upstream.accepted,
    lifetimeMs: 600_000,
  });
  const factory = onCreate
    ? {
        ...driverFactory,
        create(input) {
          const driver = driverFactory.create(input);
          onCreate(input.authority.sessionId);
          return driver;
        },
      }
    : driverFactory;
  const service = createCredentialService({ config, factory, clock });
  const listeners = await startListeners({
    config,
    tls,
    service,
    factory,
    clock,
    trustedUpstreamOrigins: new Set([upstream.origin]),
    upstreamCa: tls.ca,
  });
  resources.after(async () => {
    listeners.stopAdmission();
    await service.shutdown(1000);
    await listeners.close();
  });
  return {
    resources,
    clock,
    tls,
    config,
    upstream,
    driverFactory,
    service,
    listeners,
    callControl,
  };
}

test(
  "lost control admission response recovers one session and never replays provider writes",
  { timeout: 15000 },
  async (t) => {
    const fixture = await admissionFixture(t);
    const { clock, config, service, callControl, driverFactory, upstream } = fixture;
    const relay = await dropControlResponse(fixture.resources, config.gateway.controlSocket);
    const admissionId = `${clock.wallNow()}-${randomUUID()}`;
    const input = {
      method: "POST",
      path: "/v1/sessions",
      body: { durationSeconds: 3600, profile: "git-write" },
    };
    await assert.rejects(
      callControl(relay.socketPath, input, admissionId),
      /control-request-failed/,
    );
    const original = await relay.receipt;
    assert.equal(service.status(original.session.sessionId).state, "OPEN");
    const recover = () => callControl(config.gateway.controlSocket, input, admissionId);
    const [recovered, again] = await Promise.all([recover(), recover()]);
    assert.deepEqual(recovered, original.session);
    assert.deepEqual(again, original.session);
    assert.equal(recovered.bearer, undefined);
    assert.equal(driverFactory.drivers.length, 1);
    assert.deepEqual(
      await callControl(
        config.gateway.controlSocket,
        {
          ...input,
          body: { ...input.body, durationSeconds: 7200 },
        },
        admissionId,
      ),
      { error: "invalid-request" },
    );
    const freshId = () => `${clock.wallNow()}-${randomUUID()}`;
    assert.deepEqual(await callControl(config.gateway.controlSocket, input, freshId()), {
      error: "overloaded",
    });
    await callControl(config.gateway.controlSocket, {
      method: "POST",
      path: `/v1/sessions/${recovered.sessionId}/close`,
    });
    await clock.advance(0);
    await eventually(() => service.status(recovered.sessionId).state === "DISPOSED");
    assert.equal((await recover()).state, "DISPOSED");
    // Reconciliation does not reissue a bearer. The operator explicitly replaces
    // the closed session, and the service recovers its capacity immediately.
    const replacementId = freshId();
    const replacement = await callControl(config.gateway.controlSocket, input, replacementId);
    assert.notEqual(replacement.session.sessionId, recovered.sessionId);

    // The replacement performs one actual upstream mutation through the HTTPS owner.
    const status = await new Promise((resolve, reject) => {
      const outgoing = tlsRequest(
        {
          hostname: "127.0.0.1",
          port: fixture.listeners.address.port,
          path: "/team/nested/project",
          method: "POST",
          ca: fixture.tls.ca,
          agent: false,
          headers: {
            host: "credentials.example.test",
            authorization: `Bearer ${replacement.bearer}`,
            "content-type": "application/json",
            "content-length": "2",
          },
        },
        (incoming) => {
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode));
        },
      );
      outgoing.once("error", reject);
      outgoing.end("{}");
    });
    assert.equal(status, 200);
    assert.equal(upstream.trace.length, 1);
    assert.equal(upstream.trace[0].committed, true);
    assert.deepEqual(await recover(), { error: "not-found" });
    assert.equal(
      (await callControl(config.gateway.controlSocket, input, replacementId)).sessionId,
      replacement.session.sessionId,
    );
    assert.equal(upstream.trace.length, 1, "admission recovery must never replay a provider write");
    await callControl(config.gateway.controlSocket, {
      method: "POST",
      path: `/v1/sessions/${replacement.session.sessionId}/close`,
    });
    await clock.advance(0);
    await eventually(() => service.status(replacement.session.sessionId).state === "DISPOSED");
    assert.equal(upstream.accepted.size, 0);
    // The registry has one active allowance and one tombstone allowance per session.
    assert.deepEqual(await callControl(config.gateway.controlSocket, input, freshId()), {
      error: "overloaded",
    });
    await clock.advance(60_001);
    assert.deepEqual(await recover(), { error: "invalid-request" });
    const nextId = freshId();
    const next = await callControl(config.gateway.controlSocket, input, nextId);
    assert.equal(next.session.state, "OPEN");
    await clock.advance(3_600_001);
    assert.deepEqual(await callControl(config.gateway.controlSocket, input, nextId), {
      error: "invalid-request",
    });
    const afterExpiry = await callControl(config.gateway.controlSocket, input, freshId());
    assert.equal(afterExpiry.session.state, "OPEN");
    assert.equal(driverFactory.drivers.length, 4);
  },
);

test(
  "known control nondelivery closes the actual admitted session",
  { timeout: 10000 },
  async (t) => {
    const requests = channel("http.server.request.start");
    let socket;
    let sessionId;
    const observe = (event) => {
      if (event.request.url === "/v1/sessions") socket = event.socket;
    };
    requests.subscribe(observe);
    t.after(() => requests.unsubscribe(observe));
    const fixture = await admissionFixture(t, (id) => {
      sessionId = id;
      // Destroy the actual protected-listener socket during real driver construction,
      // before the handler can hand any admission response bytes to the transport.
      socket.destroy();
    });
    const input = {
      method: "POST",
      path: "/v1/sessions",
      body: { durationSeconds: 3600, profile: "git-write" },
    };
    const admissionId = `${fixture.clock.wallNow()}-${randomUUID()}`;
    await assert.rejects(
      fixture.callControl(fixture.config.gateway.controlSocket, input, admissionId),
      /control-request-failed/,
    );
    await fixture.clock.advance(0);
    await eventually(() => fixture.service.status(sessionId).state === "DISPOSED");
    const recovered = await fixture.callControl(
      fixture.config.gateway.controlSocket,
      input,
      admissionId,
    );
    assert.equal(recovered.state, "DISPOSED");
    assert.equal(recovered.sessionId, sessionId);
    assert.equal(recovered.bearer, undefined);
    assert.equal(fixture.driverFactory.drivers.length, 1);
    assert.equal(fixture.upstream.trace.length, 0);
  },
);

test(
  "private control socket opens, inspects and closes real sessions with bounded input",
  { timeout: 10000 },
  async (t) => {
    const [{ createSystemClock }, { createCredentialService }, { startListeners }] =
      await Promise.all([
        credentialDriverModule("clock"),
        credentialDriverModule("service"),
        credentialDriverModule("server"),
      ]);
    const clock = createSystemClock();
    const tls = await createTlsMaterial(t);
    const base = await createServiceConfiguration(t);
    const config = { ...base, gateway: { ...base.gateway, listen: "127.0.0.1:0" } };
    const github = await startGitHubFixture(t, { clock, tls });
    const [{ createGitHubDriverFactory }, { createGitHubKeyOwner }] = await Promise.all([
      githubProviderModule("index"),
      githubProviderModule("material"),
    ]);
    const key = createGitHubKeyOwner({ privateKey: github.privateKey, appId: fixtureAppId, clock });
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
      trustedEndpoints: { apiOrigin: github.origin, gitOrigin: github.origin, ca: tls.ca },
    });
    const service = createCredentialService({ config, factory, clock });
    const listeners = await startListeners({
      config,
      tls,
      service,
      factory,
      clock,
      trustedUpstreamOrigins: new Set([github.origin]),
      upstreamCa: tls.ca,
    });
    t.after(async () => {
      listeners.stopAdmission();
      await service.shutdown(1000);
      await listeners.close();
      key.close();
    });
    assert.equal((await lstat(config.gateway.controlSocket)).mode & 0o777, 0o600);
    const opened = await control(config.gateway.controlSocket, "POST", "/v1/sessions", {
      durationSeconds: 86400,
    });
    assert.equal(opened.status, 201);
    assert.equal(opened.body.session.state, "OPEN");
    assert.equal(opened.body.session.binding.grantId, "1:git-write");
    assert.ok(opened.body.bearer.length >= 43);
    const id = opened.body.session.sessionId;
    const status = await control(config.gateway.controlSocket, "GET", `/v1/sessions/${id}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.sessionId, id);
    assert.equal(status.body.bearer, undefined);
    const closed = await control(config.gateway.controlSocket, "POST", `/v1/sessions/${id}/close`);
    assert.equal(closed.status, 200);
    assert.notEqual(closed.body.state, "OPEN");
    assert.equal(closed.body.bearer, undefined);
    for (const profile of ["read-write", "app-full"])
      assert.equal(
        (
          await control(config.gateway.controlSocket, "POST", "/v1/sessions", {
            durationSeconds: 86400,
            profile,
          })
        ).status,
        400,
      );
    assert.equal(
      (await control(config.gateway.controlSocket, "POST", "/v1/sessions", { durationSeconds: 0 }))
        .status,
      400,
    );
    assert.equal(
      (
        await control(config.gateway.controlSocket, "POST", "/v1/sessions", {
          durationSeconds: 86400,
          provider: "caller-selected",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await control(config.gateway.controlSocket, "POST", "/v1/sessions", {
          padding: "x".repeat(17000),
        })
      ).status,
      413,
    );
    const agentStatus = await new Promise((resolve, reject) => {
      const outgoing = tlsRequest(
        {
          hostname: "127.0.0.1",
          port: listeners.address.port,
          path: "/v1/sessions",
          ca: tls.ca,
          headers: { host: "credentials.example.test" },
          agent: false,
        },
        (incoming) => {
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode));
        },
      );
      outgoing.once("error", reject);
      outgoing.end();
    });
    assert.equal(agentStatus, 401);
    const clientParent = await temporaryDirectory(t);
    const clientDirectory = join(clientParent, "session");
    const operator = credentialClientPath("operator");
    const relay = await dropControlResponse(t, config.gateway.controlSocket);
    const admissionId = `${Date.now()}-${randomUUID()}`;
    const failed = await run(
      process.execPath,
      [
        operator,
        "open",
        "--socket",
        relay.socketPath,
        "--duration-seconds",
        "86400",
        "--profile",
        "git-write",
        "--output",
        clientDirectory,
        "--admission-id",
        admissionId,
      ],
      { allowFailure: true },
    );
    assert.equal(failed.code, 1);
    assert.ok(failed.stderr.includes(admissionId));
    const admitted = await relay.receipt;
    const cliRecovered = await run(process.execPath, [
      operator,
      "open",
      "--socket",
      config.gateway.controlSocket,
      "--duration-seconds",
      "86400",
      "--profile",
      "git-write",
      "--output",
      clientDirectory,
      "--admission-id",
      admissionId,
    ]);
    const recovered = JSON.parse(cliRecovered.stdout);
    assert.equal(recovered.sessionId, admitted.session.sessionId);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.bearer, undefined);
    await run(process.execPath, [
      operator,
      "close",
      "--socket",
      config.gateway.controlSocket,
      "--session",
      recovered.sessionId,
    ]);
    const cliOpened = await run(process.execPath, [
      operator,
      "open",
      "--socket",
      config.gateway.controlSocket,
      "--duration-seconds",
      "86400",
      "--profile",
      "git-write",
      "--output",
      clientDirectory,
      "--ca",
      tls.certFile,
    ]);
    const cliSession = JSON.parse(cliOpened.stdout);
    const clientBearer = (await readFile(join(clientDirectory, "bearer"), "utf8")).trim();
    assert.equal(cliSession.state, "OPEN");
    assert.notEqual(cliSession.sessionId, admitted.session.sessionId);
    assert.notEqual(clientBearer, admitted.bearer);
    assert.ok(!cliOpened.stdout.includes(clientBearer) && !cliOpened.stderr.includes(clientBearer));
    const cliClosed = await run(process.execPath, [
      operator,
      "close",
      "--socket",
      config.gateway.controlSocket,
      "--session",
      cliSession.sessionId,
    ]);
    assert.notEqual(JSON.parse(cliClosed.stdout).state, "OPEN");
    assert.ok(!cliClosed.stdout.includes(clientBearer));
  },
);

test(
  "control startup rejects unsafe parents and refuses existing paths",
  { timeout: 10000 },
  async (t) => {
    const [{ createSystemClock }, { createCredentialService }, { startListeners }] =
      await Promise.all([
        credentialDriverModule("clock"),
        credentialDriverModule("service"),
        credentialDriverModule("server"),
      ]);
    const clock = createSystemClock();
    const tls = await createTlsMaterial(t);
    const base = await createServiceConfiguration(t);
    const directory = await temporaryDirectory(t);
    const target = join(directory, "control.sock");
    const config = {
      ...base,
      gateway: { ...base.gateway, listen: "127.0.0.1:0", controlSocket: target },
    };
    const factory = createAlternateDriverFactory({
      origin: "https://upstream.example.test",
      gatewayOrigin: config.gateway.publicOrigin,
      clock,
    });
    const service = createCredentialService({ config, factory, clock });
    const options = { config, tls, service, factory, clock, trustedUpstreamOrigins: new Set() };
    await chmod(directory, 0o755);
    await assert.rejects(startListeners(options), /unsafe-control-directory/);
    await chmod(directory, 0o700);
    await symlink("/does-not-exist", target);
    await assert.rejects(startListeners(options), /control-socket-exists/);
    assert.ok((await lstat(target)).isSymbolicLink());
    await service.shutdown(1000);
  },
);

test(
  "close after asynchronous authentication prevents actual upstream dispatch",
  { timeout: 10000 },
  async (t) => {
    const [
      { createSystemClock },
      { createCredentialService },
      { startListeners },
      { startAlternateUpstream },
    ] = await Promise.all([
      credentialDriverModule("clock"),
      credentialDriverModule("service"),
      credentialDriverModule("server"),
      import("../fixtures/repository-credentials/alternate.mjs"),
    ]);
    const clock = createSystemClock();
    const tls = await createTlsMaterial(t);
    const upstream = await startAlternateUpstream(t, { tls });
    const base = await createServiceConfiguration(t);
    const config = { ...base, gateway: { ...base.gateway, listen: "127.0.0.1:0" } };
    let resume;
    const barrier = new Promise((resolve) => {
      resume = resolve;
    });
    const factory = createAlternateDriverFactory({
      origin: upstream.origin,
      gatewayOrigin: config.gateway.publicOrigin,
      clock,
      accepted: upstream.accepted,
      controls: { beforeSend: () => barrier },
    });
    const service = createCredentialService({ config, factory, clock });
    const listeners = await startListeners({
      config,
      tls,
      service,
      factory,
      clock,
      trustedUpstreamOrigins: new Set([upstream.origin]),
      upstreamCa: tls.ca,
    });
    t.after(async () => {
      resume();
      listeners.stopAdmission();
      await service.shutdown(1000);
      await listeners.close();
    });
    const opened = service.open({ durationSeconds: 86400, profile: "git-write" });
    const result = new Promise((resolve) => {
      const outgoing = tlsRequest(
        {
          hostname: "127.0.0.1",
          port: listeners.address.port,
          path: "/team/nested/project",
          ca: tls.ca,
          headers: { host: "credentials.example.test", authorization: `Bearer ${opened.bearer}` },
          agent: false,
        },
        (incoming) => {
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode));
        },
      );
      outgoing.once("error", () => resolve("closed"));
      outgoing.end();
    });
    const deadline = Date.now() + 2000;
    while (
      !factory.events.some((event) => event.kind === "authentication") &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(factory.events.some((event) => event.kind === "authentication"));
    service.close(opened.session.sessionId);
    resume();
    assert.ok([503, "closed"].includes(await result));
    await service.shutdown(1000);
    assert.equal(upstream.trace.length, 0);
  },
);

test(
  "Agent response completion and premature close preserve lifecycle outcomes",
  { timeout: 10000 },
  async (t) => {
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
      if (failures.length) throw new AggregateError(failures, "listener fixture cleanup failed");
    });
    const [
      { createSystemClock },
      { createCredentialService },
      { startListeners },
      { createGitHubDriverFactory },
      { createGitHubKeyOwner },
    ] = await Promise.all([
      credentialDriverModule("clock"),
      credentialDriverModule("service"),
      credentialDriverModule("server"),
      githubProviderModule("index"),
      githubProviderModule("material"),
    ]);
    const clock = createSystemClock();
    const tls = await createTlsMaterial(resources);
    // A single exchange slot makes leaked ownership observable on the next request.
    const base = await createServiceConfiguration(resources, {
      exchanges: 1,
      exchangesPerSession: 1,
    });
    const config = { ...base, gateway: { ...base.gateway, listen: "127.0.0.1:0" } };
    const github = await startGitHubFixture(resources, { clock, tls });
    const received = [];
    let upstreamCancelled = false;
    const upstream = createTlsServer(tls, async (request, response) => {
      if (!github.authorize(request.headers.authorization)) {
        response.writeHead(401).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received.push({ method: request.method, body: Buffer.concat(chunks).toString() });
      if (request.method === "POST") {
        response.once("close", () => {
          upstreamCancelled = !response.writableFinished;
        });
        // Leave a write response unfinished so only cancellation closes upstream I/O.
        response.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
        response.write("0008NAK\n");
      } else {
        response.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
        response.end("0000");
      }
    });
    const origin = await listen(resources, upstream);
    const key = createGitHubKeyOwner({ privateKey: github.privateKey, appId: fixtureAppId, clock });
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
    const actual = createCredentialService({ config, factory, clock });
    const outcomes = [];
    // Observe the actual owner's outcome without replacing execution or settlement.
    const service = {
      ...actual,
      async execute(...args) {
        const outcome = await actual.execute(...args);
        outcomes.push(outcome);
        return outcome;
      },
    };
    const listeners = await startListeners({
      config,
      tls,
      service,
      factory,
      clock,
      trustedUpstreamOrigins: new Set([origin, github.origin]),
      upstreamCa: tls.ca,
    });
    resources.after(async () => {
      listeners.stopAdmission();
      try {
        const summary = await actual.shutdown(1000);
        assert.equal(summary.graceExpired, false);
        assert.equal(summary.pendingActions, 0);
        assert.equal(summary.pendingCredentials, 0);
        assert.equal(summary.pendingAuxiliary, 0);
        assert.equal(summary.disposedSessions, summary.closedSessions);
      } finally {
        await listeners.close();
        key.close();
      }
    });
    const opened = actual.open({ durationSeconds: 86400, profile: "git-write" });
    const authorization = `Basic ${Buffer.from(`gateway-session:${opened.bearer}`).toString("base64")}`;
    const send = (disconnect = false) =>
      new Promise((resolve, reject) => {
        const outgoing = tlsRequest(
          {
            hostname: "127.0.0.1",
            port: listeners.address.port,
            path: `/${fixtureRepository}.git/${disconnect ? "git-receive-pack" : "info/refs?service=git-upload-pack"}`,
            method: disconnect ? "POST" : "GET",
            ca: tls.ca,
            headers: {
              host: "credentials.example.test",
              authorization,
              ...(disconnect
                ? { "content-type": "application/x-git-receive-pack-request", "content-length": 4 }
                : {}),
            },
            agent: false,
          },
          (incoming) => {
            const chunks = [];
            incoming.on("data", (chunk) => {
              chunks.push(chunk);
              if (disconnect) incoming.destroy();
            });
            incoming.once("error", reject);
            incoming.once(disconnect ? "close" : "end", () =>
              resolve({
                status: incoming.statusCode,
                body: Buffer.concat(chunks).toString(),
                complete: incoming.complete,
              }),
            );
          },
        );
        outgoing.once("error", reject);
        outgoing.end(disconnect ? "0000" : undefined);
      });
    const settled = async (index) => {
      await eventually(
        () => outcomes.length > index && actual.status(opened.session.sessionId).activeUses === 0,
      );
      return outcomes[index];
    };

    await t.test("full HTTP 200 records completion and releases the exchange slot", async () => {
      for (let request = 0; request < 2; request++) {
        const index = outcomes.length;
        assert.deepEqual(await send(), { status: 200, body: "0000", complete: true });
        assert.deepEqual(await settled(index), { kind: "completed", status: 200 });
      }
    });
    await t.test("early client disconnect cancels a dispatched write without replay", async () => {
      const index = outcomes.length;
      const before = received.length;
      assert.deepEqual(await send(true), { status: 200, body: "0008NAK\n", complete: false });
      assert.equal((await settled(index)).kind, "possibly-dispatched");
      await eventually(() => upstreamCancelled);
      assert.equal(received.length, before + 1);
      assert.deepEqual(received.at(-1), { method: "POST", body: "0000" });
      const next = outcomes.length;
      assert.deepEqual(await send(), { status: 200, body: "0000", complete: true });
      assert.deepEqual(await settled(next), { kind: "completed", status: 200 });
      assert.equal(received.filter((entry) => entry.method === "POST").length, 1);
    });
  },
);
