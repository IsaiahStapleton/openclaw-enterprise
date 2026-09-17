import { createServer, request } from "node:https";
import { lstat, readFile, writeFile, rename } from "node:fs/promises";
import { startGitHubFixture } from "../repository-credentials/github.mjs";
import { startGitSmartHttpFixture } from "../repository-credentials/git.mjs";

// Only this trusted fixture container sees provider material. The production
// service still uses its fixed HTTPS origins and verifies their certificates.
const cleanup = [];
const context = { after: (callback) => cleanup.push(callback) };
const tls = {
  key: await readFile("/inputs/tls.key"),
  cert: await readFile("/inputs/tls.crt"),
  ca: await readFile("/inputs/tls.crt"),
};
const secrets = [];
const github = await startGitHubFixture(context, {
  tls,
  clock: { wallNow: () => Date.now() },
  async beforeIssueResponse() {
    await writeFile("/state/issuing", "ready", { mode: 0o600 });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        await lstat("/state/release-issue");
        return;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("fixture-issue-gate-timeout");
  },
  tokenResponse(packet) {
    secrets.push(packet.token);
    return packet;
  },
});
const pem = github.privateKey.export({ type: "pkcs8", format: "pem" });
secrets.push(pem, pem.split("\n")[1], tls.key.toString().split("\n")[1]);
await writeFile("/inputs/app.pem", pem, { mode: 0o600 });
const git = await startGitSmartHttpFixture(context, { tls, authorize: github.authorize });
const relayErrors = [];
const sockets = new Set();
const relay = createServer(tls, (incoming, outgoing) => {
  const host = incoming.headers.host;
  const origin =
    host === "api.github.com" ? github.origin : host === "github.com" ? git.origin : undefined;
  if (!origin) {
    outgoing.writeHead(421).end();
    return;
  }
  // Include actual JWT and encoded Git authorization in the trusted comparison,
  // so the probe covers more than plaintext installation-token serialization.
  const authorization = incoming.headers.authorization;
  if (authorization) {
    for (const value of [authorization, authorization.slice(authorization.indexOf(" ") + 1)]) {
      if (!secrets.includes(value)) secrets.push(value);
    }
  }
  const upstream = request(
    new URL(incoming.url, origin),
    {
      method: incoming.method,
      headers: incoming.headers,
      ca: tls.ca,
      rejectUnauthorized: true,
      agent: false,
    },
    (response) => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
      response.once("error", () => outgoing.destroy());
    },
  );
  upstream.setTimeout(10000, () => upstream.destroy());
  upstream.once("error", () => {
    relayErrors.push("upstream-failed");
    outgoing.destroy();
  });
  incoming.once("aborted", () => upstream.destroy());
  incoming.pipe(upstream);
});
relay.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
await new Promise((resolve, reject) => {
  relay.once("error", reject);
  relay.listen(443, "0.0.0.0", resolve);
});

let writing = false;
async function snapshot() {
  if (writing) return;
  writing = true;
  try {
    const report = {
      ready: true,
      issues: github.issuesOfTokens,
      tokens: github.tokenState(),
      apiTrace: github.trace,
      gitTrace: git.trace,
      errors: [...github.errors, ...relayErrors],
      pushedRef: await git.ref("refs/heads/isolation-feature").catch(() => null),
    };
    for (const [name, value] of [
      ["secrets", secrets],
      ["report", report],
    ]) {
      await writeFile(`/state/${name}.tmp`, JSON.stringify(value), { mode: 0o600 });
      await rename(`/state/${name}.tmp`, `/state/${name}.json`);
    }
  } finally {
    writing = false;
  }
}
await snapshot();
const timer = setInterval(
  () =>
    void snapshot().catch(() => {
      process.stderr.write("provider-snapshot-failed\n");
      process.exitCode = 1;
    }),
  100,
);
process.once("SIGTERM", async () => {
  clearInterval(timer);
  const guard = setTimeout(() => process.exit(1), 3000);
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => relay.close(resolve));
  for (const callback of cleanup.reverse()) await callback();
  clearTimeout(guard);
  process.exit(0);
});
