import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createResourceScope } from "./resources.mjs";
import { createControlledClock } from "./clock.mjs";
import { createTlsMaterial } from "./process.mjs";
import { startGitHubFixture, fixtureAppId, fixtureInstallationId } from "./github.mjs";
import { createServiceConfiguration } from "./service.mjs";
import { appModule } from "./runtime.mjs";

async function main() {
  const resources = createResourceScope();
  const baseClock = createControlledClock();
  let timerCallbacks = 0;
  const clock = {
    ...baseClock,
    schedule(delayMs, callback) {
      return baseClock.schedule(delayMs, () => {
        timerCallbacks++;
        callback();
      });
    },
  };
  const tls = await createTlsMaterial(resources);
  const config = await createServiceConfiguration(resources, {
    providerActionMs: 100,
    shutdownGraceMs: 1,
  });
  // GitHub has minted the token, but its response is withheld until after timeout.
  // This deliberately leaves an unknown reservation that cannot be disposed safely.
  const github = await startGitHubFixture(resources, {
    clock,
    tls,
    beforeIssueResponse: () => new Promise(() => {}),
  });
  const [
    { createGitHubKeyOwner },
    { validateGitHubRepositoryRegistry },
    { createGitHubRepositoryDescriptions },
    { createProviderQueue },
  ] = await Promise.all([
    appModule("drivers/repo/github/credentials/material"),
    appModule("drivers/repo/github/credentials/registry"),
    appModule("drivers/repo/github/credentials/descriptions"),
    appModule("drivers/repo/credentials/provider-queue"),
  ]);
  const key = createGitHubKeyOwner({ privateKey: github.privateKey, appId: fixtureAppId, clock });
  const registry = validateGitHubRepositoryRegistry({
    version: 1,
    backendId: "github-fixture",
    providerInstanceId: "github-fixture-instance",
    appId: fixtureAppId,
    githubInstallationId: fixtureInstallationId,
    maximumDurationSeconds: config.sessionPolicy.maximumDurationSeconds,
    repositories: [
      {
        repositoryRef: "repo-a",
        repositoryId: "73",
        repository: "fixture/repository",
        namespaces: [{ namespaceId: "namespace-a", profiles: ["git-read"] }],
      },
      {
        repositoryRef: "repo-b",
        repositoryId: "74",
        repository: "fixture/other",
        namespaces: [{ namespaceId: "namespace-a", profiles: ["git-read"] }],
      },
    ],
  });
  const owner = createGitHubRepositoryDescriptions({
    registry,
    key,
    privateKeyFile: "/unused-fixture-key.pem",
    config,
    clock,
    providerQueue: createProviderQueue(config.limits.providerQueue),
    trustedEndpoints: { apiOrigin: github.origin, gitOrigin: github.origin, ca: tls.ca },
  });
  const refs = ["repo-a", "repo-b"];
  assert.equal(owner.list("namespace-a", refs).pending, true);
  const deadline = Date.now() + 5000;
  while (github.issuesOfTokens.length === 0) {
    if (Date.now() >= deadline) {
      throw new Error("provider issuance did not start");
    }
    await delay(20);
  }
  await clock.advance(101);
  let result;
  while (Date.now() < deadline) {
    await delay(20);
    await clock.advance(101);
    result = owner.list("namespace-a", refs);
    if (!result.pending) {
      break;
    }
  }
  assert.equal(result?.pending, false, "queued descriptions must settle as unavailable");
  assert.deepEqual(result.descriptions, []);
  assert.equal(github.issuesOfTokens.length, 1, "unknown ownership must prevent another issuance");
  // A 1 ms configured grace must not cause repeated cleanup sweeps to consume CPU.
  // Advance in millisecond steps so an accidental tight retry loop is observable.
  const callbacksBefore = timerCallbacks;
  for (let i = 0; i < 200; i++) {
    await clock.advance(1);
  }
  assert.ok(timerCallbacks - callbacksBefore < 10, "cleanup retry must not spin");
  // Explicit shutdown interrupts the background delay and uses the requested grace.
  const stopping = owner.shutdown(1);
  await clock.advance(2);
  const summary = await stopping;
  assert.equal(summary.graceExpired, true);
  assert.ok(summary.pendingCredentials > 0, "shutdown must retain unknown credential ownership");
  process.send?.({
    type: "result",
    graceExpired: summary.graceExpired,
    pendingCredentials: summary.pendingCredentials,
  });
}

main().catch((error) => process.send?.({ type: "error", message: error.stack ?? error.message }));
