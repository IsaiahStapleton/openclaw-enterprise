import assert from "node:assert/strict";
import test from "node:test";
import {
  createRepositoryPlatformFixture,
  repositoryPlatformSelected,
} from "../helpers/repository-credentials-platform.mjs";

test(
  "ordinary Agent worker withholds readiness when material expires during a Kubernetes observation",
  {
    skip: repositoryPlatformSelected
      ? false
      : "Set OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM=1 with dedicated PostgreSQL, disposable k3d and the final-runtime fixture image.",
    timeout: 900_000,
  },
  async (context) => {
    const fixture = await createRepositoryPlatformFixture(context);
    const { namespace, kube, placement } = fixture;
    const agent = await fixture.createAgent([{ repositoryRef: "repo-a", profile: "git-full" }]);
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const gate = await fixture.armMaterialExpiry(agent.id);
    const eventCursor = fixture.events.length;
    let released = false;
    try {
      const revision = await fixture.request("POST", `${path}/deploy`, undefined, 202);
      const observed = await gate.observed();
      assert.notEqual(
        observed.failed,
        true,
        "Compute failed before producing its readiness result",
      );
      assert.equal(observed.revisionId, revision.id);
      assert.ok(observed.podUid && observed.podResourceVersion && observed.generation);
      assert.ok(observed.before < observed.deadline);
      assert.ok(observed.after >= observed.deadline);
      assert.equal(observed.readyBeforeHit, false);
      assert.equal(observed.materialReady, false, "Compute must reject the expired observation");
      assert.equal(observed.ready, false, "Compute must not report expired material ready");
      assert.equal(observed.activations, 0);
      assert.notEqual((await fixture.request("GET", path)).activeRevisionId, revision.id);
      assert.equal(
        fixture.events.slice(eventCursor).some((event) => event.code === "CLAIM_LOST"),
        false,
        "a lost Work claim must not explain the incomplete result",
      );
      // Request stop before releasing the real Compute result back to the
      // worker; its ordinary authority checks still own the stop transition.
      await fixture.request("POST", `${path}/stop`, undefined, 202);
      await gate.release(true);
      released = true;
      await kube.waitFor(
        "ordinary stop to remove the workload and settle its session",
        async () => {
          const current = await fixture.request("GET", path);
          const pods = await kube.resources(
            "pods",
            placement,
            "-l",
            `openclaw.dev/agent=${agent.id}`,
          );
          const attempts = await fixture.attempts(revision);
          return (
            current.activeRevisionId === undefined &&
            pods.length === 0 &&
            attempts.length > 0 &&
            attempts.every(({ phase }) => phase === "disposed" || phase === "invalidated")
          );
        },
      );
      assert.equal((await gate.inspect()).activations, 0);
    } finally {
      if (!released) {
        // A failed assertion must not release a ready result to the worker.
        await gate.release(false);
      }
    }
  },
);
