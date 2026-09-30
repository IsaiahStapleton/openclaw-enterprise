import assert from "node:assert/strict";
import test from "node:test";
import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";

const baseURL = "http://127.0.0.1";
const email = "audited@example.test";
const password = "audited-account-password";

function controller(audit, extra = {}) {
  const memoryDatabase = { user: [], session: [], account: [], verification: [], apikey: [] };
  const auth = createControllerAuth({
    mode: "development",
    installationId: "ins_sign_in_audit",
    baseURL,
    secret: "password-sign-in-audit-secret-at-least-32-bytes",
    secureCookies: false,
    memoryDatabase,
    passwordSignInAudit: audit,
    ...extra,
  });
  return { auth, memoryDatabase };
}

async function signIn(auth, body) {
  const sent = { status: 200, headers: {} };
  const reply = {
    header(name, value) {
      sent.headers[name] = value;
      return reply;
    },
    status(code) {
      sent.status = code;
      return reply;
    },
    send(payload) {
      sent.payload = payload;
      return reply;
    },
  };
  await auth.signInEmail(
    {
      id: "req_audit",
      ip: "127.0.0.1",
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: baseURL },
      body,
    },
    reply,
  );
  return sent;
}

test("a password-only sign-in reports its outcome to the audit seam", async () => {
  const outcomes = [];
  const { auth, memoryDatabase } = controller({
    accepted: async (userId) => outcomes.push(["accepted", userId]),
    refused: async () => outcomes.push(["refused"]),
  });
  const account = await auth.createAccount({ email, password });
  assert.equal((await signIn(auth, { email, password })).status, 200);
  assert.equal((await signIn(auth, { email, password: "wrong-password-guess" })).status, 401);
  assert.equal(
    (await signIn(auth, { email: "nobody@example.test", password: "wrong-password-guess" })).status,
    401,
  );
  assert.deepEqual(outcomes, [["accepted", account.id], ["refused"], ["refused"]]);
  assert.equal(memoryDatabase.session.length, 1);
});

test("a sign-in whose audit cannot be written is refused and its session revoked", async () => {
  const { auth, memoryDatabase } = controller({
    accepted: async () => {
      throw new Error("audit unavailable");
    },
    refused: async () => {},
  });
  await auth.createAccount({ email, password });
  const response = await signIn(auth, { email, password });
  assert.equal(response.status, 503, JSON.stringify(response.payload));
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(memoryDatabase.session.length, 0);
});

test("a wrong password whose denial audit fails is 503 and still spends the budget", async () => {
  let refusals = 0;
  const events = [];
  const { auth } = controller(
    {
      accepted: async () => {},
      refused: async () => {
        refusals += 1;
        throw new Error("audit unavailable");
      },
    },
    { onOperationalEvent: (event) => events.push(event) },
  );
  await auth.createAccount({ email, password });
  const statuses = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    statuses.push((await signIn(auth, { email, password: "wrong-password-guess" })).status);
  }
  // The audit outage is reported, never hidden behind a 401.
  assert.deepEqual(new Set(statuses), new Set([503]));
  assert.equal(refusals, 10);
  // Every failed guess counted: the next attempt is refused before the password is checked.
  const limited = await signIn(auth, { email, password: "wrong-password-guess" });
  assert.equal(limited.status, 429, JSON.stringify(limited.payload));
  assert.equal(refusals, 10);
  assert.deepEqual(
    events.map(({ event, lane }) => [event, lane]),
    [["authentication.sign-in-limited", "email"]],
  );
});
