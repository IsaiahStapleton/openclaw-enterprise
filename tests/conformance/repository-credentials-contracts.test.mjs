import test from "node:test";
import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { request } from "node:https";
import { access } from "node:fs/promises";
import { createGitHubPlanningFixture } from "../fixtures/repository-credentials/planning.mjs";
import { createResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import {
  temporaryDirectory,
  createTlsMaterial,
} from "../fixtures/repository-credentials/process.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createServiceConfiguration } from "../fixtures/repository-credentials/service.mjs";
import { startGitHubFixture } from "../fixtures/repository-credentials/github.mjs";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import {
  createGitHubServiceFactory,
  startServiceListeners,
  writeSessionClientConfiguration,
} from "../fixtures/repository-credentials/service-resources.mjs";
import {
  requestHead as head,
  issueResponse,
  pullResponse,
} from "../fixtures/repository-credentials/builders.mjs";

test("GitHub driver admits exact REST methods, conservative GraphQL writes and configured Git routes", async (t) => {
  const { factory, bind } = await createGitHubPlanningFixture(t);
  const bound = bind();
  const routes = [
    ["/repos/fixture/repository", ["GET"]],
    ["/repos/fixture/repository/pulls", ["GET", "POST"]],
    ["/repos/fixture/repository/pulls/1", ["GET", "PATCH"]],
    ["/repos/fixture/repository/issues", ["GET", "POST"]],
    ["/repos/fixture/repository/issues/1", ["GET", "PATCH"]],
    ["/repos/fixture/repository/issues/1/comments", ["GET", "POST"]],
    ["/repos/fixture/repository/issues/comments/1", ["GET", "PATCH", "DELETE"]],
    ["/graphql", ["POST"]],
    ["/meta", ["GET"]],
  ];
  const routeScenarios = routes.flatMap(([path, methods]) =>
    ["GET", "POST", "PATCH", "DELETE", "PUT"].map((method) => ({
      name: `${method} ${path} is ${methods.includes(method) ? "admitted" : "denied"}`,
      request: head(method, path),
      admitted: methods.includes(method),
      effect: method === "GET" ? "read" : "write",
    })),
  );
  for (const scenario of routeScenarios) {
    await t.test(scenario.name, () => {
      const plan = bind().plan(scenario.request);
      assert.equal("kind" in plan, !scenario.admitted);
      if (!("kind" in plan)) {
        assert.equal(plan.effect, scenario.effect);
      }
    });
  }
  for (const profile of ["git-read", "git-write", "git-full"]) {
    for (const service of ["upload", "receive"]) {
      const git = bind(profile);
      assert.equal(
        factory.unauthenticated(
          head("GET", `/fixture/repository.git/info/refs?service=git-${service}-pack`),
        ).kind,
        "challenge",
      );
      for (const request of [
        head("GET", `/fixture/repository.git/info/refs?service=git-${service}-pack`),
        head("POST", `/fixture/repository.git/git-${service}-pack`, {
          "content-type": `application/x-git-${service}-pack-request`,
          "git-protocol": "version=2",
        }),
      ]) {
        assert.equal(
          "kind" in git.plan(request),
          profile === "git-read" && service === "receive",
          `${profile} ${request.method} ${request.rawTarget}`,
        );
      }
    }
  }
  for (const profile of ["git-read", "git-write"]) {
    const git = bind(profile);
    for (const request of [head("GET", "/repos/fixture/repository"), head("POST", "/graphql")]) {
      assert.equal(git.plan(request).kind, "denied");
    }
  }
  assert.throws(() => factory.resolve("read-write"), /unsupported-profile/);
  for (const path of [
    "/repos/foreign/repo",
    "/repos/fixture/repository/../repository",
    "/repos/fixture%2frepository",
    "/repos/fixture/repository/issues?page=1&page=2",
    "/repos/fixture/repository/issues?per_page=101",
    "https://api.github.com/repos/fixture/repository",
  ]) {
    assert.equal(bound.plan(head("GET", path)).kind, "denied");
  }
});
test("pinned gh GraphQL media profile is admitted and reconstructed without widening REST media", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const bound = bind();
  const accept =
    "application/vnd.github.merge-info-preview+json, application/vnd.github.nebula-preview";
  const plan = bound.plan(
    head("POST", "/graphql", {
      accept,
      "content-type": "application/json; charset=utf-8",
      "graphql-features": "merge_queue",
    }),
  );
  assert.equal(plan.kind, undefined);
  assert.equal(plan.effect, "write");
  assert.equal(plan.requestHeaders.accept, accept);
  assert.equal(plan.requestHeaders["content-type"], "application/json");
  assert.equal(plan.requestHeaders["graphql-features"], "merge_queue");
  for (const [path, headers] of [
    ["/repos/fixture/repository/issues", { accept }],
    ["/graphql", { accept: `${accept}, application/xml` }],
    ["/graphql", { accept: "application/vnd.github.unqualified-preview+json" }],
    ["/graphql", { accept, "graphql-features": "unqualified" }],
  ]) {
    assert.equal(bound.plan(head("POST", path, headers)).kind, "denied");
  }
});
test("REST issue and PR responses preserve informational URLs on reads and successful mutations", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const bound = bind();
  const gateway = "https://credentials.example/repos/fixture/repository";
  for (const [resource, buildResponse] of [
    ["issues", issueResponse],
    ["pulls", pullResponse],
  ]) {
    const scenarios = [
      { name: "read item", method: "GET", path: `${resource}/1`, status: 200, list: false },
      { name: "list items", method: "GET", path: resource, status: 200, list: true },
      { name: "create item", method: "POST", path: resource, status: 201, list: false },
      { name: "update item", method: "PATCH", path: `${resource}/1`, status: 200, list: false },
    ];
    for (const scenario of scenarios) {
      await t.test(`${resource}: ${scenario.name} preserves informational links`, () => {
        const plan = bind().plan(
          head(scenario.method, `/repos/fixture/repository/${scenario.path}`),
        );
        const input = buildResponse();
        const expected = {
          ...structuredClone(input),
          url: `${gateway}/${resource}/1`,
          comments_url: `${gateway}/issues/1/comments`,
          ...(resource === "issues"
            ? { pull_request: { ...input.pull_request, url: `${gateway}/pulls/1` } }
            : { issue_url: `${gateway}/issues/1` }),
        };
        const output = plan.responsePolicy.rewriteJson(scenario.list ? [input] : input);
        assert.deepEqual(JSON.parse(JSON.stringify(output)), scenario.list ? [expected] : expected);
        assert.doesNotThrow(() =>
          plan.responsePolicy.headers(scenario.status, { "content-type": "application/json" }),
        );
      });
    }
  }
  for (const path of ["labels/bug", "milestones/1", "pulls/1/comments", "pulls/1/commits"]) {
    assert.equal(bound.plan(head("GET", `/repos/fixture/repository/${path}`)).kind, "denied");
  }
});
test("followed JSON links validate field purpose while GraphQL human URLs remain intact", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const bound = bind();
  const planFor = (method, path) => bound.plan(head(method, path));
  const issue = planFor("GET", "/repos/fixture/repository/issues/1");
  for (const url of [
    "https://other.example/steal",
    "https://api.github.com/repos/other/repo/issues/1",
    "https://api.github.com/repos/fixture/repository/labels/bug",
    "https://api.github.com/repos/fixture/repository/issues/1#fragment",
    "https://api.github.com/repos/fixture/repository/pulls/1",
  ]) {
    assert.throws(() => issue.responsePolicy.rewriteJson({ url }), /unsafe-upstream-url/);
  }
  assert.throws(
    () =>
      issue.responsePolicy.rewriteJson({
        comments_url: "https://api.github.com/repos/fixture/repository/issues/1",
      }),
    /unsafe-upstream-url/,
  );
  const graphql = {
    data: {
      repository: {
        url: "https://github.com/fixture/repository",
        pullRequests: {
          nodes: [
            {
              url: "https://github.com/fixture/repository/pull/1",
              body: "https://api.github.com/repos/fixture/repository/labels/bug",
            },
          ],
        },
      },
    },
  };
  assert.deepEqual(planFor("POST", "/graphql").responsePolicy.rewriteJson(graphql), graphql);
});
test("response policy rewrites admitted machine links without changing human content or forwarding credential headers", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const bound = bind();
  const plan = bound.plan(head("GET", "/repos/fixture/repository/issues/1/comments"));
  const link = "https://api.github.com/repos/fixture/repository/issues/1/comments?page=2";
  const headers = plan.responsePolicy.headers(200, {
    link: `<${link}>; rel="next"`,
    "set-cookie": "secret",
    "www-authenticate": "secret",
    "retry-after": "5",
    "content-length": "999",
  });
  assert.equal(
    headers.link,
    `<https://credentials.example/repos/fixture/repository/issues/1/comments?page=2>; rel="next"`,
  );
  assert.equal(headers["set-cookie"], undefined);
  assert.equal(headers["www-authenticate"], undefined);
  assert.equal(headers["content-length"], undefined);
  const body = plan.responsePolicy.rewriteJson({
    url: "https://api.github.com/repos/fixture/repository/issues/comments/1",
    body: link,
    html_url: "https://github.com/fixture/repository/pull/1",
    user: { url: "https://api.github.com/users/person" },
  });
  assert.equal(body.url, "https://credentials.example/repos/fixture/repository/issues/comments/1");
  assert.equal(body.body, link);
  assert.equal(body.user.url, "https://api.github.com/users/person");
  assert.throws(() => plan.responsePolicy.headers(302, { location: link }));
  assert.throws(() =>
    plan.responsePolicy.headers(200, { link: '<https://other.example/steal>; rel="next"' }),
  );
  assert.throws(() =>
    plan.responsePolicy.headers(200, {
      link: '<https://api.github.com/repos/fixture/repository/labels/bug>; rel="next"',
    }),
  );
});

