import { pathToFileURL } from "node:url";
import type { SafeConfigurationSummary } from "../../drivers/repository-credentials/service-contracts.ts";
import { loadConfiguration } from "./config.ts";
import { createSystemClock } from "../../drivers/repository-credentials/clock.ts";
export async function checkConfiguration(path: string): Promise<SafeConfigurationSummary> {
  const loaded = await loadConfiguration(path, createSystemClock());
  try {
    return Object.freeze({
      valid: true,
      gatewayOrigin: loaded.config.gateway.publicOrigin,
      profiles: loaded.config.sessionPolicy.allowedProfiles,
      maximumDurationSeconds: loaded.config.sessionPolicy.maximumDurationSeconds,
    });
  } finally {
    loaded.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--check-config") {
    process.stderr.write("usage: check-config --check-config FILE\n");
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await checkConfiguration(args[1]!))}\n`);
    } catch {
      process.stderr.write("invalid-configuration\n");
      process.exitCode = 1;
    }
  }
}
