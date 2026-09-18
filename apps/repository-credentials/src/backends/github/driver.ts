import type {
  AuthorityIdentity,
  Clock,
  DriverCustody,
  RepoDriver,
} from "../../driver-contracts.ts";
import type { RepositoryGrantIdentity } from "../../contracts.ts";
import type { ProviderTransport } from "./provider-transport.ts";
import type { RoutePolicy } from "./routes.ts";
import type { GitHubConfiguration, GitHubKeyOwner } from "./types.ts";
import { createCredentialAcquisition } from "./driver/acquisition.ts";
import { createCredentialAuthentication } from "./driver/access.ts";
import { createCredentialRetirement } from "./driver/retirement.ts";
import { createGitHubDriverState } from "./driver/state.ts";

export { sameAuthority } from "./driver/state.ts";

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

export function createGitHubDriver(options: GitHubDriverOptions): RepoDriver {
  const { authority, binding, custody, clock, key, config, permissions, routes, exchange } =
    options;
  const state = createGitHubDriverState({ authority, custody, routes });
  const acquire = createCredentialAcquisition({
    state,
    custody,
    clock,
    key,
    config,
    permissions,
    exchange,
  });
  const retire = createCredentialRetirement({
    state,
    custody,
    clock,
    exchange,
  });
  const withAuthentication = createCredentialAuthentication({ state, custody, clock });
  return Object.freeze<RepoDriver>({
    binding,
    replacement: "overlap" as const,
    cleanup: "revocable" as const,
    safeCleanupRetry: Object.freeze({ retire: false, finalize: true }),
    acquire,
    retire,
    finalize: state.finalize,
    settle: state.settle,
    plan: state.plan,
    withAuthentication,
  });
}
