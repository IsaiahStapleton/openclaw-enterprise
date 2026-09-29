import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import test from "node:test";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const socketRequire = createRequire(controllerRequire.resolve("@kubernetes/client-node"));
const { WebSocketServer } = socketRequire("ws");
const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
const selections = Object.fromEntries(
  names.map((name) => [
    `codex-plugin:${name}@openai-curated-remote`,
    {
      enabled: true,
      toolDefaults: { approval: "provider_default" },
    },
  ]),
);
const configuration = {
  plugins: {},
  features: { apps: true, plugins: true, remote_plugin: true },
  apps: {
    _default: { enabled: false },
    ...Object.fromEntries(
      names.map((name) => [name, { enabled: true, default_tools_approval_mode: "auto" }]),
    ),
  },
};

function summary(name, installed) {
  return {
    id: `${name}@openai-curated-remote`,
    remotePluginId: `plugin_${name}`,
    name,
    source: { type: "remote" },
    installed,
    enabled: installed,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_USE",
    availability: "AVAILABLE",
    version: "1.0.0",
    interface: null,
  };
}

for (const retry of [false, true]) {
  test(`generated Codex startup overlaps metadata reads and preserves policy ordering${retry ? " after a read failure" : ""}`, async (t) => {
    // The external app-server is a protocol fixture; the generated installer,
    // WebSocket client, request timers and child process are the production path.
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const events = [];
    const batches = [];
    let pending = [];
    let phaseReads = 0;
    let installed = false;
    let written = false;
    let attempts = 0;
    let outstanding = 0;
    let firstErrorDrained = !retry;
    const timers = [];
    t.after(() => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      for (const client of server.clients) {
        client.terminate();
      }
      server.close();
    });
    server.on("connection", (socket, request) => {
      assert.equal(request.headers.authorization, "Bearer startup-fixture-token");
      socket.on("message", (data) => {
        const { id, method, params } = JSON.parse(data.toString());
        if (method === "initialized") {
          return;
        }
        const send = (result) => socket.send(JSON.stringify({ id, result }));
        events.push(method);
        if (method === "initialize") {
          return send({});
        }
        if (method === "plugin/list") {
          assert.equal(outstanding, 0, "a retry must wait for every earlier read to settle");
          assert.equal(firstErrorDrained, attempts === 0 ? !retry : true);
          attempts += 1;
          phaseReads = 0;
          return send({
            marketplaces: [
              {
                name: "openai-curated-remote",
                path: null,
                interface: null,
                plugins: names.map((name) => summary(name, false)),
              },
            ],
            marketplaceLoadErrors: [],
            featuredPluginIds: [],
          });
        }
        if (method === "plugin/read") {
          const name = params.pluginName.slice("plugin_".length);
          assert.ok(names.includes(name));
          outstanding += 1;
          assert.ok(outstanding <= 4, "metadata concurrency must stay bounded");
          pending.push({ name, socket, id });
          // No timing threshold: a batch can complete only if its reads arrive.
          // Reverse replies prove that selection/detail correspondence survives.
          if (pending.length === Math.min(4, names.length - phaseReads)) {
            const batch = pending;
            pending = [];
            phaseReads = (phaseReads + batch.length) % names.length;
            batches.push(batch.map((item) => item.name));
            for (const [index, item] of batch.toReversed().entries()) {
              timers.push(
                setTimeout(
                  () => {
                    outstanding -= 1;
                    if (retry && attempts === 1 && index === 0) {
                      item.socket.send(
                        JSON.stringify({
                          id: item.id,
                          error: { code: -32000, message: "temporary metadata failure" },
                        }),
                      );
                    } else {
                      if (retry && attempts === 1) {
                        firstErrorDrained = true;
                      }
                      item.socket.send(
                        JSON.stringify({
                          id: item.id,
                          result: {
                            plugin: {
                              marketplaceName: "openai-curated-remote",
                              marketplacePath: null,
                              summary: summary(item.name, installed),
                              description: null,
                              skills: [],
                              apps: [{ id: item.name, name: item.name, needsAuth: false }],
                              appTemplates: [],
                              hooks: [],
                              mcpServers: [],
                              scheduledTasks: [],
                            },
                          },
                        }),
                      );
                    }
                  },
                  index === 0 ? 0 : 350,
                ),
              );
            }
          }
          return;
        }
        assert.equal(outstanding, 0, "writes and verification must follow complete read phases");
        if (method === "plugin/install") {
          installed = true;
          assert.equal(written, false);
          return send({ authPolicy: "ON_USE", appsNeedingAuth: [] });
        }
        if (method === "config/batchWrite") {
          assert.equal(installed, true);
          written = true;
          return send({ status: "ok" });
        }
        if (method === "config/read") {
          if (written) {
            assert.equal(batches.length, retry ? 5 : 4);
          }
          return send({ config: configuration });
        }
        assert.fail(`unexpected method ${method}`);
      });
    });
    const script = `${PLUGIN_RUNTIME_HELPERS}\ninstallCodexPlugins(${JSON.stringify({ manifest: { kind: "codex", selections } })})
      .then((value) => console.log(JSON.stringify(value)))
      .catch((error) => { console.error(error.message); process.exitCode = 1; });`;
    const child = spawn(process.execPath, ["-e", script], {
      env: {
        PATH: process.env.PATH,
        NODE_PATH: dirname(dirname(socketRequire.resolve("ws"))),
        APP_SERVER_PORT: String(server.address().port),
        APP_SERVER_TOKEN: "startup-fixture-token",
        OPENCLAW_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS: "1500",
        OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "5000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => child.kill("SIGKILL"));
    let output = "";
    let errors = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      errors += data;
    });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, errors);
    assert.deepEqual(JSON.parse(output), {
      successfulPluginIds: Object.keys(selections),
      failures: [],
    });
    assert.equal(attempts, retry ? 2 : 1);
    assert.equal(events.filter((method) => method === "plugin/install").length, names.length);
    assert.equal(events.at(-1), "config/read");
    assert.deepEqual(
      batches.map((batch) => batch.length),
      retry ? [4, 4, 2, 4, 2] : [4, 2, 4, 2],
    );
  });
}

