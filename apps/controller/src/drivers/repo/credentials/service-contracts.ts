/** Session consumers, client configuration, and operator settings. */
export type RepositoryGrantIdentity = Readonly<{
  providerInstanceId: string;
  repositoryId: string;
  grantId: string;
}>;
export interface PublicClientConfiguration {
  readonly gatewayOrigin: string;
  readonly gitRemote: string;
  readonly gitUsername: string;
  readonly canonicalApiHost: string;
  readonly apiHost: string;
  readonly repository: string;
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
export interface SafeConfigurationSummary {
  readonly valid: true;
  readonly gatewayOrigin: string;
  readonly profiles: readonly string[];
  readonly maximumDurationSeconds: number;
}
export type ControlRequest =
  | Readonly<{ method: "POST"; path: "/v1/sessions"; body: OpenSessionInput }>
  | Readonly<{ method: "GET"; path: `/v1/sessions/${string}` }>
  | Readonly<{ method: "POST"; path: `/v1/sessions/${string}/close` }>;
export type ControlErrorCode = "invalid-request" | "not-found" | "unavailable" | "overloaded";
export type ControlResponse =
  OpenSessionResult | SessionStatus | Readonly<{ error: ControlErrorCode }>;
export interface SessionControl {
  open(input: OpenSessionInput): OpenSessionResult;
  status(sessionId: string): SessionStatus | undefined;
  close(sessionId: string): SessionStatus;
}
export interface CredentialService extends SessionControl {
  shutdown(graceMs: number): Promise<ShutdownSummary>;
}
