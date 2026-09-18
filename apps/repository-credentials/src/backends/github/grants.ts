import type { AuthorityIdentity, ResolvedGrant } from "../../driver-contracts.ts";
import type { GitHubConfiguration } from "./types.ts";
import { sameAuthority } from "./driver/state.ts";

type GrantDependencies = Readonly<{
  config: GitHubConfiguration;
  gatewayOrigin: string;
}>;

export function createGrantResolver({ config, gatewayOrigin }: GrantDependencies) {
  function resolve(profile: string): ResolvedGrant {
    if (profile !== "git-read" && profile !== "git-write" && profile !== "git-full") {
      throw new Error("unsupported-profile");
    }
    return Object.freeze({
      binding: Object.freeze({
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
    const profile = (["git-read", "git-write", "git-full"] as const).find((value) =>
      sameAuthority({ ...resolve(value).binding, sessionId: authority.sessionId }, authority),
    );
    if (!profile || !authority.sessionId) {
      throw new Error("invalid-binding");
    }
    return { profile, grant: resolve(profile) };
  }
  return { resolve, forAuthority };
}