test("response policy rejects 304 without a redirect location", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const plan = bind().plan(head("GET", "/repos/fixture/repository/issues/1"));
  const headers = { "cache-control": "private, max-age=60" };
  assert.equal(plan.kind, undefined);
  assert.deepEqual(plan.responsePolicy.headers(200, headers), headers);
  // Cache validation remains within the current all-3xx refusal policy.
  assert.throws(() => plan.responsePolicy.headers(304, headers), {
    message: "upstream-redirect",
  });
});

test("native repository-ID pagination stays bound to the configured repository and issue cursor policy", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const bound = bind();
  const target = "/repos/fixture/repository/issues";
  const cursor = "Y3Vyc29yOnYyOjE=";
  const plan = bound.plan(head("GET", target));
  for (const direction of ["after", "before"]) {
    const query = `state=all&per_page=1&${direction}=${encodeURIComponent(cursor)}&page=2`;
    const canonical = `${target}?${query}`;
    const headers = plan.responsePolicy.headers(200, {
      link: `<https://api.github.com/repositories/73/issues?${query}>; rel="next"`,
    });
    assert.equal(headers.link, `<https://credentials.example${canonical}>; rel="next"`);
    assert.equal(bound.plan(head("GET", canonical)).target, canonical);
    assert.equal(bound.plan(head("POST", canonical)).kind, "denied");
    assert.equal(bind("git-write").plan(head("GET", canonical)).kind, "denied");
  }
  // A native ID is response metadata, never an additional caller-selected repository route.
  assert.equal(bound.plan(head("GET", "/repositories/73/issues")).kind, "denied");
  for (const url of [
    "https://api.github.com/repositories/74/issues?page=2",
    "https://api.github.com/repositories/730/issues?page=2",
    "https://other.example/repositories/73/issues?page=2",
    "https://api.github.com/repositories/73/actions/runs?page=2",
    `https://api.github.com/repositories/73/issues/1?after=${cursor}`,
    `https://api.github.com/repositories/73/pulls?after=${cursor}`,
    "https://api.github.com/repositories/73/issues?after=bad%20cursor",
    `https://api.github.com/repositories/73/issues?after=${"a".repeat(1025)}`,
    `https://api.github.com/repositories/73/issues?after=${cursor}&after=${cursor}`,
  ]) {
    assert.throws(() => plan.responsePolicy.headers(200, { link: `<${url}>; rel="next"` }), {
      message: "unsafe-upstream-url",
    });
  }
});

