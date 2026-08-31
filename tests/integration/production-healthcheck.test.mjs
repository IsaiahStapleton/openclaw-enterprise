import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));

test("production worker readiness rejects a stale health marker that still satisfies liveness", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-worker-health-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "ready");
  await writeFile(marker, "ready\n", { encoding: "utf8", mode: 0o600 });
  const stale = new Date(Date.now() - 60_000);
  await utimes(marker, stale, stale);
  const environment = { ...process.env, OCC_WORKER_READINESS_PATH: marker };

  // An existing marker proves the process initialized, not that queue health is still current.
  await execute(process.execPath, ["scripts/production-healthcheck.mjs", "worker"], {
    cwd: repository,
    env: environment,
  });
  await assert.rejects(
    execute(process.execPath, ["scripts/production-healthcheck.mjs", "worker", "ready"], {
      cwd: repository,
      env: environment,
    }),
    ({ stderr }) => /recent healthy database observation/.test(stderr),
  );
});
