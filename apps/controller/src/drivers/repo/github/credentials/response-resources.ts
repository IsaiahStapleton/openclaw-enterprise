import type { JsonObject, JsonValue } from "../../credentials/json-value.ts";

type ResourceKind = "repository" | "issue" | "pull" | "comment" | "other";
type LinkFields = Readonly<Record<string, RegExp>>;

interface ResourceRewriteDependencies {
  readonly rewriteUrl: (value: string, purpose?: RegExp) => string;
}

const issueUrl = /^\/issues\/[1-9][0-9]{0,14}$/;
const pullUrl = /^\/pulls\/[1-9][0-9]{0,14}$/;
const commentsUrl = /^\/issues\/[1-9][0-9]{0,14}\/comments$/;
const commentUrl = /^\/issues\/comments\/[1-9][0-9]{0,14}$/;
const resourceFields: Readonly<Record<ResourceKind, LinkFields>> = {
  repository: { url: /^$/ },
  issue: { url: issueUrl, comments_url: commentsUrl },
  pull: { url: pullUrl, comments_url: commentsUrl, issue_url: issueUrl },
  comment: { url: commentUrl, issue_url: issueUrl },
  other: {},
};

export function classifyResource(repository: string, target: string): ResourceKind {
  const prefix = `/repos/${repository}`;
  const path = target.split("?", 1)[0]!;
  if (!path.startsWith(prefix)) {
    return "other";
  }
  const suffix = path.slice(prefix.length);
  if (suffix === "") {
    return "repository";
  }
  if (suffix === "/issues" || issueUrl.test(suffix)) {
    return "issue";
  }
  if (suffix === "/pulls" || pullUrl.test(suffix)) {
    return "pull";
  }
  if (commentsUrl.test(suffix) || commentUrl.test(suffix)) {
    return "comment";
  }
  return "other";
}

function rewriteRecord(
  value: JsonObject,
  fields: LinkFields,
  dependencies: ResourceRewriteDependencies,
): JsonObject {
  const result: JsonObject = { ...value };
  for (const [field, purpose] of Object.entries(fields)) {
    const item = result[field];
    if (typeof item === "string") {
      result[field] = dependencies.rewriteUrl(item, purpose);
    }
  }
  return result;
}

function rewriteItem(
  resource: ResourceKind,
  value: JsonValue,
  dependencies: ResourceRewriteDependencies,
): JsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const result = rewriteRecord(value, resourceFields[resource], dependencies);
  const pullRequest = result.pull_request;
  if (
    resource === "issue" &&
    pullRequest !== undefined &&
    pullRequest !== null &&
    typeof pullRequest === "object" &&
    !Array.isArray(pullRequest)
  ) {
    result.pull_request = rewriteRecord(pullRequest, { url: pullUrl }, dependencies);
  }
  return result;
}

/** Only qualified resource links are followed; other nested and human data stays intact. */
export function createResourceRewriter(
  resource: ResourceKind,
  dependencies: ResourceRewriteDependencies,
): (value: JsonValue) => JsonValue {
  return (value) =>
    Array.isArray(value)
      ? value.map((item) => rewriteItem(resource, item, dependencies))
      : rewriteItem(resource, value, dependencies);
}
