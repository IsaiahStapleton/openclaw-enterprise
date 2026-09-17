import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startCredentialServiceFixture } from "../fixtures/repository-credentials/service.mjs";
import { exerciseGit } from "../fixtures/repository-credentials/workflows.mjs";
import { runInFixtureContainer } from "../fixtures/repository-credentials/container.mjs";

test("real Git clones, fetches, switches and pushes using the cold gateway helper", async (t) => {
  if (await runInFixtureContainer(t, "tests/integration/repository-credentials-git.test.mjs"))
    return;
  const fixture = await startCredentialServiceFixture(t, { profile: "git-write" });
  await exerciseGit(t, fixture);
  assert.ok(fixture.git.trace.some((entry) => entry.gitProtocol === "version=2"));
  assert.ok(fixture.git.trace.some((entry) => entry.path.endsWith("/git-receive-pack")));
  assert.equal(fixture.github.issuesOfTokens.length, 1);
  assert.deepEqual(fixture.github.issuesOfTokens[0].permissions, {
    metadata: "read",
    contents: "write",
  });
});

// The host case runs this entire file in the container, including this fault case.
if (process.env.REPOSITORY_CREDENTIALS_CONTAINER_CHILD === "1") {
  test("accepted push with a lost response is never replayed by the service", async (t) => {
    const fixture = await startCredentialServiceFixture(t);
    const { client, checkout } = await exerciseGit(t, fixture);
    await writeFile(join(checkout, "uncertain.txt"), "Accepted despite lost response\n");
    await client.git(["add", "uncertain.txt"], { cwd: checkout });
    await client.git(["commit", "-m", "Uncertain push fixture"], { cwd: checkout });
    const head = (await client.git(["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const before = fixture.git.trace.filter((entry) =>
      entry.path.endsWith("/git-receive-pack"),
    ).length;
    fixture.git.disconnectAfterNextAcceptedPush();
    const pushed = await client.git(["push", "origin", "HEAD:refs/heads/uncertain-feature"], {
      cwd: checkout,
      allowFailure: true,
    });
    assert.notEqual(pushed.code, 0);
    assert.equal(await fixture.git.ref("refs/heads/uncertain-feature"), head);
    assert.equal(
      fixture.git.trace.filter((entry) => entry.path.endsWith("/git-receive-pack")).length,
      before + 1,
    );
  });
}
