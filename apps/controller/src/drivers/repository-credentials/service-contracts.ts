import type {
  RepositoryCredentialClientConfiguration,
  RepositoryCredentialGrantIdentity,
  RepositoryCredentialSessionStatus,
} from "@openclaw-enterprise/contracts";

/** Protected single-repository operator input; registry admission uses the bound form. */
export type RepositoryCredentialSessionInput = Readonly<{
  durationSeconds: number;
  profile: string | undefined;
}>;

/** Registry-backed admission always supplies the complete resolved authority. */
export interface RepositoryCredentialBoundSessionInput extends RepositoryCredentialSessionInput {
  readonly namespaceId: string;
  readonly repositoryRef: string;
  readonly profile: string;
  readonly expectedBinding: RepositoryCredentialGrantIdentity;
  readonly deadlineWallMs: number;
  /** Look up an admission without creating a session; not part of replay identity. */
  readonly recoverOnly?: true;
}

export interface RepositoryCredentialSessionResult {
  readonly session: RepositoryCredentialSessionStatus;
  readonly bearer: string;
  readonly client: RepositoryCredentialClientConfiguration;
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
export interface SessionControl {
  open(
    input: RepositoryCredentialSessionInput | RepositoryCredentialBoundSessionInput,
  ): RepositoryCredentialSessionResult;
  status(sessionId: string): RepositoryCredentialSessionStatus | undefined;
  close(sessionId: string): RepositoryCredentialSessionStatus;
}
export interface CredentialService extends SessionControl {
  shutdown(graceMs: number): Promise<ShutdownSummary>;
}
