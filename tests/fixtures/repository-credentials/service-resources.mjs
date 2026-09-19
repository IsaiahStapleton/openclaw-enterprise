import { appModule } from "./runtime.mjs";
import { githubConfigurationData } from "./builders.mjs";
import {
  fixtureAppId,
  fixtureInstallationId,
  fixtureRepositoryId,
  fixtureRepository,
} from "./github.mjs";

export async function createGitHubServiceFactory(
  resources,
  { config, clock, privateKey, trustedEndpoints, providerInstanceId = "github-fixture" },
) {
  const [{ createGitHubDriverFactory }, { createGitHubKeyOwner }] = await Promise.all([
    appModule("drivers/repo/github/credentials/index"),
    appModule("drivers/repo/github/credentials/material"),
  ]);
  const key = createGitHubKeyOwner({ privateKey, appId: fixtureAppId, clock });
  resources.after(() => key.close());
  return createGitHubDriverFactory({
    configuration: githubConfigurationData({
      providerInstanceId,
      appId: fixtureAppId,
      installationId: fixtureInstallationId,
      repositoryId: fixtureRepositoryId,
      repository: fixtureRepository,
      privateKeyFile: "/unused-fixture-key.pem",
    }),
    key,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    clock,
    trustedEndpoints,
  });
}
