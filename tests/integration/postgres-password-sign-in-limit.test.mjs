import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  bootstrapProductionInstallation,
  composeProductionSignIn,
  consoleOrigin as origin,
  defaultInstallSettings,
  installationRoles,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const adminEmail = "limit-admin@example.test";
const authSecret = "password-limit-auth-test-secret-at-least-32-bytes";
const secrets = { "occ-auth/secret": authSecret };
const ingress = "10.0.0.9";
const wrongPassword = "wrong-guess-password";

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// The default install (no external provider) behind a trusted ingress: password sign-in
// admission keys on the resolved client address and the email, counts only failures, and
// keeps a reserved lane for Installation administrators.
test(
  "password-only sign-in limits failures per client and email with a reserved administrator lane",
  { skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL for real PostgreSQL proof." },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    let app;
    t.after(async () => {
      await app?.close();
      await pool.end();
    });
    const adminPassword = await bootstrapProductionInstallation(t, {
      databaseUrl,
      email: adminEmail,
      authSecret,
    });
    const admin = { email: adminEmail, password: adminPassword };
    const roles = await installationRoles(state, pool);
    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: { ...defaultInstallSettings, OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/24" },
      secrets,
    });
    const signIn = (client, account) =>
      app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        remoteAddress: ingress,
        headers: { origin, "x-forwarded-for": client },
        payload: account,
      });
    const timed = async (client, account) => {
      const started = performance.now();
      const response = await signIn(client, account);
      return { response, elapsed: performance.now() - started };
    };
    const adminHeaders = await signedInHeaders(app, origin, admin);
    const accountPassword = "limit-account-password";
    const createAccount = async (email, roleId) => {
      const created = await app.inject({
        method: "POST",
        url: "/api/auth/accounts",
        headers: adminHeaders,
        payload: { email, password: accountPassword, roleId },
      });
      assert.equal(created.statusCode, 201, created.body);
      return { email, password: accountPassword };
    };
    const member = await createAccount("limit-member@example.test", roles.reader.id);
    const secondAdmin = await createAccount("limit-second-admin@example.test", roles.admin.id);

    await t.test("repeated successful sign-ins are not limited", async () => {
      for (let index = 0; index < 30; index += 1) {
        const response = await signIn("198.51.100.1", member);
        assert.equal(response.statusCode, 200, `sign-in ${index}: ${response.body}`);
      }
    });

    const attacker = "203.0.113.7";
    await t.test(
      "a flood of wrong passwords from one client gets 429 with Retry-After",
      async () => {
        for (let index = 0; index < 20; index += 1) {
          const response = await signIn(attacker, {
            email: `guess-${index}@example.test`,
            password: wrongPassword,
          });
          assert.equal(response.statusCode, 401, `guess ${index}: ${response.body}`);
        }
        const refused = await signIn(attacker, {
          email: "guess-20@example.test",
          password: wrongPassword,
        });
        assert.equal(refused.statusCode, 429, refused.body);
        assert.equal(refused.json().error.code, "RATE_LIMITED");
        const retryAfter = Number(refused.headers["retry-after"]);
        assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After ${retryAfter}`);
        // A correct password for an ordinary account does not pass the exhausted client.
        assert.equal((await signIn(attacker, member)).statusCode, 429);
      },
    );

    await t.test("another client still signs in", async () => {
      assert.equal((await signIn("198.51.100.2", member)).statusCode, 200);
    });

    await t.test("administrators still sign in from the exhausted client", async () => {
      const bootstrap = await signIn(attacker, admin);
      assert.equal(bootstrap.statusCode, 200, bootstrap.body);
      const second = await signIn(attacker, secondAdmin);
      assert.equal(second.statusCode, 200, second.body);
      // A wrong administrator password there is refused like any other attempt.
      assert.equal((await signIn(attacker, { ...admin, password: wrongPassword })).statusCode, 429);
    });

    await t.test(
      "guessing an administrator's password from many clients keeps the lane",
      async () => {
        for (let index = 0; index < 10; index += 1) {
          const response = await signIn(`203.0.113.${100 + index}`, {
            ...secondAdmin,
            password: wrongPassword,
          });
          assert.equal(response.statusCode, 401, `guess ${index}: ${response.body}`);
        }
        // The email's shared budget is spent; the reserved lane still admits the right password.
        assert.equal((await signIn("203.0.113.200", secondAdmin)).statusCode, 200);
      },
    );

    await t.test("existing and unknown emails look the same in status and timing", async () => {
      const client = "203.0.113.50";
      const existing = [];
      const unknown = [];
      // Shared lane: Better Auth hashes the password for unknown emails too.
      for (let index = 0; index < 5; index += 1) {
        const known = await timed(client, { ...member, password: wrongPassword });
        const missing = await timed(client, {
          email: `missing-${index}@example.test`,
          password: wrongPassword,
        });
        assert.equal(known.response.statusCode, 401);
        assert.equal(missing.response.statusCode, 401);
        existing.push(known.elapsed);
        unknown.push(missing.elapsed);
      }
      assert.ok(
        Math.abs(median(existing) - median(unknown)) < 150,
        `shared lane medians ${median(existing)} vs ${median(unknown)} ms`,
      );
      for (let index = 0; index < 10; index += 1) {
        assert.equal(
          (await signIn(client, { email: `filler-${index}@example.test`, password: wrongPassword }))
            .statusCode,
          401,
        );
      }
      // Exhausted client: ordinary, unknown and wrong administrator attempts all wait out
      // the same refusal floor and return the same 429.
      const refusals = [];
      for (const account of [
        { ...member, password: wrongPassword },
        { email: "missing-after@example.test", password: wrongPassword },
        { ...admin, password: wrongPassword },
        { ...member, password: wrongPassword },
        { email: "missing-again@example.test", password: wrongPassword },
        { ...admin, password: wrongPassword },
      ]) {
        const { response, elapsed } = await timed(client, account);
        assert.equal(response.statusCode, 429, response.body);
        refusals.push({ elapsed, retryAfter: response.headers["retry-after"] });
      }
      const elapsed = refusals.map((refusal) => refusal.elapsed);
      assert.ok(Math.min(...elapsed) >= 990, `refusal floor: ${elapsed.join(", ")}`);
      assert.ok(Math.max(...elapsed) - Math.min(...elapsed) < 400, `spread: ${elapsed.join(", ")}`);
      for (const { retryAfter } of refusals) {
        assert.ok(Number(retryAfter) >= 1 && Number(retryAfter) <= 60, `Retry-After ${retryAfter}`);
      }
    });
  },
);
