/** Internal service boundaries. Runtime owners also check original object identity. */
declare const credentialIdentity: unique symbol;
declare const renewalIdentity: unique symbol;
declare const sessionIdentity: unique symbol;
declare const exchangeIdentity: unique symbol;
declare const planIdentity: unique symbol;
declare const outcomeIdentity: unique symbol;
export type CredentialRef = Readonly<{ [credentialIdentity]: true }>;
export type RenewalRef = Readonly<{ [renewalIdentity]: true }>;
export type SessionRef = Readonly<{ [sessionIdentity]: true }>;
export type ExchangeRef = Readonly<{ [exchangeIdentity]: true }>;
export type RepositoryGrantIdentity = Readonly<{
  providerInstanceId: string;
  repositoryId: string;
  grantId: string;
}>;
export type AuthorityIdentity = RepositoryGrantIdentity & Readonly<{ sessionId: string }>;
export interface Clock {
  wallNow(): number;
  monotonicNow(): number;
  schedule(delayMs: number, callback: () => void): () => void;
}
export interface Bounds {
  readonly deadlineMonoMs: number;
  readonly signal: AbortSignal;
}
export interface AttemptContext extends Bounds {
  readonly id: string;
  readonly authority: AuthorityIdentity;
  readonly action: "acquire" | "retire" | "finalize";
  assertAdmitted(): void;
  observeDispatch(): void;
}
export interface CaptureObservation {
  readonly observedWallMs: number;
  readonly expiresAtWallMs: number | undefined;
}
export interface DriverCustody {
  assertAttempt(attempt: AttemptContext, action: AttemptContext["action"]): void;
  capture(
    attempt: AttemptContext,
    bytes: Uint8Array,
    observation: CaptureObservation,
  ): CredentialRef;
  withAccess<T>(
    credential: CredentialRef,
    purpose: "authenticate" | "retire",
    consume: (bytes: Uint8Array) => Promise<T>,
  ): Promise<T>;
  retainRenewal(bytes: Uint8Array): RenewalRef;
  withRenewal<T>(renewal: RenewalRef, consume: (bytes: Uint8Array) => Promise<T>): Promise<T>;
  disposeRenewal(renewal: RenewalRef): Promise<void>;
}
export type SafeProviderCode =
  | "authority-unavailable"
  | "scope-mismatch"
  | "invalid-response"
  | "insufficient-validity"
  | "provider-rejected";
export type OriginalOutcome = Readonly<{
  readonly [outcomeIdentity]: true;
  readonly attemptId: string;
}>;
export type AcquireOutcome = OriginalOutcome &
  (
    | Readonly<{
        kind: "acquired";
        credential: CredentialRef;
        observedWallMs: number;
        expiresAtWallMs: number;
      }>
    | Readonly<{ kind: "not-dispatched" | "uncertain" }>
    | Readonly<{ kind: "rejected" | "reauthorization-required"; code: SafeProviderCode }>
  );
export type RetireOutcome = OriginalOutcome &
  Readonly<{ kind: "revoked" | "expired" | "not-dispatched" | "uncertain" | "unsupported" }>;
export type FinalizeOutcome = OriginalOutcome &
  (
    | Readonly<{ kind: "finalized" }>
    | Readonly<{ kind: "cleanup-pending"; reason: "not-dispatched" | "uncertain" | "unsupported" }>
  );
export type HeaderFields = Readonly<Record<string, string>>;
export interface RequestHead {
  readonly method: string;
  readonly rawTarget: string;
  readonly headers: HeaderFields;
  readonly receivedMonoMs: number;
  readonly contentEncoding: "identity" | "gzip";
  readonly framing: Readonly<{ kind: "none" | "chunked" | "length"; bytes: number | undefined }>;
}
export interface SessionAuthenticatedRequest {
  readonly session: SessionRef;
  readonly authority: AuthorityIdentity;
  readonly head: RequestHead;
}
export interface ExchangeLimits {
  readonly inputWireBytes: number;
  readonly inputDecodedBytes: number;
  readonly responseBytes: number;
  readonly totalMs: number;
  readonly inputMs: number;
  readonly firstHeaderMs: number;
  readonly stallMs: number;
  readonly connectMs: number;
}
export interface ResponsePolicy {
  readonly body: "stream" | "bounded-json";
  headers(status: number, headers: HeaderFields): HeaderFields;
  readonly rewriteJson: ((value: unknown) => unknown) | undefined;
}
export interface RequestPlan {
  readonly [planIdentity]: true;
  readonly origin: string;
  readonly method: string;
  readonly target: string;
  readonly category: string;
  readonly effect: "read" | "write";
  readonly requestHeaders: HeaderFields;
  readonly limits: ExchangeLimits;
  readonly responsePolicy: ResponsePolicy;
}
export interface PrivateUpstreamRequest {
  readonly plan: RequestPlan;
  readonly headers: HeaderFields;
}
export type Denied = Readonly<{ kind: "denied"; status: number; code: string }>;
export interface DispatchGate {
  dispatch<T>(cancel: () => void, open: () => T): T;
  track(io: Promise<void>): void;
}
export type ExchangeOutcome =
  | Readonly<{ kind: "completed"; status: number }>
  | Readonly<{ kind: "not-dispatched" | "possibly-dispatched"; code: string }>;
