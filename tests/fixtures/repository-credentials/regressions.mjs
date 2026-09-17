import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:https";
import { createServer } from "node:http";
import { sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { run, temporaryDirectory } from "./process.mjs";
import { startGitHubFixture } from "./github.mjs";
import { startGitSmartHttpFixture } from "./git.mjs";
import { registerResourceCleanup, closeAndDispose } from "./cleanup.mjs";
import { appModule } from "./runtime.mjs";

for (const reason of ["timeout", "output overflow", "cancelled"]) {
  test(`owned command tree stops on ${reason} without leaking diagnostics`, async (t) => {
    const directory = await temporaryDirectory(t);
    const pidFile = join(directory, "descendant.pid");
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      ${reason === "output overflow" ? "process.stdout.write('sensitive-fixture-value'.repeat(150000));" : ""}
      setTimeout(() => {}, 1500);`;
    const launcher = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'});`;
    const controller = new AbortController();
    let timer;
    if (reason === "cancelled")
      timer = setTimeout(() => controller.abort("sensitive-fixture-value"), 250);
    const start = performance.now();
    try {
      await assert.rejects(
        run(process.execPath, ["-e", launcher], {
          timeout: reason === "timeout" ? 250 : 5000,
          signal: controller.signal,
        }),
        (error) =>
          error.message.includes(reason) && !error.message.includes("sensitive-fixture-value"),
      );
      assert.ok(
        performance.now() - start < 1250,
        "launcher descendants must not extend the command bound",
      );
      const pid = Number(await readFile(pidFile, "utf8"));
      // A killed orphan may await the container init's reap; a zombie cannot
      // execute or retain pipes. No running descendant may survive completion.
      let running = false;
      try {
        running = !/\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      assert.equal(running, false, "owned descendant remains running");
    } finally {
      clearTimeout(timer);
    }
  });
}

function httpsJson(origin, ca, path, { method = "GET", body, authorization } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = request(
      `${origin}${path}`,
      {
        method,
        ca,
        agent: false,
        headers: {
          ...(authorization ? { authorization } : {}),
          ...(data
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(data),
              }
            : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => {
          try {
            const text = Buffer.concat(chunks).toString();
            resolve({ status: response.statusCode, value: text ? JSON.parse(text) : undefined });
          } catch {
            reject(new Error("fixture response invalid"));
          }
        });
      },
    );
    const timer = setTimeout(() => outgoing.destroy(new Error("fixture request timed out")), 3000);
    outgoing.once("close", () => clearTimeout(timer));
    outgoing.once("error", reject);
    outgoing.end(data);
  });
}

async function issueToken(fixture) {
  const now = Math.floor(fixture.clock.wallNow() / 1000);
  const unsigned = [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ iss: "12345", iat: now - 60, exp: now + 540 })).toString(
      "base64url",
    ),
  ].join(".");
  const jwt = `${unsigned}.${sign("sha256", Buffer.from(unsigned), fixture.privateKey).toString("base64url")}`;
  const response = await httpsJson(
    fixture.origin,
    fixture.tls.ca,
    "/app/installations/41/access_tokens",
    {
      method: "POST",
      authorization: `Bearer ${jwt}`,
      body: {
        repository_ids: [73],
        permissions: {
          metadata: "read",
          contents: "write",
          pull_requests: "write",
          issues: "write",
        },
      },
    },
  );
  assert.equal(response.status, 201);
  return response.value.token;
}

test("expired credential attempts are detected at both API and real Git authentication boundaries", async (t) => {
  const fixture = await startGitHubFixture(t);
  const token = await issueToken(fixture);
  const authorization = `Bearer ${token}`;
  await httpsJson(fixture.origin, fixture.tls.ca, "/repos/fixture/repository", { authorization });
  const before = fixture.tokenState()[0];
  await fixture.clock.advance(13 * 3600000 + 1000);
  assert.equal(
    (
      await httpsJson(fixture.origin, fixture.tls.ca, "/repos/fixture/repository", {
        authorization,
      })
    ).status,
    401,
  );
  const git = await startGitSmartHttpFixture(t, { tls: fixture.tls, authorize: fixture.authorize });
  assert.equal(
    (
      await httpsJson(
        git.origin,
        fixture.tls.ca,
        "/fixture/repository.git/info/refs?service=git-upload-pack",
        { authorization },
      )
    ).status,
    401,
  );
  assert.equal(fixture.tokenState()[0].uses, before.uses);
  assert.equal(fixture.tokenState()[0].attempts - before.attempts, 2);
  assert.deepEqual(fixture.authenticationAttempts.slice(-2), [
    { tokenIndex: 1, boundary: "api" },
    { tokenIndex: 1, boundary: "git" },
  ]);
});

