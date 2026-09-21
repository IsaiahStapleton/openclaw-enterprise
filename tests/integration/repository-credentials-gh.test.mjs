import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNativeClientMaterial } from "../fixtures/repository-credentials/clients.mjs";
import { appRoot, appExtension } from "../fixtures/repository-credentials/runtime.mjs";
import { cleanEnvironment, run } from "../fixtures/repository-credentials/process.mjs";
import {
  startCredentialServiceFixture,
  gatewayRequest,
} from "../fixtures/repository-credentials/service.mjs";
import { exerciseGit, exerciseGh } from "../fixtures/repository-credentials/workflows.mjs";
import { runInFixtureContainer } from "../fixtures/repository-credentials/container.mjs";

test("pinned gh uses canonical GitHub identity for REST, pagination and native PR creation", async (t) => {
  if (await runInFixtureContainer(t, "tests/integration/repository-credentials-gh.test.mjs")) {
    return;
  }
  const fixture = await startCredentialServiceFixture(t);
  const { client, checkout } = await exerciseGit(t, fixture);
  await client.git(["push", "origin", "HEAD:refs/heads/native-feature"], { cwd: checkout });
  const { issue } = await exerciseGh(t, fixture, client);
  // GitHub returns repository-ID links, and issue collections also carry opaque cursors.
  // The actual CLI must follow those links through the canonical gateway route.
  const issueInput = await client.json("pagination-issue.json", { title: "Second issue" });
  const secondIssue = JSON.parse(
    (
      await client.gh([
        "api",
        "--method",
        "POST",
        "repos/fixture/repository/issues",
        "--input",
        issueInput,
      ])
    ).stdout,
  );
  const pages = JSON.parse(
    (
      await client.gh([
        "api",
        "--paginate",
        "--slurp",
        "repos/fixture/repository/issues?state=all&per_page=1",
      ])
    ).stdout,
  );
  assert.deepEqual(
    pages.map((page) => page.map(({ number }) => number)),
    [[issue.number], [secondIssue.number]],
  );
  assert.ok(
    fixture.github.trace.some((entry) => {
      const target = new URL(entry.target, "https://api.github.com");
      return (
        target.pathname === "/repos/fixture/repository/issues" && target.searchParams.has("after")
      );
    }),
  );
  assert.equal(
    fixture.github.trace.some((entry) => entry.target.startsWith("/repositories/")),
    false,
  );
  assert.ok(
    fixture.github.trace.filter((entry) => entry.tokenIndex).every((entry) => entry.userAgent),
  );
  // All fixed runtime paths below live only inside the disposable fixture
  // container. Private HOME configuration proves real child Git is preserved;
  // image-owned system include qualification belongs to the platform tests.
  assert.equal(process.env.REPOSITORY_CREDENTIALS_CONTAINER_CHILD, "1");
  const materialRoot = "/run/oce/repository-credentials";
  await mkdir(materialRoot, { recursive: true, mode: 0o700 });
  t.after(() => rm(materialRoot, { recursive: true, force: true }));
  const material = await createNativeClientMaterial(
    t,
    [{ opened: fixture.opened, repositoryRef: "fixture" }],
    { root: materialRoot, ca: fixture.tls.ca },
  );
  const trace = join(client.directory, "native-child-git.jsonl");
  await writeFile(
    join(client.directory, ".gitconfig"),
    `[include]\n\tpath = ${join(materialRoot, "gitconfig")}\n[trace2]\n\teventTarget = ${trace}\n`,
  );
  await client.git(["push", "origin", "HEAD:refs/heads/router-feature"], { cwd: checkout });
  await rm(trace, { force: true });
  const router = join(appRoot, `drivers/repo/github/credentials/client/router.${appExtension}`);
  const routed = await run(
    process.execPath,
    [
      router,
      "gh",
      "pr",
      "create",
      "-R",
      "fixture/repository",
      "--head",
      "router-feature",
      "--base",
      "main",
      "--title",
      "Routed native child",
      "--body",
      "Selected gateway session",
    ],
    {
      cwd: checkout,
      env: cleanEnvironment({
        HOME: client.directory,
        GH_TOKEN: "ambient-token-marker",
        GIT_CONFIG_SYSTEM: "/dev/null",
        OCE_REPOSITORY_REF: "fixture",
      }),
      allowFailure: true,
    },
  );
  assert.equal(routed.code, 0, routed.stderr);
  assert.equal(routed.stderr.includes("ambient-token-marker"), false);
  const events = (await readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    events.some((event) => event.event === "start" && /(?:^|\/)git$/.test(event.argv[0])),
    "gh must execute real native Git with the normal user configuration",
  );
  assert.ok(
    [...fixture.github.pulls.values()].some((pull) => pull.title === "Routed native child"),
  );
  const pinned = JSON.stringify([
    material.manifest.generation,
    "fixture",
    fixture.opened.session.sessionId,
  ]);
  const deniedPin = await run(process.execPath, [router, "gh", "api", "repos/fixture/repository"], {
    cwd: checkout,
    env: cleanEnvironment({
      HOME: client.directory,
      OCE_REPOSITORY_SELECTION: pinned,
      OCE_REPOSITORY_REF: "other",
    }),
    allowFailure: true,
  });
  assert.notEqual(deniedPin.code, 0);
  assert.equal(deniedPin.stdout, "");
  const before = fixture.github.trace.length;
  for (const target of [
    "/user",
    "/repos/other/repository",
    "/fixture/other.git/info/refs?service=git-upload-pack",
    "/repos/fixture/repository/actions/runs",
    "/repositories/73/issues",
  ]) {
    const denied = await gatewayRequest(fixture, target);
    assert.ok(denied.status >= 400);
  }
  assert.equal(fixture.github.trace.length, before);
});

// The host case runs this entire file in the container, including this fault case.
if (process.env.REPOSITORY_CREDENTIALS_CONTAINER_CHILD === "1") {
  test("uncertain API POST, PATCH and DELETE requests are sent once", async (t) => {
    const fixture = await startCredentialServiceFixture(t);
    const prefix = "/repos/fixture/repository";
    const issued = await gatewayRequest(fixture, `${prefix}/issues`, {
      method: "POST",
      body: { title: "Replay fixture" },
    });
    const issue = JSON.parse(issued.body);
    const commented = await gatewayRequest(fixture, `${prefix}/issues/${issue.number}/comments`, {
      method: "POST",
      body: { body: "Replay fixture" },
    });
    const comment = JSON.parse(commented.body);
    for (const [method, target, body] of [
      ["POST", `${prefix}/issues`, { title: "Accepted once" }],
      ["PATCH", `${prefix}/issues/${issue.number}`, { title: "Updated once" }],
      ["DELETE", `${prefix}/issues/comments/${comment.id}`, undefined],
    ]) {
      const count = () =>
        fixture.github.trace.filter((entry) => entry.method === method && entry.target === target)
          .length;
      const before = count();
      fixture.github.disconnectAfterMutation(method, target);
      try {
        const response = await gatewayRequest(fixture, target, { method, body });
        assert.ok(response.status >= 400);
      } catch (error) {
        assert.match(error.code ?? error.message, /ECONNRESET|aborted|socket hang up/);
      }
      assert.equal(count(), before + 1);
    }
  });
}
