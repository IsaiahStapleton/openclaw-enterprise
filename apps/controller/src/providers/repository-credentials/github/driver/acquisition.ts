import type {
  AcquireOutcome,
  Clock,
  DriverCustody,
  RepositoryBackend,
} from "../../../../drivers/repository-credentials/backend-contracts.ts";
import type { ProviderTransport } from "../provider-transport.ts";
import type { GitHubConfiguration, GitHubKeyOwner } from "../types.ts";
import type { GitHubDriverState } from "./state.ts";
import { classifyAcquisitionResponse, observeAcquisitionResponse } from "./acquisition-response.ts";

type AcquisitionDependencies = Readonly<{
  state: GitHubDriverState;
  custody: DriverCustody;
  clock: Clock;
  key: GitHubKeyOwner;
  config: GitHubConfiguration;
  permissions: Readonly<Record<string, string>>;
  exchange: ProviderTransport;
}>;

export function createCredentialAcquisition(
  deps: AcquisitionDependencies,
): RepositoryBackend["acquire"] {
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
        let observation: ReturnType<typeof observeAcquisitionResponse> | undefined;
        const response = await exchange.issue(
          jwt,
          attempt,
          () => {
            dispatched = true;
          },
          assertCurrent,
          (response) => {
            observation = observeAcquisitionResponse({ state, custody, clock, attempt, response });
          },
        );
        try {
          const decision = classifyAcquisitionResponse(response.status, observation, {
            repositoryId: config.repositoryId,
            repository: config.repository,
            permissions,
            minimumValidityMs,
          });
          if (decision.kind !== "acquired") {
            return state.outcome(attempt, decision);
          }
          attempt.assertAdmitted();
          assertCurrent();
          if (attempt.signal.aborted || clock.monotonicNow() >= attempt.deadlineMonoMs) {
            return state.outcome(attempt, { kind: "uncertain" });
          }
          state.credentials.get(decision.credential)!.accepted = true;
          return state.outcome(attempt, decision);
        } finally {
          response.body.fill(0);
        }
      });
    } catch {
      return state.outcome(attempt, { kind: dispatched ? "uncertain" : "not-dispatched" });
    }
  };
}
