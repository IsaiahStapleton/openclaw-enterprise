import "../fixtures/repository-credentials/regressions.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:https";
import { sign } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { appModule } from "../fixtures/repository-credentials/runtime.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import {
  createAlternateDriverFactory,
  startAlternateUpstream,
} from "../fixtures/repository-credentials/alternate.mjs";
import { startGitHubFixture } from "../fixtures/repository-credentials/github.mjs";
import {
  createServiceConfiguration,
  eventually,
  gatewayRequest,
} from "../fixtures/repository-credentials/service.mjs";
import { runInFixtureContainer } from "../fixtures/repository-credentials/container.mjs";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import { run, temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";
import { removeRemoteBranches } from "../fixtures/repository-credentials/workflows.mjs";

test("controlled Git fixture runs real smart HTTP and records an accepted push before disconnect", async (t) => {
  const upstream = await startGitSmartHttpFixture(t);
  const directory = await temporaryDirectory(t);
  const checkout = join(directory, "checkout");
  const git = (args, options = {}) =>
    run("git", ["-c", `http.sslCAInfo=${upstream.tls.certFile}`, ...args], options);
  await git(["clone", `${upstream.origin}/fixture/repository.git`, checkout]);
  await git(["config", "user.name", "Fixture"], { cwd: checkout });
  await git(["config", "user.email", "fixture@example.test"], { cwd: checkout });
  await writeFile(join(checkout, "write.txt"), "Real Git fixture change\n");
  await git(["add", "write.txt"], { cwd: checkout });
  await git(["commit", "-m", "Fixture mutation"], { cwd: checkout });
  const head = (await git(["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
  upstream.disconnectAfterNextAcceptedPush();
  const pushed = await git(["push", "origin", "HEAD:refs/heads/accepted"], {
    cwd: checkout,
    allowFailure: true,
  });
  assert.notEqual(pushed.code, 0);
  assert.equal(await upstream.ref("refs/heads/accepted"), head);
  assert.equal(
    upstream.trace.filter((entry) => entry.path.endsWith("/git-receive-pack")).length,
    1,
  );
  // Cleanup must find an accepted write even when its response was lost, and
  // must tolerate a companion branch that the interrupted operation never made.
  await removeRemoteBranches({ git }, checkout, ["accepted", "never-created"]);
  assert.equal(
    (await git(["ls-remote", "--heads", "origin", "refs/heads/accepted"], { cwd: checkout }))
      .stdout,
    "",
  );
});

test("controlled provider fixture verifies RSA signatures and refuses gateway credentials", async (t) => {
  const fixture = await startGitHubFixture(t);
  const now = Math.floor(fixture.clock.wallNow() / 1000);
  const unsigned = [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ iss: "12345", iat: now - 60, exp: now + 540 })).toString(
      "base64url",
    ),
  ].join(".");
  const jwt = `${unsigned}.${sign("sha256", Buffer.from(unsigned), fixture.privateKey).toString("base64url")}`;
  const body = JSON.stringify({
    repository_ids: [73],
    permissions: { metadata: "read", contents: "write" },
  });
  const response = await new Promise((resolve, reject) => {
    const outgoing = request(
      `${fixture.origin}/app/installations/41/access_tokens`,
      {
        method: "POST",
        ca: fixture.tls.ca,
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (incoming) => {
        incoming.resume();
        incoming.once("end", () => resolve(incoming.statusCode));
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
  assert.equal(response, 201);
  assert.equal(fixture.authorize("Bearer gateway-session-is-not-a-provider-token"), false);
  assert.equal(fixture.issuesOfTokens.length, 1);
  assert.deepEqual(fixture.errors, []);
});

test("second backend retains renewal through expiry and finalizes through the real common owner", async (t) => {
  const clock = createControlledClock();
  const config = await createServiceConfiguration(t);
  const factory = createAlternateDriverFactory({
    origin: "https://forge.example.test",
    gatewayOrigin: config.gateway.publicOrigin,
    clock,
  });
  const { createCredentialService } = await appModule("service");
  const service = createCredentialService({ config, factory, clock });
  t.after(() => service.shutdown(1000));
  const opened = service.open({ durationSeconds: 86400, profile: "git-write" });
  const head = () => ({
    method: "GET",
    rawTarget: "/team/nested/project",
    headers: {},
    receivedMonoMs: clock.monotonicNow(),
    contentEncoding: "identity",
    framing: { kind: "none", bytes: undefined },
  });
  const perform = async (sender) => {
    const exchange = service.reserve(opened.bearer, head(), new AbortController().signal);
    assert.notEqual(exchange.kind, "denied");
    return service.execute(
      exchange,
      sender ??
        (async (_privateRequest, { gate }) =>
          gate.dispatch(
            () => {},
            () => ({ kind: "completed", status: 200 }),
          )),
    );
  };
  assert.equal((await perform()).kind, "completed");
  assert.equal(opened.session.binding.repositoryId, "repo:team/nested/project");
  const firstIdentity = opened.session.binding;
  await clock.advance(13 * 3600000 + 1000);
  assert.equal((await perform()).kind, "completed");
  assert.deepEqual(service.status(opened.session.sessionId).binding, firstIdentity);
  assert.equal(factory.events.filter((event) => event.kind === "rotate").length, 2);
  for (let iteration = 0; iteration < 4; iteration++) {
    await clock.advance(100000);
    assert.equal((await perform()).kind, "completed");
  }
  // Reclaimed access slots must leave independent renewal authority available
  // for session finalization after all short-lived access tokens have expired.
  await clock.advance(100000);
  service.close(opened.session.sessionId);
  await eventually(() => service.status(opened.session.sessionId)?.state === "DISPOSED");
  assert.equal(factory.events.filter((event) => event.kind === "finalize").length, 1);
  assert.equal(service.reserve(opened.bearer, head(), new AbortController().signal).kind, "denied");
  await assert.rejects(
    factory.drivers[0].settle(Object.freeze({ kind: "finalized", attemptId: "foreign" })),
    /foreign/,
  );
  await assert.rejects(
    factory.drivers[0].withAuthentication(Object.freeze({}), Object.freeze({}), async () => {}),
    /foreign/,
  );
});

test("second backend uses the production HTTPS sender and distinct native authentication", async (t) => {
  if (
    await runInFixtureContainer(
      t,
      "tests/conformance/repository-credentials-backend-conformance.test.mjs",
    )
  )
    return;
  const clock = createControlledClock();
  const config = await createServiceConfiguration(t);
  const upstream = await startAlternateUpstream(t, { clock });
  const factory = createAlternateDriverFactory({
    origin: upstream.origin,
    gatewayOrigin: config.gateway.publicOrigin,
    clock,
    accepted: upstream.accepted,
  });
  const [{ createCredentialService }, { startListeners }] = await Promise.all([
    appModule("service"),
    appModule("server"),
  ]);
  const service = createCredentialService({ config, factory, clock });
  const listeners = await startListeners({
    config,
    tls: upstream.tls,
    service,
    factory,
    clock,
    trustedUpstreamOrigins: new Set([upstream.origin]),
    upstreamCa: upstream.tls.ca,
  });
  t.after(async () => {
    listeners.stopAdmission();
    await service.shutdown(1000);
    await listeners.close();
  });
  const opened = service.open({ durationSeconds: 86400, profile: "git-write" });
  const fixture = { config, opened, tls: upstream.tls };
  assert.equal((await gatewayRequest(fixture, "/team/nested/project")).status, 200);
  await clock.advance(13 * 3600000 + 1);
  assert.equal((await gatewayRequest(fixture, "/team/nested/project")).status, 200);
  assert.equal(upstream.trace.length, 2);
  assert.equal(upstream.trace[1].path, "/v2/projects/team%2Fnested%2Fproject");
});

test("drain-before rotation waits for active uses and preserves the replacement", async (t) => {
  const clock = createControlledClock();
  const config = await createServiceConfiguration(t, { credentialMarginMs: 100 });
  const factory = createAlternateDriverFactory({
    origin: "https://forge.example.test",
    gatewayOrigin: config.gateway.publicOrigin,
    clock,
    lifetimeMs: 90000,
    operationMs: 60000,
  });
  const { createCredentialService } = await appModule("service");
  const service = createCredentialService({ config, factory, clock });
  t.after(() => service.shutdown(1000));
  const opened = service.open({ durationSeconds: 86400, profile: "git-write" });
  const reserve = () =>
    service.reserve(
      opened.bearer,
      {
        method: "GET",
        rawTarget: "/team/nested/project",
        headers: {},
        receivedMonoMs: clock.monotonicNow(),
        contentEncoding: "identity",
        framing: { kind: "none", bytes: undefined },
      },
      new AbortController().signal,
    );
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let dispatched = false;
  const first = service.execute(reserve(), async (_request, { gate }) => {
    gate.dispatch(release, () => {
      dispatched = true;
    });
    gate.track(held);
    await held;
    return { kind: "completed", status: 200 };
  });
  await eventually(() => dispatched);
  await clock.advance(40000);
  const second = service.execute(reserve(), async (_request, { gate }) =>
    gate.dispatch(
      () => {},
      () => ({ kind: "completed", status: 200 }),
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    factory.events.filter((event) => event.kind === "rotate").length,
    1,
    "active first use prevents invalidating rotation",
  );
  release();
  assert.equal((await first).kind, "completed");
  assert.equal((await second).kind, "completed");
  const third = await service.execute(reserve(), async (_request, { gate }) =>
    gate.dispatch(
      () => {},
      () => ({ kind: "completed", status: 200 }),
    ),
  );
  assert.equal(third.kind, "completed");
  assert.equal(
    factory.events.filter((event) => event.kind === "rotate").length,
    2,
    "predecessor retirement leaves accepted replacement usable",
  );
});
