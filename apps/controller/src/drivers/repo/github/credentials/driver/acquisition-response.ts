import type {
  AcquireOutcome,
  AttemptContext,
  Clock,
  CredentialRef,
  DriverCustody,
  OriginalOutcome,
} from "../../../credentials/backend-contracts.ts";
import type { ProviderResponse } from "../provider-transport.ts";
import type { GitHubDriverState } from "./state.ts";
import { providerClockSkewMs, tokenLifetimeMs } from "./lifetime.ts";

type AcquisitionObservation = Readonly<{
  packet: Record<string, unknown> | undefined;
  credential: CredentialRef | undefined;
  observedWallMs: number;
  expiry: number;
}>;

type ResponseObservationDependencies = Readonly<{
  state: GitHubDriverState;
  custody: DriverCustody;
  clock: Clock;
  attempt: AttemptContext;
  response: ProviderResponse;
}>;

type AcquisitionPolicy = Readonly<{
  repositoryId: string;
  repository: string;
  permissions: Readonly<Record<string, string>>;
  minimumValidityMs: number;
}>;

type OutcomePayload<T> = T extends OriginalOutcome ? Omit<T, keyof OriginalOutcome> : never;
type AcquisitionDecision = OutcomePayload<AcquireOutcome>;

export function observeAcquisitionResponse({
  state,
  custody,
  clock,
  attempt,
  response,
}: ResponseObservationDependencies): AcquisitionObservation {
  let packet: Record<string, unknown> | undefined;
  let credential: CredentialRef | undefined;
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
  const observedWallMs = clock.wallNow();
  const expiry = typeof packet?.expires_at === "string" ? Date.parse(packet.expires_at) : NaN;
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
  return { packet, credential, observedWallMs, expiry };
}

export function classifyAcquisitionResponse(
  status: number,
  observation: AcquisitionObservation | undefined,
  { repositoryId, repository, permissions, minimumValidityMs }: AcquisitionPolicy,
): AcquisitionDecision {
  if ([401, 403, 404, 422].includes(status)) {
    return {
      kind: "reauthorization-required",
      code: "authority-unavailable",
    };
  }
  if (status !== 201 || !observation?.credential) {
    return { kind: "uncertain" };
  }
  const { packet, credential, observedWallMs, expiry } = observation;
  const token = packet?.token;
  if (typeof token !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(token)) {
    return { kind: "uncertain" };
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
    repositories[0]?.id === Number(repositoryId) &&
    typeof repositories[0]?.full_name === "string" &&
    repositories[0].full_name.toLowerCase() === repository.toLowerCase();
  if (!validScope) {
    return { kind: "rejected", code: "scope-mismatch" };
  }
  if (
    !Number.isFinite(expiry) ||
    expiry <= observedWallMs + providerClockSkewMs ||
    expiry > observedWallMs + tokenLifetimeMs + providerClockSkewMs
  ) {
    return { kind: "rejected", code: "invalid-response" };
  }
  if (expiry - observedWallMs - providerClockSkewMs < minimumValidityMs) {
    return { kind: "rejected", code: "insufficient-validity" };
  }
  return {
    kind: "acquired",
    credential,
    observedWallMs,
    expiresAtWallMs: expiry - providerClockSkewMs,
  };
}
