import type { RepositoryBackendFactory } from "../../drivers/repository-credentials/backend-contracts.ts";
import type { ServiceConfig } from "../../drivers/repository-credentials/service-contracts.ts";
import type { TlsMaterial } from "../../drivers/repository-credentials/internal-contracts.ts";

export interface LoadedConfiguration {
  readonly config: ServiceConfig;
  readonly tls: TlsMaterial;
  readonly factory: RepositoryBackendFactory;
  readonly trustedUpstreamOrigins: ReadonlySet<string>;
  close(): void;
}
