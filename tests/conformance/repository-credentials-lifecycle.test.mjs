import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  createGitHubDriverFactory,
  createGitHubKeyOwner,
} from "../../apps/repository-credentials/src/backends/github/index.ts";
import { validateServiceConfig } from "../../apps/repository-credentials/src/config.ts";
import { createCredentialService } from "../../apps/repository-credentials/src/service.ts";
import { createProviderQueue } from "../../apps/repository-credentials/src/provider-queue.ts";
import { createCustody } from "../../apps/repository-credentials/src/custody.ts";
import { createLifecycle } from "../../apps/repository-credentials/src/lifecycle.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import {
  startGitHubFixture,
  fixtureAppId,
  fixtureInstallationId,
  fixtureRepository,
  fixtureRepositoryId,
} from "../fixtures/repository-credentials/github.mjs";
import { temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("cancelled queue entries release capacity while dispatched owner retains its slot until settlement", async () => {
  const queue = createProviderQueue(1);
  let settle;
  const settlement = new Promise((resolve) => {
    settle = resolve;
  });
  const firstAbort = new AbortController();
  const first = queue.run(firstAbort.signal, () => settlement);
  const queuedAbort = new AbortController();
  let queuedStarted = false;
  const queued = queue.run(queuedAbort.signal, async () => {
    queuedStarted = true;
  });
  await assert.rejects(
    queue.run(new AbortController().signal, async () => {}),
    /PROVIDER_UNAVAILABLE/,
  );
  firstAbort.abort();
  queuedAbort.abort();
  await assert.rejects(queued, /PROVIDER_UNAVAILABLE/);
  assert.equal(queue.pending, 1);
  assert.equal(queuedStarted, false);
  let nextStarted = false;
  const next = queue.run(new AbortController().signal, async () => {
    nextStarted = true;
  });
  await tick();
  assert.equal(nextStarted, false);
  settle();
  await first;
  await next;
  await tick();
  assert.equal(queue.pending, 0);
});

function uncertainLifecycle({ kind = "uncertain" } = {}) {
  const clock = createControlledClock(1700000000000);
  const authority = Object.freeze({
    sessionId: "session",
    providerInstanceId: "instance",
    repositoryId: "opaque",
    grantId: "fixed-grant",
  });
  let open = true;
  let lifecycle;
  const custody = createCustody({
    clock,
    maximumSlots: 2,
    maximumAccessBytes: 16384,
    maximumRenewalBytes: 16384,
    maximumCallbacks: 2,
    admitted: () => open,
    changed() {
      lifecycle?.maintain();
    },
  });
  const originals = new WeakSet();
  let acquires = 0;
  let finalizes = 0;
  const driver = {
    replacement: "overlap",
    cleanup: "revocable",
    async acquire(attempt) {
      custody.driver.assertAttempt(attempt, "acquire");
      attempt.observeDispatch();
      acquires++;
      const result = Object.freeze({ kind, attemptId: attempt.id });
      originals.add(result);
      return result;
    },
    async settle(original) {
      assert.ok(originals.has(original));
    },
    async finalize() {
      finalizes++;
      throw new Error("unexpected-finalize");
    },
  };
  lifecycle = createLifecycle({
    clock,
    authority,
    deadlineMonoMs: 86400000,
    custody,
    driver,
    queue: createProviderQueue(64),
    providerActionMs: 30000,
    safetyMarginMs: 60000,
    admitted: () => open,
    changed() {},
  });
  return {
    lifecycle,
    custody,
    acquires: () => acquires,
    finalizes: () => finalizes,
    close() {
      open = false;
      lifecycle.close();
    },
  };
}

test("settled unknown issue without captured material occupies its reservation and blocks remint", async () => {
  const { lifecycle, custody, acquires, finalizes, close } = uncertainLifecycle();
  await assert.rejects(lifecycle.acquire(1000, new AbortController().signal));
  await tick();
  assert.equal(custody.reservations.size, 1);
  assert.equal(lifecycle.activeActions, 0);
  await assert.rejects(lifecycle.acquire(1000, new AbortController().signal));
  assert.equal(acquires(), 1);
  close();
  await tick();
  assert.equal(lifecycle.finalized, false);
  assert.equal(finalizes(), 0);
});

test("a result cannot clear the original dispatch latch by claiming not-dispatched", async () => {
  const { lifecycle, custody, acquires, close } = uncertainLifecycle({ kind: "not-dispatched" });
  await assert.rejects(lifecycle.acquire(1000, new AbortController().signal));
  await tick();
  assert.equal(custody.reservations.size, 1);
  assert.equal(lifecycle.blocked, true);
  await assert.rejects(lifecycle.acquire(1000, new AbortController().signal));
  assert.equal(acquires(), 1);
  close();
});

test("finalization is incomplete until the original finalized outcome settles", async () => {
  const clock = createControlledClock(1700000000000);
  const authority = Object.freeze({
    sessionId: "closed-session",
    providerInstanceId: "instance",
    repositoryId: "opaque",
    grantId: "grant",
  });
  let lifecycle;
  const custody = createCustody({
    clock,
    maximumSlots: 2,
    maximumAccessBytes: 16384,
    maximumRenewalBytes: 16384,
    maximumCallbacks: 2,
    admitted: () => false,
    changed() {
      lifecycle?.maintain();
    },
  });
  let release;
  const settled = new Promise((resolve) => {
    release = resolve;
  });
  let original;
  const driver = {
    cleanup: "revocable",
    replacement: "overlap",
    async finalize(attempt) {
      custody.driver.assertAttempt(attempt, "finalize");
      original = Object.freeze({ kind: "finalized", attemptId: attempt.id });
      return original;
    },
    async settle(outcome) {
      assert.equal(outcome, original);
      await settled;
    },
  };
  lifecycle = createLifecycle({
    clock,
    authority,
    deadlineMonoMs: 1000,
    custody,
    driver,
    queue: createProviderQueue(64),
    providerActionMs: 30000,
    safetyMarginMs: 60000,
    admitted: () => false,
    changed() {},
  });
  lifecycle.close();
  await tick();
  assert.equal(lifecycle.finalized, false);
  assert.equal(lifecycle.activeActions, 1);
  release();
  await tick();
  assert.equal(lifecycle.finalized, true);
  assert.equal(lifecycle.activeActions, 0);
});

test("cleanup queue priority keeps bounded foreground progress", async () => {
  const queue = createProviderQueue(8);
  const signal = new AbortController().signal;
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const active = queue.run(signal, () => hold);
  const order = [];
  const foreground = queue.run(signal, async () => {
    order.push("foreground");
  });
  const cleanups = [1, 2, 3].map((id) =>
    queue.run(
      signal,
      async () => {
        order.push(`cleanup-${id}`);
      },
      "cleanup",
    ),
  );
  release();
  await Promise.all([active, foreground, ...cleanups]);
  assert.deepEqual(order, ["cleanup-1", "cleanup-2", "foreground", "cleanup-3"]);
});

for (const action of ["retire", "finalize"]) {
  test(`capacity changes never replay an invoked uncertain ${action}`, async () => {
    const clock = createControlledClock(1700000000000);
    const queue = createProviderQueue(1);
    let open = true;
    let lifecycle;
    const custody = createCustody({
      clock,
      maximumSlots: 2,
      maximumAccessBytes: 16384,
      maximumRenewalBytes: 16384,
      maximumCallbacks: 2,
      admitted: () => open,
      changed: () => lifecycle?.maintain(),
    });
    const originalOutcomes = new WeakSet();
    const originals = (attempt, outcome) => {
      const original = Object.freeze({ attemptId: attempt.id, ...outcome });
      originalOutcomes.add(original);
      return original;
    };
    let calls = 0;
    const driver = {
      cleanup: "revocable",
      replacement: "overlap",
      async acquire(attempt) {
        custody.driver.assertAttempt(attempt, "acquire");
        attempt.observeDispatch();
        const observation = {
          observedWallMs: clock.wallNow(),
          expiresAtWallMs: clock.wallNow() + 90000,
        };
        const credential = custody.driver.capture(attempt, Buffer.from("access"), observation);
        return originals(attempt, { kind: "acquired", credential, ...observation });
      },
      async [action](attempt) {
        custody.driver.assertAttempt(attempt, action);
        attempt.observeDispatch();
        calls++;
        return originals(
          attempt,
          action === "retire"
            ? { kind: "uncertain" }
            : { kind: "cleanup-pending", reason: "uncertain" },
        );
      },
      async settle(original) {
        assert.ok(originalOutcomes.has(original));
      },
    };
    lifecycle = createLifecycle({
      clock,
      authority: Object.freeze({
        sessionId: "session",
        providerInstanceId: "instance",
        repositoryId: "opaque",
        grantId: "grant",
      }),
      deadlineMonoMs: 86400000,
      custody,
      driver,
      queue,
      providerActionMs: 30000,
      safetyMarginMs: 60000,
      admitted: () => open,
      changed() {},
    });
    if (action === "retire")
      lifecycle.release(await lifecycle.acquire(1000, new AbortController().signal));
    open = false;
    lifecycle.close();
    await tick();
    for (let index = 0; index < 3; index++) {
      await queue.run(new AbortController().signal, async () => {});
      lifecycle.maintain();
      await tick();
    }
    assert.equal(calls, 1);
    assert.equal(lifecycle.finalized, false);
    assert.equal(lifecycle.activeActions, 0);
    if (action === "retire") {
      assert.equal(custody.reservations.size, 1);
      assert.equal([...custody.records][0].disposition, "uncertain");
    }
  });
}

async function eventually(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("expected lifecycle state was not observed");
}

for (const [profile, permissions] of [
  ["git-write", { metadata: "read", contents: "write" }],
  ["read-write", { metadata: "read", contents: "write", pull_requests: "write", issues: "write" }],
]) {
  test(`GitHub ${profile} replaces after hour 13 and disposes through the real common owner`, async (t) => {
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
      if (failures.length) throw new AggregateError(failures, "lifecycle fixture cleanup failed");
    });
    const clock = createControlledClock();
    const directory = await temporaryDirectory(resources, "rcs-lifecycle-");
    const config = validateServiceConfig({
      gateway: {
        publicOrigin: "https://credentials.example.test",
        listen: "127.0.0.1:443",
        controlSocket: join(directory, "control.sock"),
      },
      sessionPolicy: {
        maximumDurationSeconds: 172800,
        defaultProfile: "git-write",
        allowedProfiles: ["git-write", "read-write"],
      },
    });
    const github = await startGitHubFixture(resources, { clock });
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
      clock,
      gatewayOrigin: config.gateway.publicOrigin,
      limits: config.limits,
      trustedEndpoints: { apiOrigin: github.origin, gitOrigin: github.origin, ca: github.tls.ca },
    });
    const service = createCredentialService({ config, factory, clock });
    resources.after(() => service.shutdown(1000));
    const opened = service.open({ durationSeconds: 86400, profile });
    const reserve = () =>
      service.reserve(
        opened.bearer,
        {
          method: "POST",
          rawTarget: `/${fixtureRepository}.git/git-receive-pack`,
          headers: { "content-type": "application/x-git-receive-pack-request" },
          receivedMonoMs: clock.monotonicNow(),
          contentEncoding: "identity",
          framing: { kind: "length", bytes: 4 },
        },
        new AbortController().signal,
      );
    const perform = async () => {
      const exchange = reserve();
      assert.notEqual(exchange.kind, "denied");
      // This proves credential use at the common dispatch gate. Actual Git
      // protocol forwarding belongs to the transport integration suite.
      return service.execute(exchange, async ({ headers }, { gate }) =>
        gate.dispatch(
          () => {},
          () => ({
            kind: "completed",
            status: github.authorize(headers.authorization, "git") ? 200 : 401,
          }),
        ),
      );
    };
    assert.deepEqual(await perform(), { kind: "completed", status: 200 });
    assert.deepEqual(await perform(), { kind: "completed", status: 200 });
    assert.equal(github.issuesOfTokens.length, 1, "the common owner reuses a valid credential");
    const first = github.tokenState()[0];
    // Idle expiry requires a fresh credential while preserving the admitted
    // session and grant; even a rejected dispatch of expired A would fail here.
    await clock.advance(13 * 3600000 + 1000);
    assert.deepEqual(await perform(), { kind: "completed", status: 200 });
    assert.deepEqual(service.status(opened.session.sessionId).binding, opened.session.binding);
    assert.equal(github.issuesOfTokens.length, 2);
    assert.equal(github.tokenState()[0].attempts, first.attempts);
    assert.equal(github.tokenState()[1].uses, 1);
    const [initial, replacement] = github.issuesOfTokens;
    assert.ok(replacement.claims.iat > initial.claims.exp);
    assert.notEqual(replacement.jwtDigest, initial.jwtDigest);
    for (const issued of [initial, replacement]) {
      assert.deepEqual(issued.permissions, permissions);
      assert.deepEqual(issued.repositoryIds, [Number(fixtureRepositoryId)]);
    }
    service.close(opened.session.sessionId);
    assert.equal(reserve().kind, "denied");
    await eventually(() => service.status(opened.session.sessionId)?.state === "DISPOSED");
    assert.equal(github.tokenState()[1].revoked, true);
    const disposed = service.status(opened.session.sessionId);
    assert.equal(disposed.activeUses, 0);
    assert.equal(disposed.cleanup.pending, 0);
    assert.equal(disposed.cleanup.uncertain, 0);
    assert.equal(disposed.cleanup.auxiliaryPending, false);
    assert.deepEqual(github.errors, []);
  });
}
