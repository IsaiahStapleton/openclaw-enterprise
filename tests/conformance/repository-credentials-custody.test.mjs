import assert from "node:assert/strict";
import test from "node:test";
import { createCustody } from "../../apps/repository-credentials/src/custody.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";

function setup() {
  const clock = createControlledClock(1700000000000);
  let admitted = true;
  const custody = createCustody({
    clock,
    maximumSlots: 2,
    maximumAccessBytes: 16384,
    maximumRenewalBytes: 16384,
    maximumCallbacks: 2,
    admitted: () => admitted,
    changed() {},
  });
  const attempt = Object.freeze({
    id: "original-attempt",
    authority: Object.freeze({
      sessionId: "session",
      providerInstanceId: "instance",
      repositoryId: "opaque",
      grantId: "grant",
    }),
    action: "acquire",
    signal: new AbortController().signal,
    deadlineMonoMs: 30000,
    assertAdmitted() {},
    observeDispatch() {},
  });
  custody.register(attempt);
  const reservation = custody.reserve(attempt);
  const capture = () =>
    custody.driver.capture(attempt, Buffer.from("owned-material"), {
      observedWallMs: clock.wallNow(),
      expiresAtWallMs: clock.wallNow() + 90000,
    });
  return {
    clock,
    custody,
    attempt,
    reservation,
    capture,
    close: () => {
      admitted = false;
    },
  };
}

test("custody rejects copied attempts and handles and wipes callback-scoped byte copies", async () => {
  const { custody, attempt, capture, reservation } = setup();
  assert.throws(() => custody.driver.assertAttempt({ ...attempt }, "acquire"), /FOREIGN_ATTEMPT/);
  const ref = capture();
  assert.throws(() => custody.lookup({ ...ref }), /FOREIGN_CREDENTIAL/);
  const record = custody.lookup(ref);
  record.accepted = true;
  record.uses++;
  let retained;
  await custody.driver.withAccess(ref, "authenticate", async (bytes) => {
    retained = bytes;
    assert.equal(Buffer.from(bytes).toString(), "owned-material");
  });
  assert.ok(retained.every((value) => value === 0));
  record.uses--;
  record.disposition = "revoked";
  assert.throws(() => custody.release(record), /CREDENTIAL_BUSY/);
  custody.settle(reservation);
  custody.release(record);
  await assert.rejects(
    custody.driver.withAccess(ref, "retire", async () => {}),
    /FOREIGN_CREDENTIAL/,
  );
});

test("late capture survives local closure while original settlement ends capture authority", () => {
  const { custody, attempt, close, capture, reservation, clock } = setup();
  close();
  const ref = capture();
  assert.equal(custody.records.size, 1);
  custody.settle(reservation);
  assert.throws(
    () =>
      custody.driver.capture(attempt, Buffer.from("late"), {
        observedWallMs: clock.wallNow(),
        expiresAtWallMs: clock.wallNow() + 1000,
      }),
    /FOREIGN_ATTEMPT/,
  );
  const record = custody.lookup(ref);
  record.disposition = "revoked";
  custody.release(record);
  assert.equal(custody.reservations.size, 0);
});

test("access slot reclamation retains independent renewal bytes through finalization drain", async () => {
  const { custody, capture, reservation, close } = setup();
  const renewal = custody.driver.retainRenewal(Buffer.from("renewal-authority"));
  const ref = capture();
  const record = custody.lookup(ref);
  record.disposition = "expired";
  custody.settle(reservation);
  custody.release(record);
  close();
  assert.equal(custody.records.size, 0);
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let bytes;
  const read = custody.driver.withRenewal(renewal, async (value) => {
    bytes = value;
    await blocked;
  });
  let disposed = false;
  const dispose = custody.driver.disposeRenewal(renewal).then(() => {
    disposed = true;
  });
  await Promise.resolve();
  assert.equal(disposed, false);
  assert.equal(custody.renewalCount, 1);
  release();
  await read;
  await dispose;
  assert.equal(custody.renewalCount, 0);
  assert.ok(bytes.every((value) => value === 0));
});
