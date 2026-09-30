import assert from "node:assert/strict";
import test from "node:test";
import {
  SignInRateLimited,
  passwordFailureAdmission,
} from "../../apps/controller/src/auth/admission.ts";

class WrongPassword extends Error {}

const slow = {
  floorMs: 20,
  maxFloorMs: 80,
  concurrentPerEmail: 2,
  waitingPerEmail: 16,
  occupancy: 1024,
  evaluating: 16,
};

function admission(overrides = {}) {
  const administrators = new Set(overrides.administrators ?? []);
  return passwordFailureAdmission({
    perAddress: 4,
    perEmail: 3,
    slow,
    countsAsFailure: (error) => error instanceof WrongPassword,
    isReserved: async (email) => administrators.has(email),
    ...overrides,
  });
}

const wrong = () => Promise.reject(new WrongPassword("wrong"));
const right = () => Promise.resolve("signed-in");

async function outcome(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

async function status(limiter, attempt, work = wrong) {
  const { value, error } = await outcome(limiter.admit(attempt, work));
  if (error === undefined) {
    return value === "signed-in" ? 200 : value;
  }
  if (error instanceof SignInRateLimited) {
    assert.ok(error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 60);
    return 429;
  }
  if (error instanceof WrongPassword) {
    return 401;
  }
  throw error;
}

test("without a client address only the email lane applies", async () => {
  const limiter = admission();
  for (let index = 0; index < 20; index += 1) {
    assert.equal(await status(limiter, { email: `junk-${index}@example.test` }), 401);
  }
  assert.equal(await status(limiter, { email: "member@example.test" }, right), 200);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await status(limiter, { email: "member@example.test" }), 401);
  }
  assert.equal(await status(limiter, { email: "member@example.test" }, right), 429);
});

test("refused attempts create no entries, so flooding cannot reset spent budgets", async () => {
  const limiter = admission({ tableCapacity: 8 });
  const target = { clientAddress: "203.0.113.1", email: "member@example.test" };
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await status(limiter, target), 401);
  }
  assert.equal(await status(limiter, target), 429);
  for (let index = 0; index < 4; index += 1) {
    assert.equal(
      await status(limiter, { clientAddress: "203.0.113.2", email: `b-${index}@example.test` }),
      401,
    );
  }
  const flood = await Promise.all(
    Array.from({ length: 200 }, (_, index) =>
      status(limiter, { clientAddress: "203.0.113.2", email: `flood-${index}@example.test` }),
    ),
  );
  assert.deepEqual(new Set(flood), new Set([429]));
  assert.equal(await status(limiter, target), 429);
  assert.equal(
    await status(limiter, { clientAddress: "203.0.113.3", email: "member@example.test" }, right),
    429,
  );
});

test("a full table never evicts spent entries and slows new keys instead of refusing", async () => {
  const limiter = admission({ tableCapacity: 4 });
  // Two addresses each spend one failure on a distinct email: four spent entries.
  for (const index of [1, 2]) {
    assert.equal(
      await status(limiter, {
        clientAddress: `203.0.113.${index}`,
        email: `x-${index}@example.test`,
      }),
      401,
    );
  }
  const started = performance.now();
  assert.equal(
    await status(limiter, { clientAddress: "198.51.100.9", email: "member@example.test" }, right),
    200,
  );
  assert.ok(performance.now() - started >= slow.floorMs - 2, "untracked attempts are paced");
  assert.equal(
    await status(limiter, { clientAddress: "198.51.100.9", email: "member@example.test" }),
    401,
  );
  // The spent entries survived: x-1 still carries its failure toward its budget.
  for (let index = 0; index < 2; index += 1) {
    assert.equal(
      await status(limiter, { clientAddress: "203.0.113.1", email: "x-1@example.test" }),
      401,
    );
  }
  assert.equal(
    await status(limiter, { clientAddress: "203.0.113.1", email: "x-1@example.test" }, right),
    429,
  );
});

