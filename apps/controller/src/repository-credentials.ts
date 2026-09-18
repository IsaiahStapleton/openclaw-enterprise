import { pathToFileURL } from "node:url";
import { runService } from "./composition/repository-credentials/service.ts";

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
  )
    throw new Error("invalid-arguments");
  if (check) {
    const { checkConfiguration } =
      await import("./composition/repository-credentials/check-config.ts");
    process.stdout.write(`${JSON.stringify(await checkConfiguration(path))}\n`);
    return;
  }
  const [{ createSystemClock }, { loadConfiguration }] = await Promise.all([
    import("./drivers/repository-credentials/clock.ts"),
    import("./composition/repository-credentials/config.ts"),
  ]);
  const clock = createSystemClock();
  const loaded = await loadConfiguration(path, clock);
  await runService(loaded, clock);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("repository credential service failed\n");
    process.exitCode = 1;
  });
}