test("response policy rejects a literal comma inside an otherwise admitted Link URL", async (t) => {
  const { bind } = await createGitHubPlanningFixture(t);
  const bound = bind();
  const target = "/repos/fixture/repository/issues?labels=bug,help&page=2";
  const encodedTarget = "/repos/fixture/repository/issues?labels=bug%2Chelp&page=2";
  const plan = bound.plan(head("GET", target));
  assert.equal(plan.kind, undefined);
  assert.deepEqual(
    plan.responsePolicy.headers(200, {
      link: `<https://api.github.com${encodedTarget}>; rel="next"`,
    }),
    { link: `<https://credentials.example${encodedTarget}>; rel="next"` },
  );
  // A literal comma is refused by Link parsing even when the route itself is admitted.
  assert.throws(
    () =>
      plan.responsePolicy.headers(200, {
        link: `<https://api.github.com${target}>; rel="next"`,
      }),
    { message: "unsafe-upstream-url" },
  );
});

test("gateway authentication is separate from upstream signing and rejects foreign attempt/result/plan objects", async (t) => {
  const { factory, key, publicKey, bind } = await createGitHubPlanningFixture(t);
  const bound = bind();
  const bearer = "a".repeat(43);
  assert.equal(
    factory.parseAuthentication(
      head("GET", "/fixture/repository.git/info/refs?service=git-upload-pack"),
      `Basic ${Buffer.from(`gateway-session:${bearer}`).toString("base64")}`,
    ),
    bearer,
  );
  assert.equal(
    factory.parseAuthentication(head("GET", "/repos/fixture/repository"), `token ${bearer}`),
    bearer,
  );
  assert.equal(
    factory.parseAuthentication(
      head("GET", "/fixture/repository.git/info/refs?service=git-upload-pack"),
      `Bearer ${bearer}`,
    ).kind,
    "denied",
  );
  await key.withJwt(async (jwt) => {
    const [h, p, s] = jwt.split(".");
    assert.equal(
      verify("sha256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")),
      true,
    );
    assert.equal(JSON.parse(Buffer.from(p, "base64url")).iss, "12345");
  });
  await assert.rejects(
    bound.driver.acquire(
      { id: "copy", action: "acquire", authority: bound.authority },
      undefined,
      1,
    ),
    /FOREIGN_ATTEMPT/,
  );
  await assert.rejects(
    bound.driver.settle({ kind: "acquired", attemptId: "copy" }),
    /foreign-outcome/,
  );
  await assert.rejects(
    bound.driver.withAuthentication({}, {}, async () => {
      throw new Error("must-not-send");
    }),
    /invalid-credential/,
  );
  key.close();
  await assert.rejects(
    key.withJwt(async () => {}),
    /authority-unavailable/,
  );
});

