import { createServer } from "node:https";
import { createControlledClock } from "./clock.mjs";
import { createTlsMaterial, listen } from "./process.mjs";
import { createGitHubProtocol } from "./github/protocol.mjs";

export {
  fixtureRepository,
  fixtureRepositoryId,
  fixtureInstallationId,
  fixtureAppId,
  humanText,
} from "./github/protocol.mjs";

export async function startGitHubFixture(
  t,
  { clock = createControlledClock(), tls, ...options } = {},
) {
  tls ??= await createTlsMaterial(t);
  const { handleRequest, ...fixture } = createGitHubProtocol({ clock, ...options });
  const server = createServer(tls, handleRequest);
  const origin = await listen(t, server);
  return { origin, tls, ...fixture };
}
