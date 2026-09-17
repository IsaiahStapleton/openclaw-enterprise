import test from "node:test";
import assert from "node:assert/strict";
import {
  createGitHubDriverFactory,
  createGitHubKeyOwner,
} from "../../apps/repository-credentials/src/backends/github/index.ts";
import { validateServiceConfig } from "../../apps/repository-credentials/src/config.ts";
import { startGitHubFixture } from "../fixtures/repository-credentials/github.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
const config = validateServiceConfig({
  gateway: {
    publicOrigin: "https://credentials.example",
    listen: "127.0.0.1:443",
    controlSocket: "/run/credentials/control.sock",
  },
  sessionPolicy: {
    maximumDurationSeconds: 86400,
    defaultProfile: "git-write",
    allowedProfiles: ["git-write", "read-write"],
  },
});
function owner(factory, clock, profile, id, captured = () => {}) {
  const authority = { sessionId: id, ...factory.resolve(profile).binding },
    attempts = new WeakSet(),
    records = new Map();
  let sequence = 0;
  const custody = {
    assertAttempt(attempt, action) {
      assert.ok(attempts.has(attempt));
      assert.equal(attempt.action, action);
    },
    capture(attempt, bytes, observation) {
      assert.ok(attempts.has(attempt));
      const ref = Object.freeze({});
      records.set(ref, { bytes: Buffer.from(bytes), observation });
      captured();
      return ref;
    },
    async withAccess(ref, purpose, consume) {
      assert.ok(records.has(ref));
      return consume(records.get(ref).bytes);
    },
  };
  const driver = factory.create({ authority, custody, clock });
  return {
    driver,
    records,
    authority,
    attempt(action, signal = new AbortController().signal) {
      const attempt = Object.freeze({
        id: `${id}-${++sequence}`,
        authority,
        action,
        deadlineMonoMs: clock.monotonicNow() + 30000,
        signal,
        assertAdmitted() {
          assert.ok(clock.monotonicNow() < this.deadlineMonoMs);
        },
        observeDispatch() {},
      });
      attempts.add(attempt);
      return attempt;
    },
  };
}
test("real HTTPS issuance preserves exact profiles after hour 13 and revokes with owned token after key closure", async (t) => {
  const clock = createControlledClock(),
    fixture = await startGitHubFixture(t, { clock });
  const key = createGitHubKeyOwner({ privateKey: fixture.privateKey, appId: "12345", clock });
  const factory = createGitHubDriverFactory({
    configuration: {
      kind: "github-app",
      providerInstanceId: "fixture-instance",
      configVersion: "v1",
      appId: "12345",
      installationId: "41",
      repositoryId: "73",
      repository: "fixture/repository",
      privateKeyFile: "/protected/app.pem",
    },
    key,
    clock,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    trustedEndpoints: { apiOrigin: fixture.origin, gitOrigin: fixture.origin, ca: fixture.tls.ca },
  });
  const first = owner(factory, clock, "git-write", "one"),
    second = owner(factory, clock, "read-write", "two");
  const originalAttempt = first.attempt("acquire");
  await assert.rejects(first.driver.acquire({ ...originalAttempt }, undefined, 360000));
  const a = await first.driver.acquire(originalAttempt, undefined, 360000);
  assert.equal(a.kind, "acquired");
  await assert.rejects(first.driver.settle({ ...a }), /foreign-outcome/);
  await first.driver.settle(a);
  const finished = await first.driver.finalize(first.attempt("finalize"));
  assert.equal(finished.kind, "finalized");
  await first.driver.settle(finished);
  const b = await second.driver.acquire(second.attempt("acquire"), undefined, 360000);
  assert.equal(b.kind, "acquired");
  await second.driver.settle(b);
  await clock.advance(13 * 3600000 + 1);
  const c = await second.driver.acquire(second.attempt("acquire"), b.credential, 360000);
  assert.equal(c.kind, "acquired");
  await second.driver.settle(c);
  assert.deepEqual(
    fixture.issuesOfTokens.map((item) => item.permissions),
    [
      { metadata: "read", contents: "write" },
      { metadata: "read", contents: "write", pull_requests: "write", issues: "write" },
      { metadata: "read", contents: "write", pull_requests: "write", issues: "write" },
    ],
  );
  assert.notEqual(fixture.issuesOfTokens[1].claims.iat, fixture.issuesOfTokens[2].claims.iat);
  await assert.rejects(
    second.driver.retire(second.attempt("retire"), a.credential),
    /foreign-credential/,
  );
  const head = {
      method: "GET",
      rawTarget: "/repos/fixture/repository",
      headers: {},
      receivedMonoMs: clock.monotonicNow(),
      contentEncoding: "identity",
      framing: { kind: "none", bytes: undefined },
    },
    plan = second.driver.plan({ authority: second.authority, session: {}, head });
  await assert.rejects(
    second.driver.withAuthentication(c.credential, { ...plan }, async () => {}),
    /invalid-credential/,
  );
  await second.driver.withAuthentication(c.credential, plan, async (request) =>
    assert.equal(fixture.authorize(request.headers.authorization), true),
  );
  key.close();
  const retired = await second.driver.retire(second.attempt("retire"), c.credential);
  assert.equal(retired.kind, "revoked");
  await second.driver.settle(retired);
  assert.equal(fixture.tokenState().at(-1).revoked, true);
  assert.deepEqual(fixture.errors, []);
  for (const owned of [first, second])
    for (const record of owned.records.values()) record.bytes.fill(0);
});
test("refused and cancelled observations remain independently captured and token-owned cleanup succeeds", async (t) => {
  const clock = createControlledClock();
  let mode = "surplus";
  const fixture = await startGitHubFixture(t, {
    clock,
    issueResponse({ status, body }) {
      if (mode === "surplus")
        return {
          status,
          body: { ...body, permissions: { ...body.permissions, administration: "write" } },
        };
      if (mode === "refused") return { status: 403, body };
      if (mode === "short")
        return {
          status,
          body: { ...body, expires_at: new Date(clock.wallNow() + 1000).toISOString() },
        };
      return { status, body };
    },
  });
  const key = createGitHubKeyOwner({ privateKey: fixture.privateKey, appId: "12345", clock });
  t.after(() => key.close());
  const factory = createGitHubDriverFactory({
    configuration: {
      kind: "github-app",
      providerInstanceId: "fixture-instance",
      configVersion: "1",
      appId: "12345",
      installationId: "41",
      repositoryId: "73",
      repository: "fixture/repository",
      privateKeyFile: "/protected/app.pem",
    },
    key,
    clock,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    trustedEndpoints: { apiOrigin: fixture.origin, gitOrigin: fixture.origin, ca: fixture.tls.ca },
  });
  for (const [selected, expected] of [
    ["surplus", "rejected"],
    ["refused", "reauthorization-required"],
    ["short", "rejected"],
    ["cancel", "uncertain"],
  ]) {
    mode = selected;
    const abort = new AbortController();
    // Closure during the original material callback cannot remove the cleanup obligation.
    const owned = owner(factory, clock, "read-write", selected, () => {
      if (selected === "cancel") abort.abort();
    });
    const result = await owned.driver.acquire(
      owned.attempt("acquire", abort.signal),
      undefined,
      360000,
    );
    assert.equal(result.kind, expected);
    assert.equal(owned.records.size, 1);
    await owned.driver.settle(result);
    const [credential] = owned.records.keys();
    const plan = owned.driver.plan({
      authority: owned.authority,
      session: {},
      head: {
        method: "GET",
        rawTarget: "/repos/fixture/repository",
        headers: {},
        receivedMonoMs: 0,
        contentEncoding: "identity",
        framing: { kind: "none", bytes: undefined },
      },
    });
    await assert.rejects(
      owned.driver.withAuthentication(credential, plan, async () =>
        assert.fail("refused material cannot authenticate"),
      ),
      /invalid-credential/,
    );
    const cleanup = await owned.driver.retire(owned.attempt("retire"), credential);
    assert.equal(cleanup.kind, "revoked");
    await owned.driver.settle(cleanup);
    for (const record of owned.records.values()) record.bytes.fill(0);
  }
  assert.ok(fixture.tokenState().every((token) => token.revoked));
  assert.deepEqual(fixture.errors, []);
});
