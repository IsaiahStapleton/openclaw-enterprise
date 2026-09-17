import assert from "node:assert/strict";
import test from "node:test";
import {
  startCredentialServiceFixture,
  gatewayRequest,
} from "../fixtures/repository-credentials/service.mjs";
import { exerciseGit, exerciseGh } from "../fixtures/repository-credentials/workflows.mjs";
import { runInFixtureContainer } from "../fixtures/repository-credentials/container.mjs";

test("pinned gh uses canonical GitHub identity for REST, pagination and native PR creation", async (t) => {
  if (await runInFixtureContainer(t, "tests/integration/repository-credentials-gh.test.mjs"))
    return;
  const fixture = await startCredentialServiceFixture(t);
  const { client, checkout } = await exerciseGit(t, fixture);
  await client.git(["push", "origin", "HEAD:refs/heads/native-feature"], { cwd: checkout });
  await exerciseGh(t, fixture, client);
  assert.ok(
    fixture.github.trace.filter((entry) => entry.tokenIndex).every((entry) => entry.userAgent),
  );
  const before = fixture.github.trace.length;
  for (const target of [
    "/user",
    "/repos/other/repository",
    "/fixture/other.git/info/refs?service=git-upload-pack",
    "/repos/fixture/repository/actions/runs",
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
