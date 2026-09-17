import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:https";
import { createTlsMaterial, listen } from "./process.mjs";

const denied = Object.freeze({ kind: "denied", status: 403, code: "route-denied" });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function startAlternateUpstream(t, { tls, clock = { wallNow: Date.now } } = {}) {
  tls ??= await createTlsMaterial(t);
  const accepted = new Map();
  const trace = [];
  const server = createServer(tls, (request, response) => {
    const key = request.headers["x-repository-key"];
    if (typeof key !== "string" || (accepted.get(digest(key)) ?? 0) <= clock.wallNow()) {
      response.writeHead(401).end();
      return;
    }
    trace.push({ method: request.method, path: request.url });
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ repository: "team/nested/project", revision: trace.length }));
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
      if (profile !== "git-write") throw new Error("unsupported-profile");
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
      for (const key of Object.keys(binding))
        if (authority[key] !== binding[key]) throw new Error("foreign-authority");
      const outcomes = new WeakMap();
      const plans = new WeakSet();
      const handles = new WeakMap();
      const renewalBytes = randomBytes(32);
      const renewalDigest = digest(renewalBytes);
      const renewal = custody.retainRenewal(renewalBytes);
      renewalBytes.fill(0);
      let finalized = false;
      let current;
      let generation = 0;
      function result(attempt, value, settled = Promise.resolve()) {
        const original = Object.freeze({ attemptId: attempt.id, ...value });
        outcomes.set(original, settled);
        return original;
      }
      const driver = {
        binding,
        replacement: "drain-before",
        cleanup: "revocable",
        safeCleanupRetry: Object.freeze({ retire: true, finalize: false }),
        async acquire(attempt, previous, minimumValidityMs) {
          custody.assertAttempt(attempt, "acquire");
          if (previous !== undefined && !handles.has(previous))
            throw new Error("foreign-credential");
          let dispatched = false;
          try {
            attempt.assertAdmitted();
            if (finalized)
              return result(attempt, {
                kind: "reauthorization-required",
                code: "authority-unavailable",
              });
            await custody.withRenewal(renewal, async (bytes) => {
              if (digest(bytes) !== renewalDigest) throw new Error("renewal-lost");
            });
            attempt.assertAdmitted();
            attempt.observeDispatch();
            dispatched = true;
            events.push({
              kind: "rotate",
              sessionId: authority.sessionId,
              generation: ++generation,
              permission: "source:update",
              previous: previous !== undefined,
            });
            const capture = () => {
              if (current) accepted.delete(handles.get(current).digest);
              const bytes = randomBytes(24).toString("hex");
              const observation = {
                observedWallMs: clock.wallNow(),
                expiresAtWallMs: clock.wallNow() + lifetimeMs,
              };
              const credential = custody.capture(attempt, Buffer.from(bytes), observation);
              handles.set(credential, {
                digest: digest(bytes),
                expires: observation.expiresAtWallMs,
              });
              accepted.set(digest(bytes), observation.expiresAtWallMs);
              current = credential;
              return { kind: "acquired", credential, ...observation };
            };
            if (controls.lateCapture) {
              const settled = controls.lateCapture.then(() => {
                capture();
              });
              return result(attempt, { kind: "uncertain" }, settled);
            }
            const acquired = capture();
            if (controls.rejectScope)
              return result(attempt, { kind: "rejected", code: "scope-mismatch" });
            if (lifetimeMs < minimumValidityMs)
              return result(attempt, { kind: "rejected", code: "insufficient-validity" });
            return result(attempt, acquired);
          } catch {
            return result(attempt, { kind: dispatched ? "uncertain" : "not-dispatched" });
          }
        },
        async retire(attempt, credential) {
          custody.assertAttempt(attempt, "retire");
          if (!handles.has(credential)) throw new Error("foreign-credential");
          try {
            attempt.assertAdmitted();
            await custody.withAccess(credential, "retire", async (bytes) => {
              attempt.observeDispatch();
              // Retirement revokes this access token, never the replacement or
              // the session's independent renewal authority.
              accepted.delete(digest(bytes));
            });
            events.push({ kind: "retire", sessionId: authority.sessionId });
            return result(attempt, { kind: "revoked" });
          } catch {
            return result(attempt, { kind: "uncertain" });
          }
        },
        async finalize(attempt) {
          custody.assertAttempt(attempt, "finalize");
          try {
            attempt.assertAdmitted();
            await custody.withRenewal(renewal, async (bytes) => {
              if (digest(bytes) !== renewalDigest) throw new Error("renewal-lost");
              attempt.observeDispatch();
            });
            await custody.disposeRenewal(renewal);
            finalized = true;
            events.push({ kind: "finalize", sessionId: authority.sessionId });
            return result(attempt, { kind: "finalized" });
          } catch {
            return result(attempt, { kind: "cleanup-pending", reason: "uncertain" });
          }
        },
        async settle(original) {
          if (!outcomes.has(original)) throw new Error("foreign-outcome");
          await outcomes.get(original);
        },
        plan(request) {
          if (
            request.authority.sessionId !== authority.sessionId ||
            request.head.rawTarget !== "/team/nested/project" ||
            request.head.method !== "GET"
          )
            return denied;
          const plan = Object.freeze({
            origin,
            target: "/v2/projects/team%2Fnested%2Fproject",
            method: "GET",
            category: "source-read",
            effect: "read",
            requestHeaders: Object.freeze({ accept: "application/json" }),
            limits: Object.freeze({
              inputWireBytes: 1024,
              inputDecodedBytes: 1024,
              responseBytes: 8192,
              totalMs: operationMs,
              inputMs: operationMs,
              firstHeaderMs: operationMs,
              stallMs: operationMs,
              connectMs: operationMs,
            }),
            responsePolicy: Object.freeze({
              body: "stream",
              headers: (_status, headers) => ({
                "content-type": headers["content-type"] ?? "application/json",
              }),
              rewriteJson: undefined,
            }),
          });
          plans.add(plan);
          return plan;
        },
        async withAuthentication(credential, plan, send) {
          if (finalized || !plans.has(plan) || !handles.has(credential))
            throw new Error("foreign-or-closed-authority");
          return custody.withAccess(credential, "authenticate", async (bytes) => {
            events.push({ kind: "authentication", sessionId: authority.sessionId });
            await controls.beforeSend?.();
            return send(
              Object.freeze({
                plan,
                headers: Object.freeze({
                  ...plan.requestHeaders,
                  "x-repository-key": Buffer.from(bytes).toString(),
                }),
              }),
            );
          });
        },
      };
      drivers.push(driver);
      return driver;
    },
  };
  return Object.freeze(factory);
}
