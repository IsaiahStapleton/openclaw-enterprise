import test from "node:test";
import assert from "node:assert/strict";
import { startServiceProcessFixture } from "../fixtures/repository-credentials/service-process.mjs";

function outstandingToken(fixture) {
  const tokens = fixture.github.tokenState();
  assert.equal(tokens.length, 1, "the provider accepted exactly one issuance");
  const [token] = tokens;
  assert.equal(token.index, 1);
  assert.equal(token.revoked, false, "service loss does not confirm provider retirement");
  assert.ok(token.expires > fixture.clock.wallNow(), "provider authority remains unexpired");
  assert.equal(fixture.github.issuesOfTokens.length, 1);
  assert.equal(
    fixture.github.trace.filter((entry) => entry.target.endsWith("/access_tokens")).length,
    1,
    "the original issuance was dispatched exactly once",
  );
  assert.equal(
    fixture.github.trace.filter((entry) => entry.method === "DELETE").length,
    0,
    "unknown or lost credentials cannot be reported as revoked",
  );
  assert.deepEqual(fixture.github.errors, []);
  return token;
}

async function assertStaleSessionDenied(fixture, opened) {
  assert.deepEqual(await fixture.status(opened.session.sessionId), { error: "not-found" });
  const before = fixture.github.authenticationAttempts.length;
  const denied = await fixture.request(opened);
  assert.equal(denied.status, 401);
  assert.deepEqual(JSON.parse(denied.body), { error: { code: "session-unavailable" } });
  assert.equal(fixture.github.authenticationAttempts.length, before);
  outstandingToken(fixture);
}

// These are current-behavior characterizations. The missing durable accounting
// boundary is deferred; neither stale-bearer denial nor provider state proves it.
test(
  "TEST-001: SIGKILL after confirmed GitHub issuance loses session inventory",
  { timeout: 20000 },
  async (t) => {
    const fixture = await startServiceProcessFixture(t);
    const opened = await fixture.open();
    const read = await fixture.request(opened);
    assert.equal(read.status, 200);
    assert.equal(JSON.parse(read.body).full_name, "fixture/repository");
    assert.equal(outstandingToken(fixture).uses, 1);
    assert.deepEqual(fixture.github.authenticationAttempts, [{ tokenIndex: 1, boundary: "api" }]);
    assert.equal((await fixture.status(opened.session.sessionId)).cleanup.active, 1);

    const first = fixture.generation();
    await fixture.kill();
    assert.equal(outstandingToken(fixture).uses, 1);
    const replacement = await fixture.start();
    assert.notEqual(replacement.pid, first.pid);
    await assertStaleSessionDenied(fixture, opened);
    t.diagnostic(
      "safety_pass; characterization_pass: old session absent while provider token remains valid; durable target deferred",
    );
  },
);

test(
  "TEST-002: lost GitHub issuance response stays charged while service survives",
  { timeout: 20000 },
  async (t) => {
    const fixture = await startServiceProcessFixture(t, { holdIssuance: true });
    const opened = await fixture.open();
    const [failed] = await Promise.all([
      fixture.request(opened),
      (async () => {
        await fixture.waitForIssuance();
        assert.equal(outstandingToken(fixture).uses, 0);
        fixture.loseIssuanceResponse();
      })(),
    ]);
    assert.equal(failed.status, 503);
    assert.deepEqual(JSON.parse(failed.body), { error: { code: "unavailable" } });
    const status = await fixture.status(opened.session.sessionId);
    assert.equal(status.cleanup.pending, 1);
    assert.equal(status.cleanup.uncertain, 1);
    assert.equal(status.cleanup.revoked, 0);
    assert.equal(status.cleanup.expired, 0);

    // A second caller request cannot retry the original uncertain mint.
    assert.equal((await fixture.request(opened)).status, 503);
    outstandingToken(fixture);
    await fixture.close(opened.session.sessionId);
    await fixture.advance(30001);
    const closed = await fixture.status(opened.session.sessionId);
    assert.equal(closed.state, "CLOSED");
    assert.equal(closed.cleanup.pending, 1);
    assert.equal(closed.cleanup.uncertain, 1);
    assert.equal(closed.cleanup.revoked, 0);
    assert.equal(closed.cleanup.expired, 0);
    assert.deepEqual(await fixture.open(), { error: "overloaded" });
    assert.equal(outstandingToken(fixture).uses, 0);
    assert.deepEqual(fixture.github.authenticationAttempts, []);
    t.diagnostic(
      "safety_pass; characterization_pass: uncertain issuance remains charged and CLOSED is not DISPOSED",
    );
  },
);

test(
  "TEST-002: SIGKILL before GitHub issuance response loses local reservation",
  { timeout: 20000 },
  async (t) => {
    const fixture = await startServiceProcessFixture(t, { holdIssuance: true });
    const opened = await fixture.open();
    const first = fixture.generation();
    await Promise.all([
      assert.rejects(fixture.request(opened), { code: "ECONNRESET" }),
      (async () => {
        await fixture.waitForIssuance();
        assert.equal(outstandingToken(fixture).uses, 0);
        await fixture.kill();
      })(),
    ]);
    fixture.loseIssuanceResponse();
    const replacement = await fixture.start();
    assert.notEqual(replacement.pid, first.pid);
    await assertStaleSessionDenied(fixture, opened);
    // Admission is observable again despite the surviving upstream obligation.
    // This documents process-local capacity loss, not a durable target acceptance.
    const fresh = await fixture.open();
    assert.equal(fresh.session.state, "OPEN");
    assert.notEqual(fresh.session.sessionId, opened.session.sessionId);
    assert.equal(fresh.session.cleanup.pending, 0);
    assert.equal(fresh.session.cleanup.uncertain, 0);
    assert.equal(outstandingToken(fixture).uses, 0);
    assert.deepEqual(fixture.github.authenticationAttempts, []);
    t.diagnostic(
      "safety_pass; characterization_pass: restart permits admission with missing local reservation and outstanding provider authority; durable target deferred",
    );
  },
);
