import { createHash } from "node:crypto";
import { createServer } from "node:https";
import { createTlsMaterial, listen } from "./process.mjs";
import { createAlternateDriver, denied } from "./alternate/driver.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function startAlternateUpstream(
  t,
  { tls, clock = { wallNow: Date.now }, controls = {} } = {},
) {
  tls ??= await createTlsMaterial(t);
  const accepted = new Map();
  const trace = [];
  const server = createServer(tls, (request, response) => {
    const key = request.headers["x-repository-key"];
    if (typeof key !== "string" || (accepted.get(digest(key)) ?? 0) <= clock.wallNow()) {
      response.writeHead(401).end();
      return;
    }
    const entry = { method: request.method, path: request.url };
    trace.push(entry);
    void (async () => {
      if (request.method === "POST") {
        const hash = createHash("sha256");
        entry.bodyBytes = 0;
        entry.committed = false;
        for await (const chunk of request) {
          hash.update(chunk);
          entry.bodyBytes += chunk.length;
          await controls.beforeWriteChunk?.();
        }
        // This backend invalidates predecessors on rotation. Checking again at
        // commit detects rotation while a streamed write still owns that key.
        if ((accepted.get(digest(key)) ?? 0) <= clock.wallNow()) {
          response.writeHead(401).end();
          return;
        }
        entry.bodyDigest = hash.digest("hex");
        entry.committed = true;
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ repository: "team/nested/project", revision: trace.length }));
    })().catch(() => response.destroy());
  });
  return { origin: await listen(t, server), tls, trace, accepted };
}

// This adapter intentionally uses a different identity, permission vocabulary,
// authentication header and rotation model. Custody, leases and dispatch are
// supplied by the production common owner, never reimplemented here.
export function createAlternateDriverFactory({
  origin,
  gatewayOrigin,
  clock,
  accepted = new Map(),
  lifetimeMs = 90000,
  operationMs = 1000,
  controls = {},
}) {
  const binding = Object.freeze({
    providerInstanceId: "forge-fixture",
    repositoryId: "repo:team/nested/project",
    grantId: "forge-config-v7:source-update",
  });
  const events = [];
  const drivers = [];
  const factory = {
    events,
    drivers,
    resolve(profile) {
      if (profile !== "git-write") {
        throw new Error("unsupported-profile");
      }
      return Object.freeze({
        binding,
        client: Object.freeze({
          gatewayOrigin,
          gitRemote: `${gatewayOrigin}/team/nested/project`,
          gitUsername: "session",
          canonicalApiHost: "forge.example.test",
          apiHost: new URL(gatewayOrigin).host,
          repository: "team/nested/project",
        }),
      });
    },
    parseAuthentication(_head, authorization) {
      return authorization.startsWith("Bearer ") ? authorization.slice(7) : denied;
    },
    unauthenticated() {
      return denied;
    },
    create({ authority, custody }) {
      const driver = createAlternateDriver({
        binding,
        authority,
        custody,
        origin,
        clock,
        accepted,
        lifetimeMs,
        operationMs,
        controls,
        events,
      });
      drivers.push(driver);
      return driver;
    },
  };
  return Object.freeze(factory);
}
