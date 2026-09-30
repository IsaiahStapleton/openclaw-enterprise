import type { RepositoryBackendFactory } from "../../drivers/repo/credentials/backend-contracts.ts";
import type {
  ServiceConfig,
  RepositoryDescriptions,
} from "../../drivers/repo/credentials/service-contracts.ts";
import type { ProviderQueue } from "../../drivers/repo/credentials/provider-queue.ts";
import type { TlsMaterial } from "../../drivers/repo/credentials/internal-contracts.ts";

export interface LoadedConfiguration {
  readonly config: ServiceConfig;
  readonly tls: TlsMaterial;
  readonly factory: RepositoryBackendFactory;
  readonly providerQueue?: ProviderQueue;
  readonly repositoryDescriptions?: RepositoryDescriptions;
  readonly trustedUpstreamOrigins: ReadonlySet<string>;
  close(): void;
}
