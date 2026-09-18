import type { BoundDriverFactory, RequestHead } from "../../driver-contracts.ts";

type GatewayAuthenticationDependencies = Readonly<{
  isGitRoute: (head: RequestHead) => boolean;
}>;

export function createGatewayAuthentication({
  isGitRoute,
}: GatewayAuthenticationDependencies): Pick<
  BoundDriverFactory,
  "parseAuthentication" | "unauthenticated"
> {
  return {
    parseAuthentication(head, authorization) {
      const denied = Object.freeze({
        kind: "denied" as const,
        status: 401,
        code: "invalid-credential",
      });
      if (typeof authorization !== "string" || authorization.length > 4096) {
        return denied;
      }
      const git = isGitRoute(head);
      if (git) {
        const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
        if (!match) {
          return denied;
        }
        const bytes = Buffer.from(match[1]!, "base64");
        try {
          if (bytes.toString("base64") !== match[1]) {
            return denied;
          }
          const text = bytes.toString("utf8");
          const prefix = "gateway-session:";
          if (!text.startsWith(prefix)) {
            return denied;
          }
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
      return isGitRoute(head)
        ? Object.freeze({ kind: "challenge" as const, realm: "repository-credential-service" })
        : Object.freeze({ kind: "denied" as const, status: 401, code: "invalid-credential" });
    },
  };
}
