import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";

import {
  ciOtelBackendResourceKind,
  cleanupLogging,
  prepareLogging,
} from "../../scripts/ci/logging.mjs";

const digest = "a".repeat(64);
const collectorImage = `registry.example/otelcol@sha256:${digest}`;
const execute = promisify(execFile);
const selectedCollectorSmoke = process.env.OCC_TEST_LOGGING_COLLECTOR === "1";

async function readJsonlPayloads(path) {
  try {
    const text = await readFile(path, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitFor(check, description) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(250);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

function payloadContains(value, payloads) {
  return JSON.stringify(payloads).includes(value);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ci-logging-test-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("prepareLogging registers an owned Collector backend before starting Docker", async (t) => {
  const root = await fixture(t);
  const calls = [];
  const registered = [];
  const execFile = async (command, args) => {
    calls.push([command, args]);
    return { stdout: "container-id\n", stderr: "" };
  };
  const registerResource = async (kind, resource) => {
    assert.equal(calls.length, 0, "resource must be persisted before Docker mutation");
    registered.push({ kind, resource });
    return { id: "resource-1", kind, owner: "openclaw-ci-local-test", ...resource };
  };

  const result = await prepareLogging({
    laneName: "docker-model",
    directory: root,
    env: {
      OCC_DOCKER_BIN: "docker",
      OCC_TEST_LOGGING_COLLECTOR_IMAGE: collectorImage,
      OCC_CI_OTEL_BACKEND_HOST: "host.docker.internal",
      OCC_CI_OTEL_BACKEND_BIND_ADDRESS: "127.0.0.1",
    },
    execFile,
    registerResource,
    waitForReady: false,
  });

  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, ciOtelBackendResourceKind);
  assert.equal(result.resourceId, "resource-1");
  assert.equal(result.env.OCC_TEST_OTEL_LOGS, "1");
  assert.match(result.env.OCC_TEST_OTEL_LOGS_JSONL, /logs[.]jsonl$/);
  assert.match(
    result.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    /^http:\/\/host[.]docker[.]internal:\d+\/v1\/logs$/,
  );
  assert.equal(Object.hasOwn(result.env, "OCC_TEST_OTEL_LOGS_URL"), false);
  assert.match(result.artifacts.containerName, /^openclaw-ci-otel-docker-model-/);

  const run = calls.find(([command, args]) => command === "docker" && args[0] === "run");
  assert.ok(run, "prepareLogging starts a Docker Collector backend");
  assert.deepEqual(run[1].slice(0, 4), [
    "run",
    "--detach",
    "--name",
    result.artifacts.containerName,
  ]);
  assert.ok(run[1].includes(collectorImage));
  assert.ok(run[1].includes("--publish"));

  assert.equal((await stat(result.artifacts.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(result.artifacts.outputDirectory)).mode & 0o777, 0o700);
  assert.match(await readFile(result.artifacts.configPath, "utf8"), /path: \/out\/logs[.]jsonl/);
});

test("prepareLogging installs k3d Collector from the canonical Helm template", async (t) => {
  const root = await fixture(t);
  const clusterName = "openclaw-k8s-oteltest";
  const clusterDirectory = join(root, `${clusterName}-state`);
  const kubeconfig = join(clusterDirectory, "kubeconfig");
  await mkdir(clusterDirectory, { mode: 0o700 });
  await writeFile(kubeconfig, "apiVersion: v1\n", { mode: 0o600 });
  const calls = [];
  const registered = [];
  const execFile = async (command, args) => {
    calls.push([command, args]);
    if (command === "docker" && args[0] === "inspect")
      return { stdout: "172.18.0.23\n", stderr: "" };
    if (command === "kubectl" && args.includes("endpointslices")) {
      return {
        stdout: JSON.stringify({
          items: [
            {
              ports: [{ protocol: "TCP", port: 6443 }],
              endpoints: [{ conditions: { ready: true }, addresses: ["10.89.0.2"] }],
            },
          ],
        }),
        stderr: "",
      };
    }
    if (command === "helm") {
      return {
        stdout:
          "apiVersion: apps/v1\nkind: DaemonSet\nmetadata:\n  name: openclaw-enterprise-collector\n",
        stderr: "",
      };
    }
    return { stdout: "container-id\n", stderr: "" };
  };
  const registerResource = async (kind, resource) => {
    assert.equal(
      calls.length,
      0,
      "resource must be persisted before Docker or Kubernetes mutation",
    );
    registered.push({ kind, resource });
    return { id: "resource-1", kind, owner: "openclaw-ci-local-test", ...resource };
  };

  const result = await prepareLogging({
    laneName: "k3d-otel",
    cluster: {
      name: clusterName,
      directory: clusterDirectory,
      kubeconfig,
      context: `k3d-${clusterName}`,
    },
    env: {
      OCC_DOCKER_BIN: "docker",
      OCC_HELM_BIN: "helm",
      OCC_KUBECTL_BIN: "kubectl",
      OCC_TEST_LOGGING_COLLECTOR_IMAGE: collectorImage,
    },
    execFile,
    registerResource,
    waitForReady: false,
  });

  assert.equal(registered[0].resource.network, `k3d-${clusterName}`);
  assert.equal(registered[0].resource.namespace, result.artifacts.containerName);
  assert.equal(result.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, "http://172.18.0.23:4318/v1/logs");
  const dockerRun = calls.find(([command, args]) => command === "docker" && args[0] === "run");
  assert.ok(dockerRun[1].includes("--network"));
  assert.ok(dockerRun[1].includes(`k3d-${clusterName}`));
  const helm = calls.find(([command]) => command === "helm");
  assert.ok(helm[1].includes("--show-only"));
  assert.ok(helm[1].includes("templates/collector.yaml"));
  assert.ok(helm[1].includes("--values"));
  assert.ok(helm[1].includes("logging.collector.exporter.cidr=172.18.0.23/32"));
  assert.ok(helm[1].includes("logging.collector.exporter.port=4318"));
  assert.ok(helm[1].includes("cluster.cidr=10.89.0.2/32"));
  assert.ok(helm[1].includes("cluster.port=6443"));
  const collectorApply = calls.find(
    ([command, args]) =>
      command === "kubectl" &&
      args.includes("apply") &&
      args.includes(result.artifacts.manifestPath),
  );
  assert.ok(collectorApply, "the rendered Collector manifest is applied");
  assert.equal(
    collectorApply[1][collectorApply[1].indexOf("--namespace") + 1],
    registered[0].resource.namespace,
    "Collector resources must share the namespace of their Secrets and rollout checks",
  );
  const secretManifest = await readFile(result.artifacts.secretsManifestPath, "utf8");
  assert.match(secretManifest, /kind: Namespace/);
  assert.match(secretManifest, /collector[.]yaml: \|-/);
  assert.match(secretManifest, /kubernetes[.]yaml: \|-/);
  assert.match(secretManifest, /exporter[.]yaml: \|-/);
  assert.match(
    secretManifest,
    /OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http:\/\/172[.]18[.]0[.]23:4318\/v1\/logs"/,
  );
});

test(
  "prepareLogging backend receives real OTLP/HTTP logs and writes JSONL",
  {
    skip: selectedCollectorSmoke
      ? false
      : "Set OCC_TEST_LOGGING_COLLECTOR=1 for the real Docker Collector backend smoke.",
    timeout: 120_000,
  },
  async (t) => {
    const root = await fixture(t);
    let resource;
    const result = await prepareLogging({
      laneName: "logging-collector",
      directory: root,
      env: process.env,
      execFile: execute,
      registerResource: async (kind, details) => {
        resource = { id: "resource-1", kind, owner: "openclaw-ci-local-test", ...details };
        return resource;
      },
    });
    try {
      const canary = `ci-logging-smoke-${randomUUID()}`;
      const response = await fetch(result.artifacts.localEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceLogs: [
            {
              resource: {
                attributes: [{ key: "service.name", value: { stringValue: "ci-logging-smoke" } }],
              },
              scopeLogs: [
                {
                  logRecords: [
                    {
                      timeUnixNano: String(Date.now() * 1_000_000),
                      severityText: "INFO",
                      body: { stringValue: canary },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
      assert.equal(response.status, 200);
      await waitFor(
        async () => payloadContains(canary, await readJsonlPayloads(result.artifacts.logsJsonl)),
        "Collector file exporter JSONL output",
      );
    } finally {
      if (resource) await cleanupLogging(resource, { execFile: execute });
    }
  },
);

test("cleanupLogging removes the owned Collector backend and rejects foreign paths", async (t) => {
  const root = await fixture(t);
  const containerName = "openclaw-ci-otel-docker-model-abc123def456";
  const directory = join(root, `${containerName}-state`);
  await mkdir(directory, { mode: 0o700 });
  const calls = [];
  const execFile = async (command, args) => {
    calls.push([command, args]);
    return { stdout: "", stderr: "" };
  };

  await cleanupLogging(
    {
      kind: ciOtelBackendResourceKind,
      containerName,
      directory,
    },
    { execFile, env: { OCC_DOCKER_BIN: "docker" } },
  );

  assert.deepEqual(calls, [["docker", ["rm", "--force", containerName]]]);
  await assert.rejects(() => stat(directory), { code: "ENOENT" });

  await assert.rejects(
    () =>
      cleanupLogging(
        {
          kind: ciOtelBackendResourceKind,
          containerName,
          directory: resolve(root, "foreign-state"),
        },
        { execFile, env: { OCC_DOCKER_BIN: "docker" } },
      ),
    /outside ownership/,
  );
});
