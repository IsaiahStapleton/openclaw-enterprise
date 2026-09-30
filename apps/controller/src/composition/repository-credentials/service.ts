import type { Clock } from "../../drivers/repo/credentials/backend-contracts.ts";
import type { CredentialService } from "../../drivers/repo/credentials/service-contracts.ts";
import type { LoadedConfiguration } from "./contracts.ts";
import type { BoundListeners } from "../../drivers/repo/credentials/server.ts";

export interface RunningService {
  readonly service: CredentialService;
  readonly listeners: BoundListeners;
}

/** Start the service using its protected, operator-owned configuration. */
export async function startCredentialService(configurationPath: string): Promise<RunningService> {
  const [{ createSystemClock }, { loadConfiguration }] = await Promise.all([
    import("../../drivers/repo/credentials/clock.ts"),
    import("./config.ts"),
  ]);
  const clock = createSystemClock();
  const loaded = await loadConfiguration(configurationPath, clock);
  return runService(loaded, clock);
}

/** Trusted process composition, shared by the CLI and embedded process launchers. */
export async function runService(
  loaded: LoadedConfiguration,
  clock: Clock,
): Promise<RunningService> {
  const [{ createCredentialService }, { startListeners }] = await Promise.all([
    import("../../drivers/repo/credentials/service.ts"),
    import("../../drivers/repo/credentials/server.ts"),
  ]);
  const service = createCredentialService({
    config: loaded.config,
    factory: loaded.factory,
    clock,
    ...(loaded.providerQueue === undefined ? {} : { providerQueue: loaded.providerQueue }),
  });
  let listeners: BoundListeners;
  try {
    listeners = await startListeners({ ...loaded, service, clock });
  } catch {
    await Promise.all([
      service.shutdown(loaded.config.limits.shutdownGraceMs),
      loaded.repositoryDescriptions?.shutdown(loaded.config.limits.shutdownGraceMs),
    ]);
    loaded.close();
    throw new Error("startup-failed");
  }
  let stopping = false;
  const shutdown = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    listeners.stopAdmission();
    const grace = loaded.config.limits.shutdownGraceMs;
    // Wall-time process guard is independent of provider callbacks and injected clocks.
    const pending = Promise.all([
      service.shutdown(grace),
      loaded.repositoryDescriptions?.shutdown(grace),
    ]).then(([summary, descriptions]) => ({
      closedSessions: summary.closedSessions + (descriptions?.closedSessions ?? 0),
      disposedSessions: summary.disposedSessions + (descriptions?.disposedSessions ?? 0),
      pendingActions: summary.pendingActions + (descriptions?.pendingActions ?? 0),
      pendingCredentials: summary.pendingCredentials + (descriptions?.pendingCredentials ?? 0),
      pendingAuxiliary: summary.pendingAuxiliary + (descriptions?.pendingAuxiliary ?? 0),
      graceExpired: summary.graceExpired || (descriptions?.graceExpired ?? false),
    }));
    const forceExit = () => {
      process.stderr.write(
        `${JSON.stringify({ event: "shutdown", graceExpired: true, unresolved: true })}\n`,
      );
      loaded.close();
      process.exit(1);
    };
    let forced = setTimeout(forceExit, grace);
    void (async () => {
      try {
        const summary = await pending;
        if (!summary.graceExpired) {
          // Provider ownership has drained. Reserve a separate bounded window
          // for committing the original broker's terminal observations.
          clearTimeout(forced);
          forced = setTimeout(forceExit, 10_000);
        }
        await listeners.close();
        loaded.close();
        process.stdout.write(`${JSON.stringify({ event: "shutdown", ...summary })}\n`);
        clearTimeout(forced);
        process.exit(summary.graceExpired ? 1 : 0);
      } catch {
        process.stderr.write(
          `${JSON.stringify({ event: "shutdown", graceExpired: true, unresolved: true })}\n`,
        );
        loaded.close();
        process.exit(1);
      }
    })();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  const controls = Object.freeze<CredentialService>({
    open: (input) => service.open(input),
    status: (sessionId) => service.status(sessionId),
    close: (sessionId) => service.close(sessionId),
    shutdown: (graceMs) => service.shutdown(graceMs),
  });
  return Object.freeze({ service: controls, listeners });
}