test("pre-registered cleanup reconciles accepted creations with lost responses without replay", async (t) => {
  const fixture = await startGitHubFixture(t);
  const authorization = `Bearer ${await issueToken(fixture)}`;
  const send = async ({ method, path, body }) => {
    const response = await httpsJson(fixture.origin, fixture.tls.ca, `/${path}`, {
      method,
      body,
      authorization,
    });
    assert.ok(response.status < 400);
    return response.value;
  };
  const repository = "fixture/repository";
  const prefix = `repos/${repository}`;
  const parent = await send({
    method: "POST",
    path: `${prefix}/issues`,
    body: { title: "Parent", body: "Unrelated issue" },
  });
  const other = await send({
    method: "POST",
    path: `${prefix}/pulls`,
    body: { title: "Unrelated", head: "other", base: "main", body: "Unrelated PR" },
  });
  await send({
    method: "POST",
    path: `${prefix}/issues/${parent.number}/comments`,
    body: { body: "Unrelated comment" },
  });
  const cleanups = [];
  for (const [kind, label, head] of [
    ["issues", "issue"],
    ["comment", "comment"],
    ["pulls", "rest", "unique-rest"],
    ["pulls", "native", "unique-native"],
  ]) {
    const marker = `<!-- regression-run:${label} -->`;
    registerResourceCleanup(cleanups, {
      request: send,
      repository,
      kind,
      marker,
      head,
      issueNumber: parent.number,
    });
    const path =
      label === "native"
        ? "graphql"
        : `${prefix}/${kind === "comment" ? `issues/${parent.number}/comments` : kind}`;
    const input = { title: "Owned", body: marker, base: "main", head };
    const body =
      label === "native"
        ? {
            query:
              "mutation CreatePullRequest($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id number url } } }",
            variables: {
              input: {
                repositoryId: "R_fixture",
                title: input.title,
                body: marker,
                headRefName: head,
                baseRefName: "main",
              },
            },
          }
        : input;
    fixture.disconnectAfterMutation("POST", `/${path}`);
    await assert.rejects(send({ method: "POST", path, body }));
  }
  for (const action of cleanups.reverse()) await action(AbortSignal.timeout(5000));
  assert.equal(fixture.issues.get(parent.number).state, "open");
  assert.equal(fixture.pulls.get(other.number).state, "open");
  assert.equal(fixture.comments.size, 1);
  assert.equal([...fixture.comments.values()][0].body, "Unrelated comment");
  assert.equal([...fixture.issues.values()].filter((x) => x.state === "closed").length, 1);
  assert.equal([...fixture.pulls.values()].filter((x) => x.state === "closed").length, 2);
  assert.equal(
    fixture.trace.filter(
      (x) => x.method === "POST" && x.target !== "/app/installations/41/access_tokens",
    ).length,
    7,
  );
  const missing = [];
  registerResourceCleanup(missing, {
    request: send,
    repository,
    kind: "issues",
    marker: "<!-- unresolved-run -->",
  });
  await assert.rejects(missing[0](), /unresolved issues identity/);
});

test("control cleanup rejects unavailable and pending disposal through the actual operator client", async (t) => {
  const { callControl } = await appModule("client/operator");
  const directory = await temporaryDirectory(t, "cleanup-control-");
  const socket = join(directory, "control.sock");
  const sessionId = "cleanup-session";
  const resolved = {
    sessionId,
    state: "DISPOSED",
    activeUses: 0,
    cleanup: {
      active: 0,
      pending: 0,
      uncertain: 0,
      auxiliaryPending: false,
    },
  };
  let response = { error: "unavailable" };
  let calls = 0;
  let statusUnavailable = false;
  const server = createServer((request, reply) => {
    request.resume();
    calls++;
    reply
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify(
          statusUnavailable && request.method === "GET" ? { error: "unavailable" } : response,
        ),
      );
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(
    closeAndDispose(callControl, socket, sessionId),
    /local closure unconfirmed/,
  );
  for (const state of ["OPEN", "DISPOSED"]) {
    response = { ...resolved, state, sessionId: state === "OPEN" ? sessionId : "foreign" };
    await assert.rejects(
      closeAndDispose(callControl, socket, sessionId),
      /local closure unconfirmed/,
    );
  }
  response = { ...resolved, state: "CLOSED", cleanup: { ...resolved.cleanup, pending: 1 } };
  calls = 0;
  await assert.rejects(
    closeAndDispose(callControl, socket, sessionId, { timeoutMs: 60, pollMs: 10 }),
    /local closure confirmed; disposal pending/,
  );
  assert.ok(calls > 2, "pending cleanup must be polled within its deadline");
  response = { ...resolved, cleanup: { ...resolved.cleanup, uncertain: 1 } };
  await assert.rejects(
    closeAndDispose(callControl, socket, sessionId, { timeoutMs: 30, pollMs: 10 }),
    /disposal pending/,
  );
  response = resolved;
  statusUnavailable = true;
  await assert.rejects(closeAndDispose(callControl, socket, sessionId), /local closure confirmed/);
  statusUnavailable = false;
  assert.deepEqual(await closeAndDispose(callControl, socket, sessionId), {
    localClosure: "confirmed",
    disposal: "confirmed",
  });
});