test("partial fixture cleanup retains the startup failure and releases keys and files", async () => {
  const resources = createResourceScope();
  const directory = await temporaryDirectory(resources);
  const { key } = await createGitHubPlanningFixture(resources);
  const startupFailure = new Error("startup failed");
  const cleanupFailure = new Error("cleanup failed");
  resources.after(() => {
    throw cleanupFailure;
  });
  const closed = resources.close(startupFailure);
  assert.equal(resources.close(), closed);
  await assert.rejects(closed, (error) => {
    assert.deepEqual(error.errors, [startupFailure, cleanupFailure]);
    assert.equal(error.cause, startupFailure);
    return true;
  });
  await assert.rejects(access(directory), { code: "ENOENT" });
  await assert.rejects(
    key.withJwt(async () => {}),
    /authority-unavailable/,
  );
});

test("a cleanup deadline is a failure and does not prevent remaining resource release", async () => {
  const resources = createResourceScope({ cleanupTimeoutMs: 20 });
  const directory = await temporaryDirectory(resources);
  const pendingCleanup = Promise.withResolvers();
  resources.after(() => pendingCleanup.promise);
  const closed = resources.close();
  await assert.rejects(closed, (error) => {
    assert.equal(error.errors.length, 1);
    assert.match(error.errors[0].message, /cleanup timed out/);
    return true;
  });
  await assert.rejects(access(directory), { code: "ENOENT" });
  pendingCleanup.resolve();
  await pendingCleanup.promise;
  // Late completion cannot replace the recorded cleanup deadline with success.
  assert.equal(resources.close(), closed);
});

test(
  "service resource factories revoke acquired credentials before closing local upstreams",
  { timeout: 15000 },
  async (t) => {
    const resources = createResourceScope();
    t.after(() => resources.close());
    const clock = createControlledClock();
    const tls = await createTlsMaterial(resources);
    const original = await createServiceConfiguration(resources);
    const config = { ...original, gateway: { ...original.gateway, listen: "127.0.0.1:0" } };
    const github = await startGitHubFixture(resources, { clock, tls });
    const git = await startGitSmartHttpFixture(resources, { authorize: github.authorize, tls });
    const factory = await createGitHubServiceFactory(resources, {
      config,
      clock,
      privateKey: github.privateKey,
      trustedEndpoints: { apiOrigin: github.origin, gitOrigin: git.origin, ca: tls.ca },
    });
    const { service, listeners } = await startServiceListeners(resources, {
      config,
      factory,
      clock,
      tls,
      upstreamOrigins: [github.origin, git.origin],
    });
    const opened = service.open({ durationSeconds: 86400, profile: "git-full" });
    const clientDirectory = await writeSessionClientConfiguration(resources, {
      opened,
      ca: tls.ca,
    });
    // Dial the owned loopback listener while retaining the public authority and TLS validation.
    const response = await new Promise((resolve, reject) => {
      const outgoing = request(
        {
          hostname: "127.0.0.1",
          port: listeners.address.port,
          path: "/repos/fixture/repository",
          ca: tls.ca,
          headers: { host: "credentials.example.test", authorization: `Bearer ${opened.bearer}` },
          agent: false,
        },
        (incoming) => {
          const chunks = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.once("error", reject);
          incoming.once("end", () =>
            resolve({ status: incoming.statusCode, body: Buffer.concat(chunks) }),
          );
        },
      );
      outgoing.setTimeout(3000, () => outgoing.destroy(new Error("fixture request timeout")));
      outgoing.once("error", reject);
      outgoing.end();
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).full_name, "fixture/repository");
    assert.equal(github.issuesOfTokens.length, 1);
    await resources.close();
    assert.equal(service.status(opened.session.sessionId).state, "DISPOSED");
    assert.equal(github.tokenState()[0].revoked, true);
    assert.deepEqual(github.errors, []);
    await assert.rejects(access(clientDirectory), { code: "ENOENT" });
    await assert.rejects(access(config.gateway.controlSocket), { code: "ENOENT" });
  },
);
