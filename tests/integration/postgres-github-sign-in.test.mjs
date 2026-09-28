import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { chromium } from "playwright";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { composeProduction } from "../../apps/controller/src/composition/production.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const email = "github-recovery@example.test";
const password = "github-local-recovery-password";
const authSecret = "github-composed-auth-test-secret-at-least-32-bytes";
const providerAccessToken = "ghu_fixture_provider_token";
const providerRefreshToken = "ghr_fixture_provider_refresh_token";

// The provider fixture replaces only remote HTTP. State, audit, IAM, Better Auth,
// Fastify and the browser Console remain their ordinary implementations.
test(
  "PostgreSQL GitHub sign-in preserves an existing account through the ordinary Console",
  {
    skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL for real PostgreSQL proof.",
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    const apps = [];
    let browser;
    const provider = createServer();
    t.after(async () => {
      await browser?.close();
      for (const app of apps.reverse()) {
        await app.close();
      }
      await new Promise((resolve) => provider.close(resolve));
      await pool.end();
    });
    const bootstrap = await ensureDevelopmentBootstrap(t, {
      databaseUrl,
      email,
      password,
      authSecret,
      authBaseURL: "http://127.0.0.1",
      installationName: "GitHub browser proof",
    });
    const installation = await state.loadInstallation();
    const recovery = (await pool.query('SELECT id FROM occ."user" WHERE email = $1', [email]))
      .rows[0].id;
    const bootstrapPolicy = await state.loadNativeIAMState(installation.id);
    const principal = bootstrapPolicy.identities.find(
      (identity) => identity.kind === "principal" && identity.subject === recovery,
    );
    assert.ok(principal);
    // Configuration storage persists across controller restarts in this fixture.
    // No Agent is deployed; this proves the ordinary authorized detail read.
    const configurationDriver = createTestConfigurationDriver();
    const drivers = () => ({
      computeDriver: createDevelopmentComputeDriver(),
      configurationDriver,
    });
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const base = {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authSecret,
      authBaseURL: origin,
    };
    const unconfigured = await composePostgresDevelopment(base, drivers());
    apps.push(unconfigured);
    const admitted = Promise.withResolvers();
    const releaseAdmitted = Promise.withResolvers();
    t.after(() => releaseAdmitted.resolve());
    unconfigured.addHook("onRequest", async (request) => {
      if (request.url === "/api/auth/session?maintenance-drain") {
        admitted.resolve();
        await releaseAdmitted.promise;
      }
    });
    await unconfigured.listen({ host: "127.0.0.1", port });
    assert.equal(
      (await unconfigured.inject({ url: "/api/auth/providers" })).json().data.github,
      false,
    );
    const legacy = await unconfigured.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password },
    });
    assert.equal(legacy.statusCode, 200);
    const legacyCookie = cookieHeaderFromSetCookie(legacy.headers["set-cookie"]);
    const legacyHeaders = { cookie: legacyCookie, origin };
    const role = bootstrapPolicy.roles.find((candidate) =>
      candidate.permissions.some(
        (permission) => permission.action === "read" && permission.resourceKind === "installation",
      ),
    );
    const created = await unconfigured.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: legacyHeaders,
      payload: { email: "github-limited@example.test", password, roleId: role.id },
    });
    assert.equal(created.statusCode, 201, created.body);
    const limited = created.json().data;
    const namespaceId = (
      await unconfigured.inject({ url: "/namespaces", headers: legacyHeaders })
    ).json().data[0].id;
    const configuration = await unconfigured.inject({
      method: "POST",
      url: `/namespaces/${namespaceId}/configurations`,
      headers: legacyHeaders,
      payload: { kind: "agent", values: {} },
    });
    assert.equal(configuration.statusCode, 201, configuration.body);
    const createdAgent = await unconfigured.inject({
      method: "POST",
      url: `/namespaces/${namespaceId}/agents`,
      headers: legacyHeaders,
      payload: {
        name: "Existing GitHub sign-in Agent",
        configurationId: configuration.json().data.id,
        harnessAuth: null,
      },
    });
    assert.equal(createdAgent.statusCode, 201, createdAgent.body);
    const agent = createdAgent.json().data;
    const before = await state.loadNativeIAMState(installation.id);

    // Exercise the real listener shutdown with a request already admitted by
    // Fastify. The hook controls timing only; app.close owns stop and drain.
    const drainingRequest = fetch(`${origin}/api/auth/session?maintenance-drain`, {
      headers: { cookie: legacyCookie },
    });
    await admitted.promise;
    let closed = false;
    const closing = unconfigured.close().then(() => {
      closed = true;
    });
    try {
      for (let i = 0; i < 100 && unconfigured.server.listening; i++) {
        await nextTurn();
      }
      assert.equal(unconfigured.server.listening, false);
      assert.equal(closed, false, "shutdown waits for admitted work");
      await assert.rejects(fetch(`${origin}/api/auth/session`), /fetch failed/);
      assert.equal(
        (await pool.query("SELECT count(*)::int AS count FROM occ.human_authentication_recovery"))
          .rows[0].count,
        0,
        "activation has not begun during the drain",
      );
    } finally {
      releaseAdmitted.resolve();
    }
    assert.equal((await (await drainingRequest).json()).data.user.id, recovery);
    await closing;
    assert.equal(closed, true);
    apps.pop();
    const config = {
      ...base,
      authBaseURL: origin,
      github: {
        clientId: "composed-client",
        clientSecret: "composed-secret",
        recoveryUserId: recovery,
      },
    };
    // Rejected startup must preserve the stopped Installation's legacy sessions
    // and leave its one-way enrollment/recovery transaction uncommitted.
    async function activationState() {
      const snapshot = {};
      for (const table of [
        "session",
        "human_authentication_accounts",
        "human_authentication_recovery",
      ]) {
        const rows = (
          await pool.query(
            `SELECT to_jsonb(row) AS value FROM occ.${table} AS row ORDER BY to_jsonb(row)::text`,
          )
        ).rows;
        // Hash full rows so a failed equality assertion cannot print session tokens.
        snapshot[table] = rows.map(({ value }) =>
          createHash("sha256").update(JSON.stringify(value)).digest("hex"),
        );
      }
      return snapshot;
    }
    const beforeInvalidConfiguration = await activationState();
    assert.ok(beforeInvalidConfiguration.session.length > 0);
    // Only the account created through the provisioning route is enrolled before activation.
    assert.deepEqual(
      (await pool.query("SELECT user_id FROM occ.human_authentication_accounts")).rows,
      [{ user_id: limited.id }],
    );
    assert.deepEqual(beforeInvalidConfiguration.human_authentication_recovery, []);
    const productionRuntime = await loadInstallationConfiguration({
      mode: "production",
      environment: {},
      startupConfiguration: {
        configuration: createInstallationDriverConfiguration(),
        logging: { level: "info" },
      },
    });
    assert.ok(productionRuntime);
    const productionConfig = {
      ...config,
      mode: "production",
      authBaseURL: "https://console.example.test",
      drivers: {
        ...drivers(),
        installation: productionRuntime.installation,
        createIAMDriver: (state) => new NativeIAMDriver(state),
      },
    };
    // Production server settings admit nonempty short secrets, so exercise the
    // production composition itself as well as the development browser path.
    const invalidConfigurations = [
      [
        "production short secret",
        () => composeProduction({ ...productionConfig, authSecret: "too-short" }),
        /OCC_AUTH_SECRET/,
      ],
      [
        "development short secret",
        () => composePostgresDevelopment({ ...config, authSecret: "too-short" }, drivers()),
        /OCC_AUTH_SECRET/,
      ],
      [
        "origin path",
        () =>
          composePostgresDevelopment({ ...config, authBaseURL: `${origin}/console` }, drivers()),
        /origin|BASE_URL/,
      ],
      [
        "origin query",
        () =>
          composePostgresDevelopment(
            { ...config, authBaseURL: `${origin}?preview=true` },
            drivers(),
          ),
        /origin|BASE_URL/,
      ],
      [
        "development incomplete native admin",
        () => composePostgresDevelopment({ ...config, nativeAdmin: { enabled: true } }, drivers()),
        /native administration|Native admin/,
      ],
      [
        "production incomplete native admin",
        () => composeProduction({ ...productionConfig, nativeAdmin: { enabled: true } }),
        /native administration|Native admin/,
      ],
    ];
    for (const [name, start, expectedError] of invalidConfigurations) {
      await t.test(name, async () => {
        await assert.rejects(async () => {
          const unexpectedApp = await start();
          apps.push(unexpectedApp);
        }, expectedError);
        assert.deepEqual(await activationState(), beforeInvalidConfiguration, name);
      });
    }
    const app = await composePostgresDevelopment(config, drivers());
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port });
    assert.equal(
      (await app.inject({ url: "/api/auth/session", headers: { cookie: legacyCookie } })).json()
        .data,
      null,
    );
    async function passwordLogin() {
      const result = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin },
        payload: { email, password },
      });
      assert.equal(result.statusCode, 200, result.body);
      return { cookie: cookieHeaderFromSetCookie(result.headers["set-cookie"]), origin };
    }
    async function readAccount(userId, requestHeaders) {
      const result = await app.inject({
        url: `/api/auth/accounts/${userId}`,
        headers: requestHeaders,
      });
      assert.equal(result.statusCode, 200, result.body);
      return result.json().data;
    }
    const local = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin },
      payload: { email, password },
    });
    assert.equal(local.statusCode, 200, local.body);
    const adminCookie = cookieHeaderFromSetCookie(local.headers["set-cookie"]);
    let headers = { cookie: adminCookie, origin };
    const serviceKey = JSON.parse(
      await readFile(join(bootstrap.directory, "initial-admin-service-key.json"), "utf8"),
    ).data.key;
    assert.equal(
      (await app.inject({ url: "/installation", headers: { "x-api-key": serviceKey } })).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: "/installation",
          headers: { ...headers, "x-api-key": "invalid-key" },
        })
      ).statusCode,
      401,
    );

    const attach = await app.inject({
      method: "POST",
      url: `/api/auth/accounts/${recovery}/providers/github`,
      headers,
      payload: {
        subject: "12345678",
        expectedVersion: (await readAccount(recovery, headers)).version,
      },
    });
    assert.equal(attach.statusCode, 200, attach.body);
    assert.equal(
      (await app.inject({ url: "/api/auth/session", headers })).json().data,
      null,
      "attachment invalidates old target sessions",
    );
    headers = await passwordLogin();
    const immutableBefore = await state.loadNativeIAMState(installation.id);
    assert.deepEqual(immutableBefore, before);

    let providerSubject = 12345678;
    let exchangeCount = 0;
    let providerRequestCount = 0;
    let providerAvailable = true;
    provider.on("request", async (request, response) => {
      providerRequestCount += 1;
      if (!providerAvailable) {
        response.writeHead(503);
        response.end("{}");
        return;
      }
      if (request.url === "/login/oauth/access_token") {
        exchangeCount += 1;
        let body = "";
        for await (const chunk of request) {
          body += chunk;
        }
        const input = new URLSearchParams(body);
        assert.equal(input.get("redirect_uri"), `${origin}/api/auth/providers/github/callback`);
        assert.ok(input.get("code_verifier"));
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            access_token: providerAccessToken,
            token_type: "bearer",
            scope: "",
            expires_in: 28800,
            refresh_token: providerRefreshToken,
            refresh_token_expires_in: 15897600,
          }),
        );
      } else if (request.url === "/user") {
        assert.equal(request.headers.authorization, `Bearer ${providerAccessToken}`);
        response.setHeader("content-type", "application/json");
        // GitHub email is deliberately absent. Only the numeric provider subject is identity.
        response.end(JSON.stringify({ id: providerSubject, login: "mutable-profile" }));
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

    async function start(target = app) {
      const response = await target.inject({
        method: "POST",
        url: "/api/auth/providers/github/start",
        headers: { origin },
      });
      assert.equal(response.statusCode, 200, response.body);
      const url = new URL(response.json().data.url);
      assert.equal(url.origin, "https://github.com");
      assert.equal(url.searchParams.has("scope"), false);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(
        url.searchParams.get("redirect_uri"),
        `${origin}/api/auth/providers/github/callback`,
      );
      const { attemptId } = response.json().data;
      assert.match(attemptId, /^[A-Za-z0-9_-]{43}$/);
      return {
        cookie: cookieHeaderFromSetCookie(response.headers["set-cookie"]),
        state: url.searchParams.get("state"),
        attemptId,
      };
    }
    const attempt = await start();
    // Use a live attempt and authorized enrollment inputs so these requests prove
    // route rejection before provider work or account changes, not invalid input.
    const accountBeforeRejectedRoutes = await readAccount(limited.id, headers);
    const rejectedEnrollment = {
      subject: "22222222",
      expectedVersion: accountBeforeRejectedRoutes.version,
    };
    for (const request of [
      { method: "POST", url: "/api/auth/github/start" },
      {
        method: "GET",
        url: `/api/auth/github/callback?state=${attempt.state}&code=fixture-code`,
      },
      { method: "POST", url: "/api/auth/providers/unregistered/start" },
      {
        method: "GET",
        url: `/api/auth/providers/unregistered/callback?state=${attempt.state}&code=fixture-code`,
      },
      {
        method: "POST",
        url: `/api/auth/accounts/${limited.id}/github`,
        payload: rejectedEnrollment,
      },
      {
        method: "POST",
        url: `/api/auth/accounts/${limited.id}/providers/unregistered`,
        payload: rejectedEnrollment,
      },
    ]) {
      const rejected = await app.inject({
        ...request,
        headers: { ...headers, cookie: `${headers.cookie}; ${attempt.cookie}` },
      });
      assert.equal(rejected.statusCode, 404, `${request.method} ${request.url.split("?")[0]}`);
      assert.equal(rejected.headers["set-cookie"], undefined);
      assert.equal(rejected.headers.location, undefined);
    }
    assert.equal(providerRequestCount, 0, "unregistered routes cannot contact the provider");
    assert.deepEqual(await readAccount(limited.id, headers), accountBeforeRejectedRoutes);

    const callbackPath = `/api/auth/providers/github/callback?state=${attempt.state}&code=fixture-code`;
    const callback = await app.inject({
      url: callbackPath,
      headers: { cookie: attempt.cookie },
    });
    assert.equal(callback.statusCode, 302);
    assert.equal(callback.headers.location, "/console/", callback.body);
    const githubCookie = cookieHeaderFromSetCookie(callback.headers["set-cookie"]);
    const session = await app.inject({
      url: "/api/auth/session",
      headers: { cookie: githubCookie },
    });
    assert.equal(session.json().data.user.id, recovery);
    const namespaces = await app.inject({
      url: "/namespaces",
      headers: { cookie: githubCookie },
    });
    assert.equal(namespaces.statusCode, 200, namespaces.body);
    assert.ok(namespaces.json().data.length > 0);
    assert.ok(namespaces.json().data.some((namespace) => namespace.id === namespaceId));
    assert.equal(
      (
        await app.inject({
          url: `/namespaces/${namespaceId}`,
          headers: { cookie: githubCookie },
        })
      ).statusCode,
      200,
    );
    assert.equal(exchangeCount, 1);
    const consumed = await app.inject({
      url: callbackPath,
      headers: { cookie: attempt.cookie },
    });
    assert.equal(consumed.headers.location, "/console/?authError=github");
    assert.equal(exchangeCount, 1, "a consumed callback cannot exchange again");

    // The redirect stays exactly /console/; only the HttpOnly receipt cookie tells
    // the starting tab which session its attempt created.
    const receipt = [callback.headers["set-cookie"]]
      .flat()
      .find((value) => value.startsWith("occ_login_receipt="));
    assert.ok(receipt);
    assert.match(receipt, /HttpOnly/i);
    assert.match(receipt, /SameSite=Strict/i);
    assert.match(receipt, /Max-Age=120/);
    const receiptCookie = receipt.split(";", 1)[0];
    const githubSessionCookie = githubCookie
      .split("; ")
      .filter((cookie) => !cookie.startsWith("occ_login_receipt="))
      .join("; ");
    async function result(attemptId, cookie, requestHeaders = { origin }) {
      return app.inject({
        method: "POST",
        url: "/api/auth/providers/github/result",
        headers: { ...requestHeaders, cookie },
        payload: { attemptId },
      });
    }
    async function sessionRows() {
      return (await pool.query("SELECT id, expires_at FROM occ.session ORDER BY id")).rows;
    }
    const sessionsBeforeResult = await sessionRows();
    // A cross-origin or Origin-less request cannot read the key, even with valid cookies.
    const withoutOrigin = await result(attempt.attemptId, githubCookie, {});
    assert.equal(withoutOrigin.statusCode, 403, withoutOrigin.body);
    // Like sign-out, a supplied Sec-Fetch-Site must be same-origin.
    const sameSite = await result(attempt.attemptId, githubCookie, {
      origin,
      "sec-fetch-site": "same-site",
    });
    assert.equal(sameSite.statusCode, 403, sameSite.body);
    // A different live attempt, such as another tab's, cannot claim this session.
    const otherTab = await start();
    const wrongAttempt = await result(otherTab.attemptId, githubCookie);
    assert.equal(wrongAttempt.statusCode, 401, wrongAttempt.body);
    // A later sign-in replaced the cookie: the receipt must not bind the new session.
    const replacedCookie = `${(await passwordLogin()).cookie}; ${receiptCookie}`;
    const replaced = await result(attempt.attemptId, replacedCookie);
    assert.equal(replaced.statusCode, 401, replaced.body);
    // An expired receipt is refused even while its browser cookie is still sent.
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 121_000 });
    let expired;
    try {
      expired = await result(attempt.attemptId, githubCookie);
    } finally {
      t.mock.timers.reset();
    }
    assert.equal(expired.statusCode, 401, expired.body);
    const confirmed = await result(attempt.attemptId, githubCookie);
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmed.headers["cache-control"], "no-store");
    const { sessionKey } = confirmed.json().data;
    assert.equal(
      (await app.inject({ url: "/api/auth/session", headers: { cookie: githubCookie } })).json()
        .data.sessionKey,
      sessionKey,
      "the result key names the session the callback issued",
    );
    const confirmedCookies = [confirmed.headers["set-cookie"]].flat().join("\n");
    assert.doesNotMatch(confirmedCookies, /session_token/, "the exchange issues no session");
    assert.match(confirmedCookies, /occ_login_receipt=;.*Max-Age=0/);
    // The password login above added a row; the exchange itself added or extended none.
    const sessionsAfterResult = await sessionRows();
    for (const row of sessionsBeforeResult) {
      assert.deepEqual(
        sessionsAfterResult.find((candidate) => candidate.id === row.id),
        row,
      );
    }
    assert.equal(sessionsAfterResult.length, sessionsBeforeResult.length + 1);
    // Replaying a copied receipt after the browser cleared it is refused.
    const replay = await result(attempt.attemptId, githubCookie);
    assert.equal(replay.statusCode, 401, replay.body);
    // The key narrows protected API admission: absent keeps the cookie contract,
    // a matching key admits, and a foreign, malformed or duplicated key rejects.
    // A key without the cookie never selects a session.
    const foreignKey = (
      await app.inject({ url: "/api/auth/session", headers: { cookie: headers.cookie } })
    ).json().data.sessionKey;
    for (const [requestHeaders, status] of [
      [{ cookie: githubSessionCookie }, 200],
      [{ cookie: githubSessionCookie, "x-occ-session-key": sessionKey }, 200],
      [{ cookie: githubSessionCookie, "x-occ-session-key": foreignKey }, 401],
      [{ cookie: githubSessionCookie, "x-occ-session-key": "malformed" }, 401],
      [{ cookie: githubSessionCookie, "x-occ-session-key": [sessionKey, sessionKey] }, 401],
      [{ "x-occ-session-key": sessionKey }, 401],
    ]) {
      const narrowed = await app.inject({ url: "/namespaces", headers: requestHeaders });
      assert.equal(narrowed.statusCode, status, narrowed.body);
    }

    // Unknown provider identities cannot create accounts, even when local account data exists.
    providerSubject = 87654321;
    const unknown = await start();
    const denied = await app.inject({
      url: `/api/auth/providers/github/callback?state=${unknown.state}&code=unknown`,
      headers: { cookie: unknown.cookie },
    });
    assert.equal(denied.headers.location, "/console/?authError=github");
    assert.equal(denied.headers["set-cookie"], undefined);
    providerSubject = 12345678;
    const recoveryDisable = await app.inject({
      method: "POST",
      url: `/api/auth/accounts/${recovery}/disable`,
      headers,
      payload: { expectedVersion: (await readAccount(recovery, headers)).version },
    });
    assert.equal(recoveryDisable.statusCode, 404);

    const stale = await start();
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/auth/accounts/${recovery}/revoke`,
          headers,
          payload: { expectedVersion: (await readAccount(recovery, headers)).version },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: "/api/auth/session", headers: { cookie: githubCookie } })).json()
        .data,
      null,
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/auth/providers/github/callback?state=${stale.state}&code=stale`,
          headers: { cookie: stale.cookie },
        })
      ).headers.location,
      "/console/?authError=github",
    );
    providerAvailable = false;
    const unavailableAttempt = await start();
    const unavailable = await app.inject({
      url: `/api/auth/providers/github/callback?state=${unavailableAttempt.state}&code=provider-unavailable`,
      headers: { cookie: unavailableAttempt.cookie },
    });
    assert.equal(unavailable.headers.location, "/console/?authError=github");
    assert.equal(unavailable.headers["set-cookie"], undefined);
    const offlinePassword = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin },
      payload: { email, password },
    });
    assert.equal(offlinePassword.statusCode, 200, offlinePassword.body);
    const passwordCookie = cookieHeaderFromSetCookie(offlinePassword.headers["set-cookie"]);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/sign-out",
          headers: { cookie: passwordCookie, origin },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: "/api/auth/session", headers: { cookie: passwordCookie } })).json()
        .data,
      null,
    );
    providerAvailable = true;

    browser = await chromium.launch({
      headless: true,
      ...(process.env.OCC_TEST_BROWSER_EXECUTABLE
        ? { executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE }
        : {}),
    });
    const page = await browser.newPage();
    await page.route("https://github.com/login/oauth/authorize**", async (route) => {
      const state = new URL(route.request().url()).searchParams.get("state");
      await route.fulfill({
        status: 302,
        headers: {
          location: `${origin}/api/auth/providers/github/callback?state=${state}&code=browser-code`,
        },
      });
    });
    await page.goto(`${origin}/console/`);
    // The Console confirms that the callback's session is the one this tab's attempt
    // created, then pins its key on every later request.
    const resultRequest = page.waitForRequest(
      (candidate) => new URL(candidate.url()).pathname === "/api/auth/providers/github/result",
    );
    const pinnedRead = page.waitForRequest(
      (candidate) => new URL(candidate.url()).pathname === "/namespaces",
    );
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.waitForURL(/\/console\/(agents|providers|namespaces|settings)/);
    const confirmedResult = await (await resultRequest).response();
    assert.equal(confirmedResult.status(), 200);
    const browserSession = await page.evaluate(
      async () => (await (await fetch("/api/auth/session")).json()).data,
    );
    assert.equal(browserSession.user.id, recovery);
    assert.equal((await confirmedResult.json()).data.sessionKey, browserSession.sessionKey);
    assert.equal((await pinnedRead).headers()["x-occ-session-key"], browserSession.sessionKey);
    assert.deepEqual(
      await page.evaluate(() => ({ ...sessionStorage })),
      {},
      "the one-use attemptId leaves tab storage after the exchange",
    );
    const browserNamespaces = await page.evaluate(
      async () => (await (await fetch("/namespaces")).json()).data,
    );
    assert.ok(browserNamespaces.some((namespace) => namespace.id === namespaceId));
    const detailResponse = page.waitForResponse(
      (response) =>
        response.url() === `${origin}/namespaces/${namespaceId}/agents/${agent.id}` &&
        response.status() === 200,
    );
    await page.goto(`${origin}/console/agents/${agent.id}?namespace=${namespaceId}&revision=draft`);
    assert.equal((await (await detailResponse).json()).data.id, agent.id);
    await page.getByRole("heading", { name: "Create new version" }).waitFor();
    await page.getByRole("button", { name: "Configuration", exact: true }).waitFor();
    assert.ok((await page.locator("body").textContent()).includes(agent.name));
    const after = await state.loadNativeIAMState(installation.id);
    assert.deepEqual(
      after,
      before,
      "sign-in and enrollment preserve every Principal, role and grant",
    );
    const methods = await pool.query(
      `SELECT access_token,refresh_token,id_token,access_token_expires_at,
              refresh_token_expires_at,scope,password FROM occ.account WHERE identity_only`,
    );
    assert.ok(methods.rows.length > 0);
    assert.ok(methods.rows.every((row) => Object.values(row).every((value) => value === null)));
    const audit = await pool.query("SELECT row_to_json(a)::text AS value FROM occ.audit_events a");
    // Expiring App credentials must not escape through login, session inspection,
    // browser cookies, or audit, even when the shared App can access repositories.
    const exposed = JSON.stringify([
      callback.headers,
      callback.body,
      session.headers,
      session.json(),
      denied.headers,
      denied.body,
      browserSession,
      await page.context().cookies(origin),
      audit.rows.map(({ value }) => JSON.parse(value)),
    ]);
    assert.equal(exposed.includes(providerAccessToken), false);
    assert.equal(exposed.includes(providerRefreshToken), false);
    assert.equal(exposed.includes("fixture-code"), false);
    assert.doesNotMatch(
      exposed,
      /"(?:access_token|refresh_token|expires_in|refresh_token_expires_in|access_token_expires_at|refresh_token_expires_at|accessToken|refreshToken|accessTokenExpiresAt|refreshTokenExpiresAt|scopes?)":/,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM occ."user"')).rows[0].count,
      2,
    );
    // The pre-activation account is bound only to the Installation.
    // GitHub login must preserve that boundary instead of granting Namespace access.
    const browserCookies = (await page.context().cookies(origin))
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");
    const adminHeaders = { cookie: browserCookies, origin };
    // A failed provisioning (unknown Role) leaves no user, method or Principal behind.
    const badRole = await app.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: adminHeaders,
      payload: { email: "bad-role@example.test", password, roleId: "role-does-not-exist" },
    });
    assert.equal(badRole.statusCode, 400, badRole.body);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM occ."user"')).rows[0].count,
      2,
    );
    assert.deepEqual(await state.loadNativeIAMState(installation.id), before);
    // Account creation stays available with GitHub sign-in activated.
    const opened = await app.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: adminHeaders,
      payload: { email: "after-activation@example.test", password, roleId: role.id },
    });
    assert.equal(opened.statusCode, 201, opened.body);
    const createdId = opened.json().data.id;
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM occ."user"')).rows[0].count,
      3,
    );
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: adminHeaders,
      payload: { email: "after-activation@example.test", password, roleId: role.id },
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    const createdLogin = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin },
      payload: { email: "after-activation@example.test", password },
    });
    assert.equal(createdLogin.statusCode, 200, createdLogin.body);
    const createdSession = await app.inject({
      url: "/api/auth/session",
      headers: { cookie: cookieHeaderFromSetCookie(createdLogin.headers["set-cookie"]) },
    });
    assert.equal(createdSession.json().data.user.id, createdId);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/auth/accounts/${createdId}/providers/github`,
          headers: adminHeaders,
          payload: {
            subject: "33333333",
            expectedVersion: (await readAccount(createdId, adminHeaders)).version,
          },
        })
      ).statusCode,
      200,
    );
    assert.ok(
      (await readAccount(createdId, adminHeaders)).methods.some(
        (method) => method.subject === "33333333",
      ),
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/auth/accounts/${limited.id}/providers/github`,
          headers: adminHeaders,
          payload: {
            subject: "22222222",
            expectedVersion: (await readAccount(limited.id, adminHeaders)).version,
          },
        })
      ).statusCode,
      200,
    );
    const retarget = await app.inject({
      method: "POST",
      url: `/api/auth/accounts/${limited.id}/providers/github`,
      headers: adminHeaders,
      payload: {
        subject: "12345678",
        expectedVersion: (await readAccount(limited.id, adminHeaders)).version,
      },
    });
    assert.ok([404, 409].includes(retarget.statusCode));
    const limitedBefore = await state.loadNativeIAMState(installation.id);
    providerSubject = 22222222;
    const limitedAttempt = await start();
    const limitedCallback = await app.inject({
      url: `/api/auth/providers/github/callback?state=${limitedAttempt.state}&code=limited`,
      headers: { cookie: limitedAttempt.cookie },
    });
    assert.equal(limitedCallback.headers.location, "/console/");
    const limitedCookie = cookieHeaderFromSetCookie(limitedCallback.headers["set-cookie"]);
    assert.equal(
      (await app.inject({ url: "/installation", headers: { cookie: limitedCookie } })).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: `/namespaces/${namespaceId}`, headers: { cookie: limitedCookie } }))
        .statusCode,
      403,
    );
    assert.deepEqual(
      (await app.inject({ url: "/namespaces", headers: { cookie: limitedCookie } })).json().data,
      [],
    );
    assert.deepEqual(await state.loadNativeIAMState(installation.id), limitedBefore);
    assert.equal(
      (
        await app.inject({
          url: `/namespaces/${namespaceId}/agents/${agent.id}`,
          headers: { cookie: limitedCookie },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/auth/accounts/${recovery}`,
          headers: { cookie: limitedCookie, origin },
        })
      ).statusCode,
      200,
      "the existing Installation-only administrator keeps account administration but no Namespace grants",
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/auth/accounts/${recovery}`,
          headers: { "x-api-key": serviceKey, origin },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/auth/accounts/${recovery}`,
          headers: { cookie: browserCookies },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/auth/accounts/${limited.id}/disable`,
          headers: adminHeaders,
          payload: { expectedVersion: (await readAccount(limited.id, adminHeaders)).version },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: "/api/auth/session", headers: { cookie: limitedCookie } })).json()
        .data,
      null,
    );
    const disabledPassword = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin },
      payload: { email: "github-limited@example.test", password },
    });
    assert.equal(disabledPassword.statusCode, 401);
    assert.equal(disabledPassword.headers["set-cookie"], undefined);
    async function accountAction(path, expectedVersion) {
      return app.inject({
        method: "POST",
        url: path,
        headers: adminHeaders,
        payload: { expectedVersion },
      });
    }
    // Re-enable restores password sign-in under a new version.
    const disabledAccount = await readAccount(limited.id, adminHeaders);
    assert.equal(disabledAccount.disabled, true);
    assert.equal(
      (await accountAction(`/api/auth/accounts/${limited.id}/enable`, disabledAccount.version - 1))
        .statusCode,
      409,
    );
    const enabled = await accountAction(
      `/api/auth/accounts/${limited.id}/enable`,
      disabledAccount.version,
    );
    assert.equal(enabled.statusCode, 200, enabled.body);
    const enabledAccount = await readAccount(limited.id, adminHeaders);
    assert.equal(enabledAccount.disabled, false);
    assert.equal(enabledAccount.version, disabledAccount.version + 1);
    assert.equal(
      (await accountAction(`/api/auth/accounts/${limited.id}/enable`, enabledAccount.version))
        .statusCode,
      409,
      "enabling an enabled account is a conflict",
    );
    const reenabledPassword = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin },
      payload: { email: "github-limited@example.test", password },
    });
    assert.equal(reenabledPassword.statusCode, 200, reenabledPassword.body);
    // Detach by methodId removes the GitHub identity and its sessions only.
    const withGitHub = await readAccount(createdId, adminHeaders);
    const credentialMethod = withGitHub.methods.find(
      (method) => method.providerId === "credential",
    );
    const githubMethod = withGitHub.methods.find((method) => method.providerId !== "credential");
    assert.ok(credentialMethod && githubMethod);
    const createdCookie = cookieHeaderFromSetCookie(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/sign-in/email",
          headers: { origin },
          payload: { email: "after-activation@example.test", password },
        })
      ).headers["set-cookie"],
    );
    assert.equal(
      (
        await accountAction(
          `/api/auth/accounts/${createdId}/methods/${credentialMethod.methodId}/detach`,
          withGitHub.version,
        )
      ).statusCode,
      409,
      "the password method cannot be detached",
    );
    assert.equal(
      (
        await accountAction(
          `/api/auth/accounts/${createdId}/methods/${githubMethod.methodId}/detach`,
          withGitHub.version - 1,
        )
      ).statusCode,
      409,
    );
    const detached = await accountAction(
      `/api/auth/accounts/${createdId}/methods/${githubMethod.methodId}/detach`,
      withGitHub.version,
    );
    assert.equal(detached.statusCode, 200, detached.body);
    const afterDetach = await readAccount(createdId, adminHeaders);
    assert.equal(afterDetach.version, withGitHub.version + 1);
    assert.deepEqual(
      afterDetach.methods.map((method) => method.methodId),
      [credentialMethod.methodId],
    );
    assert.equal(
      (await app.inject({ url: "/api/auth/session", headers: { cookie: createdCookie } })).json()
        .data,
      null,
    );
    await browser.close();
    browser = undefined;
    await app.close();
    apps.pop();
    const restarted = await composePostgresDevelopment(config, drivers());
    apps.push(restarted);
    await restarted.listen({ host: "127.0.0.1", port });
    assert.equal(
      (
        await restarted.inject({ url: "/api/auth/session", headers: { cookie: limitedCookie } })
      ).json().data,
      null,
    );
    await assert.rejects(
      composePostgresDevelopment({ ...base, authBaseURL: origin }, drivers()),
      /activated human authentication profile/,
    );
  },
);
