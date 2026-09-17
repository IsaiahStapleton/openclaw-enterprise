import assert from "node:assert/strict";
import test from "node:test";
import { createCredentialService } from "../../apps/repository-credentials/src/service.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createAlternateDriverFactory } from "../fixtures/repository-credentials/alternate.mjs";

const config = () => ({
  sessionPolicy: {
    maximumDurationSeconds: 172800,
    defaultProfile: "git-write",
    allowedProfiles: ["git-write"],
  },
  limits: {
    sessions: 16,
    providerQueue: 64,
    credentialSlotsPerSession: 2,
    accessTokenBytes: 16384,
    renewalBytesPerSession: 16384,
    providerActionMs: 30000,
    credentialMarginMs: 60000,
    exchanges: 32,
    exchangesPerSession: 4,
    exchangeMs: 300000,
  },
});
const head = (clock) => ({
  method: "GET",
  rawTarget: "/team/nested/project",
  headers: {},
  receivedMonoMs: clock.monotonicNow(),
  contentEncoding: "identity",
  framing: { kind: "none", bytes: undefined },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const send = async (_request, context) =>
  context.gate.dispatch(
    () => {},
    () => ({ kind: "completed", status: 200 }),
  );

function setup(options = {}) {
  const clock = createControlledClock(1700000000000);
  const factory = createAlternateDriverFactory({
    origin: "https://upstream.example.test",
    gatewayOrigin: "https://gateway.example.test",
    clock,
    ...options,
  });
  const configuration = config();
  const service = createCredentialService({ config: configuration, factory, clock });
  const opened = service.open({ durationSeconds: 86400, profile: undefined });
  return {
    clock,
    factory,
    service,
    opened,
    configuration,
    exchange: (signal = new AbortController().signal) =>
      service.reserve(opened.bearer, head(clock), signal),
  };
}

test("immutable session binding, digest-only public status and original exchange identity", async () => {
  const { clock, service, opened, configuration, exchange } = setup();
  assert.equal(opened.bearer.length, 43);
  assert.ok(Object.isFrozen(opened.session.binding));
  configuration.sessionPolicy.allowedProfiles.push("broader");
  assert.throws(() => service.open({ durationSeconds: 1, profile: "broader" }), /INVALID_PROFILE/);
  assert.equal(
    service.reserve("x".repeat(43), head(clock), new AbortController().signal).kind,
    "denied",
  );
  const ref = exchange();
  assert.throws(() => service.plan({ ...ref }), /FOREIGN_EXCHANGE/);
  assert.equal((await service.execute(ref, send)).kind, "completed");
  assert.equal(
    JSON.stringify(service.status(opened.session.sessionId)).includes(opened.bearer),
    false,
  );
  service.close(opened.session.sessionId);
  assert.equal(
    service.reserve(opened.bearer, head(clock), new AbortController().signal).kind,
    "denied",
  );
  await tick();
  assert.equal(service.status(opened.session.sessionId).state, "DISPOSED");
  assert.equal(clock.pendingTimers(), 0);
});

test("unchanged bearer replaces expired access after hour 13 while retaining renewal authority", async () => {
  const { clock, service, opened, factory, exchange } = setup();
  assert.equal((await service.execute(exchange(), send)).kind, "completed");
  await clock.advance(13 * 3600000);
  assert.equal((await service.execute(exchange(), send)).kind, "completed");
  assert.equal(factory.events.filter((event) => event.kind === "rotate").length, 2);
  for (let index = 0; index < 5; index++) {
    await clock.advance(100000);
    assert.equal((await service.execute(exchange(), send)).kind, "completed");
  }
  await clock.advance(100000);
  service.close(opened.session.sessionId);
  await tick();
  assert.equal(factory.events.filter((event) => event.kind === "finalize").length, 1);
  assert.equal(service.status(opened.session.sessionId).state, "DISPOSED");
});

test("concurrent misses coalesce and cancellation of one waiter preserves another", async () => {
  const { service, factory, opened, exchange } = setup();
  const abort = new AbortController();
  const first = service.execute(exchange(abort.signal), send);
  const second = service.execute(exchange(), send);
  abort.abort();
  assert.equal((await first).kind, "not-dispatched");
  assert.equal((await second).kind, "completed");
  assert.equal(factory.events.filter((event) => event.kind === "rotate").length, 1);
  service.close(opened.session.sessionId);
  await tick();
});

test("last-waiter cancellation refuses later requests until original acquisition settlement", async (t) => {
  const { service, factory, opened, configuration, exchange } = setup();
  const settlement = Promise.withResolvers();
  const acquired = Promise.withResolvers();
  const driver = factory.drivers[0];
  const settle = driver.settle.bind(driver);
  // Delay only settlement of the fixture's real captured outcome. The service
  // still owns the original attempt, custody reservation and cleanup.
  driver.settle = async (outcome) => {
    if (outcome.kind === "acquired") {
      acquired.resolve();
      await settlement.promise;
    }
    await settle(outcome);
  };
  t.after(async () => {
    service.close(opened.session.sessionId);
    settlement.resolve();
    await tick();
  });

  const abort = new AbortController();
  const first = service.execute(exchange(abort.signal), send);
  await acquired.promise;
  abort.abort();
  assert.equal((await first).kind, "not-dispatched");
  await tick();

  // Requests must fail without waiting for their own cancellation or the
  // unsettled provider action, and each refusal must return exchange capacity.
  for (let index = 0; index < configuration.limits.exchangesPerSession * 2; index++) {
    const ref = exchange();
    assert.notEqual(ref.kind, "denied");
    const outcome = await Promise.race([
      service.execute(ref, send),
      tick().then(() => ({ kind: "pending" })),
    ]);
    assert.deepEqual(
      outcome,
      { kind: "not-dispatched", code: "exchange-unavailable" },
      "an aborted acquisition must refuse new waiters before settlement",
    );
  }
  assert.equal(factory.events.filter((event) => event.kind === "rotate").length, 1);
  assert.equal(factory.events.filter((event) => event.kind === "authentication").length, 0);

  // Local closure cannot release the captured credential or finalize its
  // session while the original acquisition owner remains unsettled.
  service.close(opened.session.sessionId);
  await tick();
  const pending = service.status(opened.session.sessionId);
  assert.equal(pending.state, "CLOSED");
  assert.equal(pending.cleanup.pending, 1);
  assert.equal(pending.cleanup.auxiliaryPending, true);
  assert.equal(factory.events.filter((event) => event.kind === "retire").length, 0);
  assert.equal(factory.events.filter((event) => event.kind === "finalize").length, 0);
  settlement.resolve();
  await tick();
  assert.equal(factory.events.filter((event) => event.kind === "rotate").length, 1);
  assert.equal(factory.events.filter((event) => event.kind === "retire").length, 1);
  assert.equal(factory.events.filter((event) => event.kind === "finalize").length, 1);
  assert.equal(service.status(opened.session.sessionId).state, "DISPOSED");
});

test("a backward wall clock does not extend access or task authority", async () => {
  const { clock, service, opened, factory, exchange } = setup();
  assert.equal((await service.execute(exchange(), send)).kind, "completed");
  await clock.advance(100000, -3600000);
  assert.equal((await service.execute(exchange(), send)).kind, "completed");
  assert.equal(factory.events.filter((event) => event.kind === "rotate").length, 2);
  await clock.advance(86400000, -86400000);
  assert.equal(service.status(opened.session.sessionId).state, "DISPOSED");
  assert.equal(
    service.reserve(opened.bearer, head(clock), new AbortController().signal).kind,
    "denied",
  );
});

test("final dispatch rejects closure after asynchronous authentication and joins live I/O", async () => {
  const { service, opened, exchange } = setup();
  let ready;
  let continueSend;
  const entered = new Promise((resolve) => {
    ready = resolve;
  });
  const blocked = new Promise((resolve) => {
    continueSend = resolve;
  });
  let openedTransport = false;
  const work = service.execute(exchange(), async (_request, context) => {
    ready();
    await blocked;
    return context.gate.dispatch(
      () => {},
      () => {
        openedTransport = true;
        return { kind: "completed", status: 200 };
      },
    );
  });
  await entered;
  service.close(opened.session.sessionId);
  assert.equal(service.status(opened.session.sessionId).state, "CLOSED");
  assert.equal((await work).kind, "not-dispatched");
  continueSend();
  await tick();
  assert.equal(openedTransport, false);
  assert.equal(service.status(opened.session.sessionId).state, "DISPOSED");
});

test("late captured refusal retains its slot through original settlement and is cleaned after close", async () => {
  let release;
  const lateCapture = new Promise((resolve) => {
    release = resolve;
  });
  const { service, opened, factory, exchange } = setup({ controls: { lateCapture } });
  assert.equal((await service.execute(exchange(), send)).kind, "not-dispatched");
  assert.equal(service.status(opened.session.sessionId).cleanup.uncertain, 1);
  assert.equal((await service.execute(exchange(), send)).kind, "not-dispatched");
  assert.equal(factory.events.filter((event) => event.kind === "rotate").length, 1);
  service.close(opened.session.sessionId);
  assert.equal(service.status(opened.session.sessionId).state, "CLOSED");
  release();
  await tick();
  assert.equal(factory.events.filter((event) => event.kind === "retire").length, 1);
  assert.equal(service.status(opened.session.sessionId).state, "DISPOSED");
});

test("scope refusal cleans the independently captured credential", async () => {
  const { service, opened, factory, exchange } = setup({ controls: { rejectScope: true } });
  assert.equal((await service.execute(exchange(), send)).kind, "not-dispatched");
  await tick();
  assert.equal(factory.events.filter((event) => event.kind === "retire").length, 1);
  service.close(opened.session.sessionId);
  await tick();
  assert.equal(service.status(opened.session.sessionId).state, "DISPOSED");
});

test("drain-before replacement waits for an active exchange before rotating", async () => {
  const { clock, service, opened, factory, exchange } = setup({ lifetimeMs: 61000 });
  let release;
  const active = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const sent = new Promise((resolve) => {
    entered = resolve;
  });
  const first = service.execute(exchange(), async (_request, context) => {
    context.gate.track(active);
    return context.gate.dispatch(release, () => {
      entered();
      return { kind: "completed", status: 200 };
    });
  });
  await sent;
  await clock.advance(500);
  // Rotation must wait for the first owned I/O even though the next exchange
  // needs a fresh credential to cover its full remaining budget.
  await clock.advance(400);
  const next = service.execute(exchange(), send);
  await tick();
  assert.equal(factory.events.filter((event) => event.kind === "rotate").length, 1);
  release();
  await first;
  assert.equal((await next).kind, "completed");
  assert.equal(factory.events.filter((event) => event.kind === "rotate").length, 2);
  service.close(opened.session.sessionId);
  await tick();
});

test("insufficient full exchange validity refuses once and retires the captured token", async () => {
  const { service, opened, factory, exchange } = setup({ lifetimeMs: 60999 });
  let sends = 0;
  const result = await service.execute(exchange(), async (...args) => {
    sends++;
    return send(...args);
  });
  assert.equal(result.kind, "not-dispatched");
  assert.equal(sends, 0);
  await tick();
  assert.equal(factory.events.filter((event) => event.kind === "rotate").length, 1);
  assert.equal(factory.events.filter((event) => event.kind === "retire").length, 1);
  service.close(opened.session.sessionId);
  await tick();
});

test("finite shutdown reports an unsettled late callback without inventing disposal", async () => {
  let release;
  const lateCapture = new Promise((resolve) => {
    release = resolve;
  });
  const { service, clock, opened, exchange } = setup({ controls: { lateCapture } });
  await service.execute(exchange(), send);
  const shutdown = service.shutdown(50);
  await clock.advance(50);
  const summary = await shutdown;
  assert.equal(summary.graceExpired, true);
  assert.equal(summary.pendingActions, 1);
  assert.equal(summary.pendingCredentials, 1);
  assert.equal(summary.pendingAuxiliary, 1);
  assert.equal(service.status(opened.session.sessionId).state, "CLOSED");
  release();
  await tick();
  assert.equal(service.status(opened.session.sessionId).state, "DISPOSED");
});

test("closing one session preserves another session and prevents replay after dispatch", async () => {
  const { service, clock, opened, exchange } = setup();
  const other = service.open({ durationSeconds: 3600, profile: undefined });
  let calls = 0;
  const outcome = await service.execute(exchange(), async (_request, context) => {
    calls++;
    return context.gate.dispatch(
      () => {},
      () => {
        throw new Error("upstream-disconnected");
      },
    );
  });
  assert.equal(outcome.kind, "possibly-dispatched");
  assert.equal(calls, 1);
  service.close(opened.session.sessionId);
  await tick();
  const otherRef = service.reserve(other.bearer, head(clock), new AbortController().signal);
  assert.equal((await service.execute(otherRef, send)).kind, "completed");
  service.close(other.session.sessionId);
  await tick();
});

for (const acquireFirst of [false, true]) {
  test(`saturated cleanup queue drains every session and renewal after ${acquireFirst ? "retirement" : "finalization"} admission rejection`, async () => {
    const clock = createControlledClock(1700000000000);
    const factory = createAlternateDriverFactory({
      origin: "https://upstream.example.test",
      gatewayOrigin: "https://gateway.example.test",
      clock,
    });
    const configuration = config();
    configuration.limits.providerQueue = 1;
    configuration.limits.sessions = 4;
    const service = createCredentialService({ config: configuration, factory, clock });
    const sessions = Array.from({ length: 4 }, () =>
      service.open({ durationSeconds: 3600, profile: undefined }),
    );
    if (acquireFirst) {
      for (const session of sessions) {
        const exchange = service.reserve(session.bearer, head(clock), new AbortController().signal);
        assert.equal((await service.execute(exchange, send)).kind, "completed");
        await tick();
      }
    }
    // Hold the first real outcome's settlement so one running action and one
    // queued action exhaust capacity while the other sessions remain eligible.
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const firstDriver = factory.drivers[0];
    const settle = firstDriver.settle.bind(firstDriver);
    firstDriver.settle = async (original) => {
      await settle(original);
      if (original.kind === (acquireFirst ? "revoked" : "finalized")) await held;
    };
    for (const session of sessions) service.close(session.session.sessionId);
    await tick();
    await clock.advance(1);
    await tick();
    const action = acquireFirst ? "retire" : "finalize";
    assert.equal(factory.events.filter((event) => event.kind === action).length, 1);
    for (const session of sessions) {
      const status = service.status(session.session.sessionId);
      assert.equal(status.state, "CLOSED");
      assert.equal(status.cleanup.uncertain, 0);
    }
    release();
    await tick();
    for (const session of sessions) {
      const id = session.session.sessionId;
      const status = service.status(id);
      assert.equal(status.state, "DISPOSED");
      assert.equal(status.cleanup.auxiliaryPending, false);
      assert.equal(status.cleanup.pending, 0);
      assert.equal(status.cleanup.uncertain, 0);
      for (const kind of acquireFirst ? ["retire", "finalize"] : ["finalize"])
        assert.equal(
          factory.events.filter((event) => event.kind === kind && event.sessionId === id).length,
          1,
        );
    }
    assert.equal(clock.pendingTimers(), 0);
    // DISPOSED requires empty renewal custody, and every bounded session slot
    // must be available for another admission after cleanup drains.
    const replacements = sessions.map(() =>
      service.open({ durationSeconds: 3600, profile: undefined }),
    );
    for (const session of replacements) service.close(session.session.sessionId);
    await tick();
    assert.equal(clock.pendingTimers(), 0);
    for (const session of replacements)
      assert.equal(service.status(session.session.sessionId).state, "DISPOSED");
  });
}
