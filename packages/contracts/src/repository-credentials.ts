/** Session consumers, client configuration, and operator settings. */
export type RepositoryCredentialGrantIdentity = Readonly<{
  providerInstanceId: string;
  repositoryId: string;
  grantId: string;
}>;
export interface RepositoryCredentialClientConfiguration {
  readonly gatewayOrigin: string;
  readonly gitRemote: string;
  readonly gitUsername: string;
  readonly canonicalApiHost: string;
  readonly apiHost: string;
  readonly repository: string;
}
export type RepositoryCredentialSessionInput = Readonly<{
  durationSeconds: number;
  profile: string | undefined;
}>;
export interface RepositoryCredentialSessionStatus {
  readonly sessionId: string;
  readonly state: "OPEN" | "CLOSED" | "DISPOSED";
  readonly deadlineWallMs: number;
  readonly binding: RepositoryCredentialGrantIdentity;
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
export interface RepositoryCredentialSessionResult {
  readonly session: RepositoryCredentialSessionStatus;
  readonly bearer: string;
  readonly client: RepositoryCredentialClientConfiguration;
}
