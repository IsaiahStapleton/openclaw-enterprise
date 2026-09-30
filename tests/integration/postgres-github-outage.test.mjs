import assert from "node:assert/strict";
import { createServer } from "node:http";
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
  installationRoles,
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
// sign-in keeps working; strangers can slow the recovery administrator's password but never
// refuse it.
// The provider fixture replaces only remote HTTP to github.com and api.github.com.
test(
  "a GitHub outage fails GitHub sign-in closed while password sign-in keeps working",
  { skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL for real PostgreSQL proof." },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    const provider = createServer();
    let mode = "up";
    let app;
    t.after(async () => {
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
    // Members read the Installation but do not administer it, so a spent email refuses them.
    const { reader: readerRole } = await installationRoles(state, pool);

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

    const wrong = "outage-wrong-password";

    await t.test("successful password sign-ins spend no budget during an outage", async () => {
      mode = "error";
      // Only failed sign-ins count: more successes in one minute than the ten-failure budget
      // from one address all sign in.
      for (let index = 0; index < 12; index += 1) {
        const signedIn = await passwordSignIn(app, origin, other, "198.51.100.1");
        assert.equal(signedIn.statusCode, 200, signedIn.body);
      }
      assert.equal(
        (await githubSignIn("203.0.113.10")).headers.location,
        "/console/?authError=github",
      );
    });

    await t.test(
      "without a trusted proxy, one ingress address is never an Installation-wide budget",
      async () => {
        // The fixture sets no trusted proxy, so every browser reaches the API from one
        // address. Failures there for many emails spend only those emails' budgets.
        const ingress = "198.51.100.1";
        for (let index = 0; index < 25; index += 1) {
          const response = await passwordSignIn(
            app,
            origin,
            { email: `outage-guess-${index}@example.test`, password: wrong },
            ingress,
          );
          assert.equal(response.statusCode, 401, response.body);
        }
        const signedIn = await passwordSignIn(app, origin, member, ingress);
        assert.equal(signedIn.statusCode, 200, signedIn.body);
        // External start has no per-minute budget to spend, and junk callbacks without the
        // browser's attempt cookie spend only their own key, never a real browser's.
        mode = "up";
        for (let index = 0; index < 35; index += 1) {
          const start = await app.inject({
            method: "POST",
            url: "/api/auth/providers/github/start",
            remoteAddress: ingress,
            headers: { origin },
          });
          assert.equal(start.statusCode, 200, start.body);
        }
        for (let index = 0; index < 35; index += 1) {
          const junk = await app.inject({
            url: `/api/auth/providers/github/callback?state=${"j".repeat(43)}&code=junk`,
            remoteAddress: ingress,
          });
          assert.equal(junk.headers.location, "/console/?authError=github");
        }
        const callback = await githubSignIn(ingress);
        assert.equal(callback.headers.location, "/console/", callback.body);
      },
    );

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

    await t.test("strangers spending the recovery email slow it but never refuse it", async () => {
      const signedIn = await passwordSignIn(app, origin, admin, "192.0.2.64");
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      const device = knownDeviceOf(signedIn);
      assert.ok(device, "a password sign-in marks the browser");
      // Anyone who knows the recovery email can spend its budget.
      let refused;
      for (let index = 0; index < 12 && refused === undefined; index += 1) {
        const response = await passwordSignIn(
          app,
          origin,
          { ...admin, password: wrong },
          `203.0.113.${170 + index}`,
        );
        if (response.statusCode === 429) {
          refused = response;
        } else {
          assert.equal(response.statusCode, 401, response.body);
        }
      }
      assert.ok(refused, "the recovery email's budget is spent");
      assert.ok(Number(refused.headers["retry-after"]) >= 1, "refusals carry Retry-After");
      // A new browser's correct recovery password is still checked, after the slowed floor.
      const started = performance.now();
      const slowed = await passwordSignIn(app, origin, admin, "192.0.2.65");
      assert.equal(slowed.statusCode, 200, slowed.body);
      assert.ok(performance.now() - started >= 1_000, "the attempt was slowed");
      assert.equal(
        (await currentSession(app, cookieHeaderFromSetCookie(slowed.headers["set-cookie"]))).user
          .id,
        adminId,
      );
      // The browser that signed in before spends its own lane instead.
      const known = await signInWith(device, admin, "192.0.2.64");
      assert.equal(known.statusCode, 200, known.body);
      const cookie = cookieHeaderFromSetCookie(known.headers["set-cookie"]);
      assert.equal((await currentSession(app, cookie)).user.id, adminId);
    });
  },
);
