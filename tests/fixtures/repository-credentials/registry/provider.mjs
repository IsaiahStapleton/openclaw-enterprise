import { createServer, request as httpsRequest } from "node:https";
import { startGitHubFixture, fixtureInstallationId } from "../github.mjs";
import { startGitSmartHttpFixture } from "../git.mjs";
import { listen } from "../process.mjs";

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

export async function startRegistryProviderFixtures(
  resources,
  { definitions, clock, tls, keyPair, tokenLifetimeMs },
) {
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
      tokenLifetimeMs: tokenLifetimeMs,
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
  return { repositories, apiOrigin, gitOrigin };
}
