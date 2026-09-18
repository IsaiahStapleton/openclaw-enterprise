import type {
  Clock,
  CredentialRef,
  DriverCustody,
  PrivateUpstreamRequest,
  RepoDriver,
  RequestPlan,
  RetireOutcome,
} from "../../../driver-contracts.ts";
import type { ProviderTransport } from "../provider-transport.ts";
import type { GitHubDriverState } from "./state.ts";
import { tokenLifetimeMs } from "./lifetime.ts";

type CredentialAccessDependencies = Readonly<{
  state: GitHubDriverState;
  custody: DriverCustody;
  clock: Clock;
  exchange: ProviderTransport;
}>;

export function createCredentialAccess(
  deps: CredentialAccessDependencies,
): Pick<RepoDriver, "retire" | "withAuthentication"> {
  const { state, custody, clock, exchange } = deps;
  return {
    async retire(attempt, credential): Promise<RetireOutcome> {
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
    },
    async withAuthentication<T>(
      credential: CredentialRef,
      plan: RequestPlan,
      send: (request: PrivateUpstreamRequest) => Promise<T>,
    ): Promise<T> {
      const record = state.credentials.get(credential);
      if (
        state.finalized ||
        !state.plans.has(plan) ||
        !record?.accepted ||
        record.expiresAt === undefined ||
        clock.wallNow() >= record.expiresAt ||
        clock.monotonicNow() - record.observedMono >= record.expiresAt - record.observedWall
      ) {
        throw new Error("invalid-credential");
      }
      return custody.withAccess(credential, "authenticate", async (bytes) => {
        const copy = Buffer.from(bytes);
        const basic = plan.category.startsWith("git-")
          ? Buffer.concat([Buffer.from("x-access-token:"), copy])
          : undefined;
        try {
          const authorization = basic
            ? `Basic ${basic.toString("base64")}`
            : `Bearer ${copy.toString("utf8")}`;
          return await send(
            Object.freeze({
              plan,
              headers: Object.freeze({ ...plan.requestHeaders, authorization }),
            }),
          );
        } finally {
          basic?.fill(0);
          copy.fill(0);
        }
      });
    },
  };
}
