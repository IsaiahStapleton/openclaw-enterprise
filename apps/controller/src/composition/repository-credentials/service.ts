import type { Clock } from "../../drivers/repository-credentials/backend-contracts.ts";
import type { CredentialService } from "../../drivers/repository-credentials/service-contracts.ts";
import type { LoadedConfiguration } from "./contracts.ts";
import type { BoundListeners } from "../../drivers/repository-credentials/server.ts";

export interface RunningService {
  readonly service: CredentialService;
  readonly listeners: BoundListeners;
}

/** Trusted process composition, shared by the CLI and embedded process launchers. */
export async function runService(
  loaded: LoadedConfiguration,
  clock: Clock,
): Promise<RunningService> {
  const [{ createCredentialService }, { startListeners }] = await Promise.all([
    import("../../drivers/repository-credentials/service.ts"),
    import("../../drivers/repository-credentials/server.ts"),
  ]);
  const service = createCredentialService({
    config: loaded.config,
    factory: loaded.factory,
    clock,
  });
  let listeners: BoundListeners;
  try {
    listeners = await startListeners({ ...loaded, service, clock });
  } catch {
    await service.shutdown(loaded.config.limits.shutdownGraceMs);
    loaded.close();
    throw new Error("startup-failed");
  }
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    listeners.stopAdmission();
    const grace = loaded.config.limits.shutdownGraceMs;
    // Wall-time process guard is independent of provider callbacks and injected clocks.
    const pending = service.shutdown(grace);
    const forced = setTimeout(() => {
      process.stderr.write(
        `${JSON.stringify({ event: "shutdown", graceExpired: true, unresolved: true })}\n`,
      );
      loaded.close();
      process.exit(1);
    }, grace);
    void pending.then(
      async (summary) => {
        await listeners.close();
        loaded.close();
        process.stdout.write(`${JSON.stringify({ event: "shutdown", ...summary })}\n`);
        clearTimeout(forced);
        process.exit(summary.graceExpired ? 1 : 0);
      },
      () => {
        process.stderr.write(
          `${JSON.stringify({ event: "shutdown", graceExpired: true, unresolved: true })}\n`,
        );
        loaded.close();
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { service, listeners };
}
