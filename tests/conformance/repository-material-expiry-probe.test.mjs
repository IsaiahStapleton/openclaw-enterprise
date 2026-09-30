import assert from "node:assert/strict";
import test from "node:test";
import { installRepositoryMaterialExpiryProbe } from "../helpers/repository-material-expiry-probe.mjs";

function fakeCompute({ fail = false, matching = true } = {}) {
  const revision = { id: "revision", agentId: "agent", namespaceId: "tenant" };
  const namespace = { name: "execution", plane: "execution" };
  const deadline = Date.now() + 30_000;
  const material = { generation: "generation", bindings: [{ deadlineWallMs: deadline }] };
  const response = {
    items: [
      {
        metadata: {
          namespace: namespace.name,
          uid: "pod-uid",
          resourceVersion: "1",
          labels: {
            "openclaw.dev/agent": revision.agentId,
            "openclaw.dev/revision": revision.id,
            "openclaw.dev/workload-role": "gateway",
          },
          annotations: { "openclaw.dev/repository-material-generation": material.generation },
        },
        status: { conditions: [{ type: "Ready", status: matching ? "True" : "False" }] },
      },
    ],
  };
  const core = {
    async listNamespacedPod() {
      return response;
    },
  };
  const driver = {
    async clients() {
      return { core };
    },
    async repositoryMaterialReady(current, target, binding) {
      const observed = await core.listNamespacedPod({
        namespace: target.name,
        labelSelector: `openclaw.dev/namespace=${current.namespaceId},openclaw.dev/agent=${current.agentId},openclaw.dev/revision=${current.id},openclaw.dev/workload-role=gateway`,
      });
      assert.equal(observed, response, "the probe must forward the original response");
      if (fail) {
        throw new Error("controlled readiness failure");
      }
      return Date.now() < binding.bindings[0].deadlineWallMs;
    },
    async prepareRevision(current) {
      return { ready: await this.repositoryMaterialReady(current, namespace, material) };
    },
    async activateRevision() {},
  };
  return { driver, revision, deadline };
}

test("the test probe advances only a matching observation and restores the clock", async () => {
  const { driver, revision, deadline } = fakeCompute();
  const clock = Date.now;
  let observed;
  const event = new Promise((resolve) => {
    observed = resolve;
  });
  const probe = await installRepositoryMaterialExpiryProbe(driver, observed);
  probe.arm("probe", revision.agentId);
  const pending = driver.prepareRevision(revision);
  const receipt = await event;
  assert.equal(receipt.deadline, deadline);
  assert.equal(receipt.materialReady, false);
  assert.equal(receipt.ready, false);
  assert.equal(Date.now, clock);
  probe.release("probe", true);
  assert.deepEqual(await pending, { ready: false });
  assert.deepEqual(probe.inspect("probe"), { activations: 0, state: "resumed" });
});

test("the test probe restores the clock when the real readiness operation fails", async () => {
  const { driver, revision } = fakeCompute({ fail: true });
  const clock = Date.now;
  const probe = await installRepositoryMaterialExpiryProbe(driver, () => {});
  probe.arm("probe", revision.agentId);
  await assert.rejects(driver.prepareRevision(revision), /controlled readiness failure/);
  assert.equal(Date.now, clock);
});

test("cancelling a held observation fences later preparation and activation", async () => {
  const { driver, revision } = fakeCompute();
  let observed;
  const event = new Promise((resolve) => {
    observed = resolve;
  });
  const probe = await installRepositoryMaterialExpiryProbe(driver, observed);
  probe.arm("probe", revision.agentId);
  const pending = driver.prepareRevision(revision);
  await event;
  probe.release("probe", false);
  await assert.rejects(pending, /cancelled the pending Compute result/);
  await assert.rejects(driver.prepareRevision(revision), /cancelled further preparation/);
  await assert.rejects(driver.activateRevision(revision), /cancelled activation/);
});

test("an unrelated or unready Pod does not advance the worker clock", async () => {
  const { driver, revision } = fakeCompute({ matching: false });
  const clock = Date.now;
  let emitted = false;
  const probe = await installRepositoryMaterialExpiryProbe(driver, () => {
    emitted = true;
  });
  probe.arm("probe", revision.agentId);
  assert.deepEqual(await driver.prepareRevision(revision), { ready: true });
  assert.equal(Date.now, clock);
  assert.equal(emitted, false);
});

test("a timed-out observation cannot later be released as a real result", async () => {
  const { driver, revision } = fakeCompute();
  let observed;
  const event = new Promise((resolve) => {
    observed = resolve;
  });
  const probe = await installRepositoryMaterialExpiryProbe(driver, observed, { holdTimeoutMs: 10 });
  probe.arm("probe", revision.agentId);
  const pending = driver.prepareRevision(revision);
  await event;
  await assert.rejects(pending, /release timed out/);
  assert.throws(() => probe.release("probe", true), /no longer held/);
  assert.deepEqual(probe.inspect("probe"), { activations: 0, state: "timed-out" });
});

test("a later preparation stays fenced until the observation has been checked", async () => {
  const { driver, revision } = fakeCompute();
  let observed;
  const event = new Promise((resolve) => {
    observed = resolve;
  });
  const probe = await installRepositoryMaterialExpiryProbe(driver, observed);
  probe.arm("probe", revision.agentId);
  const first = driver.prepareRevision(revision);
  await event;
  probe.release("probe", true);
  assert.deepEqual(await first, { ready: false });
  const later = driver.prepareRevision(revision);
  probe.finish("probe");
  await assert.rejects(later, /fenced a subsequent preparation/);
});
