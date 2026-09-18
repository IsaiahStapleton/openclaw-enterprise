import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const nodeRequire = createRequire(import.meta.url);
const OCC_DIFFS_DIGEST =
  "sha512-5VTDNEo7D3iOgRoL5C31JPTbA/EXQEFRuxOvLy67IMFmOajwroGsUMWeuKkmqzFbPNQxvn7GACDSr/5Vmpx3/g==";

function openClawRuntime(selection = {}) {
  return {
    manifest: {
      kind: "openclaw",
      selections: { "occ-plugin:diffs": { enabled: true, approvalMode: "always", ...selection } },
    },
  };
}

function runOpenClawRuntimeHelper(runtime, responses, options = {}) {
  const calls = options.calls ?? [];
  const files = new Map([
    [
      "/etc/openclaw/openclaw.json",
      JSON.stringify(
        options.baseConfig ?? {
          gateway: { port: 8080 },
          plugins: { installs: { keep: { source: "npm" } }, load: { paths: ["existing"] } },
          tools: { alsoAllow: ["existing-tool"] },
        },
      ),
    ],
  ]);
  const sandbox = {
    JSON,
    process: {
      env: { OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json", HOME: "/home/node" },
    },
    require(specifier) {
      if (specifier === "node:child_process") {
        return {
          spawnSync(command, args, options) {
            calls.push({ command, args, options });
            return responses.shift() ?? { status: 0, stdout: "", stderr: "" };
          },
        };
      }
      if (specifier === "node:fs") {
        return {
          mkdirSync() {},
          readFileSync(path) {
            if (!files.has(path)) {
              throw new Error(`Missing mocked file: ${path}`);
            }
            return files.get(path);
          },
          writeFileSync(path, data) {
            files.set(path, String(data));
          },
        };
      }
      return nodeRequire(specifier);
    },
  };
  vm.runInNewContext(
    `${PLUGIN_RUNTIME_HELPERS}
installOpenClawPlugins(${JSON.stringify(runtime)});`,
    sandbox,
  );
  return { calls, files };
}

function installedPluginResponses() {
  return [
    { status: 0, stdout: "", stderr: "" },
    { status: 0, stdout: JSON.stringify({ refreshed: true }), stderr: "" },
    {
      status: 0,
      stdout: JSON.stringify({
        plugin: {
          id: "diffs",
          version: "2026.8.2",
          rootDir: "/home/node/.openclaw/plugins/@openclaw/diffs",
        },
        install: {
          source: "npm",
          resolvedName: "@openclaw/diffs",
          resolvedVersion: "2026.8.2",
          installPath: "/home/node/.openclaw/plugins/@openclaw/diffs",
          integrity: OCC_DIFFS_DIGEST,
        },
      }),
      stderr: "",
    },
  ];
}

test("OpenClaw runtime helper installs exact admitted package pins and verifies the install record", async () => {
  const runtime = openClawRuntime();
  const { calls, files } = runOpenClawRuntimeHelper(runtime, installedPluginResponses());

  assert.deepEqual(JSON.parse(JSON.stringify(calls.map((call) => call.args))), [
    [
      "/app/openclaw.mjs",
      "plugins",
      "install",
      "@openclaw/diffs@2026.8.2",
      "--pin",
      "--force",
      "--no-enable",
    ],
    ["/app/openclaw.mjs", "plugins", "registry", "--refresh", "--json"],
    ["/app/openclaw.mjs", "plugins", "inspect", "diffs", "--json"],
  ]);

  const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  assert.equal(effective.gateway.port, 8080);
  assert.deepEqual(effective.plugins.installs.keep, { source: "npm" });
  assert.deepEqual(effective.plugins.load.paths, ["existing"]);
  assert.deepEqual(effective.plugins.entries, { diffs: { enabled: true } });
  assert.deepEqual(effective.tools.alsoAllow, ["existing-tool", "diffs"]);
});

test("OpenClaw runtime helper fails before readiness when raw Codex bridge config conflicts", () => {
  const runtime = {
    manifest: {
      kind: "codex",
      selections: {
        "codex-plugin:linear@openai-curated-remote": { enabled: true, approvalMode: "auto" },
      },
    },
  };

  assert.throws(
    () =>
      runOpenClawRuntimeHelper(runtime, [], {
        baseConfig: {
          gateway: { port: 8080 },
          plugins: {
            entries: {
              codex: {
                config: {
                  codexPlugins: {
                    enabled: true,
                    allow_all_plugins: false,
                    plugins: { google_calendar: { enabled: true } },
                  },
                },
              },
            },
          },
        },
      }),
    /Codex bridge configuration conflicts/,
  );
});

test("OpenClaw runtime helper fails before readiness when installed metadata drifts", async () => {
  const runtime = openClawRuntime();
  assert.throws(
    () =>
      runOpenClawRuntimeHelper(runtime, [
        { status: 0, stdout: "", stderr: "" },
        { status: 0, stdout: JSON.stringify({ refreshed: true }), stderr: "" },
        {
          status: 0,
          stdout: JSON.stringify({
            plugin: {
              id: "diffs",
              version: "2026.8.2",
              rootDir: "/home/node/.openclaw/plugins/@openclaw/diffs",
            },
            install: {
              source: "npm",
              resolvedName: "@openclaw/diffs",
              resolvedVersion: "2026.8.3",
              installPath: "/home/node/.openclaw/plugins/@openclaw/diffs",
              integrity: OCC_DIFFS_DIGEST,
            },
          }),
          stderr: "",
        },
      ]),
    /installed version does not match/,
  );
});

test("OpenClaw runtime helper fails before readiness when bundled metadata shadows the install", async () => {
  const runtime = openClawRuntime();
  assert.throws(
    () =>
      runOpenClawRuntimeHelper(runtime, [
        { status: 0, stdout: "", stderr: "" },
        { status: 0, stdout: JSON.stringify({ refreshed: true }), stderr: "" },
        {
          status: 0,
          stdout: JSON.stringify({
            plugin: {
              id: "diffs",
              version: "2026.8.2",
              rootDir: "/app/plugin-skills/diffs",
            },
            install: {
              source: "npm",
              resolvedName: "@openclaw/diffs",
              resolvedVersion: "2026.8.2",
              installPath: "/home/node/.openclaw/plugins/@openclaw/diffs",
              integrity: OCC_DIFFS_DIGEST,
            },
          }),
          stderr: "",
        },
      ]),
    /runtime root directory does not resolve inside the admitted install path/,
  );
});

for (const [name, tools, expected] of [
  [
    "explicit allowlist",
    { allow: ["read"], deny: ["exec"] },
    { allow: ["read", "diffs"], deny: ["exec"] },
  ],
  [
    "profile grants",
    { profile: "coding", alsoAllow: ["existing-tool"], deny: ["exec"] },
    { profile: "coding", alsoAllow: ["existing-tool", "diffs"], deny: ["exec"] },
  ],
  ["existing grant", { allow: ["read", "diffs"] }, { allow: ["read", "diffs"] }],
  ["empty allowlist", { allow: [] }, { allow: [], alsoAllow: ["diffs"] }],
]) {
  test(`OpenClaw startup composes plugin grants with ${name}`, () => {
    const { files } = runOpenClawRuntimeHelper(openClawRuntime(), installedPluginResponses(), {
      baseConfig: { tools },
    });
    const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
    assert.deepEqual(effective.tools, expected);
  });
}

for (const [field, plugins] of [
  ["plugins.enabled", { enabled: false }],
  ["plugins.deny", { deny: ["diffs"] }],
  ["plugins.allow", { allow: ["memory-core"] }],
  ["plugins.deny", { deny: [" Diffs "] }],
]) {
  test(`OpenClaw startup rejects blocked selection before installation: ${JSON.stringify(plugins)}`, () => {
    const calls = [];
    assert.throws(
      () =>
        runOpenClawRuntimeHelper(openClawRuntime(), installedPluginResponses(), {
          calls,
          baseConfig: { plugins },
        }),
      (error) =>
        error.message.includes("OpenClaw plugin configuration conflicts") &&
        error.message.includes(field),
    );
    assert.equal(calls.length, 0);
  });
}

for (const selection of [{ enabled: false }, { approvalMode: "never" }]) {
  test(`OpenClaw startup preserves restrictions for disabled selection: ${JSON.stringify(selection)}`, () => {
    const plugins = { allow: ["memory-core"], deny: ["diffs"], enabled: false };
    const { files, calls } = runOpenClawRuntimeHelper(
      openClawRuntime(selection),
      installedPluginResponses(),
      {
        baseConfig: { plugins },
      },
    );
    const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
    assert.deepEqual(effective.plugins, { ...plugins, entries: { diffs: { enabled: false } } });
    assert.ok(calls[0].args.includes("--no-enable"));
  });
}

test("OpenClaw startup rejects a blocked Codex bridge before readiness", () => {
  const runtime = {
    manifest: {
      kind: "codex",
      selections: {
        "codex-plugin:linear@openai-curated-remote": { enabled: true, approvalMode: "auto" },
      },
    },
  };
  const calls = [];
  assert.throws(
    () =>
      runOpenClawRuntimeHelper(runtime, [], {
        calls,
        baseConfig: { plugins: { deny: ["codex"] } },
      }),
    /OpenClaw plugin configuration conflicts.*codex.*plugins.deny/,
  );
  assert.equal(calls.length, 0);
});
