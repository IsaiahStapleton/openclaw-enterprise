import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";

async function within(promise, message, timeoutMs = 30_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startRepositoryPlatformWorker({ databaseUrl, configFile, events }) {
  const child = fork(
    new URL("./repository-credentials-platform-worker-child.mjs", import.meta.url),
    [],
    {
      execArgv: [],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  let receipt;
  let failure;
  const closed = new Promise((resolve) => {
    child.once("error", () => {
      failure = new Error("platform worker spawn failed");
    });
    child.once("close", (code, signal) => {
      receipt = { pid: child.pid, code, signal };
      resolve(receipt);
    });
  });
  let ready;
  const probeRequests = new Map();
  let probeObserved;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  child.on("message", (message) => {
    if (message.type === "event") {
      events.push(message.event);
    } else if (message.type === "ready") {
      ready();
    } else if (message.type === "material-expiry-response") {
      probeRequests.get(message.requestId)?.(message);
    } else if (message.type === "material-expiry-observed") {
      probeObserved?.(message);
    }
  });
  async function probeCommand(action, id, extra = {}) {
    const requestId = randomUUID();
    const response = new Promise((resolve) => {
      probeRequests.set(requestId, resolve);
    });
    try {
      child.send({ type: "material-expiry-command", action, id, requestId, ...extra });
      const message = await within(response, `material expiry probe ${action} timed out`);
      assert.notEqual(message.failed, true, `material expiry probe ${action} failed`);
      return message.result;
    } finally {
      probeRequests.delete(requestId);
    }
  }
  async function terminate(signal) {
    if (!receipt) {
      assert.equal(child.kill(signal), true, "termination must reach the owned worker");
    }
    try {
      return await within(closed, "platform worker termination was not joined");
    } catch (error) {
      child.kill("SIGKILL");
      await within(closed, "platform worker forced termination was not joined", 5_000);
      throw error;
    }
  }
  try {
    child.send({ databaseUrl, configFile }, (error) => {
      if (error) {
        failure = new Error("platform worker startup IPC failed");
        child.kill("SIGKILL");
      }
    });
    await within(
      Promise.race([
        started,
        closed.then(() => {
          throw failure ?? new Error("platform worker exited before readiness");
        }),
      ]),
      "platform worker startup timed out",
    );
  } catch (error) {
    await terminate("SIGKILL");
    throw error;
  }
  return {
    pid: child.pid,
    async armMaterialExpiry(agentId) {
      assert.equal(probeObserved, undefined, "only one expiry probe may be armed");
      const id = randomUUID();
      const observed = new Promise((resolve) => {
        probeObserved = (message) => {
          if (message.id === id) {
            resolve(message);
          }
        };
      });
      await probeCommand("arm", id, { agentId });
      return {
        observed: () => within(observed, "material expiry observation timed out", 180_000),
        release: (proceed) => probeCommand("release", id, { proceed }),
        inspect: () => probeCommand("inspect", id),
      };
    },
    async stop() {
      const result = await terminate("SIGTERM");
      assert.equal(result.code, 0, "platform worker must stop cleanly");
      assert.equal(result.signal, null);
    },
    async kill() {
      const result = await terminate("SIGKILL");
      assert.equal(result.code, null);
      assert.equal(result.signal, "SIGKILL");
      return result;
    },
  };
}
