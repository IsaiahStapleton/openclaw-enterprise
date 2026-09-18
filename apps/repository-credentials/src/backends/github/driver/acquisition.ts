import type {
  AcquireOutcome,
  Clock,
  CredentialRef,
  DriverCustody,
  RepoDriver,
} from "../../../driver-contracts.ts";
import type { ProviderResponse, ProviderTransport } from "../provider-transport.ts";
import type { GitHubConfiguration, GitHubKeyOwner } from "../types.ts";
import type { GitHubDriverState } from "./state.ts";
import { providerClockSkewMs, tokenLifetimeMs } from "./lifetime.ts";

type AcquisitionDependencies = Readonly<{
  state: GitHubDriverState;
  custody: DriverCustody;
  clock: Clock;
  key: GitHubKeyOwner;
  config: GitHubConfiguration;
  permissions: Readonly<Record<string, string>>;
  exchange: ProviderTransport;
}>;

export function createCredentialAcquisition(deps: AcquisitionDependencies): RepoDriver["acquire"] {
  const { state, custody, clock, key, config, permissions, exchange } = deps;
  return async function acquire(attempt, previous, minimumValidityMs): Promise<AcquireOutcome> {
    if (previous !== undefined && !state.credentials.has(previous)) {
      throw new Error("foreign-credential");
    }
    if (!Number.isFinite(minimumValidityMs) || minimumValidityMs < 0) {
      throw new Error("invalid-validity");
    }
    state.admit(attempt, "acquire");
    let dispatched = false;
    try {
      if (state.finalized) {
        return state.outcome(attempt, { kind: "not-dispatched" });
      }
      return await key.withJwt(async (jwt, assertCurrent) => {
        let packet: Record<string, unknown> | undefined;
        let credential: CredentialRef | undefined;
        let observedWallMs = 0;
        let expiry = NaN;
        const captureResponseCredential = (response: ProviderResponse) => {
          try {
            const parsed: unknown = JSON.parse(response.body.toString("utf8"));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              packet = parsed as Record<string, unknown>;
            }
          } catch {
            // Preserve status-based failure handling; the response finally wipes bytes,
            // while the lifecycle retains cleanup ownership for uncertain issuance.
          }
          const token = packet?.token;
          observedWallMs = clock.wallNow();
          expiry = typeof packet?.expires_at === "string" ? Date.parse(packet.expires_at) : NaN;
          if (typeof token === "string" && token.length > 0) {
            const bytes = Buffer.from(token);
            try {
              // Capture in the response callback, before timeout or close can discard its body.
              credential = custody.capture(attempt, bytes, {
                observedWallMs,
                // Custody may release material at this bound. Provider wall time
                // is only an authentication limit, not proof of remote expiry.
                expiresAtWallMs: observedWallMs + tokenLifetimeMs,
              });
              state.credentials.set(credential, {
                expiresAt: Number.isFinite(expiry) ? expiry - providerClockSkewMs : undefined,
                observedWall: observedWallMs,
                observedMono: clock.monotonicNow(),
                accepted: false,
              });
            } finally {
              bytes.fill(0);
            }
          }
        };
        const response = await exchange(
          {
            method: "POST",
            path: `/app/installations/${config.installationId}/access_tokens`,
            authorization: jwt,
            body: JSON.stringify({
              repository_ids: [Number(config.repositoryId)],
              permissions,
            }),
          },
          attempt,
          () => {
            dispatched = true;
          },
          assertCurrent,
          captureResponseCredential,
        );
        try {
          const token = packet?.token;
          if ([401, 403, 404, 422].includes(response.status)) {
            return state.outcome(attempt, {
              kind: "reauthorization-required",
              code: "authority-unavailable",
            });
          }
          if (
            response.status !== 201 ||
            !credential ||
            typeof token !== "string" ||
            !/^[\x21-\x7e]{1,16384}$/.test(token)
          ) {
            return state.outcome(attempt, { kind: "uncertain" });
          }
          const returned = packet?.permissions;
          const repositories = packet?.repositories;
          const validScope =
            returned &&
            typeof returned === "object" &&
            !Array.isArray(returned) &&
            Object.keys(returned).length === Object.keys(permissions).length &&
            Object.entries(permissions).every(
              ([name, value]) => (returned as Record<string, unknown>)[name] === value,
            ) &&
            Array.isArray(repositories) &&
            repositories.length === 1 &&
            repositories[0]?.id === Number(config.repositoryId) &&
            typeof repositories[0]?.full_name === "string" &&
            repositories[0].full_name.toLowerCase() === config.repository.toLowerCase();
          if (!validScope) {
            return state.outcome(attempt, { kind: "rejected", code: "scope-mismatch" });
          }
          if (
            !Number.isFinite(expiry) ||
            expiry <= observedWallMs + providerClockSkewMs ||
            expiry > observedWallMs + tokenLifetimeMs + providerClockSkewMs
          ) {
            return state.outcome(attempt, { kind: "rejected", code: "invalid-response" });
          }
          if (expiry - observedWallMs - providerClockSkewMs < minimumValidityMs) {
            return state.outcome(attempt, { kind: "rejected", code: "insufficient-validity" });
          }
          attempt.assertAdmitted();
          assertCurrent();
          if (attempt.signal.aborted || clock.monotonicNow() >= attempt.deadlineMonoMs) {
            return state.outcome(attempt, { kind: "uncertain" });
          }
          state.credentials.get(credential)!.accepted = true;
          return state.outcome(attempt, {
            kind: "acquired",
            credential,
            observedWallMs,
            expiresAtWallMs: expiry - providerClockSkewMs,
          });
        } finally {
          response.body.fill(0);
        }
      });
    } catch {
      return state.outcome(attempt, { kind: dispatched ? "uncertain" : "not-dispatched" });
    }
  };
}