// The regular protocol cases above own deterministic timing and write-order
// assertions. This opt-in case verifies the pinned external server contract.
test(
  "generated metadata reads and disabled-selection startup use a native Codex app-server",
  {
    skip: process.env.OCC_TEST_CODEX_STARTUP_READS_REAL !== "1",
    timeout: 180_000,
  },
  async (t) => {
    const runtimeImage = process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE;
    assert.match(
      runtimeImage ?? "",
      /(?:^sha256:|@sha256:)[a-f0-9]{64}$/,
      "an immutable native runtime image is required",
    );
    assert.ok(
      process.env.CODEX_ACCESS_TOKEN,
      "an explicitly authorized service-account token is required",
    );
    const { randomUUID } = await import("node:crypto");
    const name = `oce-native-startup-${randomUUID()}`;
    const child = spawn(
      "docker",
      ["run", "--rm", "-i", "--name", name, "--entrypoint", "node", runtimeImage],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    t.after(async () => {
      const cleanup = spawn("docker", ["rm", "--force", name], { stdio: "ignore" });
      await once(cleanup, "exit");
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      errors += data;
    });
    const nativeScript = `
const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const { once } = require("node:events");
process.env.CODEX_HOME = "/tmp/native-codex-proof";
process.env.APP_SERVER_PORT = "4500";
process.env.APP_SERVER_TOKEN = randomBytes(32).toString("hex");
process.env.OPENCLAW_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS = "30000";
process.env.OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS = "60000";
mkdirSync(process.env.CODEX_HOME, { recursive: true });
mkdirSync("/home/node/workspace", { recursive: true });
writeFileSync(process.env.CODEX_HOME + "/config.toml", '[features]\\napps = true\\nplugins = true\\nremote_plugin = true\\n'.replaceAll("\\\\n", "\\n"));
const version = spawnSync("codex", ["--version"], { encoding: "utf8" });
assert.equal(version.status, 0);
assert.equal(version.stdout.trim(), "codex-cli 0.156.0", "native proof is pinned to the reviewed runtime");
const login = spawnSync("codex", ["-c", "cli_auth_credentials_store=file", "login", "--with-access-token"], {
  input: ${JSON.stringify(process.env.CODEX_ACCESS_TOKEN)}, encoding: "utf8", timeout: 30000,
});
assert.equal(login.status, 0, "native service-account login must succeed");
const server = spawn("codex", ["-c", 'otel.exporter="none"', "app-server", "--listen", "ws://127.0.0.1:4500", "--ws-auth", "capability-token", "--ws-token-sha256", createHash("sha256").update(process.env.APP_SERVER_TOKEN).digest("hex")], {
  cwd: "/home/node/workspace", stdio: "ignore",
});
${PLUGIN_RUNTIME_HELPERS}
(async () => {
  try {
    let listed;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { listed = await codexAppServerRequest("plugin/list", {}); break; }
      catch { await pluginRuntimeDelay(250); }
    }
    assert.ok(listed, "native catalog must become available");
    const marketplace = listed.marketplaces.find((entry) => entry.name === "openai-curated-remote");
    assert.ok(marketplace, "native curated catalog is required");
    const candidates = marketplace.plugins.filter((entry) => typeof entry.remotePluginId === "string").slice(0, 6);
    assert.equal(candidates.length, 6, "native catalog must provide two bounded read batches");
    const params = candidates.map((entry) => ({ remoteMarketplaceName: marketplace.name, pluginName: entry.remotePluginId }));
    let outstanding = 0;
    let maximum = 0;
    const read = async (params) => {
      outstanding++;
      maximum = Math.max(maximum, outstanding);
      try { return await codexAppServerRequest("plugin/read", params); }
      finally { outstanding--; }
    };
    const details = await readCodexPluginDetails(params, read);
    assert.equal(maximum, 4);
    assert.equal(outstanding, 0);
    assert.deepEqual(details.map((detail) => detail.plugin.summary.remotePluginId), candidates.map((entry) => entry.remotePluginId));
    await assert.rejects(readCodexPluginDetails([
      { remoteMarketplaceName: marketplace.name, pluginName: "plugin_nonexistent_native_startup_proof" },
      ...params.slice(0, 3),
    ], read), (error) => error instanceof CodexAppServerRequestError && error.method === "plugin/read");
    assert.equal(outstanding, 0, "native error must drain the whole batch before retry");
    const recovered = await readCodexPluginDetails(params, read);
    assert.deepEqual(recovered.map((detail) => detail.plugin.summary.remotePluginId), candidates.map((entry) => entry.remotePluginId));
    const selections = Object.fromEntries(candidates.slice(0, 4).map((entry) => ["codex-plugin:" + entry.id, { enabled: false, toolDefaults: { approval: "provider_default" } }]));
    const result = await installCodexPlugins({ manifest: { kind: "codex", selections } });
    assert.deepEqual(result, { successfulPluginIds: [], failures: [] });
    const effective = await readCodexAppConfiguration();
    assert.equal(effective.apps._default.enabled, false);
    for (const detail of details.slice(0, 4)) {
      for (const app of detail.plugin.apps) {
        assert.equal(effective.apps[app.id]?.enabled ?? effective.apps._default.enabled, false,
          "disabled selections must not enable native app bindings");
      }
    }
    console.log(JSON.stringify({ version: version.stdout.trim(), nativeReadCount: params.length, maxOutstanding: maximum, drainedNativeError: true, recovered: true, disabledAppPolicy: true, disabledStartupSelections: Object.keys(selections).length }));
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
})().catch((error) => { console.error(error.name + ": " + error.message); process.exitCode = 1; });
`;
    child.stdin.end(nativeScript);
    const [code] = await once(child, "exit");
    assert.equal(code, 0, errors.replaceAll(process.env.CODEX_ACCESS_TOKEN, "[REDACTED]"));
    const receipt = JSON.parse(output.trim());
    assert.deepEqual(receipt, {
      version: "codex-cli 0.156.0",
      nativeReadCount: 6,
      maxOutstanding: 4,
      drainedNativeError: true,
      recovered: true,
      disabledAppPolicy: true,
      disabledStartupSelections: 4,
    });
    t.diagnostic(JSON.stringify(receipt));
  },
);
