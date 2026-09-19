import type { AuthorityIdentity, ResolvedGrant } from "../../credentials/backend-contracts.ts";
import type { GitHubConfiguration, GitHubFactoryOptions } from "./types.ts";
import { sameAuthority } from "./driver/state.ts";

type GrantDependencies = Readonly<{
  config: GitHubConfiguration;
  gatewayOrigin: string;
  selectedBinding?: GitHubFactoryOptions["binding"];
}>;

export function createGrantResolver({ config, gatewayOrigin, selectedBinding }: GrantDependencies) {
  function resolve(profile: string): ResolvedGrant {
    if (profile !== "git-read" && profile !== "git-write" && profile !== "git-full") {
      throw new Error("unsupported-profile");
    }
    if (selectedBinding && profile !== selectedBinding.profile) {
      throw new Error("unsupported-profile");
    }
    return Object.freeze({
      binding:
        selectedBinding?.identity ??
        Object.freeze({
          providerInstanceId: config.providerInstanceId,
          repositoryId: config.repositoryId,
          grantId: `${config.configVersion}:${profile}`,
        }),
      client: Object.freeze({
        gatewayOrigin,
        gitRemote: `${gatewayOrigin}/${config.repository}.git`,
        gitUsername: "gateway-session",
        canonicalApiHost: "github.com",
        apiHost: new URL(gatewayOrigin).hostname,
        repository: config.repository,
      }),
    });
  }
  function forAuthority(authority: AuthorityIdentity) {
    const profile = (
      selectedBinding ? [selectedBinding.profile] : (["git-read", "git-write", "git-full"] as const)
    ).find((value) =>
      sameAuthority({ ...resolve(value).binding, sessionId: authority.sessionId }, authority),
    );
    if (!profile || !authority.sessionId) {
      throw new Error("invalid-binding");
    }
    return { profile, grant: resolve(profile) };
  }
  return { resolve, forAuthority };
}
