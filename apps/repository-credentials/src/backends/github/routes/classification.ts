import type { RequestHead } from "../../../driver-contracts.ts";
import type { GitHubProfile } from "../types.ts";

export type Route = Readonly<{
  kind: "git-discovery" | "git-fetch" | "git-push" | "api";
  effect: "read" | "write";
  target: string;
}>;
const resourceNumber = /^[1-9][0-9]{0,14}$/;
// Native gh 2.100.0 PR discovery and creation use this exact GraphQL media profile.
export const nativeGraphqlAccept =
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
interface ParsedTarget {
  readonly raw: string;
  readonly path: string;
  readonly query: string;
}

function parseTarget(raw: string, limit: number): ParsedTarget | undefined {
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
  return { raw, path, query };
}

function classifyGitRoute(
  head: RequestHead,
  target: ParsedTarget,
  repository: string,
  profile: GitHubProfile,
): Route | undefined {
  const { raw, path, query } = target;
  const git = `/${repository}.git/`;
  if (head.headers["git-protocol"] !== undefined && head.headers["git-protocol"] !== "version=2")
    return;
  if (
    path === `${git}info/refs` &&
    head.method === "GET" &&
    (query === "service=git-upload-pack" ||
      (profile !== "git-read" && query === "service=git-receive-pack"))
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
    profile !== "git-read" &&
    path === `${git}git-receive-pack` &&
    head.headers["content-type"] === "application/x-git-receive-pack-request"
  )
    return { kind: "git-push", effect: "write", target: raw };
  return;
}

interface ApiRoutePolicy {
  readonly methods: readonly string[];
  readonly queryParameters: readonly string[];
}

function matchApiRoute(path: string, repository: string): ApiRoutePolicy | undefined {
  const prefix = `/repos/${repository}`;
  if (path === prefix || path === "/meta") return { methods: ["GET"], queryParameters: [] };
  if (path === "/graphql") return { methods: ["POST"], queryParameters: [] };
  if (!path.startsWith(`${prefix}/`)) return;
  const parts = path.slice(prefix.length + 1).split("/");
  if (parts.length === 1 && (parts[0] === "pulls" || parts[0] === "issues"))
    return {
      methods: ["GET", "POST"],
      queryParameters:
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
            ],
    };
  if (
    parts.length === 2 &&
    (parts[0] === "pulls" || parts[0] === "issues") &&
    resourceNumber.test(parts[1]!)
  )
    return { methods: ["GET", "PATCH"], queryParameters: [] };
  if (
    parts.length === 3 &&
    parts[0] === "issues" &&
    resourceNumber.test(parts[1]!) &&
    parts[2] === "comments"
  )
    return { methods: ["GET", "POST"], queryParameters: ["page", "per_page", "since"] };
  if (
    parts.length === 3 &&
    parts[0] === "issues" &&
    parts[1] === "comments" &&
    resourceNumber.test(parts[2]!)
  )
    return { methods: ["GET", "PATCH", "DELETE"], queryParameters: [] };
  return;
}

function allowsQuery(method: string, query: string, parameters: readonly string[]): boolean {
  if (query) {
    if (method !== "GET") return false;
    const params = new URLSearchParams(query),
      seen = new Set<string>();
    for (const [name, value] of params) {
      if (seen.has(name) || !parameters.includes(name) || !queryValues[name]?.test(value))
        return false;
      seen.add(name);
    }
    if (!seen.size) return false;
  }
  return true;
}

function classifyApiRoute(
  head: RequestHead,
  target: ParsedTarget,
  repository: string,
): Route | undefined {
  const { raw, path, query } = target;
  const policy = matchApiRoute(path, repository);
  if (!policy || !policy.methods.includes(head.method)) return;
  if (!allowsQuery(head.method, query, policy.queryParameters)) return;
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

export function classifyRoute(
  head: RequestHead,
  policy: Readonly<{ repository: string; profile: GitHubProfile; targetBytes: number }>,
): Route | undefined {
  const target = parseTarget(head.rawTarget, policy.targetBytes);
  if (!target) return;
  if (target.path.startsWith(`/${policy.repository}.git/`))
    return classifyGitRoute(head, target, policy.repository, policy.profile);
  if (policy.profile !== "git-full" || head.contentEncoding !== "identity") return;
  return classifyApiRoute(head, target, policy.repository);
}
