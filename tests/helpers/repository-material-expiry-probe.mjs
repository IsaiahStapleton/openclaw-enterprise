import { AsyncLocalStorage } from "node:async_hooks";

// The probe is installed only for the expiry integration case. It forwards the
// original Kubernetes response and Compute result without changing either.
export async function installRepositoryMaterialExpiryProbe(
  driver,
  send,
  { holdTimeoutMs = 30_000 } = {},
) {
  const clients = await driver.clients("execution");
  const core = clients.core;
  const listPods = core.listNamespacedPod;
  const prepare = driver.prepareRevision;
  const ready = driver.repositoryMaterialReady;
  const activate = driver.activateRevision;
  if (![listPods, prepare, ready, activate].every((method) => typeof method === "function")) {
    throw new Error("The real Kubernetes Compute probe boundary is unavailable.");
  }
  const observation = new AsyncLocalStorage();
  let probe;

  core.listNamespacedPod = async function (...args) {
    const result = await listPods.apply(this, args);
    const scoped = observation.getStore();
    if (scoped === undefined || scoped.probe.hit !== undefined) {
      return result;
    }
    const [request] = args;
    const labels = Object.fromEntries(
      (request.labelSelector ?? "").split(",").map((entry) => entry.split("=")),
    );
    const { revision, namespace, material } = scoped;
    if (
      request.namespace !== namespace.name ||
      labels["openclaw.dev/namespace"] !== revision.namespaceId ||
      labels["openclaw.dev/agent"] !== revision.agentId ||
      labels["openclaw.dev/revision"] !== revision.id ||
      labels["openclaw.dev/workload-role"] !== "gateway"
    ) {
      return result;
    }
    const pod = result.items?.find(
      (item) =>
        item.metadata?.namespace === namespace.name &&
        item.metadata?.uid &&
        item.metadata?.resourceVersion &&
        item.metadata?.deletionTimestamp === undefined &&
        item.metadata?.labels?.["openclaw.dev/agent"] === revision.agentId &&
        item.metadata?.labels?.["openclaw.dev/revision"] === revision.id &&
        item.metadata?.labels?.["openclaw.dev/workload-role"] === "gateway" &&
        item.metadata?.annotations?.["openclaw.dev/repository-material-generation"] ===
          material.generation &&
        item.status?.conditions?.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        ),
    );
    if (pod === undefined) {
      return result;
    }
    const deadline = Math.min(...material.bindings.map(({ deadlineWallMs }) => deadlineWallMs));
    const realNow = Date.now;
    const before = realNow();
    if (!Number.isSafeInteger(deadline) || before >= deadline) {
      throw new Error("The probe must observe live material before advancing its clock.");
    }
    scoped.probe.hit = {
      revisionId: revision.id,
      podUid: pod.metadata.uid,
      podResourceVersion: pod.metadata.resourceVersion,
      generation: material.generation,
      before,
      deadline,
    };
    // Date.now is process-wide. Restore it as soon as the readiness call settles;
    // timers and the separate PostgreSQL server retain their ordinary clocks.
    scoped.restoreClock = () => {
      Date.now = realNow;
    };
    Date.now = () => Math.max(realNow(), deadline);
    scoped.probe.hit.after = Date.now();
    return result;
  };

  driver.repositoryMaterialReady = async function (revision, namespace, material) {
    const current = probe;
    if (
      current === undefined ||
      current.agentId !== revision.agentId ||
      current.hit !== undefined
    ) {
      return ready.call(this, revision, namespace, material);
    }
    const scoped = { probe: current, revision, namespace, material, restoreClock: undefined };
    return observation.run(scoped, async () => {
      try {
        const result = await ready.call(this, revision, namespace, material);
        if (current.hit !== undefined) {
          current.materialReady = result;
        }
        return result;
      } finally {
        scoped.restoreClock?.();
      }
    });
  };

  driver.prepareRevision = async function (revision, context) {
    const current = probe;
    if (current?.agentId === revision.agentId && current.cancelled) {
      throw new Error("Expiry probe cancelled further preparation.");
    }
    if (current?.agentId === revision.agentId && current.reported) {
      // The first result must reach the worker, but a later retry must not
      // activate while the parent observes its durable incomplete outcome.
      await current.retryFence;
      throw new Error("Expiry probe fenced a subsequent preparation.");
    }
    let result;
    try {
      result = await prepare.call(this, revision, context);
    } catch (error) {
      if (current?.agentId === revision.agentId && current.hit !== undefined && !current.reported) {
        current.reported = true;
        current.cancelled = true;
        send({ type: "material-expiry-observed", id: current.id, failed: true });
      }
      throw error;
    }
    if (current === undefined || current.agentId !== revision.agentId || current.reported) {
      return result;
    }
    if (current.hit === undefined) {
      current.readyBeforeHit ||= result.ready === true;
      return result;
    }
    current.reported = true;
    current.state = "held";
    send({
      type: "material-expiry-observed",
      id: current.id,
      ...current.hit,
      materialReady: current.materialReady,
      ready: result.ready,
      readyBeforeHit: current.readyBeforeHit,
      activations: current.activations,
    });
    let timer;
    try {
      const proceed = await Promise.race([
        current.release,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            current.cancelled = true;
            current.state = "timed-out";
            reject(new Error("Expiry probe release timed out."));
          }, holdTimeoutMs);
        }),
      ]);
      if (!proceed) {
        throw new Error("Expiry probe cancelled the pending Compute result.");
      }
      current.state = "resumed";
      send({ type: "material-expiry-resumed", id: current.id });
      return result;
    } finally {
      clearTimeout(timer);
    }
  };

  driver.activateRevision = async function (revision, ...args) {
    if (probe?.agentId === revision.agentId) {
      probe.activations += 1;
      if (probe.cancelled) {
        throw new Error("Expiry probe cancelled activation.");
      }
    }
    return activate.call(this, revision, ...args);
  };

  return {
    arm(id, agentId) {
      if (probe !== undefined) {
        throw new Error("Only one material expiry probe is supported.");
      }
      let release;
      let releaseRetry;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const retryFence = new Promise((resolve) => {
        releaseRetry = resolve;
      });
      probe = {
        id,
        agentId,
        release: pending,
        resolve: release,
        retryFence,
        resolveRetry: releaseRetry,
        readyBeforeHit: false,
        activations: 0,
        reported: false,
        cancelled: false,
        state: "armed",
      };
    },
    release(id, proceed) {
      if (probe?.id !== id) {
        throw new Error("Unknown material expiry probe.");
      }
      if (proceed === true && probe.state !== "held") {
        throw new Error("The material expiry observation is no longer held.");
      }
      if (proceed !== true) {
        probe.cancelled = true;
        probe.resolveRetry();
      }
      if (proceed === true) {
        probe.state = "released";
      }
      probe.resolve(proceed === true);
    },
    finish(id) {
      if (probe?.id !== id) {
        throw new Error("Unknown material expiry probe.");
      }
      probe.cancelled = true;
      probe.resolveRetry();
    },
    inspect(id) {
      if (probe?.id !== id) {
        throw new Error("Unknown material expiry probe.");
      }
      return { activations: probe.activations, state: probe.state };
    },
  };
}
