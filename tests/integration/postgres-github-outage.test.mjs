import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  bootstrapProductionInstallation,
  composeProductionSignIn,
  consoleOrigin as origin,
  currentSession,
  defaultInstallSettings,
  githubUpgradeSettings,
  passwordSignIn,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const adminEmail = "outage-recovery@example.test";
const password = "outage-member-password";
const authSecret = "outage-auth-test-secret-at-least-32-bytes";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-github-login/client-id": "outage-client-id",
  "occ-github-login/client-secret": "outage-client-secret",
};
const memberSubject = 7_000_001;

// GitHub is optional: when it errors or stalls, GitHub sign-in fails closed and password
// sign-in, including the recovery administrator's reserved lane, keeps working.
// The provider fixture replaces only remote HTTP to github.com and api.github.com.
test(
  "a GitHub outage fails GitHub sign-in closed while password sign-in keeps working",
  { skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL for real PostgreSQL proof." },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    const held = new pg.Client({ connectionString: databaseUrl });
    const provider = createServer();
    let mode = "up";
    let app;
    t.after(async () => {
      await held.end().catch(() => {});
      await app?.close();
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      await pool.end();
    });
    provider.on("request", async (request, response) => {
      if (mode === "hang") {
        return; // Never answers; the controller's shared provider deadline must end the wait.
      }
      if (mode === "error") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      for await (const chunk of request) {
        void chunk;
      }
      response.setHeader("content-type", "application/json");
      if (request.url === "/login/oauth/access_token") {
        response.end(JSON.stringify({ access_token: "ghu_outage_fixture", token_type: "bearer" }));
      } else if (request.url === "/user") {
        response.end(JSON.stringify({ id: memberSubject, login: "outage-member" }));
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
    const originalFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin === "https://github.com" || url.origin === "https://api.github.com") {
        return originalFetch(new URL(url.pathname + url.search, providerOrigin), init);
      }
      return originalFetch(input, init);
    });

    const adminPassword = await bootstrapProductionInstallation(t, {
      databaseUrl,
      email: adminEmail,
      authSecret,
    });
    const admin = { email: adminEmail, password: adminPassword };
    const installation = await state.loadInstallation();
    const readerRole = (await state.loadNativeIAMState(installation.id)).roles.find((role) =>
      role.permissions.some(
        (permission) => permission.action === "read" && permission.resourceKind === "installation",
      ),
    );

    // Password onboarding on the default install, then the GitHub upgrade.
    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: defaultInstallSettings,
      secrets,
    });
    let adminHeaders = await signedInHeaders(app, origin, admin);
    const adminId = (await currentSession(app, adminHeaders.cookie)).user.id;
    const members = [];
    for (const email of ["outage-member@example.test", "outage-other@example.test"]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/auth/accounts",
        headers: adminHeaders,
        payload: { email, password, roleId: readerRole.id },
      });
      assert.equal(created.statusCode, 201, created.body);
      members.push({ id: created.json().data.id, email, password });
    }
    const [member, other] = members;
    await app.close();
    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: githubUpgradeSettings(adminId),
      secrets,
    });
    adminHeaders = await signedInHeaders(app, origin, admin);
    const account = await app.inject({
      url: `/api/auth/accounts/${member.id}`,
      headers: adminHeaders,
    });
    const attached = await app.inject({
      method: "POST",
      url: `/api/auth/accounts/${member.id}/providers/github`,
      headers: adminHeaders,
      payload: { subject: String(memberSubject), expectedVersion: account.json().data.version },
    });
    assert.equal(attached.statusCode, 200, attached.body);

    async function githubSignIn(remoteAddress = "192.0.2.50") {
      const start = await app.inject({
        method: "POST",
        url: "/api/auth/providers/github/start",
        remoteAddress,
        headers: { origin },
      });
      assert.equal(start.statusCode, 200, start.body);
      const attemptState = new URL(start.json().data.url).searchParams.get("state");
      return app.inject({
        url: `/api/auth/providers/github/callback?state=${attemptState}&code=outage-code`,
        remoteAddress,
        headers: { cookie: cookieHeaderFromSetCookie(start.headers["set-cookie"]) },
      });
    }
    const sessionCount = async () =>
      (await pool.query("SELECT count(*)::int AS count FROM occ.session")).rows[0].count;
    async function assertFailedClosed(callback, sessionsBefore) {
      assert.equal(callback.statusCode, 302);
      assert.equal(callback.headers.location, "/console/?authError=github");
      assert.equal(callback.headers["set-cookie"], undefined);
      assert.equal(await sessionCount(), sessionsBefore, "no session is issued");
    }

    await t.test("the fixture provider signs the attached account in while up", async () => {
      const callback = await githubSignIn();
      assert.equal(callback.headers.location, "/console/", callback.body);
      const cookie = cookieHeaderFromSetCookie(callback.headers["set-cookie"]);
      assert.equal((await currentSession(app, cookie)).user.id, member.id);
    });

    await t.test("provider 5xx fails closed; password sign-in keeps working", async () => {
      mode = "error";
      const before = await sessionCount();
      await assertFailedClosed(await githubSignIn(), before);
      const signedIn = await passwordSignIn(app, origin, member);
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      const cookie = cookieHeaderFromSetCookie(signedIn.headers["set-cookie"]);
      assert.equal((await currentSession(app, cookie)).user.id, member.id);
      const signedOut = await app.inject({
        method: "POST",
        url: "/api/auth/sign-out",
        headers: { cookie, origin },
      });
      assert.equal(signedOut.statusCode, 200, signedOut.body);
      assert.equal(await currentSession(app, cookie), null);
    });

    await t.test(
      "a hung provider fails closed at the deadline without blocking passwords",
      async () => {
        mode = "hang";
        const before = await sessionCount();
        const started = performance.now();
        const pending = githubSignIn();
        // Password sign-in proceeds while the provider exchange is stalled.
        const signedIn = await passwordSignIn(app, origin, member, "192.0.2.51");
        assert.equal(signedIn.statusCode, 200, signedIn.body);
        const callback = await pending;
        const elapsed = performance.now() - started;
        assert.ok(elapsed >= 9_000 && elapsed < 20_000, `deadline elapsed ${elapsed} ms`);
        await assertFailedClosed(callback, before + 1);
      },
    );

    await t.test("the recovery administrator keeps a reserved lane under a flood", async () => {
      mode = "error";
      // Hold the shared lane's four global slots: password attempts for two ordinary accounts
      // from four client addresses wait on their user rows, locked by another client.
      await held.connect();
      await held.query("BEGIN");
      await held.query(`SELECT id FROM occ."user" WHERE id = ANY($1) FOR UPDATE`, [
        [member.id, other.id],
      ]);
      const flood = [
        [member, "198.51.100.1"],
        [member, "198.51.100.2"],
        [other, "198.51.100.3"],
        [other, "198.51.100.4"],
      ].map(([target, address]) => passwordSignIn(app, origin, target, address));
      const deadline = performance.now() + 10_000;
      for (;;) {
        const waiting = (
          await pool.query(
            `SELECT count(*)::int AS count FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          )
        ).rows[0].count;
        if (waiting === 4) {
          break;
        }
        assert.ok(performance.now() < deadline, `only ${waiting} flood attempts are admitted`);
        await delay(20);
      }
      try {
        const refused = await passwordSignIn(
          app,
          origin,
          { email: "outage-third@example.test", password },
          "203.0.113.9",
        );
        assert.equal(refused.statusCode, 429, "the shared lane is exhausted");
        const recovery = await passwordSignIn(app, origin, admin, "198.51.100.1");
        assert.equal(recovery.statusCode, 200, recovery.body);
        const cookie = cookieHeaderFromSetCookie(recovery.headers["set-cookie"]);
        assert.equal((await currentSession(app, cookie)).user.id, adminId);
        assert.equal(
          (await githubSignIn("203.0.113.10")).headers.location,
          "/console/?authError=github",
        );
      } finally {
        await held.query("COMMIT");
      }
      for (const response of await Promise.all(flood)) {
        assert.equal(response.statusCode, 200, response.body);
      }
    });

    await t.test("GitHub sign-in recovers without a restart", async () => {
      mode = "up";
      const callback = await githubSignIn("192.0.2.60");
      assert.equal(callback.headers.location, "/console/", callback.body);
    });

    // Known-device cookie in the guarded profile: a browser that signed in to an account
    // before spends its own lane instead of the email's (or the shared recovery lane), so a
    // stranger who knows the email cannot keep that browser out. The cookie never signs in.
    const knownDeviceOf = (response) =>
      [response.headers["set-cookie"] ?? []]
        .flat()
        .find((value) => value.startsWith("__Host-occ_known_device="))
        ?.split(";", 1)[0];
    const signInWith = (cookie, account, remoteAddress) =>
      app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        remoteAddress,
        headers: { origin, cookie },
        payload: { email: account.email, password: account.password },
      });
    const wrong = "outage-wrong-password";

    await t.test("a GitHub sign-in marks the browser for password fallback", async () => {
      mode = "up";
      const callback = await githubSignIn("192.0.2.61");
      assert.equal(callback.headers.location, "/console/", callback.body);
      const setCookie = [callback.headers["set-cookie"]]
        .flat()
        .find((value) => value.startsWith("__Host-occ_known_device="));
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /Secure/i);
      assert.match(setCookie, /SameSite=Strict/i);
      assert.match(setCookie, /Path=\//);
      assert.doesNotMatch(setCookie, /Domain=/i);
      const refused = await passwordSignIn(
        app,
        origin,
        { ...member, password: wrong },
        "192.0.2.61",
      );
      assert.equal(refused.statusCode, 401);
      assert.equal(knownDeviceOf(refused), undefined, "a failure marks nothing");
    });

    await t.test(
      "a known browser keeps signing in while strangers spend the member's email",
      async () => {
        const signedIn = await passwordSignIn(app, origin, member, "192.0.2.62");
        assert.equal(signedIn.statusCode, 200, signedIn.body);
        const device = knownDeviceOf(signedIn);
        assert.ok(device, "a password sign-in marks the browser");
        // Strangers from many addresses spend the member's email key.
        let refusedAt;
        for (let index = 0; index < 12 && refusedAt === undefined; index += 1) {
          const response = await passwordSignIn(
            app,
            origin,
            { ...member, password: wrong },
            `203.0.113.${140 + index}`,
          );
          if (response.statusCode === 429) {
            refusedAt = index;
          } else {
            assert.equal(response.statusCode, 401, response.body);
          }
        }
        assert.notEqual(refusedAt, undefined, "the email key is spent");
        assert.equal(
          (await passwordSignIn(app, origin, member, "192.0.2.63")).statusCode,
          429,
          "a new browser is refused",
        );
        const known = await signInWith(device, member, "192.0.2.62");
        assert.equal(known.statusCode, 200, known.body);
        const cookie = cookieHeaderFromSetCookie(known.headers["set-cookie"]);
        assert.equal((await currentSession(app, cookie)).user.id, member.id);
        // The cookie is bound to its account and grants nothing for another email.
        const foreign = await signInWith(device, { ...other, password: wrong }, "192.0.2.62");
        assert.equal(foreign.statusCode, 401);
        // A valid cookie never authenticates a wrong password.
        const guessed = await signInWith(device, { ...member, password: wrong }, "192.0.2.62");
        assert.equal(guessed.statusCode, 401);
      },
    );

    await t.test(
      "the recovery administrator's known browser survives a spent recovery lane",
      async () => {
        const signedIn = await passwordSignIn(app, origin, admin, "192.0.2.64");
        assert.equal(signedIn.statusCode, 200, signedIn.body);
        const device = knownDeviceOf(signedIn);
        // T5: anyone who knows the recovery email can spend its reserved lane.
        let spent = false;
        for (let index = 0; index < 25 && !spent; index += 1) {
          const response = await passwordSignIn(
            app,
            origin,
            { ...admin, password: wrong },
            `203.0.113.${170 + index}`,
          );
          spent = response.statusCode === 429;
        }
        assert.ok(spent, "the recovery lane is spent");
        assert.equal((await passwordSignIn(app, origin, admin, "192.0.2.65")).statusCode, 429);
        const known = await signInWith(device, admin, "192.0.2.64");
        assert.equal(known.statusCode, 200, known.body);
        const cookie = cookieHeaderFromSetCookie(known.headers["set-cookie"]);
        assert.equal((await currentSession(app, cookie)).user.id, adminId);
      },
    );
  },
);
