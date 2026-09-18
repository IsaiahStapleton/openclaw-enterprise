import assert from "node:assert/strict";
import test from "node:test";
import {
  createRepositoryPlatformFixture,
  repositoryPlatformSelected,
} from "../helpers/repository-credentials-platform.mjs";

test(
  "ordinary Agent repository bindings traverse HTTP, PostgreSQL, Unix control and Kubernetes material",
  {
    skip: repositoryPlatformSelected
      ? false
      : "Set OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM=1 with dedicated PostgreSQL, disposable k3d and the final-runtime fixture image.",
    timeout: 900_000,
  },
  async (context) => {
    const fixture = await createRepositoryPlatformFixture(context);
    const { namespace, credentials, kube, placement } = fixture;
    const agent = await fixture.createAgent([
      { repositoryRef: "repo-a", profile: "git-full" },
      { repositoryRef: "repo-b", profile: "git-read" },
    ]);
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    await fixture.request(
      "PATCH",
      path,
      {
        configurationId: agent.configurationId,
        repositoryBindings: [{ repositoryRef: "unapproved-repository" }],
      },
      404,
    );
    assert.ok(credentials.repositories.every(({ github }) => github.issuesOfTokens.length === 0));
    assert.deepEqual(
      (await fixture.request("GET", path)).repositoryBindings,
      agent.repositoryBindings,
    );
    // The second real admission succeeds remotely while its response is held.
    // Expiring the real PostgreSQL lease leaves a partly recorded binding set;
    // recovery must close the once-delivered session before replacing it.
    const gate = fixture.control.holdCreatedResponse(2);
    let withheld;
    void gate.observed.then((receipt) => {
      withheld = receipt;
    });
    const revision = await fixture.request("POST", `${path}/deploy`, undefined, 202);
    try {
      await kube.waitFor(
        "second admission response at the actual Unix transport",
        () => withheld,
        30_000,
      );
      const partial = await fixture.attempts(revision);
      assert.equal(partial.filter(({ phase }) => phase === "open").length, 1);
      assert.equal(partial.filter(({ phase }) => phase === "opening").length, 1);
      assert.equal(credentials.service.status(withheld.sessionId).state, "OPEN");
      const pods = await kube.resources("pods", placement, "-l", `openclaw.dev/agent=${agent.id}`);
      assert.equal(pods.length, 0, "a partial credential set must not reach Compute");
      const claimCursor = fixture.events.length;
      const expired = await fixture.pool.query(
        "UPDATE occ.controller_work SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE revision_id=$1 AND state='claimed' RETURNING idempotency_key",
        [revision.id],
      );
      assert.equal(expired.rowCount, 1);
      await kube.waitFor(
        "actual lease loss to abort the partial deployment",
        () =>
          fixture.events
            .slice(claimCursor)
            .some((event) => event.event === "worker.error" && event.code === "CLAIM_LOST"),
        30_000,
      );
    } finally {
      gate.release();
    }
    let pod = await fixture.readyPod(agent, revision);
    const original = await fixture.material(pod);
    assert.deepEqual(
      original.bindings.map(({ repositoryRef }) => repositoryRef),
      ["repo-a", "repo-b"],
    );
    assert.notEqual(original.bindings[0].sessionId, original.bindings[1].sessionId);
    for (const binding of original.bindings) {
      assert.equal(binding.directoryMode, 0o700);
      for (const file of binding.files) {
        assert.equal(file.regular, true);
        assert.equal(file.symbolicLink, false);
        assert.equal(file.mode, 0o600);
      }
    }
    await kube.waitFor("lost-response admission cleanup", async () =>
      (await fixture.attempts(revision)).some(
        ({ session_id, phase }) => session_id === withheld.sessionId && phase === "disposed",
      ),
    );
    const recovered = await fixture.attempts(revision);
    assert.ok(
      recovered.some(
        ({ session_id, phase }) => session_id === withheld.sessionId && phase === "disposed",
      ),
    );
    assert.notEqual(credentials.service.status(withheld.sessionId)?.state, "OPEN");
    const owned = recovered.filter(({ phase }) => phase === "open");
    assert.equal(owned.length, 2);
    for (const binding of original.bindings) {
      const attempt = owned.find((row) => row.repository_ref === binding.repositoryRef);
      assert.equal(attempt.phase, "open");
      assert.equal(attempt.session_id, binding.sessionId);
      assert.equal(Number(attempt.deadline_wall_ms), binding.deadlineWallMs);
      assert.equal(credentials.service.status(binding.sessionId).state, "OPEN");
    }
    context.diagnostic(
      "Actual HTTP admission and PostgreSQL-owned sessions reached private regular files in the Agent Pod.",
    );

    // The runtime image retains the real clients. Only the Harness is a fixture;
    // this deterministic case makes no model-execution claim.
    const [first, second] = credentials.repositories;
    const workspace = "/home/node/.openclaw/workspace";
    const firstCheckout = `${workspace}/repository`;
    const secondCheckout = `${workspace}/other`;
    await fixture.tool(pod, "git", ["clone", `https://github.com/${first.repository}.git`]);
    await fixture.tool(pod, "git", ["clone", `https://github.com/${second.repository}.git`]);
    const [metadata, remote] = await Promise.all([
      fixture.tool(pod, "gh", ["api", `repos/${first.repository}`], { cwd: firstCheckout }),
      fixture.tool(pod, "git", ["-C", secondCheckout, "ls-remote", "origin", "HEAD"]),
    ]);
    assert.equal(JSON.parse(metadata).full_name, first.repository);
    assert.match(remote, /^[a-f0-9]{40}\s+HEAD\s*$/);
    assert.deepEqual(first.github.issuesOfTokens[0].repositoryIds.map(String), [
      first.repositoryId,
    ]);
    assert.deepEqual(second.github.issuesOfTokens[0].repositoryIds.map(String), [
      second.repositoryId,
    ]);
    assert.equal(second.github.issuesOfTokens[0].permissions.contents, "read");

    await fixture.tool(pod, "git", ["-C", firstCheckout, "fetch", "origin"]);
    await fixture.tool(pod, "git", ["-C", firstCheckout, "switch", "-c", "native-feature"]);
    await fixture.podNode(
      pod,
      `require('node:fs').writeFileSync(${JSON.stringify(`${firstCheckout}/platform-proof.txt`)}, 'repository platform proof\n');`,
    );
    await fixture.tool(pod, "git", ["-C", firstCheckout, "add", "platform-proof.txt"]);
    await fixture.tool(pod, "git", [
      "-C",
      firstCheckout,
      "-c",
      "user.name=Platform Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "Repository platform proof",
    ]);
    const commit = (
      await fixture.tool(pod, "git", ["-C", firstCheckout, "rev-parse", "HEAD"])
    ).trim();
    await fixture.tool(pod, "git", [
      "-C",
      firstCheckout,
      "push",
      "origin",
      "HEAD:refs/heads/native-feature",
    ]);
    assert.equal(await first.git.ref("refs/heads/native-feature"), commit);
    await fixture.tool(
      pod,
      "gh",
      [
        "pr",
        "create",
        "--head",
        "native-feature",
        "--base",
        "main",
        "--title",
        "Platform fixture",
        "--body",
        "Repository platform proof",
      ],
      { cwd: firstCheckout },
    );
    assert.equal([...first.github.pulls.values()].filter(({ native }) => native).length, 1);
    assert.equal(second.github.pulls.size, 0);

    // A different admitted binding cannot upgrade this read-only repository.
    const secondBefore = second.git.trace.length;
    await fixture.tool(
      pod,
      "git",
      ["-C", secondCheckout, "push", "origin", "HEAD:refs/heads/denied-write"],
      { expected: "failure" },
    );
    assert.equal(
      second.git.trace.slice(secondBefore).some(({ path }) => path.endsWith("/git-receive-pack")),
      false,
    );
    const beforeDeniedApi = second.github.trace.length;
    await fixture.tool(pod, "gh", ["api", `repos/${second.repository}`], {
      cwd: secondCheckout,
      expected: 1,
    });
    assert.equal(second.github.trace.length, beforeDeniedApi);

    // The default write profile admits Git writes, but still cannot create PRs
    // or use the REST surface reserved for explicit full access.
    const writer = await fixture.createAgent([{ repositoryRef: "repo-a", profile: "git-write" }]);
    const writerPath = `/namespaces/${namespace.id}/agents/${writer.id}`;
    const writerRevision = await fixture.request("POST", `${writerPath}/deploy`, undefined, 202);
    const writerPod = await fixture.readyPod(writer, writerRevision);
    await fixture.tool(writerPod, "git", [
      "ls-remote",
      `https://github.com/${first.repository}.git`,
      "HEAD",
    ]);
    assert.deepEqual(first.github.issuesOfTokens.at(-1).permissions, {
      metadata: "read",
      contents: "write",
    });
    const writerTrace = first.github.trace.length;
    await fixture.tool(writerPod, "gh", ["api", `repos/${first.repository}`], {
      expected: "failure",
    });
    await fixture.tool(
      writerPod,
      "gh",
      [
        "pr",
        "create",
        "--repo",
        `github.com/${first.repository}`,
        "--head",
        "native-feature",
        "--base",
        "main",
        "--title",
        "Denied profile",
        "--body",
        "Must not reach provider",
      ],
      { expected: "failure" },
    );
    assert.equal(first.github.trace.length, writerTrace);
    await fixture.request("POST", `${writerPath}/stop`, undefined, 202);
    await kube.waitFor("write-profile Agent stop without affecting its sibling", async () =>
      (await fixture.attempts(writerRevision)).every(
        ({ phase }) => phase === "disposed" || phase === "invalidated",
      ),
    );
    assert.equal((await fixture.request("GET", path)).activeRevisionId, revision.id);
    assert.equal((await fixture.material(pod)).generation, original.generation);
    context.diagnostic(
      "The same Agent used both independently scoped bindings; real Git/gh preserved profile denial and repository routing.",
    );

    // Worker replacement resumes durable maintenance without opening fresh
    // authority for material already retained by the same immutable revision.
    const replacementCursor = await fixture.restartWorker();
    await kube.waitFor("maintenance after worker replacement", async () =>
      fixture.events
        .slice(replacementCursor)
        .some(
          (event) =>
            event.event === "worker.completed" &&
            event.revisionId === revision.id &&
            event.code === "REVISION_ALREADY_ACTIVE",
        ),
    );
    assert.deepEqual(
      (await fixture.attempts(revision))
        .filter(({ phase }) => phase === "open")
        .map(({ session_id }) => session_id)
        .sort(),
      owned.map(({ session_id }) => session_id).sort(),
    );
    assert.equal((await fixture.material(pod)).generation, original.generation);

    // Removing exactly one real immutable Secret exercises retained-material
    // repair through Compute's observation and the normal worker retry path.
    const projected = pod.spec.volumes.find(
      ({ name }) => name === "repository-material-projection",
    );
    assert.equal(projected.projected.sources.length, 2);
    await kube.kubectl(
      "delete",
      "secret",
      projected.projected.sources[0].secret.name,
      "-n",
      placement,
    );
    const repairedPod = await fixture.readyPod(agent, revision, pod.metadata.uid);
    const repaired = await fixture.material(repairedPod);
    assert.notEqual(repaired.generation, original.generation);
    assert.notEqual(repaired.bindings[0].sessionId, original.bindings[0].sessionId);
    assert.equal(repaired.bindings[1].sessionId, original.bindings[1].sessionId);
    assert.notEqual(credentials.service.status(original.bindings[0].sessionId)?.state, "OPEN");
    pod = repairedPod;

    // The service owns ephemeral sessions. Its restart must force the worker
    // to replace both sessions and roll actual runtime material before success.
    await credentials.restart();
    const restartedPod = await fixture.readyPod(agent, revision, pod.metadata.uid);
    const restarted = await fixture.material(restartedPod);
    assert.notEqual(restarted.generation, repaired.generation);
    for (const binding of restarted.bindings) {
      assert.notEqual(
        binding.sessionId,
        repaired.bindings.find((entry) => entry.repositoryRef === binding.repositoryRef).sessionId,
      );
      assert.equal(credentials.service.status(binding.sessionId).state, "OPEN");
    }
    await fixture.tool(restartedPod, "git", ["-C", firstCheckout, "fetch", "origin"]);
    const beforeRenewal = first.github.issuesOfTokens.length;
    // Controlled provider/service time proves hour-thirteen renewal without a
    // wall-clock wait. Perform it after repairs so new admission timestamps use
    // the same real clock as the worker throughout the lifecycle assertions.
    await credentials.clock.advance(13 * 60 * 60 * 1000);
    await fixture.tool(restartedPod, "git", ["-C", firstCheckout, "fetch", "origin"]);
    assert.ok(first.github.issuesOfTokens.length > beforeRenewal);
    assert.equal((await fixture.material(restartedPod)).generation, restarted.generation);
    context.diagnostic(
      "Worker restart, exact missing-material repair, service restart, and controlled hour-thirteen renewal passed through the real platform path.",
    );

    await fixture.request("POST", `${path}/stop`, undefined, 202);
    await kube.waitFor("ordinary Agent stop to dispose sessions and workloads", async () => {
      const current = await fixture.request("GET", path);
      const attempts = await fixture.attempts(revision);
      const pods = await kube.resources("pods", placement, "-l", `openclaw.dev/agent=${agent.id}`);
      return (
        current.activeRevisionId === undefined &&
        pods.length === 0 &&
        attempts.every(({ phase }) => phase === "disposed" || phase === "invalidated")
      );
    });
    for (const binding of restarted.bindings) {
      assert.notEqual(credentials.service.status(binding.sessionId)?.state, "OPEN");
    }
    const remaining = await kube.resources(
      "secrets",
      placement,
      "-l",
      `openclaw.dev/agent=${agent.id},openclaw.dev/repository-material=session`,
    );
    assert.equal(
      remaining.length,
      0,
      "runtime material must be removed after actual Pod termination",
    );
    for (const repository of credentials.repositories)
      assert.deepEqual(repository.github.errors, []);
  },
);
