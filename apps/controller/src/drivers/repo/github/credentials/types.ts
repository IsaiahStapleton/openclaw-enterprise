import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";
import type { KeyObject } from "node:crypto";
import type { RepositoryBackendFactory, Clock } from "../../credentials/backend-contracts.ts";
import type { ServiceLimits } from "../../credentials/service-contracts.ts";

export type GitHubProfile = "git-read" | "git-write" | "git-full";
/** Internal scope used only by the repository metadata lookup. */
export type GitHubTokenProfile = GitHubProfile | "metadata-read";
export interface GitHubConfiguration {
  readonly kind: "github-app";
  readonly providerInstanceId: string;
  readonly configVersion: string;
  readonly appId: string;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly repository: string;
  readonly privateKeyFile: string;
}
export interface GitHubKeyOwner {
  withJwt<T>(consume: (jwt: string, assertCurrent: () => void) => Promise<T>): Promise<T>;
  close(): void;
}
export interface GitHubFactoryOptions {
  readonly configuration: GitHubConfiguration;
  /** Restricted service-internal token capability; never a user-facing access profile. */
  readonly metadataOnly?: true;
  readonly binding?: Readonly<{
    profile: GitHubTokenProfile;
    identity: RepositoryCredentialGrantIdentity;
    pushRefAllowlist?: readonly string[];
  }>;
  readonly key: GitHubKeyOwner;
  readonly gatewayOrigin: string;
  readonly limits: ServiceLimits;
  readonly clock: Clock;
  readonly trustedEndpoints?: Readonly<{ apiOrigin: string; gitOrigin: string; ca?: Uint8Array }>;
}
export interface GitHubDriverFactory extends RepositoryBackendFactory {
  readonly trustedUpstreamOrigins: ReadonlySet<string>;
}
export type GitHubKeyOptions = Readonly<{ privateKey: KeyObject; appId: string; clock: Clock }>;
