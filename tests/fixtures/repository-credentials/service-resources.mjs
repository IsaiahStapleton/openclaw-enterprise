import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { appModule } from "./runtime.mjs";
import { temporaryDirectory } from "./process.mjs";
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
    appModule("backends/github/index"),
    appModule("backends/github/material"),
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

async function shutdownService(service, clock) {
  let timer;
  try {
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => {
        Promise.resolve(clock.advance?.(1000)).then(
          () => reject(new Error("credential fixture shutdown exceeded its grace")),
          reject,
        );
      }, 1500);
    });
    const summary = await Promise.race([service.shutdown(1000), watchdog]);
    assert.equal(summary.graceExpired, false, "fixture shutdown grace expired");
    assert.equal(summary.disposedSessions, summary.closedSessions);
    assert.equal(summary.pendingActions, 0);
    assert.equal(summary.pendingCredentials, 0);
    assert.equal(summary.pendingAuxiliary, 0);
  } finally {
    clearTimeout(timer);
  }
}

export async function startServiceListeners(
  resources,
  {
    config,
    factory,
    clock,
    tls,
    upstreamOrigins,
    trustedUpstreamOrigins = new Set(upstreamOrigins),
  },
) {
  const [{ createCredentialService }, { startListeners }] = await Promise.all([
    appModule("service"),
    appModule("server"),
  ]);
  const service = createCredentialService({ config, factory, clock });
  let listeners;
  // Separate hooks retain every cleanup failure and keep upstreams alive for revocation.
  resources.after(() => listeners?.close());
  resources.after(() => shutdownService(service, clock));
  resources.after(() => listeners?.stopAdmission());
  listeners = await startListeners({
    config,
    tls,
    service,
    factory,
    trustedUpstreamOrigins,
    clock,
    upstreamCa: tls.ca,
  });
  return { service, listeners };
}

export async function writeSessionClientConfiguration(resources, { opened, ca }) {
  const { writeClientConfiguration } = await appModule("client/config");
  const parent = await temporaryDirectory(resources, "rcs-client-");
  await chmod(parent, 0o700);
  const clientDirectory = join(parent, "session");
  await writeClientConfiguration(opened, clientDirectory, ca);
  return clientDirectory;
}
