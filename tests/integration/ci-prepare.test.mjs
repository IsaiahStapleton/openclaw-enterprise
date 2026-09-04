import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const preparePath = join(repositoryRoot, "scripts/ci/prepare.mjs");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ci-prepare-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  return root;
}

async function writeState(path, state) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function runPrepare(args, env = {}) {
  return spawnSync(process.execPath, [preparePath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const digest = "a".repeat(64);
const immutableImage = `registry.example/openclaw/runtime@sha256:${digest}`;
const mutableImage = "registry.example/openclaw/runtime:latest";

test("prepareLane fails closed instead of overwriting an existing CI state file", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state.json");
  const state = {
    version: 1,
    repositoryRoot,
    lane: "postgres",
    prefix: "openclaw-ci-local-existing-state",
    statePath,
    resources: [
      {
        id: "resource-1",
        kind: "compose-postgres",
        owner: "openclaw-ci-local-existing-state",
        name: "openclaw_ci_pg_existing_state_abcdef123456",
        composeFile: join(repositoryRoot, "compose.postgres.yaml"),
        port: 51234,
      },
    ],
  };
  await writeState(statePath, state);

  const result = runPrepare(["--lane", "helper-timeout", "--state", statePath]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /CI state already exists/);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
});

test("prepareLane rejects mutable Kubernetes image inputs before creating state", async (t) => {
  const root = await fixture(t);
  const caCertPath = join(root, "ca.crt");
  const caKeyPath = join(root, "ca.key");
  const adminKeyPath = join(root, "admin.key");
  await writeFile(caCertPath, "certificate\n", { mode: 0o600 });
  await chmod(caCertPath, 0o600);
  await writeFile(caKeyPath, "private key\n", { mode: 0o600 });
  await chmod(caKeyPath, 0o600);
  await writeFile(adminKeyPath, "admin key\n", { mode: 0o600 });
  await chmod(adminKeyPath, 0o600);

  const optionalKubernetesImages = {
    OCC_TEST_KUBERNETES_GATEWAY_IMAGE: "",
    OCC_TEST_KUBERNETES_AGENT_IMAGE: "",
    OCC_TEST_KUBERNETES_RUNTIME_IMAGE: "",
    OCC_TEST_KUBERNETES_CODEX_IMAGE: "",
  };
  const baseModelEnv = {
    OPENAI_API_KEY: "test-openai-key",
    OCC_TEST_OPENAI_MODEL: "gpt-test",
  };
  const k3dImages = {
    OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
    OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
  };
  const cases = [
    {
      lane: "k3d-model",
      envName: "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
      env: {
        ...baseModelEnv,
        ...optionalKubernetesImages,
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
      },
    },
    {
      lane: "k3d-otel",
      envName: "OCC_TEST_KUBERNETES_AGENT_IMAGE",
      env: {
        ...baseModelEnv,
        ...optionalKubernetesImages,
        OCC_TEST_OTEL_LOGS_URL: "http://127.0.0.1:4318/v1/logs",
        OCC_TEST_KUBERNETES_AGENT_IMAGE: mutableImage,
      },
    },
    {
      lane: "gateway-routing",
      envName: "OCC_TEST_KUBERNETES_AGENT_IMAGE",
      env: {
        ...baseModelEnv,
        ...k3dImages,
        OCC_TEST_KUBERNETES_AGENT_IMAGE: mutableImage,
        OCC_TEST_GATEWAY_CA_CERT_PATH: caCertPath,
        OCC_TEST_GATEWAY_CA_KEY_PATH: caKeyPath,
      },
    },
    {
      lane: "slack",
      envName: "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
      env: {
        ...baseModelEnv,
        ...k3dImages,
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
        OCC_TEST_SLACK_PROXY_URL: "http://127.0.0.1:3000",
        OCC_TEST_SLACK_CHANNEL_ID: "C0123456789",
        OCC_TEST_SLACK_SENDER_BOT_TOKEN: "xoxb-sender",
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
      },
    },
    {
      lane: "provider-account",
      envName: "OCC_TEST_KUBERNETES_AGENT_IMAGE",
      env: {
        ...k3dImages,
        OCC_TEST_KUBERNETES_AGENT_IMAGE: mutableImage,
        OCC_TEST_OPENAI_MODEL: "gpt-test",
        OCC_TEST_CHATGPT_WORKSPACE_ID: "workspace-test",
        OCC_TEST_CHATGPT_ADMIN_KEY_PATH: adminKeyPath,
      },
    },
    {
      lane: "openshell",
      envName: "OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE",
      env: {
        ...baseModelEnv,
        ...k3dImages,
        OCC_TEST_OPENSHELL_CLI: "openshell",
        OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: mutableImage,
        OCC_TEST_OPENSHELL_HELM: "helm",
        OCC_TEST_OPENSHELL_HELM_CHART: "openshell-chart",
        OCC_TEST_OPENSHELL_RUNTIME_CLASS: "runc",
      },
    },
    {
      lane: "openshell",
      envName: "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
      env: {
        ...baseModelEnv,
        ...k3dImages,
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
        OCC_TEST_OPENSHELL_CLI: "openshell",
        OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_HELM: "helm",
        OCC_TEST_OPENSHELL_HELM_CHART: "openshell-chart",
        OCC_TEST_OPENSHELL_RUNTIME_CLASS: "runc",
      },
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const statePath = join(root, `state-${index}.json`);
    const result = runPrepare(["--lane", testCase.lane, "--state", statePath], testCase.env);

    assert.equal(result.status, 1, `${testCase.lane} unexpectedly passed`);
    assert.match(result.stderr, new RegExp(`${testCase.envName} must be an immutable`));
    await assert.rejects(() => stat(statePath), { code: "ENOENT" });
  }
});
