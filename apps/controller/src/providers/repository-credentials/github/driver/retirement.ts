import type {
  Clock,
  DriverCustody,
  RepositoryBackend,
  RetireOutcome,
} from "../../../../drivers/repository-credentials/backend-contracts.ts";
import type { ProviderTransport } from "../provider-transport.ts";
import type { GitHubDriverState } from "./state.ts";
import { tokenLifetimeMs } from "./lifetime.ts";

type RetirementDependencies = Readonly<{
  state: GitHubDriverState;
  custody: DriverCustody;
  clock: Clock;
  exchange: ProviderTransport;
}>;

export function createCredentialRetirement({
  state,
  custody,
  clock,
  exchange,
}: RetirementDependencies): RepositoryBackend["retire"] {
  return async (attempt, credential): Promise<RetireOutcome> => {
    const record = state.credentials.get(credential);
    if (!record) {
      throw new Error("foreign-credential");
    }
    state.admit(attempt, "retire");
    let dispatched = false;
    try {
      if (clock.monotonicNow() - record.observedMono >= tokenLifetimeMs) {
        return state.outcome(attempt, { kind: "expired" });
      }
      return await custody.withAccess(credential, "retire", async (bytes) => {
        const copy = Buffer.from(bytes);
        try {
          if (
            copy.length < 1 ||
            copy.length > 16384 ||
            copy.some((byte) => byte < 0x21 || byte > 0x7e)
          ) {
            return state.outcome(attempt, { kind: "unsupported" });
          }
          const response = await exchange.revoke(copy.toString("utf8"), attempt, () => {
            dispatched = true;
          });
          try {
            return state.outcome(attempt, {
              kind: response.status === 204 ? "revoked" : "uncertain",
            });
          } finally {
            response.body.fill(0);
          }
        } finally {
          copy.fill(0);
        }
      });
    } catch {
      return state.outcome(attempt, { kind: dispatched ? "uncertain" : "not-dispatched" });
    }
  };
}