export type ExchangeSender = (
  request: PrivateUpstreamRequest,
  context: Bounds & Readonly<{ gate: DispatchGate }>,
) => Promise<ExchangeOutcome>;
export interface RepoDriver {
  readonly binding: RepositoryGrantIdentity;
  readonly replacement: "overlap" | "drain-before";
  readonly cleanup: "revocable" | "expiry-only";
  readonly safeCleanupRetry: Readonly<{ retire: boolean; finalize: boolean }>;
  acquire(
    attempt: AttemptContext,
    previous: CredentialRef | undefined,
    minimumValidityMs: number,
  ): Promise<AcquireOutcome>;
  retire(attempt: AttemptContext, credential: CredentialRef): Promise<RetireOutcome>;
  finalize(attempt: AttemptContext): Promise<FinalizeOutcome>;
  settle(original: AcquireOutcome | RetireOutcome | FinalizeOutcome): Promise<void>;
  plan(request: SessionAuthenticatedRequest): RequestPlan | Denied;
  withAuthentication<T>(
    credential: CredentialRef,
    plan: RequestPlan,
    send: (request: PrivateUpstreamRequest) => Promise<T>,
  ): Promise<T>;
}
export interface PublicClientConfiguration {
  readonly gatewayOrigin: string;
  readonly gitRemote: string;
  readonly gitUsername: string;
  readonly canonicalApiHost: string;
  readonly apiHost: string;
  readonly repository: string;
}
export interface ResolvedGrant {
  readonly binding: RepositoryGrantIdentity;
  readonly client: PublicClientConfiguration;
}
export interface BoundDriverFactory {
  parseAuthentication(head: RequestHead, authorization: string): string | Denied;
  resolve(profile: string): ResolvedGrant;
  create(
    input: Readonly<{ authority: AuthorityIdentity; custody: DriverCustody; clock: Clock }>,
  ): RepoDriver;
  unauthenticated(head: RequestHead): Readonly<{ kind: "challenge"; realm: string }> | Denied;
}
export type OpenSessionInput = Readonly<{ durationSeconds: number; profile: string | undefined }>;
export interface SessionStatus {
  readonly sessionId: string;
  readonly state: "OPEN" | "CLOSED" | "DISPOSED";
  readonly deadlineWallMs: number;
  readonly binding: RepositoryGrantIdentity;
  readonly activeUses: number;
  readonly cleanup: Readonly<{
    active: number;
    pending: number;
    revoked: number;
    expired: number;
    uncertain: number;
    auxiliaryPending: boolean;
  }>;
}
export interface OpenSessionResult {
  readonly session: SessionStatus;
  readonly bearer: string;
  readonly client: PublicClientConfiguration;
}
export interface ShutdownSummary {
  readonly closedSessions: number;
  readonly disposedSessions: number;
  readonly pendingActions: number;
  readonly pendingCredentials: number;
  readonly pendingAuxiliary: number;
  readonly graceExpired: boolean;
}
export interface CredentialService {
  open(input: OpenSessionInput): OpenSessionResult;
  status(sessionId: string): SessionStatus | undefined;
  close(sessionId: string): SessionStatus;
  reserve(bearer: string, head: RequestHead, signal: AbortSignal): ExchangeRef | Denied;
  plan(exchange: ExchangeRef): RequestPlan;
  execute(exchange: ExchangeRef, send: ExchangeSender): Promise<ExchangeOutcome>;
  cancel(exchange: ExchangeRef): void;
  shutdown(graceMs: number): Promise<ShutdownSummary>;
}
export interface ServiceLimits {
  readonly sessions: number;
  readonly credentialSlotsPerSession: number;
  readonly providerActions: number;
  readonly providerQueue: number;
  readonly sockets: number;
  readonly exchanges: number;
  readonly exchangesPerSession: number;
  readonly headerBytes: number;
  readonly headerPairs: number;
  readonly targetBytes: number;
  readonly gitFetchInputBytes: number;
  readonly gitPushInputBytes: number;
  readonly gitResponseBytes: number;
  readonly apiInputBytes: number;
  readonly apiResponseBytes: number;
  readonly controlBodyBytes: number;
  readonly headerMs: number;
  readonly connectMs: number;
  readonly stallMs: number;
  readonly inputMs: number;
  readonly firstHeaderMs: number;
  readonly exchangeMs: number;
  readonly providerActionMs: number;
  readonly shutdownGraceMs: number;
  readonly credentialMarginMs: number;
  readonly accessTokenBytes: number;
  readonly renewalBytesPerSession: number;
  readonly privateKeyBytes: number;
}
export interface ServiceConfig {
  readonly gateway: Readonly<{ publicOrigin: string; listen: string; controlSocket: string }>;
  readonly sessionPolicy: Readonly<{
    maximumDurationSeconds: number;
    defaultProfile: string;
    allowedProfiles: readonly string[];
  }>;
  readonly limits: ServiceLimits;
}
export interface TlsMaterial {
  readonly cert: Uint8Array;
  readonly key: Uint8Array;
  readonly ca?: Uint8Array;
}
export interface LoadedConfiguration {
  readonly config: ServiceConfig;
  readonly tls: TlsMaterial;
  readonly factory: BoundDriverFactory;
  readonly trustedUpstreamOrigins: ReadonlySet<string>;
  close(): void;
}
export interface SafeConfigurationSummary {
  readonly valid: true;
  readonly gatewayOrigin: string;
  readonly profiles: readonly string[];
  readonly maximumDurationSeconds: number;
}
export interface RunningListeners {
  readonly address?: Readonly<{ address: string; family: string; port: number }>;
  stopAdmission(): void;
  close(): Promise<void>;
}
export type ControlRequest =
  | Readonly<{ method: "POST"; path: "/v1/sessions"; body: OpenSessionInput }>
  | Readonly<{ method: "GET"; path: `/v1/sessions/${string}` }>
  | Readonly<{ method: "POST"; path: `/v1/sessions/${string}/close` }>;
export type ControlErrorCode = "invalid-request" | "not-found" | "unavailable" | "overloaded";
export type ControlResponse =
  OpenSessionResult | SessionStatus | Readonly<{ error: ControlErrorCode }>;
