import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";

test(
  "unknown metadata token ownership settles queued display and remains visible at shutdown",
  { timeout: 20000 },
  async () => {
    // This child owns only local fixture services. Its intentionally unknown token
    // cannot be disposed, so the parent terminates and joins the disposable process.
    const child = fork(
      new URL("../fixtures/repository-credentials/metadata-uncertain-child.mjs", import.meta.url),
      [],
      {
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    try {
      const message = await Promise.race([
        once(child, "message").then(([value]) => value),
        once(child, "exit").then(() => {
          throw new Error("metadata fixture exited before its report");
        }),
      ]);
      assert.notEqual(message.type, "error", message.message);
      assert.deepEqual(message, { type: "result", graceExpired: true, pendingCredentials: 1 });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  },
);