test("an administrator is slowed, never refused, and slow guesses are bounded", async () => {
  const email = "admin@example.test";
  const limiter = admission({ administrators: [email] });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await status(limiter, { clientAddress: `203.0.113.${index}`, email }), 401);
  }
  let running = 0;
  let peak = 0;
  const guess = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running -= 1;
    throw new WrongPassword("wrong");
  };
  const guesses = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      status(limiter, { clientAddress: `203.0.114.${index}`, email }, guess),
    ),
  );
  assert.deepEqual(new Set(guesses), new Set([429]));
  assert.ok(peak <= slow.concurrentPerEmail, `peak ${peak}`);
  const started = performance.now();
  assert.equal(await status(limiter, { clientAddress: "198.51.100.1", email }, right), 200);
  assert.ok(performance.now() - started >= slow.maxFloorMs - 2, "the floor grew to its cap");
});

test("refusals take the growing floor whether or not the email administers", async () => {
  const limiter = admission({ administrators: ["admin@example.test"] });
  const client = "203.0.113.9";
  for (let index = 0; index < 4; index += 1) {
    assert.equal(await status(limiter, { clientAddress: client, email: `f-${index}@x.test` }), 401);
  }
  const expected = [20, 40, 80, 80];
  const emails = ["member@x.test", "admin@example.test", "missing@x.test", "admin@example.test"];
  for (const [index, email] of emails.entries()) {
    const started = performance.now();
    assert.equal(await status(limiter, { clientAddress: client, email }), 429);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= expected[index] - 2, `refusal ${index}: ${elapsed} ms`);
    assert.ok(elapsed < expected[index] + 60, `refusal ${index}: ${elapsed} ms`);
  }
});

test("a failing administrator lookup surfaces as a dependency error", async () => {
  const outage = new Error("database unavailable");
  const limiter = admission({
    isReserved: async () => {
      throw outage;
    },
  });
  const email = "someone@example.test";
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await status(limiter, { email }), 401);
  }
  const { error } = await outcome(limiter.admit({ email }, right));
  assert.equal(error, outage);
});

test("a success resets the email's failures but not the address's", async () => {
  const limiter = admission();
  const email = "typo@example.test";
  for (let index = 0; index < 2; index += 1) {
    assert.equal(await status(limiter, { email }), 401);
  }
  assert.equal(await status(limiter, { email }, right), 200);
  // The earlier typos no longer count: the email has its whole budget again, and no more.
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await status(limiter, { email }), 401, `failure ${index}`);
  }
  assert.equal(await status(limiter, { email }, right), 429);

  // The address lane is shared by every account behind it, so one success clears nothing.
  const clientAddress = "203.0.113.40";
  for (let index = 0; index < 2; index += 1) {
    assert.equal(await status(limiter, { clientAddress, email: "own@example.test" }), 401);
  }
  assert.equal(await status(limiter, { clientAddress, email: "own@example.test" }, right), 200);
  for (let index = 0; index < 2; index += 1) {
    assert.equal(await status(limiter, { clientAddress, email: "other@example.test" }), 401);
  }
  assert.equal(await status(limiter, { clientAddress, email: "third@example.test" }), 429);
});

test("entering the slow lane reports once per lane per window, with hashed keys", async () => {
  const reports = [];
  const limiter = admission({ onLimited: (limited) => reports.push(limited) });
  const email = "victim@example.test";
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await status(limiter, { email }), 401);
  }
  assert.deepEqual(reports, []);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await status(limiter, { email }), 429);
  }
  assert.equal(reports.length, 1);
  assert.equal(reports[0].lane, "email");
  assert.match(reports[0].key, /^email:[a-f0-9]{64}$/);

  const clientAddress = "203.0.113.77";
  for (let index = 0; index < 4; index += 1) {
    assert.equal(await status(limiter, { clientAddress, email: `a-${index}@example.test` }), 401);
  }
  for (let index = 0; index < 2; index += 1) {
    assert.equal(await status(limiter, { clientAddress, email: `b-${index}@example.test` }), 429);
  }
  assert.equal(reports.length, 2);
  assert.equal(reports[1].lane, "address");
  assert.match(reports[1].key, /^ip:[a-f0-9]{64}$/);
  const serialized = JSON.stringify(reports);
  assert.equal(serialized.includes("victim"), false);
  assert.equal(serialized.includes("203.0.113"), false);
});

