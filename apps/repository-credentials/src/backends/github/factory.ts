import type { RepoDriver, ResolvedGrant } from "../../driver-contracts.ts";
import { createGitHubDriver, sameAuthority } from "./driver.ts";
import { validateGitHubConfiguration } from "./config.ts";
import { createProviderTransport } from "./provider-transport.ts";
import { createRoutePolicy } from "./routes.ts";
import type { GitHubDriverFactory, GitHubFactoryOptions, GitHubProfile } from "./types.ts";
const profiles = Object.freeze({
  "git-read": Object.freeze({ metadata: "read", contents: "read" }),
  "git-write": Object.freeze({ metadata: "read", contents: "write" }),
  "git-full": Object.freeze({
    metadata: "read",
    contents: "write",
    pull_requests: "write",
    issues: "write",
  }),
});
function endpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password)
    throw new Error("invalid-endpoint");
  return url.origin;
}
export function createGitHubDriverFactory(options: GitHubFactoryOptions): GitHubDriverFactory {
  const config = validateGitHubConfiguration(options.configuration);
  const apiOrigin = endpoint(options.trustedEndpoints?.apiOrigin ?? "https://api.github.com"),
    gitOrigin = endpoint(options.trustedEndpoints?.gitOrigin ?? "https://github.com");
  const gatewayOrigin = endpoint(options.gatewayOrigin);
  const grant = (profile: string): ResolvedGrant => {
    if (profile !== "git-read" && profile !== "git-write" && profile !== "git-full")
      throw new Error("unsupported-profile");
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
  };
  const policy = (profile: GitHubProfile) =>
    createRoutePolicy({
      repository: config.repository,
      repositoryId: config.repositoryId,
      profile,
      gatewayOrigin,
      gitOrigin,
      apiOrigin,
      limits: options.limits,
    });
  const unauthenticatedPolicy = policy("git-write");
  return Object.freeze<GitHubDriverFactory>({
    trustedUpstreamOrigins: new Set([apiOrigin, gitOrigin]),
    resolve: grant,
    parseAuthentication(head, authorization) {
      const denied = Object.freeze({
        kind: "denied" as const,
        status: 401,
        code: "invalid-credential",
      });
      if (typeof authorization !== "string" || authorization.length > 4096) return denied;
      const git = unauthenticatedPolicy.route(head) !== undefined;
      if (git) {
        const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
        if (!match) return denied;
        const bytes = Buffer.from(match[1]!, "base64");
        try {
          if (bytes.toString("base64") !== match[1]) return denied;
          const text = bytes.toString("utf8");
          const prefix = "gateway-session:";
          if (!text.startsWith(prefix)) return denied;
          const token = text.slice(prefix.length);
          return /^[A-Za-z0-9_-]{43,256}$/.test(token) ? token : denied;
        } finally {
          bytes.fill(0);
        }
      }
      const match = /^(?:token|Bearer) ([A-Za-z0-9_-]{43,256})$/i.exec(authorization);
      return match?.[1] ?? denied;
    },
    unauthenticated(head) {
      return unauthenticatedPolicy.route(head)
        ? Object.freeze({ kind: "challenge" as const, realm: "repository-credential-service" })
        : Object.freeze({ kind: "denied" as const, status: 401, code: "invalid-credential" });
    },
    create({ authority: input, custody, clock }): RepoDriver {
      const authority = Object.freeze({ ...input });
      const profile = (["git-read", "git-write", "git-full"] as const).find((value) =>
        sameAuthority({ ...grant(value).binding, sessionId: authority.sessionId }, authority),
      );
      if (!profile || !authority.sessionId) throw new Error("invalid-binding");
      const binding = grant(profile).binding,
        permissions = profiles[profile],
        routes = policy(profile);
      const exchange = createProviderTransport(apiOrigin, options.trustedEndpoints?.ca, clock);
      return createGitHubDriver({
        authority,
        binding,
        custody,
        clock,
        key: options.key,
        config,
        permissions,
        routes,
        exchange,
      });
    },
  });
}
