import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  createGitHubDriverFactory,
  createGitHubKeyOwner,
} from "../../apps/repository-credentials/src/backends/github/index.ts";
import { validateServiceConfig } from "../../apps/repository-credentials/src/config.ts";
const clock = { wallNow: () => 1700000000000, monotonicNow: () => 0, schedule: () => () => {} };
const config = validateServiceConfig({
  gateway: {
    publicOrigin: "https://credentials.example",
    listen: "127.0.0.1:443",
    controlSocket: "/run/credentials/control.sock",
  },
  sessionPolicy: {
    maximumDurationSeconds: 86400,
    defaultProfile: "git-write",
    allowedProfiles: ["git-write", "git-full"],
  },
});
function setup() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = createGitHubKeyOwner({ privateKey, appId: "12345", clock });
  const factory = createGitHubDriverFactory({
    configuration: {
      kind: "github-app",
      providerInstanceId: "github-test",
      configVersion: "1",
      appId: "12345",
      installationId: "41",
      repositoryId: "73",
      repository: "fixture/repository",
      privateKeyFile: "/protected/app.pem",
    },
    key,
    clock,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
  });
  return { factory, key, publicKey };
}
function head(method, target, headers = {}) {
  return {
    method,
    rawTarget: target,
    headers: ["POST", "PATCH"].includes(method)
      ? { "content-type": "application/json", ...headers }
      : headers,
    receivedMonoMs: 0,
    contentEncoding: "identity",
    framing: { kind: "none", bytes: undefined },
  };
}
function driver(factory, profile = "git-full") {
  const authority = { sessionId: "session-one", ...factory.resolve(profile).binding };
  return {
    authority,
    driver: factory.create({
      authority,
      custody: {
        assertAttempt() {
          throw new Error("foreign-attempt");
        },
      },
      clock,
    }),
  };
}
test("GitHub driver admits exact REST methods, conservative GraphQL writes and configured Git routes", () => {
  const { factory } = setup(),
    bound = driver(factory),
    session = {};
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
  for (const [path, methods] of routes)
    for (const method of ["GET", "POST", "PATCH", "DELETE", "PUT"]) {
      const plan = bound.driver.plan({
        authority: bound.authority,
        session,
        head: head(method, path),
      });
      assert.equal("kind" in plan, !methods.includes(method), `${method} ${path}`);
      if (!("kind" in plan)) assert.equal(plan.effect, method === "GET" ? "read" : "write");
    }
  const git = driver(factory, "git-write");
  for (const service of ["upload", "receive"]) {
    assert.equal(
      factory.unauthenticated(
        head("GET", `/fixture/repository.git/info/refs?service=git-${service}-pack`),
      ).kind,
      "challenge",
    );
    assert.equal(
      "kind" in
        git.driver.plan({
          authority: git.authority,
          session,
          head: head("POST", `/fixture/repository.git/git-${service}-pack`, {
            "content-type": `application/x-git-${service}-pack-request`,
            "git-protocol": "version=2",
          }),
        }),
      false,
    );
  }
  assert.equal(
    git.driver.plan({
      authority: git.authority,
      session,
      head: head("GET", "/repos/fixture/repository"),
    }).kind,
    "denied",
  );
  for (const path of [
    "/repos/foreign/repo",
    "/repos/fixture/repository/../repository",
    "/repos/fixture%2frepository",
    "/repos/fixture/repository/issues?page=1&page=2",
    "/repos/fixture/repository/issues?per_page=101",
    "https://api.github.com/repos/fixture/repository",
  ])
    assert.equal(
      bound.driver.plan({ authority: bound.authority, session, head: head("GET", path) }).kind,
      "denied",
    );
});
test("pinned gh GraphQL media profile is admitted and reconstructed without widening REST media", () => {
  const { factory } = setup(),
    bound = driver(factory);
  const accept =
    "application/vnd.github.merge-info-preview+json, application/vnd.github.nebula-preview";
  const plan = bound.driver.plan({
    authority: bound.authority,
    session: {},
    head: head("POST", "/graphql", {
      accept,
      "content-type": "application/json; charset=utf-8",
      "graphql-features": "merge_queue",
    }),
  });
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
  ])
    assert.equal(
      bound.driver.plan({
        authority: bound.authority,
        session: {},
        head: head("POST", path, headers),
      }).kind,
      "denied",
    );
});
test("REST issue and PR responses preserve informational URLs on reads and successful mutations", () => {
  const { factory } = setup(),
    bound = driver(factory);
  const api = "https://api.github.com/repos/fixture/repository";
  const gateway = "https://credentials.example/repos/fixture/repository";
  for (const resource of ["issues", "pulls"])
    for (const [method, path, status] of [
      ["GET", `${resource}/1`, 200],
      ["GET", resource, 200],
      ["POST", resource, 201],
      ["PATCH", `${resource}/1`, 200],
    ]) {
      const plan = bound.driver.plan({
        authority: bound.authority,
        session: {},
        head: head(method, `/repos/fixture/repository/${path}`),
      });
      const input = {
        url: `${api}/${resource}/1`,
        comments_url: `${api}/issues/1/comments`,
        title: `${api}/labels/bug`,
        body: `${api}/milestones/1`,
        html_url: "https://github.com/fixture/repository/pull/1",
        labels: [{ id: 1, name: "bug", url: `${api}/labels/bug` }],
        milestone: { url: `${api}/milestones/1`, title: "Release", description: `${api}/issues/1` },
        user: { url: "https://api.github.com/users/person" },
        ...(resource === "issues"
          ? {
              pull_request: {
                url: `${api}/pulls/1`,
                html_url: "https://github.com/fixture/repository/pull/1",
                diff_url: "https://github.com/fixture/repository/pull/1.diff",
              },
            }
          : {
              issue_url: `${api}/issues/1`,
              // PR review comments, commits and head repository metadata are informational here.
              review_comments_url: `${api}/pulls/1/comments`,
              commits_url: `${api}/pulls/1/commits`,
              head: { repo: { url: `${api}`, labels_url: `${api}/labels{/name}` } },
            }),
      };
      const list = method === "GET" && path === resource;
      const output = plan.responsePolicy.rewriteJson(list ? [input] : input);
      const expected = {
        ...input,
        url: `${gateway}/${resource}/1`,
        comments_url: `${gateway}/issues/1/comments`,
        ...(resource === "issues"
          ? { pull_request: { ...input.pull_request, url: `${gateway}/pulls/1` } }
          : { issue_url: `${gateway}/issues/1` }),
      };
      assert.deepEqual(
        JSON.parse(JSON.stringify(output)),
        list ? [expected] : expected,
        `${method} ${path}`,
      );
      assert.doesNotThrow(() =>
        plan.responsePolicy.headers(status, { "content-type": "application/json" }),
      );
    }
  for (const path of ["labels/bug", "milestones/1", "pulls/1/comments", "pulls/1/commits"])
    assert.equal(
      bound.driver.plan({
        authority: bound.authority,
        session: {},
        head: head("GET", `/repos/fixture/repository/${path}`),
      }).kind,
      "denied",
    );
});
test("followed JSON links validate field purpose while GraphQL human URLs remain intact", () => {
  const { factory } = setup(),
    bound = driver(factory);
  const planFor = (method, path) =>
    bound.driver.plan({ authority: bound.authority, session: {}, head: head(method, path) });
  const issue = planFor("GET", "/repos/fixture/repository/issues/1");
  for (const url of [
    "https://other.example/steal",
    "https://api.github.com/repos/other/repo/issues/1",
    "https://api.github.com/repos/fixture/repository/labels/bug",
    "https://api.github.com/repos/fixture/repository/issues/1#fragment",
    "https://api.github.com/repos/fixture/repository/pulls/1",
  ])
    assert.throws(() => issue.responsePolicy.rewriteJson({ url }), /unsafe-upstream-url/);
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
test("response policy rewrites admitted machine links without changing human content or forwarding credential headers", () => {
  const { factory } = setup(),
    bound = driver(factory);
  const plan = bound.driver.plan({
    authority: bound.authority,
    session: {},
    head: head("GET", "/repos/fixture/repository/issues/1/comments"),
  });
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
test("gateway authentication is separate from upstream signing and rejects foreign attempt/result/plan objects", async () => {
  const { factory, key, publicKey } = setup(),
    bound = driver(factory),
    bearer = "a".repeat(43);
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
    /foreign-attempt/,
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

test("native repository-ID pagination stays bound to the configured repository and issue cursor policy", async (t) => {
  const { factory, key } = setup();
  t.after(() => key.close());
  const bind = (profile = "git-full") => {
    const bound = driver(factory, profile);
    const session = {};
    return {
      plan: (request) =>
        bound.driver.plan({
          authority: bound.authority,
          session,
          head: request,
        }),
    };
  };
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
  ])
    assert.throws(() => plan.responsePolicy.headers(200, { link: `<${url}>; rel="next"` }), {
      message: "unsafe-upstream-url",
    });
});
