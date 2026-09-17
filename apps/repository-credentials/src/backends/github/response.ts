import type { HeaderFields, RequestHead, ResponsePolicy } from "../../contracts.ts";

interface ResponsePolicyOptions {
  readonly repository: string;
  readonly apiOrigin: string;
  readonly gatewayOrigin: string;
}

const issueUrl = /^\/issues\/[1-9][0-9]{0,14}$/;
const pullUrl = /^\/pulls\/[1-9][0-9]{0,14}$/;
const commentsUrl = /^\/issues\/[1-9][0-9]{0,14}\/comments$/;
const commentUrl = /^\/issues\/comments\/[1-9][0-9]{0,14}$/;
type LinkFields = Readonly<Record<string, RegExp>>;

export function createResponsePolicy(
  options: ResponsePolicyOptions,
  allowsRoute: (head: RequestHead) => boolean,
): (git: boolean, target: string) => ResponsePolicy {
  const prefix = `/repos/${options.repository}`;
  function rewriteUrl(value: string, purpose?: RegExp): string {
    const url = new URL(value);
    if (
      (url.origin !== options.apiOrigin && url.origin !== "https://api.github.com") ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("unsafe-upstream-url");
    if (
      purpose &&
      (!url.pathname.startsWith(prefix) || !purpose.test(url.pathname.slice(prefix.length)))
    )
      throw new Error("unsafe-upstream-url");
    const target = `${url.pathname}${url.search}`;
    if (
      !allowsRoute({
        method: "GET",
        rawTarget: target,
        headers: {},
        receivedMonoMs: 0,
        contentEncoding: "identity",
        framing: { kind: "none", bytes: undefined },
      })
    )
      throw new Error("unsafe-upstream-url");
    return `${options.gatewayOrigin}${target}`;
  }
  function rewriteRecord(value: unknown, fields: LinkFields): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const result: Record<string, unknown> = { ...value };
    for (const [field, purpose] of Object.entries(fields)) {
      const item = result[field];
      if (typeof item === "string") result[field] = rewriteUrl(item, purpose);
    }
    return result;
  }
  return (git: boolean, target: string): ResponsePolicy => {
    const path = target.split("?", 1)[0]!;
    const suffix = path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
    const issue = suffix === "/issues" || (suffix !== undefined && issueUrl.test(suffix));
    let fields: LinkFields = {};
    if (suffix === "") fields = { url: /^$/ };
    else if (issue) fields = { url: issueUrl, comments_url: commentsUrl };
    else if (suffix === "/pulls" || (suffix !== undefined && pullUrl.test(suffix)))
      fields = { url: pullUrl, comments_url: commentsUrl, issue_url: issueUrl };
    else if (suffix !== undefined && (commentsUrl.test(suffix) || commentUrl.test(suffix)))
      fields = { url: commentUrl, issue_url: issueUrl };
    function rewriteItem(value: unknown): unknown {
      const result = rewriteRecord(value, fields);
      if (issue && result && typeof result === "object" && !Array.isArray(result)) {
        const record = result as Record<string, unknown>;
        if (record.pull_request !== undefined)
          record.pull_request = rewriteRecord(record.pull_request, { url: pullUrl });
      }
      return result;
    }
    return Object.freeze({
      body: git ? "stream" : "bounded-json",
      // Only qualified REST resource fields are followed. Nested labels, milestones,
      // repository metadata and GraphQL fields remain application data.
      rewriteJson: git
        ? undefined
        : (value: unknown) => (Array.isArray(value) ? value.map(rewriteItem) : rewriteItem(value)),
      headers(status: number, headers: HeaderFields): HeaderFields {
        if (status >= 300 && status < 400) throw new Error("upstream-redirect");
        const output: Record<string, string> = {};
        for (const name of [
          "content-type",
          "cache-control",
          "expires",
          "pragma",
          "x-ratelimit-limit",
          "x-ratelimit-remaining",
          "x-ratelimit-reset",
          "x-ratelimit-used",
          "x-ratelimit-resource",
        ]) {
          const value = headers[name];
          if (value !== undefined && value.length <= 2048 && !/[\r\n]/.test(value))
            output[name] = value;
        }
        const retry = headers["retry-after"];
        if (retry !== undefined && /^[0-9]{1,10}$/.test(retry)) output["retry-after"] = retry;
        const link = headers.link;
        if (link !== undefined) {
          if (git || link.length > 8192) throw new Error("unsafe-upstream-url");
          output.link = link
            .split(",")
            .map((part) => {
              const match = /^\s*<([^<>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
              if (!match) throw new Error("unsafe-upstream-url");
              return `<${rewriteUrl(match[1]!)}>; rel="${match[2]}"`;
            })
            .join(", ");
        }
        return Object.freeze(output);
      },
    });
  };
}
