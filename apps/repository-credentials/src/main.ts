import { pathToFileURL } from "node:url";
import type { Clock } from "./driver-contracts.ts";
import type { CredentialService } from "./contracts.ts";
import type { LoadedConfiguration } from "./internal-contracts.ts";
import type { BoundListeners } from "./server.ts";

export interface RunningService {
  readonly service: CredentialService;
  readonly listeners: BoundListeners;
}

/** Direct process composition; check-config loads no session or listener owner. */
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const check = args.includes("--check-config");
  const pathIndex = args.indexOf("--config");
  const path = pathIndex < 0 ? undefined : args[pathIndex + 1];
  const permitted = check ? 3 : 2;
  if (
    !path ||
    args.length !== permitted ||
    (check && args.filter((arg) => arg === "--check-config").length !== 1)
  ) {
    throw new Error("invalid-arguments");
  }
  if (check) {
    const { checkConfiguration } = await import("./check-config.ts");
    process.stdout.write(`${JSON.stringify(await checkConfiguration(path))}\n`);
    return;
  }
  const [{ createSystemClock }, { loadConfiguration }] = await Promise.all([
    import("./clock.ts"),
    import("./config.ts"),
  ]);
  const clock = createSystemClock();
  const loaded = await loadConfiguration(path, clock);
  await runService(loaded, clock);
}

/** Trusted process composition, shared by the CLI and embedded process launchers. */
export async function runService(
  loaded: LoadedConfiguration,
  clock: Clock,
): Promise<RunningService> {
  const [{ createCredentialService }, { startListeners }] = await Promise.all([
    import("./service.ts"),
    import("./server.ts"),
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
    if (stopping) {
      return;
    }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("repository credential service failed\n");
    process.exitCode = 1;
  });
}
