import type {
  AttemptContext,
  Clock,
  DriverCustody,
  RepositoryBackend,
  RetireOutcome,
} from "../../../../drivers/repository-credentials/backend-contracts.ts";
import type { ProviderResponse, ProviderTransport } from "../provider-transport.ts";
import type { GitHubDriverState } from "./state.ts";
import { tokenLifetimeMs } from "./lifetime.ts";

type RetirementDependencies = Readonly<{
  state: GitHubDriverState;
  custody: DriverCustody;
  clock: Clock;
  exchange: ProviderTransport;
}>;

function isRetirableToken(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 1 &&
    bytes.length <= 16384 &&
    bytes.every((byte) => byte >= 0x21 && byte <= 0x7e)
  );
}

export function createCredentialRetirement({
  state,
  custody,
  clock,
  exchange,
}: RetirementDependencies): RepositoryBackend["retire"] {
  async function retireBorrowed(
    attempt: AttemptContext,
    bytes: Uint8Array,
    onDispatch: () => void,
  ): Promise<RetireOutcome> {
    const copy = Buffer.from(bytes);
    let response: ProviderResponse | undefined;
    try {
      if (!isRetirableToken(copy)) {
        return state.outcome(attempt, { kind: "unsupported" });
      }
      response = await exchange.revoke(copy.toString("utf8"), attempt, onDispatch);
      return state.outcome(attempt, {
        kind: response.status === 204 ? "revoked" : "uncertain",
      });
    } finally {
      copy.fill(0);
      response?.body.fill(0);
    }
  }

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
      return await custody.withAccess(credential, "retire", (bytes) =>
        retireBorrowed(attempt, bytes, () => {
          dispatched = true;
        }),
      );
    } catch {
      return state.outcome(attempt, { kind: dispatched ? "uncertain" : "not-dispatched" });
    }
  };
}
