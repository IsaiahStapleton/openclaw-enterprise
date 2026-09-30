import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startCredentialServiceFixture, eventually, gatewayRequest } from "./service.mjs";
import { exerciseGit, exerciseGh } from "./workflows.mjs";
import { fixtureRepository } from "./github.mjs";

async function clientFileDigests(directory) {
  return Promise.all(
    ["bearer", "client.json", "gitconfig", "gh/hosts.yml", "gh/config.yml", "ca.pem"].map(
      async (name) => ({
        name,
        digest: createHash("sha256")
          .update(await readFile(join(directory, name)))
          .digest("hex"),
      }),
    ),
  );
}

export async function qualifyLongSession(t, { profile = "git-full" } = {}) {
  assert.ok(profile === "git-full" || profile === "git-write");
  const fixture = await startCredentialServiceFixture(t, { profile });
  const { client, checkout, commit } = await exerciseGit(t, fixture, { push: false });
  const { session } = fixture.opened;
  const admittedFiles = await clientFileDigests(fixture.clientDirectory);
  const firstToken = fixture.github.tokenState()[0];
  const firstIssue = fixture.github.issuesOfTokens[0];
  // The same running service and private client files survive a trusted clock
  // advance. No admission, bearer rewrite, or runtime restart is performed.
  await fixture.clock.advance(13 * 3600000 + 1000);
  await client.git(
    ["push", "origin", "HEAD:refs/heads/agent-feature", "HEAD:refs/heads/native-feature"],
    { cwd: checkout },
  );
  assert.equal(await fixture.git.ref("refs/heads/agent-feature"), commit);
  if (profile === "git-full") {
    await exerciseGh(t, fixture, client);
  } else {
    // git-write permits pull requests but does not permit the issue writes
    // exercised by the broader git-full workflow.
    const traceStart = fixture.github.trace.length;
    await client.gh([
      "pr",
      "create",
      "--repo",
      `github.com/${fixtureRepository}`,
      "--head",
      "native-feature",
      "--base",
      "main",
      "--title",
      "Long-session change",
      "--body",
      "Created after controlled token renewal",
    ]);
    const pull = [...fixture.github.pulls.values()].find(
      ({ title, native }) => title === "Long-session change" && native,
    );
    assert.ok(pull);
    const readBack = JSON.parse(
      (await client.gh(["api", `repos/${fixtureRepository}/pulls/${pull.number}`])).stdout,
    );
    assert.equal(readBack.head.ref, "native-feature");
    assert.equal(readBack.base.ref, "main");
    assert.equal(await fixture.git.ref("refs/heads/native-feature"), commit);
    const refreshedToken = fixture.github.issuesOfTokens[1];
    assert.ok(refreshedToken);
    assert.ok(
      fixture.github.trace
        .slice(traceStart)
        .some(
          ({ operation, tokenIndex }) =>
            operation === "createPullRequest" && tokenIndex === refreshedToken.index,
        ),
    );
    assert.deepEqual(refreshedToken.permissions, {
      metadata: "read",
      contents: "write",
      issues: "read",
      pull_requests: "write",
      checks: "read",
      statuses: "read",
    });
    assert.equal(fixture.github.errors.length, 0);
  }
  assert.deepEqual(
    await clientFileDigests(fixture.clientDirectory),
    admittedFiles,
    "the bearer and client configuration files remain unchanged",
  );
  assert.equal(fixture.service.status(session.sessionId).deadlineWallMs, session.deadlineWallMs);
  assert.equal(fixture.service.status(session.sessionId).sessionId, session.sessionId);
  assert.deepEqual(fixture.service.status(session.sessionId).binding, session.binding);
  assert.equal(
    fixture.github.tokenState()[0].attempts,
    firstToken.attempts,
    "expired A receives no post-advance authentication attempts",
  );
  assert.equal(fixture.github.issuesOfTokens.length, 2);
  const secondIssue = fixture.github.issuesOfTokens[1];
  assert.ok(secondIssue.claims.iat > firstIssue.claims.exp);
  assert.deepEqual(secondIssue.permissions, firstIssue.permissions);
  assert.deepEqual(secondIssue.repositoryIds, firstIssue.repositoryIds);
  fixture.service.close(session.sessionId);
  assert.ok((await gatewayRequest(fixture, "/repos/fixture/repository")).status >= 400);
  await eventually(() => fixture.service.status(session.sessionId)?.state === "DISPOSED");
  assert.equal(fixture.github.tokenState()[1].revoked, true);
}
