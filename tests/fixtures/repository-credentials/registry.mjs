import { generateKeyPairSync } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { createServer, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { createControlledClock } from "./clock.mjs";
import { serviceConfigurationData } from "./builders.mjs";
import { startGitHubFixture, fixtureAppId, fixtureInstallationId } from "./github.mjs";
import { startGitSmartHttpFixture } from "./git.mjs";
import { createTlsMaterial, listen, temporaryDirectory } from "./process.mjs";
import { createResourceScope } from "./resources.mjs";
import { credentialDriverModule, githubProviderModule } from "./runtime.mjs";
import { startServiceListeners, writeSessionClientConfiguration } from "./service-resources.mjs";

export const defaultRegistryRepositories = Object.freeze([
  Object.freeze({
    repositoryRef: "repo-a",
    repository: "fixture/repository",
    repositoryId: "73",
  }),
  Object.freeze({
    repositoryRef: "repo-b",
    repository: "fixture/other",
    repositoryId: "74",
  }),
]);

function providerToken(authorization) {
  if (authorization?.startsWith("Basic ")) {
    return Buffer.from(authorization.slice(6), "base64").toString().split(":").slice(1).join(":");
  }
  return authorization?.replace(/^(Bearer|token) /, "");
}

async function issuanceBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new Error("fixture request limit");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function startProviderTransport(resources, { tls, select }) {
  const outgoing = new Set();
  const server = createServer(tls, (request, response) => {
    void (async () => {
      const selected = await select(request);
      if (!selected) {
        response.writeHead(404).end();
        return;
      }
      // This is only a controlled provider's fixed dispatch table. Session
      // admission and repository authority remain in the real gateway factory.
      const upstream = httpsRequest(
        new URL(request.url, selected.origin),
        {
          method: request.method,
          headers: { ...request.headers, host: new URL(selected.origin).host },
          ca: tls.ca,
          agent: false,
        },
        (incoming) => {
          response.writeHead(incoming.statusCode, incoming.headers);
          incoming.on("error", () => response.destroy());
          incoming.pipe(response);
        },
      );
      outgoing.add(upstream);
      upstream.once("close", () => outgoing.delete(upstream));
      upstream.once("error", () => response.destroy());
      upstream.setTimeout(30000, () => upstream.destroy(new Error("provider fixture timeout")));
      response.once("close", () => upstream.destroy());
      request.once("error", () => upstream.destroy());
      if (selected.body !== undefined) {
        upstream.end(selected.body);
      } else {
        request.pipe(upstream);
      }
    })().catch(() => response.destroy());
  });
  const origin = await listen(resources, server);
  resources.after(() => {
    for (const upstream of outgoing) {
      upstream.destroy();
    }
  });
  return origin;
}

export async function startRegistryCredentialServiceFixture(t, options = {}) {
  const resources = createResourceScope();
  try {
    const clock = options.clock ?? createControlledClock();
    const tls = options.tls ?? (await createTlsMaterial(resources));
    const namespaceId = options.namespaceId ?? "namespace-fixture";
    const providerId = options.providerId ?? "github-fixture";
    const durationSeconds = options.durationSeconds ?? 86400;
    const maximumDurationSeconds = options.maximumDurationSeconds ?? 172800;
    const profile = options.profile ?? "git-full";
    const definitions = options.repositories ?? defaultRegistryRepositories;
    const directory = await temporaryDirectory(resources, "rcs-registry-");
    await chmod(directory, 0o700);
    const privateKeyFile = join(directory, "app.pem");
    const registryFile = join(directory, "registry.json");
    const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeFile(privateKeyFile, keyPair.privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
    await writeFile(
      registryFile,
      JSON.stringify({
        version: 1,
        providerId,
        providerInstanceId: "github-fixture-instance",
        appId: fixtureAppId,
        githubInstallationId: fixtureInstallationId,
        maximumDurationSeconds,
        repositories: definitions.map((entry) => ({
          repositoryRef: entry.repositoryRef,
          repositoryId: entry.repositoryId,
          repository: entry.repository,
          namespaces: [
            {
              namespaceId,
              profiles: entry.profiles ?? ["git-read", "git-write", "git-full"],
            },
          ],
        })),
      }),
      { mode: 0o600 },
    );
    const [
      { validateServiceConfig },
      { loadGitHubRepositoryRegistry },
      { resolveGitHubRepositoryBinding },
      { createGitHubRegistryDriverFactory },
      { createGitHubKeyOwner },
    ] = await Promise.all([
      credentialDriverModule("configuration"),
      githubProviderModule("registry-loader"),
      githubProviderModule("registry"),
      githubProviderModule("registry-factory"),
      githubProviderModule("material"),
    ]);
    const config = validateServiceConfig(
      serviceConfigurationData({
        gateway: {
          publicOrigin: "https://credentials.example.test",
          listen: "0.0.0.0:443",
          controlSocket: join(directory, "control.sock"),
          ...options.gateway,
        },
        sessionPolicy: { maximumDurationSeconds },
        limits: options.limits,
      }),
    );
    const tokenOwners = new Map();
    const repositories = [];
    for (const definition of definitions) {
      const entry = { ...definition };
      entry.github = await startGitHubFixture(resources, {
        clock,
        tls,
        keyPair,
        repository: entry.repository,
        repositoryId: entry.repositoryId,
        tokenLifetimeMs: options.tokenLifetimeMs,
        tokenResponse(packet) {
          tokenOwners.set(packet.token, entry);
          return packet;
        },
      });
      entry.git = await startGitSmartHttpFixture(resources, {
        tls,
        repository: entry.repository,
        authorize: entry.github.authorize,
      });
      repositories.push(entry);
    }
    const apiOrigin = await startProviderTransport(resources, {
      tls,
      async select(request) {
        const pathname = new URL(request.url, "https://api.github.com").pathname;
        if (
          request.method === "POST" &&
          pathname === `/app/installations/${fixtureInstallationId}/access_tokens`
        ) {
          const body = await issuanceBody(request);
          const ids = JSON.parse(body.toString()).repository_ids;
          const entry =
            Array.isArray(ids) && ids.length === 1
              ? repositories.find((item) => item.repositoryId === String(ids[0]))
              : undefined;
          return entry && { origin: entry.github.origin, body };
        }
        const repository = repositories.find((entry) => {
          const prefix = `/repos/${entry.repository}`;
          return pathname === prefix || pathname.startsWith(`${prefix}/`);
        });
        if (repository) {
          return { origin: repository.github.origin };
        }
        if (["/graphql", "/installation/token", "/meta"].includes(pathname)) {
          const entry = tokenOwners.get(providerToken(request.headers.authorization));
          return entry && { origin: entry.github.origin };
        }
        return undefined;
      },
    });
    const gitOrigin = await startProviderTransport(resources, {
      tls,
      select(request) {
        const pathname = new URL(request.url, "https://github.com").pathname;
        const entry = repositories.find((item) => {
          const prefix = `/${item.repository}.git`;
          return pathname === prefix || pathname.startsWith(`${prefix}/`);
        });
        return entry && { origin: entry.git.origin };
      },
    });
    const key = createGitHubKeyOwner({
      privateKey: keyPair.privateKey,
      appId: fixtureAppId,
      clock,
    });
    resources.after(() => key.close());
    let current;
    let activeScope;
    let registry;
    const start = async () => {
      registry = await loadGitHubRepositoryRegistry(registryFile, providerId);
      const factory = createGitHubRegistryDriverFactory({
        registry,
        key,
        privateKeyFile,
        gatewayOrigin: config.gateway.publicOrigin,
        limits: config.limits,
        clock,
        trustedEndpoints: { apiOrigin, gitOrigin, ca: tls.ca },
      });
      activeScope = createResourceScope();
      const started = await startServiceListeners(activeScope, {
        config,
        factory,
        clock,
        tls,
        upstreamOrigins: [apiOrigin, gitOrigin],
      });
      current = { factory, ...started };
    };
    resources.after(() => activeScope?.close());
    await start();
    const byRef = new Map(repositories.map((entry) => [entry.repositoryRef, entry]));
    const fixture = {
      clock,
      tls,
      config,
      providerId,
      namespaceId,
      registryFile,
      privateKeyFile,
      repositories,
      byRef,
      get registry() {
        return registry;
      },
      get factory() {
        return current.factory;
      },
      get service() {
        return current.service;
      },
      get listeners() {
        return current.listeners;
      },
      async open(repositoryRef, overrides = {}) {
        const entry = byRef.get(repositoryRef);
        if (!entry) {
          throw new Error("unknown fixture repository");
        }
        const binding = resolveGitHubRepositoryBinding(registry, {
          namespaceId,
          repositoryRef,
          profile: overrides.profile ?? entry.profile ?? profile,
        });
        const selectedDuration = overrides.durationSeconds ?? durationSeconds;
        const opened = current.service.open({
          namespaceId,
          repositoryRef,
          profile: binding.profile,
          expectedBinding: binding.grant,
          durationSeconds: selectedDuration,
          deadlineWallMs: overrides.deadlineWallMs ?? clock.wallNow() + selectedDuration * 1000,
        });
        const clientDirectory = await writeSessionClientConfiguration(resources, {
          opened,
          ca: tls.ca,
        });
        entry.opened = opened;
        entry.clientDirectory = clientDirectory;
        return { opened, clientDirectory };
      },
      async restart() {
        await activeScope.close();
        for (const entry of repositories) {
          delete entry.opened;
          delete entry.clientDirectory;
        }
        await start();
      },
      close() {
        return resources.close();
      },
    };
    if (options.autoOpen !== false) {
      for (const entry of repositories) {
        await fixture.open(entry.repositoryRef);
      }
    }
    t.after(() => resources.close());
    return fixture;
  } catch (error) {
    await resources.close(error);
  }
}
