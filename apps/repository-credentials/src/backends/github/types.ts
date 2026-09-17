import type { KeyObject } from "node:crypto";
import type { BoundDriverFactory, Clock, ServiceLimits } from "../../contracts.ts";
export type GitHubProfile = "git-write" | "read-write";
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
  readonly key: GitHubKeyOwner;
  readonly gatewayOrigin: string;
  readonly limits: ServiceLimits;
  readonly clock: Clock;
  readonly trustedEndpoints?: Readonly<{ apiOrigin: string; gitOrigin: string; ca?: Uint8Array }>;
}
export interface GitHubDriverFactory extends BoundDriverFactory {
  readonly trustedUpstreamOrigins: ReadonlySet<string>;
}
export type GitHubKeyOptions = Readonly<{ privateKey: KeyObject; appId: string; clock: Clock }>;
