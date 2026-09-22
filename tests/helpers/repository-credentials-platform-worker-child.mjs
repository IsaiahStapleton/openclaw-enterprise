import pg from "pg";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";

let worker;

process.once("message", async ({ databaseUrl, configFile }) => {
  try {
    const drivers = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: configFile },
    });
    worker = createControllerWorker({
      mode: "production",
      pool: new pg.Pool({ connectionString: databaseUrl, max: 4 }),
      drivers,
      pollIntervalMs: 25,
      leaseDurationMs: 6_000,
      maxAttempts: 30,
      emit: (event) => process.send({ type: "event", event }),
    });
    await worker.start();
    process.send({ type: "ready" });
  } catch {
    // Configuration and database errors may contain private connection details.
    process.exit(1);
  }
});

process.once("SIGTERM", async () => {
  try {
    await worker?.stop();
    process.exit(0);
  } catch {
    process.exit(1);
  }
});

// Losing the test runner must not strand the separately owned worker.
process.once("disconnect", () => process.exit(1));
