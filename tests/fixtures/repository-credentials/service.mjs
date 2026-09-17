import assert from "node:assert/strict";
import { join } from "node:path";
import { appModule } from "./runtime.mjs";
import { chmod } from "node:fs/promises";
import { request } from "node:https";
import { createControlledClock } from "./clock.mjs";
import { createTlsMaterial, temporaryDirectory } from "./process.mjs";
import {
  startGitHubFixture,
  fixtureAppId,
  fixtureInstallationId,
  fixtureRepository,
  fixtureRepositoryId,
} from "./github.mjs";
import { startGitSmartHttpFixture } from "./git.mjs";

export { appModule, appRoot, appExtension, repositoryRoot } from "./runtime.mjs";

export async function createServiceConfiguration(t, limits = {}) {
  const { validateServiceConfig } = await appModule("config");
  const directory = await temporaryDirectory(t, "rcs-");
  await chmod(directory, 0o700);
  return validateServiceConfig({
    gateway: {
      publicOrigin: "https://credentials.example.test",
      listen: "0.0.0.0:443",
      controlSocket: join(directory, "control.sock"),
    },
    sessionPolicy: {
      maximumDurationSeconds: 172800,
      defaultProfile: "git-write",
      allowedProfiles: ["git-write", "read-write"],
    },
    limits,
  });
}

export async function startCredentialServiceFixture(t, options = {}) {
  const cleanups = [];
  const resources = { after: (cleanup) => cleanups.push(cleanup) };
  t.after(async () => {
    const failures = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "credential fixture cleanup failed");
  });
  const clock = options.clock ?? createControlledClock();
  const tls = await createTlsMaterial(resources);
  const config = await createServiceConfiguration(resources, options.limits);
  const github = await startGitHubFixture(resources, {
    clock,
    tls,
    tokenLifetimeMs: options.tokenLifetimeMs,
  });
  const git = await startGitSmartHttpFixture(resources, { authorize: github.authorize, tls });
  const [
    { createGitHubDriverFactory },
    { createGitHubKeyOwner },
    { createCredentialService },
    { startListeners },
    { writeClientConfiguration },
  ] = await Promise.all([
    appModule("backends/github/index"),
    appModule("backends/github/material"),
    appModule("service"),
    appModule("server"),
    appModule("client/config"),
  ]);
  const key = createGitHubKeyOwner({ privateKey: github.privateKey, appId: fixtureAppId, clock });
  let service;
  let listeners;
  // Reverse cleanup keeps upstreams alive until session revocation finishes,
  // including failures partway through composition.
  resources.after(async () => {
    listeners?.stopAdmission();
    try {
      if (service) {
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
    } finally {
      try {
        await listeners?.close();
      } finally {
        key.close();
      }
    }
  });
  const factory = createGitHubDriverFactory({
    configuration: {
      kind: "github-app",
      providerInstanceId: "github-fixture",
      configVersion: "1",
      appId: fixtureAppId,
      installationId: fixtureInstallationId,
      repositoryId: fixtureRepositoryId,
      repository: fixtureRepository,
      privateKeyFile: "/unused-fixture-key.pem",
    },
    key,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    clock,
    trustedEndpoints: { apiOrigin: github.origin, gitOrigin: git.origin, ca: tls.ca },
  });
  service = createCredentialService({ config, factory, clock });
  listeners = await startListeners({
    config,
    tls,
    service,
    factory,
    trustedUpstreamOrigins: new Set([github.origin, git.origin]),
    clock,
    upstreamCa: tls.ca,
  });
  const opened = service.open({ durationSeconds: 86400, profile: options.profile ?? "read-write" });
  const parent = await temporaryDirectory(resources, "rcs-client-");
  await chmod(parent, 0o700);
  const clientDirectory = join(parent, "session");
  await writeClientConfiguration(opened, clientDirectory, tls.ca);
  return { clock, tls, config, factory, service, listeners, opened, clientDirectory, github, git };
}

export function gatewayRequest(fixture, target, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const outgoing = request(
      `${fixture.config.gateway.publicOrigin}${target}`,
      {
        method,
        ca: fixture.tls.ca,
        headers: {
          authorization: `Bearer ${fixture.opened.bearer}`,
          ...(encoded
            ? { "content-type": "application/json", "content-length": encoded.length }
            : {}),
          ...headers,
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.once("end", () =>
          resolve({
            status: incoming.statusCode,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        incoming.once("error", reject);
      },
    );
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error("fixture request timeout")));
    outgoing.once("error", reject);
    outgoing.end(encoded);
  });
}

export async function eventually(check, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("expected fixture state was not observed");
}
