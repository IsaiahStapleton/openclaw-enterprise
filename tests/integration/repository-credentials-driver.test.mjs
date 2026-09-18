import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { request } from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/index.ts";
import { GitHubRepositoryCredentialDriver } from "../../apps/controller/src/drivers/repository-credentials/github.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/providers/repository-credentials/control-client.ts";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.mjs";

async function unusedPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function driverFor(registry, socket, sessionDurationSeconds = 3600, publicCa) {
  return new GitHubRepositoryCredentialDriver(
    {
      id: registry.providerId,
      client: new UnixRepositoryCredentialControlClient({ controlSocket: socket }),
      drivers: { repository_credentials: "repository-credentials" },
    },
    registry,
    { sessionDurationSeconds, ...(publicCa === undefined ? {} : { publicCa }) },
  );
}

function gateway(fixture, opened, repository) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port: fixture.listeners.address.port,
        path: `/${repository}.git/info/refs?service=git-upload-pack`,
        method: "GET",
        ca: fixture.tls.ca,
        agent: false,
        headers: {
          host: "credentials.example.test",
          authorization: `Basic ${Buffer.from(`gateway-session:${opened.files.bearer}`).toString("base64")}`,
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.once("error", reject);
        incoming.once("end", () =>
          resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

test(
  "concrete Driver resolves locally and controls exact sessions for two repositories",
  { timeout: 30000 },
  async (t) => {
    const fixture = await startRegistryCredentialServiceFixture(t, {
      autoOpen: false,
      gateway: { listen: `127.0.0.1:${await unusedPort()}` },
    });
    const signal = new AbortController().signal;
    const local = driverFor(fixture.registry, "/nonexistent/repository-control.sock");
    const resolution = local.resolve({
      namespaceId: fixture.namespaceId,
      bindings: [
        { repositoryRef: "repo-a", profile: "git-read" },
        { repositoryRef: "repo-b", profile: "git-full" },
      ],
    });
    assert.equal(resolution.sessionDurationSeconds, 3600);
    assert.throws(
      () =>
        local.resolve({
          namespaceId: fixture.namespaceId,
          bindings: [{ repositoryRef: "repo-a" }, { repositoryRef: "repo-a" }],
        }),
      ScopeViolationError,
    );
    const driver = driverFor(
      fixture.registry,
      fixture.config.gateway.controlSocket,
      3600,
      fixture.tls.ca,
    );
    await new UnixRepositoryCredentialControlClient({
      controlSocket: fixture.config.gateway.controlSocket,
    }).health(signal);
    const inputs = resolution.bindings.map((binding) => ({
      namespaceId: fixture.namespaceId,
      admissionId: `${fixture.clock.wallNow()}-${randomUUID()}`,
      binding,
      durationSeconds: 3600,
      deadlineWallMs: fixture.clock.wallNow() + 1800_000,
    }));
    const opened = await Promise.all(inputs.map((input) => driver.open(input, signal)));
    for (let index = 0; index < opened.length; index++) {
      assert.equal(opened[index].kind, "created");
      const result = opened[index];
      assert.deepEqual(result.session.binding, inputs[index].binding.grant);
      assert.equal(result.session.deadlineWallMs, inputs[index].deadlineWallMs);
      assert.equal(result.result, undefined);
      assert.equal(result.bearer, undefined);
      assert.equal(result.files["ca.pem"], fixture.tls.ca.toString("utf8"));
      assert.deepEqual(
        Object.keys(result.files).sort(),
        ["bearer", "ca.pem", "client.json", "gh/config.yml", "gh/hosts.yml", "gitconfig"].sort(),
      );
      assert.equal(JSON.parse(result.files["client.json"]).sessionId, result.session.sessionId);
      const response = await gateway(fixture, result, fixture.repositories[index].repository);
      assert.equal(response.status, 200, response.body);
      assert.equal(
        (await gateway(fixture, result, fixture.repositories[1 - index].repository)).status,
        400,
      );
      const recovered = await driver.open({ ...inputs[index], recoverOnly: true }, signal);
      assert.equal(recovered.kind, "recovered");
      assert.equal(recovered.status.sessionId, result.session.sessionId);
      assert.equal(recovered.bearer, undefined);
    }
    // Each real provider observed only its exact numeric repository and profile.
    assert.equal(fixture.repositories[0].github.issuesOfTokens.length, 1);
    assert.deepEqual(fixture.repositories[0].github.issuesOfTokens[0].repositoryIds, [73]);
    assert.deepEqual(fixture.repositories[0].github.issuesOfTokens[0].permissions, {
      metadata: "read",
      contents: "read",
    });
    assert.equal(fixture.repositories[1].github.issuesOfTokens.length, 1);
    assert.deepEqual(fixture.repositories[1].github.issuesOfTokens[0].repositoryIds, [74]);
    assert.deepEqual(fixture.repositories[1].github.issuesOfTokens[0].permissions, {
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      issues: "write",
    });
    await assert.rejects(
      driver.open({ ...inputs[0], durationSeconds: 3599 }, signal),
      ScopeViolationError,
    );
    const fenced = { ...inputs[0], admissionId: `${fixture.clock.wallNow()}-${randomUUID()}` };
    assert.deepEqual(await driver.open({ ...fenced, recoverOnly: true }, signal), {
      kind: "missing",
    });
    assert.deepEqual(await driver.open(fenced, signal), { kind: "missing" });

    // A changed local Provider registry must not obstruct restrictive cleanup of the old admission.
    const changedProvider = driverFor(
      { ...fixture.registry, providerId: "replacement-provider" },
      fixture.config.gateway.controlSocket,
    );
    assert.equal(
      (await changedProvider.open({ ...inputs[0], recoverOnly: true }, signal)).kind,
      "recovered",
    );
    await assert.rejects(changedProvider.open(inputs[0], signal), ScopeViolationError);

    await fixture.restart();
    assert.equal(await driver.status(opened[0].session.sessionId, signal), undefined);
    assert.deepEqual(await driver.open({ ...inputs[0], recoverOnly: true }, signal), {
      kind: "missing",
    });
    await assert.rejects(
      local.status(opened[0].session.sessionId, signal),
      DependencyUnavailableError,
    );
  },
);

test("Unix control rejects malformed status and preserves authoritative absence versus outage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "repository-control-reply-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const socket = join(directory, "control.sock");
  const id = randomUUID();
  const valid = {
    sessionId: id,
    state: "CLOSED",
    deadlineWallMs: Date.now() + 1000,
    binding: { providerInstanceId: "instance", repositoryId: "repository", grantId: "grant" },
    activeUses: 0,
    cleanup: {
      active: 0,
      pending: 1,
      revoked: 0,
      expired: 0,
      uncertain: 0,
      auxiliaryPending: false,
    },
  };
  let reply = { status: 200, body: valid };
  // This independent wire peer supplies invalid protocol packets; it implements no session policy.
  const server = createServer((incoming, response) => {
    incoming.resume();
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new UnixRepositoryCredentialControlClient({ controlSocket: socket });
  const signal = new AbortController().signal;
  assert.equal((await client.close(id, signal)).cleanup.pending, 1);
  for (const body of [
    { ...valid, sessionId: randomUUID() },
    { ...valid, binding: { ...valid.binding, grantId: "x".repeat(513) } },
    { ...valid, activeUses: -1 },
    { ...valid, cleanup: { ...valid.cleanup, pending: "1" } },
    { ...valid, bearer: "unexpected" },
    { ...valid, state: "OPEN" },
    { ...valid, state: "DISPOSED" },
  ]) {
    reply = { status: 200, body };
    await assert.rejects(client.close(id, signal), (error) => error.retryable === true);
  }
  reply = { status: 404, body: { error: "not-found" } };
  assert.equal(await client.status(id, signal), undefined);
  for (const candidate of [
    { status: 503, body: { error: "unavailable" } },
    { status: 404, body: { error: "admission-missing" } },
    { status: 404, body: { message: "missing" } },
  ]) {
    reply = candidate;
    await assert.rejects(
      client.status(id, signal),
      (error) => error.retryable === true && !error.message.includes(socket),
    );
  }
});
