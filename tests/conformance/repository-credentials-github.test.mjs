import test from "node:test";
import assert from "node:assert/strict";
import {
  createGitHubDriverFactory,
  createGitHubKeyOwner,
} from "../../apps/controller/src/providers/repository-credentials/github/index.ts";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repository-credentials/configuration.ts";
import { startGitHubFixture } from "../fixtures/repository-credentials/github.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createProviderTransport } from "../../apps/controller/src/providers/repository-credentials/github/provider-transport.ts";

const config = validateServiceConfig({
  gateway: {
    publicOrigin: "https://credentials.example",
    listen: "127.0.0.1:443",
    controlSocket: "/run/credentials/control.sock",
  },
  sessionPolicy: {
    maximumDurationSeconds: 86400,
    defaultProfile: "git-write",
    allowedProfiles: ["git-read", "git-write", "git-full"],
  },
});
function owner(factory, clock, profile, id, captured = () => {}) {
  const authority = { sessionId: id, ...factory.resolve(profile).binding };
  const attempts = new WeakSet();
  const records = new Map();
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
test("provider transport pins destination and exact issuance scope before receiving credentials", async (t) => {
  const clock = createControlledClock();
  const fixture = await startGitHubFixture(t, { clock });
  const key = createGitHubKeyOwner({ privateKey: fixture.privateKey, appId: "12345", clock });
  t.after(() => key.close());
  const scope = { installationId: "41", repositoryId: "73", profile: "git-read" };
  for (const origin of [
    "http://localhost",
    "https://user@example.test",
    `${fixture.origin}/path`,
  ]) {
    assert.throws(() => createProviderTransport(origin, fixture.tls.ca, clock, scope));
  }
  for (const installationId of ["//other.example", "https://other.example", "41/../42", "41?x=1"]) {
    assert.throws(() =>
      createProviderTransport(fixture.origin, fixture.tls.ca, clock, { ...scope, installationId }),
    );
  }
  for (const changes of [
    { repositoryId: "9007199254740992" },
    { repositoryId: 73 },
    { installationId: 41 },
    { profile: "__proto__" },
  ]) {
    assert.throws(() =>
      createProviderTransport(fixture.origin, fixture.tls.ca, clock, { ...scope, ...changes }),
    );
  }
  let installationReads = 0;
  const transportScope = {
    ...scope,
    get installationId() {
      return ++installationReads === 1 ? "41" : "42";
    },
  };
  const transport = createProviderTransport(fixture.origin, fixture.tls.ca, clock, transportScope);
  assert.equal(installationReads, 1);
  assert.deepEqual(Object.keys(transport).sort(), ["issue", "revoke"]);
  assert.ok(Object.isFrozen(transport));
  // A later caller cannot replace the URL, request body, or admitted permission map.
  transportScope.repositoryId = "74";
  transportScope.profile = "git-full";
  let dispatches = 0;
  let observations = 0;
  const attempt = (action) => ({
    action,
    deadlineMonoMs: clock.monotonicNow() + 30000,
    signal: new AbortController().signal,
    assertAdmitted() {},
    observeDispatch() {},
  });
  const onDispatch = () => dispatches++;
  const observeResponse = () => observations++;
  for (const authorization of ["unsafe\r\nHeader: value", "", { path: "//other.example" }]) {
    await assert.rejects(
      transport.issue(authorization, attempt("acquire"), onDispatch, () => {}, observeResponse),
      /provider-unavailable/,
    );
  }
  assert.equal(dispatches, 0);
  assert.equal(fixture.issuesOfTokens.length, 0);
  const issued = await key.withJwt((jwt, assertCurrent) =>
    transport.issue(jwt, attempt("acquire"), onDispatch, assertCurrent, observeResponse),
  );
  let token;
  try {
    assert.equal(issued.status, 201);
    token = JSON.parse(issued.body.toString()).token;
  } finally {
    issued.body.fill(0);
  }
  assert.equal(observations, 1);
  assert.deepEqual(fixture.issuesOfTokens[0].repositoryIds, [73]);
  assert.deepEqual(fixture.issuesOfTokens[0].permissions, { metadata: "read", contents: "read" });
  const revoked = await transport.revoke(token, attempt("retire"), onDispatch);
  try {
    assert.equal(revoked.status, 204);
  } finally {
    revoked.body.fill(0);
  }
  assert.equal(dispatches, 2);
  assert.equal(fixture.tokenState()[0].revoked, true);
  assert.deepEqual(fixture.errors, []);
});
test("real HTTPS issuance preserves exact profiles after hour 13 and revokes with owned token after key closure", async (t) => {
  const clock = createControlledClock();
  const providerClock = createControlledClock(clock.wallNow());
  const fixture = await startGitHubFixture(t, { clock: providerClock });
  const key = createGitHubKeyOwner({ privateKey: fixture.privateKey, appId: "12345", clock });
  const factory = createGitHubDriverFactory({
    configuration: {
      kind: "github-app",
      providerInstanceId: "fixture-instance",
      configVersion: "v1",
      appId: "12345",
      installationId: "41",
      repositoryId: "73",
      repository: "Fixture/Repository",
      privateKeyFile: "/protected/app.pem",
    },
    key,
    clock,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    trustedEndpoints: { apiOrigin: fixture.origin, gitOrigin: fixture.origin, ca: fixture.tls.ca },
  });
  const first = owner(factory, clock, "git-write", "one");
  const second = owner(factory, clock, "git-full", "two");
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
  await providerClock.advance(13 * 3600000 + 1);
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
    rawTarget: "/repos/Fixture/Repository",
    headers: {},
    receivedMonoMs: clock.monotonicNow(),
    contentEncoding: "identity",
    framing: { kind: "none", bytes: undefined },
  };
  const plan = second.driver.plan({ authority: second.authority, session: {}, head });
  // GitHub returns canonical identity casing even when configuration retains capitals.
  const issuePlan = second.driver.plan({
    authority: second.authority,
    session: {},
    head: {
      ...head,
      method: "POST",
      rawTarget: "/repos/Fixture/Repository/issues",
      headers: { "content-type": "application/json" },
    },
  });
  const canonicalIssue = "https://api.github.com/repos/fixture/repository/issues/1";
  assert.deepEqual(
    issuePlan.responsePolicy.rewriteJson({ url: canonicalIssue, body: canonicalIssue }),
    {
      url: "https://credentials.example/repos/Fixture/Repository/issues/1",
      body: canonicalIssue,
    },
  );
  for (const prefix of ["repos/fixture/repository", "repositories/73"]) {
    assert.equal(
      issuePlan.responsePolicy.headers(200, {
        link: `<https://api.github.com/${prefix}/issues?after=Y3Vyc29yOnYyOjE%3D&page=2>; rel="next"`,
      }).link,
      '<https://credentials.example/repos/Fixture/Repository/issues?after=Y3Vyc29yOnYyOjE%3D&page=2>; rel="next"',
    );
  }
  for (const target of [
    "repos/fixture/repository-other/issues/1",
    "repos/fixture-other/repository/issues/1",
    "repos/fixture/repository/Issues/1",
    "REPOS/fixture/repository/issues/1",
    "repos/fixture/repository/issues/1?after=cursor",
    "repositories/730/issues/1",
  ]) {
    assert.throws(
      () => issuePlan.responsePolicy.rewriteJson({ url: `https://api.github.com/${target}` }),
      /unsafe-upstream-url/,
    );
  }
  await assert.rejects(
    second.driver.withAuthentication(c.credential, { ...plan }, async () => {}),
    /invalid-credential/,
  );
  await second.driver.withAuthentication(c.credential, plan, async (request) =>
    assert.equal(fixture.authorize(request.headers.authorization), true),
  );
  // A local wall jump denies authentication but does not expire the provider token.
  await clock.advance(0, 2 * 3600000);
  await assert.rejects(
    second.driver.withAuthentication(c.credential, plan, async () =>
      assert.fail("a forward wall jump must deny authentication"),
    ),
    /invalid-credential/,
  );
  key.close();
  const retired = await second.driver.retire(second.attempt("retire"), c.credential);
  assert.equal(retired.kind, "revoked");
  await second.driver.settle(retired);
  assert.equal(fixture.tokenState().at(-1).revoked, true);
  assert.deepEqual(fixture.errors, []);
  for (const owned of [first, second]) {
    for (const record of owned.records.values()) {
      record.bytes.fill(0);
    }
  }
});
test("refused and cancelled observations remain independently captured and token-owned cleanup succeeds", async (t) => {
  const clock = createControlledClock();
  const providerClock = createControlledClock(clock.wallNow() + 5000);
  let mode = "surplus";
  const fixture = await startGitHubFixture(t, {
    clock: providerClock,
    issueResponse({ status, body }) {
      if (mode === "surplus") {
        return {
          status,
          body: { ...body, permissions: { ...body.permissions, administration: "write" } },
        };
      }
      if (mode === "refused") {
        return { status: 403, body };
      }
      if (mode === "excess-skew") {
        return {
          status,
          body: { ...body, expires_at: new Date(clock.wallNow() + 3660001).toISOString() },
        };
      }
      if (mode === "short") {
        return {
          status,
          body: { ...body, expires_at: new Date(clock.wallNow() + 1000).toISOString() },
        };
      }
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
    ["excess-skew", "rejected"],
    ["valid-skew", "acquired"],
  ]) {
    mode = selected;
    const abort = new AbortController();
    // Closure during the original material callback cannot remove the cleanup obligation.
    const owned = owner(factory, clock, "git-full", selected, () => {
      if (selected === "cancel") {
        abort.abort();
      }
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
    if (selected === "valid-skew") {
      await owned.driver.withAuthentication(credential, plan, async ({ headers }) =>
        assert.equal(fixture.authorize(headers.authorization), true),
      );
      // Service wall time stays behind while independent provider time advances.
      // Authentication must stop conservatively; the still-live token needs DELETE.
      await providerClock.advance(3595000);
      await clock.advance(3595000, 0);
      assert.ok(fixture.tokenState().at(-1).expires > providerClock.wallNow());
    }
    await assert.rejects(
      owned.driver.withAuthentication(credential, plan, async () =>
        assert.fail("refused material cannot authenticate"),
      ),
      /invalid-credential/,
    );
    const cleanup = await owned.driver.retire(owned.attempt("retire"), credential);
    assert.equal(cleanup.kind, "revoked");
    await owned.driver.settle(cleanup);
    for (const record of owned.records.values()) {
      record.bytes.fill(0);
    }
  }
  assert.ok(fixture.tokenState().every((token) => token.revoked));
  assert.deepEqual(fixture.errors, []);
});
