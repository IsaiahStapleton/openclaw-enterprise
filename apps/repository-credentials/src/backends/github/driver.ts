import type {
  AcquireOutcome,
  AttemptContext,
  AuthorityIdentity,
  Clock,
  CredentialRef,
  DriverCustody,
  FinalizeOutcome,
  OriginalOutcome,
  PrivateUpstreamRequest,
  RepoDriver,
  RepositoryGrantIdentity,
  RequestPlan,
  RetireOutcome,
} from "../../contracts.ts";
import type { ProviderResponse, ProviderTransport } from "./provider-transport.ts";
import type { RoutePolicy } from "./routes.ts";
import type { GitHubConfiguration, GitHubKeyOwner } from "./types.ts";

interface GitHubDriverOptions {
  readonly authority: AuthorityIdentity;
  readonly binding: RepositoryGrantIdentity;
  readonly custody: DriverCustody;
  readonly clock: Clock;
  readonly key: GitHubKeyOwner;
  readonly config: GitHubConfiguration;
  readonly permissions: Readonly<Record<string, string>>;
  readonly routes: RoutePolicy;
  readonly exchange: ProviderTransport;
}

type OutcomePayload<T> = T extends OriginalOutcome ? Omit<T, keyof OriginalOutcome> : never;
type ProviderOutcomePayload = OutcomePayload<AcquireOutcome | RetireOutcome | FinalizeOutcome>;

export function sameAuthority(a: AuthorityIdentity, b: AuthorityIdentity): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.providerInstanceId === b.providerInstanceId &&
    a.repositoryId === b.repositoryId &&
    a.grantId === b.grantId
  );
}

