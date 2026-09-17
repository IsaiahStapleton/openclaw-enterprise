import type { Denied, RequestHead, RequestPlan, ServiceLimits } from "../../contracts.ts";
import type { GitHubProfile } from "./types.ts";
import { createResponsePolicy } from "./response.ts";
type Route = Readonly<{
  kind: "git-discovery" | "git-fetch" | "git-push" | "api";
  effect: "read" | "write";
  target: string;
}>;
const deny = (): Denied =>
  Object.freeze({ kind: "denied", status: 400, code: "unsupported-request" });
const number = /^[1-9][0-9]{0,14}$/;
// Native gh 2.100.0 PR discovery and creation use this exact GraphQL media profile.
const nativeGraphqlAccept =
  "application/vnd.github.merge-info-preview+json, application/vnd.github.nebula-preview";
const queryValues: Readonly<Record<string, RegExp>> = Object.freeze({
  page: /^[1-9][0-9]{0,5}$/,
  per_page: /^(?:[1-9]|[1-9][0-9]|100)$/,
  state: /^(open|closed|all)$/,
  sort: /^(created|updated|popularity|long-running|comments)$/,
  direction: /^(asc|desc)$/,
  head: /^[A-Za-z0-9_.:/-]{1,256}$/,
  base: /^[A-Za-z0-9_./-]{1,256}$/,
  since: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
  labels: /^[A-Za-z0-9 _.,-]{1,512}$/,
  creator: /^[A-Za-z0-9-]{1,39}$/,
  mentioned: /^[A-Za-z0-9-]{1,39}$/,
  assignee: /^(?:\*|none|[A-Za-z0-9-]{1,39})$/,
});
function classify(
  head: RequestHead,
  repository: string,
  profile: GitHubProfile,
  limit: number,
): Route | undefined {
  const raw = head.rawTarget;
  if (
    Buffer.byteLength(raw) > limit ||
    !/^\/[\x21-\x7e]*$/.test(raw) ||
    /[\\#]/.test(raw) ||
    raw.startsWith("//")
  )
    return;
  const split = raw.indexOf("?"),
    path = split < 0 ? raw : raw.slice(0, split),
    query = split < 0 ? "" : raw.slice(split + 1);
  if (
    path.includes("%") ||
    path.split("/").some((piece) => piece === "." || piece === "..") ||
    query.includes("?") ||
    /%(?![0-9A-Fa-f]{2})/.test(query)
  )
    return;
  const git = `/${repository}.git/`;
  if (path.startsWith(git)) {
    if (head.headers["git-protocol"] !== undefined && head.headers["git-protocol"] !== "version=2")
      return;
    if (
      path === `${git}info/refs` &&
      head.method === "GET" &&
      (query === "service=git-upload-pack" || query === "service=git-receive-pack")
    )
      return {
        kind: "git-discovery",
        effect: query.includes("receive") ? "write" : "read",
        target: raw,
      };
    if (query || head.method !== "POST") return;
    if (
      path === `${git}git-upload-pack` &&
      head.headers["content-type"] === "application/x-git-upload-pack-request"
    )
      return { kind: "git-fetch", effect: "read", target: raw };
    if (
      path === `${git}git-receive-pack` &&
      head.headers["content-type"] === "application/x-git-receive-pack-request"
    )
      return { kind: "git-push", effect: "write", target: raw };
    return;
  }
  if (profile !== "read-write" || head.contentEncoding !== "identity") return;
  const prefix = `/repos/${repository}`;
  let allowed: string[] = [],
    parameters: string[] = [];
  if (path === prefix) allowed = ["GET"];
  else if (path === "/graphql") allowed = ["POST"];
  else if (path === "/meta") allowed = ["GET"];
  else if (path.startsWith(`${prefix}/`)) {
    const parts = path.slice(prefix.length + 1).split("/");
    if (parts.length === 1 && (parts[0] === "pulls" || parts[0] === "issues")) {
      allowed = ["GET", "POST"];
      parameters =
        parts[0] === "pulls"
          ? ["page", "per_page", "state", "head", "base", "sort", "direction"]
          : [
              "page",
              "per_page",
              "state",
              "sort",
              "direction",
              "since",
              "labels",
              "creator",
              "mentioned",
              "assignee",
            ];
    } else if (
      parts.length === 2 &&
      (parts[0] === "pulls" || parts[0] === "issues") &&
      number.test(parts[1]!)
    )
      allowed = ["GET", "PATCH"];
    else if (
      parts.length === 3 &&
      parts[0] === "issues" &&
      number.test(parts[1]!) &&
      parts[2] === "comments"
    ) {
      allowed = ["GET", "POST"];
      parameters = ["page", "per_page", "since"];
    } else if (
      parts.length === 3 &&
      parts[0] === "issues" &&
      parts[1] === "comments" &&
      number.test(parts[2]!)
    )
      allowed = ["GET", "PATCH", "DELETE"];
  }
  if (!allowed.includes(head.method)) return;
  if (query) {
    if (head.method !== "GET") return;
    const params = new URLSearchParams(query),
      seen = new Set<string>();
    for (const [name, value] of params) {
      if (seen.has(name) || !parameters.includes(name) || !queryValues[name]?.test(value)) return;
      seen.add(name);
    }
    if (!seen.size) return;
  }
  if (
    ["POST", "PATCH"].includes(head.method) &&
    !/^application\/(?:json|vnd\.github\+json)(?:;\s*charset=utf-8)?$/i.test(
      head.headers["content-type"] ?? "",
    )
  )
    return;
  const accept = head.headers.accept;
  if (
    accept !== undefined &&
    !["*/*", "application/json", "application/vnd.github+json"].includes(accept) &&
    !(path === "/graphql" && accept === nativeGraphqlAccept)
  )
    return;
  const feature = head.headers["graphql-features"];
  if (feature !== undefined && (path !== "/graphql" || feature !== "merge_queue")) return;
  return { kind: "api", effect: head.method === "GET" ? "read" : "write", target: raw };
}
export interface RoutePolicy {
  route(head: RequestHead): Route | undefined;
  plan(head: RequestHead): RequestPlan | Denied;
}

interface RoutePolicyOptions {
  readonly repository: string;
  readonly profile: GitHubProfile;
  readonly gatewayOrigin: string;
  readonly gitOrigin: string;
  readonly apiOrigin: string;
  readonly limits: ServiceLimits;
}

export function createRoutePolicy(options: RoutePolicyOptions): RoutePolicy {
  const route = (head: RequestHead) =>
    classify(head, options.repository, options.profile, options.limits.targetBytes);
  const responsePolicy = createResponsePolicy(options, (head) => route(head) !== undefined);
  return Object.freeze({
    route,
    plan(head: RequestHead): RequestPlan | Denied {
      const selected = route(head);
      if (!selected) return deny();
      if (
        head.method === "GET" &&
        (head.framing.kind === "chunked" || (head.framing.bytes ?? 0) > 0)
      )
        return deny();
      const git = selected.kind !== "api";
      if (head.contentEncoding === "gzip" && (!git || head.method !== "POST")) return deny();
      const input =
        selected.kind === "git-push"
          ? options.limits.gitPushInputBytes
          : selected.kind === "git-fetch"
            ? options.limits.gitFetchInputBytes
            : selected.kind === "api"
              ? options.limits.apiInputBytes
              : 1;
      if ((head.framing.bytes ?? 0) > input)
        return Object.freeze({ kind: "denied", status: 413, code: "limit-exceeded" });
      const headers: Record<string, string> = {
        "user-agent": "openclaw-enterprise-repository-credentials",
        "accept-encoding": "identity",
      };
      if (git) {
        if (head.headers["git-protocol"] === "version=2") headers["git-protocol"] = "version=2";
        if (head.method === "POST") headers["content-type"] = head.headers["content-type"]!;
        headers.accept = head.headers.accept ?? "*/*";
      } else {
        headers.accept =
          selected.target === "/graphql" && head.headers.accept === nativeGraphqlAccept
            ? nativeGraphqlAccept
            : "application/vnd.github+json";
        headers["x-github-api-version"] = "2026-03-10";
        if (["POST", "PATCH"].includes(head.method)) headers["content-type"] = "application/json";
        if (head.headers["graphql-features"])
          headers["graphql-features"] = head.headers["graphql-features"];
      }
      return Object.freeze({
        origin: git ? options.gitOrigin : options.apiOrigin,
        method: head.method,
        target: selected.target,
        category: selected.kind,
        effect: selected.effect,
        requestHeaders: Object.freeze(headers),
        limits: Object.freeze({
          inputWireBytes: input,
          inputDecodedBytes: input,
          responseBytes: git ? options.limits.gitResponseBytes : options.limits.apiResponseBytes,
          totalMs: options.limits.exchangeMs,
          inputMs:
            selected.kind === "git-push" ? options.limits.exchangeMs : options.limits.inputMs,
          firstHeaderMs: options.limits.firstHeaderMs,
          stallMs: options.limits.stallMs,
          connectMs: options.limits.connectMs,
        }),
        responsePolicy: responsePolicy(git, selected.target),
      }) as RequestPlan;
    },
  });
}
