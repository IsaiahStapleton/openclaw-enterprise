import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run, temporaryDirectory } from "./process.mjs";
import { registerResourceCleanup, closeAndDispose } from "./cleanup.mjs";
import { appModule } from "./runtime.mjs";
import { startCredentialServiceFixture, gatewayRequest } from "./service.mjs";
import { runInFixtureContainer } from "./container.mjs";

export function registerCredentialFixtureRegressions() {
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
      if (reason === "cancelled") {
        // Cancel only after the descendant exists, so this proves tree cleanup
        // rather than racing process startup on a busy container host.
        timer = setInterval(() => {
          if (existsSync(pidFile)) {
            controller.abort("sensitive-fixture-value");
          }
        }, 10);
      }
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
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
        assert.equal(running, false, "owned descendant remains running");
      } finally {
        clearInterval(timer);
      }
    });
  }

  test("pre-registered cleanup reconciles accepted creations with lost responses without replay", async (t) => {
    if (await runInFixtureContainer(t, "tests/fixtures/repository-credentials/regressions.mjs")) {
      return;
    }
    // Reconciliation uses the same admitted session and production sender as the
    // original write, including when the provider accepted it but lost its reply.
    const serviceFixture = await startCredentialServiceFixture(t);
    const fixture = serviceFixture.github;
    const send = async ({ method, path, body }) => {
      const response = await gatewayRequest(serviceFixture, `/${path}`, { method, body });
      assert.ok(response.status < 400);
      return response.body ? JSON.parse(response.body) : undefined;
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
    for (const action of cleanups.reverse()) {
      await action(AbortSignal.timeout(5000));
    }
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
    await assert.rejects(
      closeAndDispose(callControl, socket, sessionId),
      /local closure confirmed/,
    );
    statusUnavailable = false;
    assert.deepEqual(await closeAndDispose(callControl, socket, sessionId), {
      localClosure: "confirmed",
      disposal: "confirmed",
    });
  });
}

// Container qualification also selects this fixture directly with source or emitted owners.
if (import.meta.main) {
  registerCredentialFixtureRegressions();
}