export function createGitHubDriver(options: GitHubDriverOptions): RepoDriver {
  const { authority, binding, custody, clock, key, config, permissions, routes, exchange } =
    options;
  const plans = new WeakSet<RequestPlan>(),
    credentials = new WeakMap<
      CredentialRef,
      {
        expiresAt: number | undefined;
        observedWall: number;
        observedMono: number;
        accepted: boolean;
      }
    >();
  const results = new WeakSet<object>(),
    attempts = new WeakSet<AttemptContext>();
  let finalized = false;
  function admit(attempt: AttemptContext, action: AttemptContext["action"]) {
    custody.assertAttempt(attempt, action);
    if (
      !sameAuthority(attempt.authority, authority) ||
      attempt.action !== action ||
      attempts.has(attempt)
    )
      throw new Error("foreign-attempt");
    attempts.add(attempt);
  }
  function outcome<T extends ProviderOutcomePayload>(
    attempt: AttemptContext,
    value: T,
  ): Readonly<T> & OriginalOutcome {
    const result = Object.freeze({ ...value, attemptId: attempt.id }) as Readonly<T> &
      OriginalOutcome;
    results.add(result);
    return result;
  }
  return Object.freeze<RepoDriver>({
    binding,
    replacement: "overlap" as const,
    cleanup: "revocable" as const,
    safeCleanupRetry: Object.freeze({ retire: false, finalize: true }),
    async acquire(attempt, previous, minimumValidityMs): Promise<AcquireOutcome> {
      if (previous !== undefined && !credentials.has(previous))
        throw new Error("foreign-credential");
      if (!Number.isFinite(minimumValidityMs) || minimumValidityMs < 0)
        throw new Error("invalid-validity");
      admit(attempt, "acquire");
      let dispatched = false;
      try {
        if (finalized) return outcome(attempt, { kind: "not-dispatched" });
        return await key.withJwt(async (jwt, assertCurrent) => {
          let packet: Record<string, unknown> | undefined, credential: CredentialRef | undefined;
          let observedWallMs = 0,
            expiry = NaN;
          const observe = (response: ProviderResponse) => {
            try {
              const parsed: unknown = JSON.parse(response.body.toString("utf8"));
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                packet = parsed as Record<string, unknown>;
            } catch {}
            const token = packet?.token;
            observedWallMs = clock.wallNow();
            expiry = typeof packet?.expires_at === "string" ? Date.parse(packet.expires_at) : NaN;
            if (typeof token === "string" && token.length > 0) {
              const bytes = Buffer.from(token);
              try {
                // Capture in the response callback, before timeout or close can discard its body.
                credential = custody.capture(attempt, bytes, {
                  observedWallMs,
                  expiresAtWallMs: Number.isFinite(expiry) ? expiry : undefined,
                });
                credentials.set(credential, {
                  expiresAt: Number.isFinite(expiry) ? expiry : undefined,
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
            observe,
          );
          try {
            const token = packet?.token;
            if ([401, 403, 404, 422].includes(response.status))
              return outcome(attempt, {
                kind: "reauthorization-required",
                code: "authority-unavailable",
              });
            if (
              response.status !== 201 ||
              !credential ||
              typeof token !== "string" ||
              !/^[\x21-\x7e]{1,16384}$/.test(token)
            )
              return outcome(attempt, { kind: "uncertain" });
            const returned = packet?.permissions,
              repositories = packet?.repositories;
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
            if (!validScope) return outcome(attempt, { kind: "rejected", code: "scope-mismatch" });
            if (
              !Number.isFinite(expiry) ||
              expiry <= observedWallMs ||
              expiry > observedWallMs + 3600000
            )
              return outcome(attempt, { kind: "rejected", code: "invalid-response" });
            if (expiry - observedWallMs < minimumValidityMs)
              return outcome(attempt, { kind: "rejected", code: "insufficient-validity" });
            attempt.assertAdmitted();
            assertCurrent();
            if (attempt.signal.aborted || clock.monotonicNow() >= attempt.deadlineMonoMs)
              return outcome(attempt, { kind: "uncertain" });
            credentials.get(credential)!.accepted = true;
            return outcome(attempt, {
              kind: "acquired",
              credential,
              observedWallMs,
              expiresAtWallMs: expiry,
            });
          } finally {
            response.body.fill(0);
          }
        });
      } catch {
        return outcome(attempt, { kind: dispatched ? "uncertain" : "not-dispatched" });
      }
    },
    async retire(attempt, credential): Promise<RetireOutcome> {
      const record = credentials.get(credential);
      if (!record) throw new Error("foreign-credential");
      admit(attempt, "retire");
      let dispatched = false;
      try {
        if (
          record.expiresAt !== undefined &&
          (clock.wallNow() >= record.expiresAt ||
            clock.monotonicNow() - record.observedMono >= record.expiresAt - record.observedWall)
        )
          return outcome(attempt, { kind: "expired" });
        return await custody.withAccess(credential, "retire", async (bytes) => {
          const copy = Buffer.from(bytes);
          try {
            if (
              copy.length < 1 ||
              copy.length > 16384 ||
              copy.some((byte) => byte < 0x21 || byte > 0x7e)
            )
              return outcome(attempt, { kind: "unsupported" });
            const response = await exchange(
              {
                method: "DELETE",
                path: "/installation/token",
                authorization: copy.toString("utf8"),
                body: "",
              },
              attempt,
              () => {
                dispatched = true;
              },
            );
            try {
              return outcome(attempt, {
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
        return outcome(attempt, { kind: dispatched ? "uncertain" : "not-dispatched" });
      }
    },
    async finalize(attempt): Promise<FinalizeOutcome> {
      admit(attempt, "finalize");
      try {
        attempt.assertAdmitted();
        finalized = true;
        return outcome(attempt, { kind: "finalized" });
      } catch {
        return outcome(attempt, { kind: "cleanup-pending", reason: "not-dispatched" });
      }
    },
    async settle(original) {
      if (!results.has(original)) throw new Error("foreign-outcome");
      results.delete(original);
    },
    plan(request) {
      if (finalized || !sameAuthority(request.authority, authority))
        return Object.freeze({ kind: "denied" as const, status: 403, code: "invalid-binding" });
      const plan = routes.plan(request.head);
      if (!("kind" in plan)) plans.add(plan);
      return plan;
    },
    async withAuthentication<T>(
      credential: CredentialRef,
      plan: RequestPlan,
      send: (request: PrivateUpstreamRequest) => Promise<T>,
    ): Promise<T> {
      const record = credentials.get(credential);
      if (
        finalized ||
        !plans.has(plan) ||
        !record?.accepted ||
        record.expiresAt === undefined ||
        clock.wallNow() >= record.expiresAt ||
        clock.monotonicNow() - record.observedMono >= record.expiresAt - record.observedWall
      )
        throw new Error("invalid-credential");
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
  });
}
