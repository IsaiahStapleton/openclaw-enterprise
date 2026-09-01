import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadWorkspaceFilesAccess } from "../../apps/controller/src/composition/workspace-files.ts";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";

const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
const agentId = "agt_00000000-0000-4000-8000-000000000001";
const otherNamespaceId = "ns_00000000-0000-4000-8000-000000000002";
const otherAgentId = "agt_00000000-0000-4000-8000-000000000002";

async function yamlPath(t, basename, value) {
  const directory = await mkdtemp(join(tmpdir(), "occ-workspace-files-config-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, basename);
  // JSON is valid YAML and exercises the same Kubernetes SDK parser as server startup.
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

async function rawYamlPath(t, basename, contents) {
  const directory = await mkdtemp(join(tmpdir(), "occ-workspace-files-config-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, basename);
  await writeFile(path, contents, "utf8");
  return path;
}

function endpoint(overrides = {}) {
  return {
    namespaceId,
    agentId,
    url: "wss://gateway.example/openclaw",
    nativeAgentId: "native-agent-1",
    identity: "occ-workspace-files",
    userHeader: "x-openclaw-operator",
    ...overrides,
  };
}

function revision(overrides = {}) {
  return {
    id: "rev_00000000-0000-4000-8000-000000000001",
    namespaceId,
    agentId,
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {},
    harness: { id: "test-harness", version: "1.0.0", mode: "embedded" },
    compute: { id: "compute-test", implementation: "deterministic-test" },
    servicePrincipalId: "sp-workspace-files",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function readRequest(overrides = {}) {
  return {
    revision: revision(overrides.revision),
    filename: "AGENTS.md",
    clientAddress: "127.0.0.1",
    signal: new AbortController().signal,
    deadline: new Date(Date.now() + 1_000),
  };
}

async function load(t, configuration) {
  return loadWorkspaceFilesAccess(await yamlPath(t, "workspace-files.yaml", configuration));
}

test("workspace-files endpoint configuration requires an absolute YAML path", async () => {
  await assert.rejects(
    loadWorkspaceFilesAccess("workspace-files.yaml"),
    /OCC_WORKSPACE_FILES_CONFIG_PATH|absolute/i,
  );
});

test("workspace-files endpoint configuration rejects unavailable and malformed YAML", async (t) => {
  await assert.rejects(
    loadWorkspaceFilesAccess(join(tmpdir(), "missing-workspace-files.yaml")),
    /unavailable/i,
  );
  await assert.rejects(
    loadWorkspaceFilesAccess(await rawYamlPath(t, "workspace-files.yaml", "endpoints: [")),
    /valid YAML/i,
  );
});

test("workspace-files endpoint configuration loads one exact Agent access map", async (t) => {
  const access = await load(t, { endpoints: [endpoint()] });

  assert.equal(typeof access.read, "function");
  assert.equal(typeof access.write, "function");

  // The configured tuple is exact; sibling and cross-Namespace Agents fail closed
  // before the native gateway client can select a fallback target.
  assert.deepEqual(
    await access.read(readRequest({ revision: revision({ namespaceId: otherNamespaceId }) })),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await access.read(readRequest({ revision: revision({ agentId: otherAgentId }) })),
    { status: "unavailable" },
  );
});

test("workspace-files endpoint configuration rejects malformed endpoint files", async (t) => {
  for (const [configuration, expected] of [
    [{}, /endpoints|schema/i],
    [{ endpoints: [], extra: true }, /endpoints|schema/i],
    [{ endpoints: {} }, /endpoints|schema/i],
    [{ endpoints: [endpoint({ unexpected: true })] }, /unsupported|unknown|schema/i],
    [{ endpoints: [endpoint({ namespaceId: "" })] }, /namespaceId|schema/i],
    [{ endpoints: [endpoint({ agentId: "" })] }, /agentId|schema/i],
    [{ endpoints: [endpoint({ url: "" })] }, /url|schema/i],
    [{ endpoints: [endpoint({ nativeAgentId: "" })] }, /nativeAgentId|schema/i],
    [{ endpoints: [endpoint({ identity: "" })] }, /identity|schema/i],
    [{ endpoints: [endpoint({ userHeader: "" })] }, /userHeader|schema/i],
    [{ endpoints: [endpoint({ url: "relative" })] }, /url|absolute/i],
    [{ endpoints: [endpoint({ url: "https://gateway.example/openclaw" })] }, /url|wss/i],
    [{ endpoints: [endpoint({ url: "wss://user:pass@gateway.example/openclaw" })] }, /url/i],
    [{ endpoints: [endpoint({ url: "wss://gateway.example/openclaw?token=secret" })] }, /url/i],
    [{ endpoints: [endpoint({ url: "wss://gateway.example/openclaw#secret" })] }, /url/i],
    [{ endpoints: [endpoint({ userHeader: "authorization" })] }, /header|reserved/i],
    [{ endpoints: [endpoint({ userHeader: "cookie" })] }, /header|reserved/i],
    [{ endpoints: [endpoint({ userHeader: "host" })] }, /header|reserved/i],
    [{ endpoints: [endpoint({ userHeader: "connection" })] }, /header|reserved/i],
    [{ endpoints: [endpoint({ userHeader: "content-length" })] }, /header|reserved/i],
    [{ endpoints: [endpoint({ userHeader: "transfer-encoding" })] }, /header|reserved/i],
    [{ endpoints: [endpoint({ userHeader: "x-forwarded-for" })] }, /header|reserved/i],
    [{ endpoints: [endpoint({ userHeader: "x-real-ip" })] }, /header|reserved/i],
    [{ endpoints: [endpoint({ userHeader: "x-user\r\nx-secret" })] }, /header/i],
    [{ endpoints: [endpoint({ identity: "occ\r\nx-secret: leaked" })] }, /identity|header/i],
    [{ endpoints: [endpoint({ tlsFingerprint: "sha256:not-hex" })] }, /fingerprint/i],
    [
      { endpoints: [endpoint(), endpoint({ nativeAgentId: "native-agent-duplicate" })] },
      /duplicate|namespaceId|agentId/i,
    ],
  ]) {
    await assert.rejects(load(t, configuration), expected);
  }
});

test("workspace-files server startup validates API-only endpoint configuration before database access", async (t) => {
  const workspacePath = await yamlPath(t, "workspace-files.yaml", {
    endpoints: [endpoint({ url: "wss://gateway.example/openclaw?token=secret" })],
  });
  const installationPath = await yamlPath(t, "installation.yaml", installation());

  const server = spawnSync(process.execPath, ["apps/controller/src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      OCC_CONFIG_PATH: installationPath,
      OCC_HOST: "192.0.2.10",
      OCC_PORT: "8080",
      OCC_AUTH_SECRET: "production-auth-secret-with-at-least-32-characters",
      OCC_AUTH_BASE_URL: "http://192.0.2.10:8080",
      OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
      OCC_WORKSPACE_FILES_CONFIG_PATH: workspacePath,
    },
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(server.status, 1);
  assert.match(server.stderr, /workspace file|OCC_WORKSPACE_FILES_CONFIG_PATH|url/i);
  assert.doesNotMatch(server.stderr, /ECONNREFUSED|PostgreSQL|database/i);
});