test("a full table reports the untracked lane once, and a failing reporter changes nothing", async () => {
  const reports = [];
  const limiter = admission({
    tableCapacity: 2,
    onLimited: (limited) => {
      reports.push(limited);
      throw new Error("log sink unavailable");
    },
  });
  assert.equal(await status(limiter, { clientAddress: "203.0.113.1", email: "x@x.test" }), 401);
  for (let index = 0; index < 2; index += 1) {
    assert.equal(
      await status(limiter, { clientAddress: "198.51.100.9", email: `m-${index}@x.test` }, right),
      200,
    );
  }
  assert.deepEqual(reports, [{ lane: "untracked" }]);
});

test("a known device keeps its own budget when the email lane is exhausted", async () => {
  const limiter = admission();
  const email = "victim@example.test";
  const device = { email, knownDevice: "device-1" };
  // Strangers spend the victim's email lane (T1): ordinary attempts are now refused.
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await status(limiter, { email }), 401);
  }
  assert.equal(await status(limiter, { email }, right), 429);
  // The victim's known browser still has its password checked at once, repeatedly.
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    assert.equal(await status(limiter, device, right), 200);
    assert.ok(performance.now() - started < slow.floorMs, "not paced");
  }
  // Every known device of the account has its own lane.
  assert.equal(await status(limiter, { email, knownDevice: "device-2" }, right), 200);
});

test("a known device's failures spend the device lane, not the email lane", async () => {
  const limiter = admission();
  const email = "member@example.test";
  const device = { email, knownDevice: "device-1" };
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await status(limiter, device), 401);
  }
  // The device's lane is spent: it is limited like an email, and a correct non-administrator
  // password is refused there, so a stolen cookie buys only its own budget.
  assert.equal(await status(limiter, device, right), 429);
  // The email lane is untouched: other browsers are unaffected by that device's typos.
  assert.equal(await status(limiter, { email }, right), 200);
});

test("strangers holding the email's slow-lane slots do not crowd out a known device", async () => {
  const email = "admin@example.test";
  const limiter = admission({ administrators: [email] });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await status(limiter, { email }), 401);
  }
  // T2: enough concurrent slow attempts to fill the email's running and waiting slots.
  const flood = Array.from({ length: slow.concurrentPerEmail + slow.waitingPerEmail }, () =>
    status(limiter, { email }),
  );
  // Without the cookie, the administrator's own attempt finds the wait list full and is
  // refused after the floor, however correct its password.
  assert.equal(await status(limiter, { email }, right), 429);
  // With it, the administrator signs in without waiting on the email's slots.
  const started = performance.now();
  assert.equal(await status(limiter, { email, knownDevice: "admin-browser" }, right), 200);
  assert.ok(performance.now() - started < slow.floorMs, "not queued behind the flood");
  assert.deepEqual(new Set(await Promise.all(flood)), new Set([429]));
});

test("a known device is still bound by the client address lane", async () => {
  const limiter = admission();
  const clientAddress = "203.0.113.90";
  for (let index = 0; index < 4; index += 1) {
    assert.equal(await status(limiter, { clientAddress, email: `junk-${index}@x.test` }), 401);
  }
  // The address lane is spent; a known device of a non-administrator behind it is refused.
  assert.equal(
    await status(
      limiter,
      { clientAddress, email: "member@example.test", knownDevice: "device-1" },
      right,
    ),
    429,
  );
});
