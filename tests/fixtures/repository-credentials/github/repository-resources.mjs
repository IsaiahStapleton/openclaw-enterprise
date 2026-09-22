import assert from "node:assert/strict";
import { fixtureRepository, fixtureRepositoryId } from "./metadata.mjs";

const json = (status, body, headers = {}) => ({ status, body, headers });

export function createRepositoryResources({
  repository = fixtureRepository,
  repositoryId = fixtureRepositoryId,
} = {}) {
  const [owner, name] = repository.split("/");
  const issues = new Map();
  const pulls = new Map();
  const comments = new Map();
  let nextNumber = 1;
  let nextComment = 101;
  const repo = {
    id: Number(repositoryId),
    node_id: repositoryId === fixtureRepositoryId ? "R_fixture" : `R_fixture_${repositoryId}`,
    name,
    full_name: repository,
    owner: { login: owner, id: 1, type: "Organization" },
    private: true,
    default_branch: "main",
    html_url: `https://github.com/${repository}`,
    clone_url: `https://github.com/${repository}.git`,
  };
  function pageOf(values, url, defaultSize = 100) {
    const size = Number(url.searchParams.get("per_page") ?? defaultSize);
    const page = Number(url.searchParams.get("page") ?? 1);
    return values.slice((page - 1) * size, page * size);
  }
  function issuePull(input, native = false) {
    const number = nextNumber++;
    const pull = {
      id: number,
      node_id: `PR_${number}`,
      number,
      state: "open",
      title: input.title,
      body: input.body ?? "",
      html_url: `https://github.com/${repository}/pull/${number}`,
      url: `https://api.github.com/repos/${repository}/pulls/${number}`,
      head: { ref: input.head ?? input.headRefName ?? "native-feature" },
      base: { ref: input.base ?? input.baseRefName ?? "main" },
      native,
    };
    pulls.set(number, pull);
    return pull;
  }
  function dispatch({ method, url, body }) {
    if (url.pathname === "/graphql") {
      const query = body.query ?? "";
      if (query.includes("createPullRequest")) {
        const input = body.variables?.input ?? body.variables ?? {};
        const pull = issuePull(input, true);
        return json(200, {
          data: {
            createPullRequest: {
              pullRequest: { id: pull.node_id, number: pull.number, url: pull.html_url },
            },
          },
        });
      }
      const graphRepository = {
        id: repo.node_id,
        name: repo.name,
        nameWithOwner: repository,
        owner: { login: owner, __typename: "Organization" },
        isPrivate: true,
        isFork: false,
        hasIssuesEnabled: true,
        hasWikiEnabled: false,
        viewerPermission: "WRITE",
        defaultBranchRef: { name: "main" },
        parent: null,
        mergeCommitAllowed: true,
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
        pullRequests: { nodes: [], totalCount: 0 },
        ref: { name: "native-feature", target: { oid: "a".repeat(40) } },
      };
      return json(200, {
        data: {
          repository: graphRepository,
          repo_000: graphRepository,
          viewer: { login: "fixture-bot" },
        },
      });
    }
    if (url.pathname === "/meta") {
      return json(200, { installed_version: "github.com" });
    }
    const prefix = `/repos/${repository}`;
    const suffix = url.pathname.slice(prefix.length);
    if (!url.pathname.startsWith(prefix)) {
      return json(404, {});
    }
    if (!suffix && method === "GET") {
      return json(200, repo);
    }
    if (suffix === "/pulls" && method === "POST") {
      return json(201, issuePull(body));
    }
    if (suffix === "/pulls" && method === "GET") {
      const head = url.searchParams.get("head")?.split(":").slice(1).join(":");
      return json(
        200,
        pageOf(
          [...pulls.values()].filter((pull) => !head || pull.head.ref === head),
          url,
        ),
      );
    }
    const pullMatch = /^\/pulls\/(\d+)$/.exec(suffix);
    if (pullMatch) {
      const pull = pulls.get(Number(pullMatch[1]));
      if (!pull) {
        return json(404, {});
      }
      if (method === "PATCH") {
        Object.assign(pull, body);
      }
      return json(200, pull);
    }
    if (suffix === "/issues" && method === "POST") {
      const number = nextNumber++;
      const issue = {
        ...body,
        number,
        id: number,
        state: "open",
        html_url: `https://github.com/${repository}/issues/${number}`,
        url: `https://api.github.com/repos/${repository}/issues/${number}`,
      };
      issues.set(number, issue);
      return json(201, issue);
    }
    if (suffix === "/issues" && method === "GET") {
      const values = [...issues.values()];
      const size = Number(url.searchParams.get("per_page") ?? 100);
      const page = Number(url.searchParams.get("page") ?? 1);
      const cursor = (issue) => Buffer.from(`cursor:v2:${issue.id}`).toString("base64");
      const after = url.searchParams.get("after");
      const index = after ? values.findIndex((issue) => cursor(issue) === after) : -1;
      assert.ok(!after || index >= 0, "pagination must preserve the issued cursor");
      const offset = after ? index + 1 : (page - 1) * size;
      const selected = values.slice(offset, offset + size);
      const headers = {};
      if (offset + size < values.length) {
        const next = new URL(url);
        next.pathname = `/repositories/${repositoryId}/issues`;
        next.searchParams.set("after", cursor(selected.at(-1)));
        next.searchParams.set("page", String(page + 1));
        headers.link = `<${next}>; rel="next"`;
      }
      return json(200, selected, headers);
    }
    const issueMatch = /^\/issues\/(\d+)$/.exec(suffix);
    if (issueMatch) {
      const issue = issues.get(Number(issueMatch[1]));
      if (!issue) {
        return json(404, {});
      }
      if (method === "PATCH") {
        Object.assign(issue, body);
      }
      return json(200, issue);
    }
    const collection = /^\/issues\/(\d+)\/comments$/.exec(suffix);
    if (collection) {
      const issue = Number(collection[1]);
      if (method === "POST") {
        const id = nextComment++;
        const comment = {
          id,
          body: body.body,
          issue,
          url: `https://api.github.com/repos/${repository}/issues/comments/${id}`,
          html_url: `https://github.com/${repository}/issues/${issue}#issuecomment-${id}`,
        };
        comments.set(id, comment);
        return json(201, comment);
      }
      const values = [...comments.values()].filter((comment) => comment.issue === issue);
      const page = Number(url.searchParams.get("page") ?? 1);
      const size = Number(url.searchParams.get("per_page") ?? 1);
      const headers =
        values.length > page * size
          ? {
              link: `<https://api.github.com/repositories/${repositoryId}${suffix}?page=${page + 1}&per_page=${size}>; rel="next"`,
            }
          : {};
      return json(200, pageOf(values, url, 1), headers);
    }
    const item = /^\/issues\/comments\/(\d+)$/.exec(suffix);
    if (item) {
      const id = Number(item[1]);
      const comment = comments.get(id);
      if (!comment) {
        return json(404, {});
      }
      if (method === "DELETE") {
        comments.delete(id);
        return { status: 204 };
      }
      if (method === "PATCH") {
        comment.body = body.body;
      }
      return json(200, comment);
    }
    return json(404, { message: "Fixture endpoint not implemented" });
  }
  return { repo, issues, pulls, comments, dispatch };
}
