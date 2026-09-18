import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, verify, createHash } from "node:crypto";

export const fixtureRepository = "fixture/repository";
export const fixtureRepositoryId = "73";
export const fixtureInstallationId = "41";
export const fixtureAppId = "12345";
export const humanText =
  "Keep https://api.github.com/repos/fixture/repository in this human-authored text.";

export function createGitHubProtocol({
  clock,
  tokenLifetimeMs = 3600000,
  tokenResponse = (packet) => packet,
  beforeIssueResponse,
  issueResponse = (response) => response,
  issueResponseGate,
}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const tokens = new Map();
  const issues = new Map();
  const pulls = new Map();
  const comments = new Map();
  const trace = [];
  const issuesOfTokens = [];
  const authenticationAttempts = [];
  const errors = [];
  let nextNumber = 1;
  let nextComment = 101;
  let disconnectMutation;
  const repo = {
    id: 73,
    node_id: "R_fixture",
    name: "repository",
    full_name: fixtureRepository,
    owner: { login: "fixture", id: 1, type: "Organization" },
    private: true,
    default_branch: "main",
    html_url: `https://github.com/${fixtureRepository}`,
    clone_url: `https://github.com/${fixtureRepository}.git`,
  };
  function tokenFrom(authorization) {
    if (authorization?.startsWith("Basic "))
      return Buffer.from(authorization.slice(6), "base64").toString().split(":").slice(1).join(":");
    return authorization?.replace(/^(Bearer|token) /, "");
  }
  function authorize(authorization, boundary = "api") {
    const token = tokens.get(tokenFrom(authorization));
    authenticationAttempts.push({ tokenIndex: token?.index, boundary });
    if (token) token.attempts++;
    if (!token || token.revoked || token.expires <= clock.wallNow()) return false;
    token.uses++;
    return true;
  }
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
      html_url: `https://github.com/${fixtureRepository}/pull/${number}`,
      url: `https://api.github.com/repos/${fixtureRepository}/pulls/${number}`,
      head: { ref: input.head ?? input.headRefName ?? "native-feature" },
      base: { ref: input.base ?? input.baseRefName ?? "main" },
      native,
    };
    pulls.set(number, pull);
    return pull;
  }
  const handleRequest = async (request, response) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error("fixture request limit");
        chunks.push(chunk);
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const url = new URL(request.url, "https://api.github.com");
      const entry = {
        method: request.method,
        target: request.url,
        userAgent: request.headers["user-agent"],
        apiVersion: request.headers["x-github-api-version"],
        graphQLFeatures: request.headers["graphql-features"],
        tokenIndex: tokens.get(tokenFrom(request.headers.authorization))?.index,
      };
      trace.push(entry);
      const json = (status, value, headers = {}) => {
        if (disconnectMutation === `${request.method} ${url.pathname}`) {
          disconnectMutation = undefined;
          response.destroy();
          return;
        }
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(value));
      };
      if (
        request.method === "POST" &&
        url.pathname === `/app/installations/${fixtureInstallationId}/access_tokens`
      ) {
        const jwt = tokenFrom(request.headers.authorization);
        const [header, payload, signature] = jwt.split(".");
        assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "RS256");
        assert.equal(
          verify(
            "sha256",
            Buffer.from(`${header}.${payload}`),
            publicKey,
            Buffer.from(signature, "base64url"),
          ),
          true,
        );
        const claims = JSON.parse(Buffer.from(payload, "base64url"));
        assert.equal(String(claims.iss), fixtureAppId);
        assert.ok(claims.iat <= clock.wallNow() / 1000);
        assert.ok(claims.exp > clock.wallNow() / 1000);
        assert.ok(claims.exp - claims.iat <= 600);
        assert.deepEqual(body.repository_ids.map(String), [fixtureRepositoryId]);
        const permissions = body.permissions;
        const acceptedPermissions = [
          { metadata: "read", contents: "read" },
          { metadata: "read", contents: "write" },
          { metadata: "read", contents: "write", pull_requests: "write", issues: "write" },
        ];
        assert.ok(
          acceptedPermissions.some(
            (allowed) =>
              Object.keys(permissions).length === Object.keys(allowed).length &&
              Object.entries(allowed).every(([name, value]) => permissions[name] === value),
          ),
          "issuance requires an exact supported permission map",
        );
        const token = `fixture_access_${randomBytes(24).toString("hex")}`;
        const expires = clock.wallNow() + tokenLifetimeMs;
        const index = tokens.size + 1;
        tokens.set(token, { index, expires, revoked: false, uses: 0, attempts: 0 });
        issuesOfTokens.push({
          index,
          jwtDigest: createHash("sha256").update(jwt).digest("hex"),
          claims,
          permissions: { ...permissions },
          repositoryIds: [...body.repository_ids],
          expires,
        });
        await beforeIssueResponse?.();
        await issueResponseGate?.();
        const issued = issueResponse({
          status: 201,
          body: tokenResponse({
            token,
            expires_at: new Date(expires).toISOString(),
            permissions,
            repository_selection: "selected",
            repositories: [repo],
          }),
        });
        json(issued.status, issued.body);
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/installation/token") {
        const token = tokens.get(tokenFrom(request.headers.authorization));
        assert.ok(token, "retirement uses an owned provider token");
        token.revoked = true;
        response.writeHead(204).end();
        return;
      }
      if (!authorize(request.headers.authorization)) {
        json(401, { message: "Unauthorized" });
        return;
      }
      if (url.pathname === "/graphql") {
        const query = body.query ?? "";
        entry.operation = query.includes("createPullRequest") ? "createPullRequest" : "query";
        if (query.includes("createPullRequest")) {
          const input = body.variables?.input ?? body.variables ?? {};
          const pull = issuePull(input, true);
          json(200, {
            data: {
              createPullRequest: {
                pullRequest: { id: pull.node_id, number: pull.number, url: pull.html_url },
              },
            },
          });
        } else {
          const repository = {
            id: "R_fixture",
            name: "repository",
            nameWithOwner: fixtureRepository,
            owner: { login: "fixture", __typename: "Organization" },
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
          json(200, {
            data: { repository, repo_000: repository, viewer: { login: "fixture-bot" } },
          });
        }
        return;
      }
      if (url.pathname === "/meta") {
        json(200, { installed_version: "github.com" });
        return;
      }
      const prefix = `/repos/${fixtureRepository}`;
      const suffix = url.pathname.slice(prefix.length);
      if (!url.pathname.startsWith(prefix)) {
        json(404, {});
        return;
      }
      if (!suffix && request.method === "GET") {
        json(200, repo);
        return;
      }
      if (suffix === "/pulls" && request.method === "POST") {
        json(201, issuePull(body));
        return;
      }
      if (suffix === "/pulls" && request.method === "GET") {
        const head = url.searchParams.get("head")?.split(":").slice(1).join(":");
        json(
          200,
          pageOf(
            [...pulls.values()].filter((pull) => !head || pull.head.ref === head),
            url,
          ),
        );
        return;
      }
      const pullMatch = /^\/pulls\/(\d+)$/.exec(suffix);
      if (pullMatch) {
        const pull = pulls.get(Number(pullMatch[1]));
        if (!pull) {
          json(404, {});
          return;
        }
        if (request.method === "PATCH") Object.assign(pull, body);
        json(200, pull);
        return;
      }
      if (suffix === "/issues" && request.method === "POST") {
        const number = nextNumber++;
        const issue = {
          ...body,
          number,
          id: number,
          state: "open",
          html_url: `https://github.com/${fixtureRepository}/issues/${number}`,
          url: `https://api.github.com/repos/${fixtureRepository}/issues/${number}`,
        };
        issues.set(number, issue);
        json(201, issue);
        return;
      }
      if (suffix === "/issues" && request.method === "GET") {
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
          next.pathname = `/repositories/${fixtureRepositoryId}/issues`;
          next.searchParams.set("after", cursor(selected.at(-1)));
          next.searchParams.set("page", String(page + 1));
          headers.link = `<${next}>; rel="next"`;
        }
        json(200, selected, headers);
        return;
      }
      const issueMatch = /^\/issues\/(\d+)$/.exec(suffix);
      if (issueMatch) {
        const issue = issues.get(Number(issueMatch[1]));
        if (!issue) {
          json(404, {});
          return;
        }
        if (request.method === "PATCH") Object.assign(issue, body);
        json(200, issue);
        return;
      }
      const collection = /^\/issues\/(\d+)\/comments$/.exec(suffix);
      if (collection) {
        const issue = Number(collection[1]);
        if (request.method === "POST") {
          const id = nextComment++;
          const comment = {
            id,
            body: body.body,
            issue,
            url: `https://api.github.com/repos/${fixtureRepository}/issues/comments/${id}`,
            html_url: `https://github.com/${fixtureRepository}/issues/${issue}#issuecomment-${id}`,
          };
          comments.set(id, comment);
          json(201, comment);
          return;
        }
        const values = [...comments.values()].filter((comment) => comment.issue === issue);
        const page = Number(url.searchParams.get("page") ?? 1);
        const size = Number(url.searchParams.get("per_page") ?? 1);
        const headers =
          values.length > page * size
            ? {
                link: `<https://api.github.com/repositories/${fixtureRepositoryId}${suffix}?page=${page + 1}&per_page=${size}>; rel="next"`,
              }
            : {};
        json(200, pageOf(values, url, 1), headers);
        return;
      }
      const item = /^\/issues\/comments\/(\d+)$/.exec(suffix);
      if (item) {
        const id = Number(item[1]);
        const comment = comments.get(id);
        if (!comment) {
          json(404, {});
          return;
        }
        if (request.method === "DELETE") {
          comments.delete(id);
          if (disconnectMutation === `${request.method} ${url.pathname}`) {
            disconnectMutation = undefined;
            response.destroy();
            return;
          }
          response.writeHead(204).end();
          return;
        }
        if (request.method === "PATCH") comment.body = body.body;
        json(200, comment);
        return;
      }
      json(404, { message: "Fixture endpoint not implemented" });
    } catch (error) {
      // Keep failure evidence safe: assertion values may include signing input.
      errors.push(error.name);
      response.destroy();
    }
  };
  return {
    handleRequest,
    clock,
    privateKey,
    publicKey,
    trace,
    issuesOfTokens,
    authenticationAttempts,
    issues,
    pulls,
    comments,
    errors,
    authorize,
    tokenState: () => [...tokens.values()].map((token) => ({ ...token })),
    disconnectAfterMutation(method, target) {
      disconnectMutation = `${method} ${target}`;
    },
  };
}
