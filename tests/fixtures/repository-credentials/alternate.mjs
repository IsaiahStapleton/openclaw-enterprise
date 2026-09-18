import { createHash } from "node:crypto";
import { createServer } from "node:https";
import { createTlsMaterial, listen } from "./process.mjs";
import { createAlternateDriver } from "./alternate/driver.mjs";
import { createAlternateUpstreamHandler } from "./alternate/upstream.mjs";
import { denied, resolveAlternateProfile } from "./alternate/policy.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function startAlternateUpstream(
  t,
  { tls, clock = { wallNow: Date.now }, controls = {} } = {},
) {
  tls ??= await createTlsMaterial(t);
  const accepted = new Map();
  const trace = [];
  const handleRequest = createAlternateUpstreamHandler({
    authorize: (key) =>
      typeof key === "string" && !((accepted.get(digest(key)) ?? 0) <= clock.wallNow()),
    observe: (entry) => trace.push(entry),
    beforeWriteChunk: () => controls.beforeWriteChunk?.(),
    revision: () => trace.length,
  });
  const server = createServer(tls, handleRequest);
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
      return resolveAlternateProfile(profile, { binding, gatewayOrigin });
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
