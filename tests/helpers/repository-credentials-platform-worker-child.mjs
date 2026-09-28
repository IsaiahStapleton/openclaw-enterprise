import pg from "pg";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { startRepositoryReceiptServer } from "../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";

let worker;
let receiptServer;

process.once("message", async ({ databaseUrl, configFile }) => {
  try {
    const drivers = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: configFile },
    });
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    if (drivers.repositoryReceipt !== undefined) {
      receiptServer = await startRepositoryReceiptServer({
        ...drivers.repositoryReceipt,
        state: new PostgresPlatformState(pool),
      });
    }
    worker = createControllerWorker({
      mode: "production",
      pool,
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
    await receiptServer?.close();
    await worker?.stop();
    process.exit(0);
  } catch {
    process.exit(1);
  }
});

// Losing the test runner must not strand the separately owned worker.
process.once("disconnect", () => process.exit(1));
