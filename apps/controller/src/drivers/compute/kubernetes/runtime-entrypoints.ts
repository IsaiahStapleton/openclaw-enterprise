export const GATEWAY_RUNTIME_ENTRYPOINT = String.raw`
const { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");

const runtimeAssetsDirectory = "/home/node/openclaw-runtime-assets";

function clearDirectoryContents(directory) {
  mkdirSync(directory, { recursive: true });
  for (const entry of readdirSync(directory)) {
    rmSync(join(directory, entry), { recursive: true, force: true });
  }
}

function publishImageTree(source, destination, required) {
  if (!existsSync(source)) {
    if (required) {
      throw new Error("Required runtime asset tree is missing: " + source);
    }
    clearDirectoryContents(destination);
    return;
  }
  if (!lstatSync(source).isDirectory()) {
    throw new Error("Runtime asset tree is not a directory: " + source);
  }
  if (required && readdirSync(source).length === 0) {
    throw new Error("Required runtime asset tree is empty: " + source);
  }
  mkdirSync(runtimeAssetsDirectory, { recursive: true });
  clearDirectoryContents(destination);
  cpSync(source, destination, { recursive: true });
}

function publishDedicatedGatewayRuntimeAssets() {
  publishImageTree("/app/skills", runtimeAssetsDirectory + "/bundled-skills", true);
  publishImageTree("/app/plugin-skills", runtimeAssetsDirectory + "/plugin-skills", false);
}

function forwardTermination(child) {
  let terminating = false;
  const forward = (signal) => {
    if (terminating) return;
    terminating = true;
    child.kill(signal);
    setTimeout(() => child.kill("SIGKILL"), 8_000).unref();
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
}

mkdirSync("/home/node/.openclaw", { recursive: true });
mkdirSync("/home/node/workspace", { recursive: true });
if (process.env.OPENCLAW_WORKSPACE_DIR !== undefined) {
  mkdirSync(process.env.OPENCLAW_WORKSPACE_DIR, { recursive: true });
  publishDedicatedGatewayRuntimeAssets();
}
delete process.env.OPENCLAW_LOG_LEVEL;
const child = spawn(
  "node",
  ["/app/openclaw.mjs", "gateway", "--port", process.env.OPENCLAW_GATEWAY_PORT],
  { stdio: "inherit" },
);
forwardTermination(child);
child.on("exit", (code, signal) => process.exit(code ?? (signal === "SIGTERM" ? 0 : 1)));
`;

export const AGENT_RUNTIME_ENTRYPOINT = String.raw`
const { createHash } = require("node:crypto");
const { mkdirSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");

mkdirSync(process.env.CODEX_HOME, { recursive: true });
mkdirSync("/home/node/workspace", { recursive: true });
const accessToken = process.env.CODEX_ACCESS_TOKEN;
const workspaceId = process.env.CODEX_CHATGPT_WORKSPACE_ID;
if (accessToken !== undefined && (!workspaceId || process.env.OPENAI_API_KEY !== undefined)) {
  throw new Error("Codex service-account authentication configuration is invalid.");
}
if (accessToken === undefined && workspaceId !== undefined) {
  throw new Error("Codex service-account authentication configuration is invalid.");
}
const loginArguments = accessToken === undefined
  ? ["login", "--with-api-key"]
  : [
      "-c",
      "cli_auth_credentials_store=file",
      "-c",
      "forced_chatgpt_workspace_id=" + JSON.stringify(workspaceId),
      "login",
      "--with-access-token",
    ];
const login = spawnSync("codex", loginArguments, {
  input: accessToken ?? process.env.OPENAI_API_KEY,
  encoding: "utf8",
  stdio: ["pipe", "ignore", "pipe"],
});
if (login.status !== 0) throw new Error("Codex model authentication initialization failed.");
delete process.env.CODEX_ACCESS_TOKEN;

function forwardTermination(child) {
  let terminating = false;
  const forward = (signal) => {
    if (terminating) return;
    terminating = true;
    child.kill(signal);
    setTimeout(() => child.kill("SIGKILL"), 8_000).unref();
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
}

const digest = createHash("sha256").update(process.env.APP_SERVER_TOKEN).digest("hex");
const child = spawn(
  "codex",
  [
    "-c",
    "otel.exporter=\"none\"",
    "-c",
    "otel.log_user_prompt=false",
    "app-server",
    "--listen",
    "ws://0.0.0.0:" + process.env.APP_SERVER_PORT,
    "--ws-auth",
    "capability-token",
    "--ws-token-sha256",
    digest,
  ],
  { stdio: "inherit", cwd: "/home/node/workspace" },
);
forwardTermination(child);
child.on("exit", (code, signal) => process.exit(code ?? (signal === "SIGTERM" ? 0 : 1)));
`;

// Check native readiness over Pod loopback: kubelet's node source can also be
// the trusted apiserver proxy source, but its probes have no forwarded headers.
export const GATEWAY_READINESS_ENTRYPOINT = String.raw`
const timeout = setTimeout(() => process.exit(1), 2_000);
const request = require("node:http").get(
  "http://127.0.0.1:" + process.env.OPENCLAW_GATEWAY_PORT + "/readyz",
  (response) => {
    response.resume();
    clearTimeout(timeout);
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);
request.on("error", () => process.exit(1));
`;

export const AGENT_READINESS_ENTRYPOINT = String.raw`
const timeout = setTimeout(() => process.exit(1), 2_000);
const socket = new WebSocket("ws://127.0.0.1:" + process.env.APP_SERVER_PORT, {
  headers: { Authorization: "Bearer " + process.env.APP_SERVER_TOKEN },
});
socket.addEventListener("open", () => {
  clearTimeout(timeout);
  socket.close();
  process.exit(0);
});
socket.addEventListener("error", () => process.exit(1));
`;
