import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");
const occ = join(repository, "bin", "occ");
const selected = process.env.OCC_TEST_DEV_UP_OPENSHELL_REAL === "1";

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
  return address.port;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function waitForPort(child, port, stderr) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`OpenShell port-forward exited before readiness: ${stderr()}`);
    }
    const connected = await new Promise((resolveConnect) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(250);
      socket.once("connect", () => {
        socket.destroy();
        resolveConnect(true);
      });
      const unavailable = () => {
        socket.destroy();
        resolveConnect(false);
      };
      socket.once("error", unavailable);
      socket.once("timeout", unavailable);
    });
    if (connected) {
      return;
    }
    await delay(100);
  }
  throw new Error(`OpenShell port-forward did not become ready: ${stderr()}`);
}

async function stopPortForward(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function waitForNamespaceReady(environment, apiPort, stateDirectory, namespaceId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await execute(occ, ["namespace", "get", namespaceId, "--output", "json"], {
      cwd: repository,
      env: {
        ...environment,
        OCC_URL: `http://127.0.0.1:${apiPort}`,
        OCC_SERVICE_KEY_FILE: join(stateDirectory, "initial-admin-service-key.json"),
      },
      maxBuffer: 4 * 1024 * 1024,
    });
    const namespace = JSON.parse(result.stdout);
    if (namespace.status === "ready") {
      return namespace;
    }
    if (namespace.status === "failed") {
      throw new Error(`OCC Namespace ${namespaceId} failed reconciliation.`);
    }
    await delay(500);
  }
  throw new Error(`OCC Namespace ${namespaceId} did not become ready.`);
}

test(
  "dev-up installs the pinned OpenShell profile in its owned k3d cluster",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_DEV_UP_OPENSHELL_REAL=1 to run the real development profile.",
    timeout: 1_200_000,
  },
  async (t) => {
    await access(occ);
    const root = await mkdtemp(join(tmpdir(), "oce-dev-up-openshell-real-"));
    const stateDirectory = join(root, "state");
    const suffix = randomUUID().slice(0, 8);
    const cluster = `occ-dev-openshell-${suffix}`;
    const project = `oce_dev_openshell_${suffix}`;
    const apiPort = await unusedPort();
    const kubernetesPort = await unusedPort();
    const postgresPort = await unusedPort();
    const environment = {
      ...process.env,
      OPENCLAW_DEV_PORT: String(apiPort),
      OCC_POSTGRES_PORT: String(postgresPort),
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
      OCC_DEVELOPMENT_SANDBOX_DRIVER: "openshell",
      OCC_DEVELOPMENT_CONTAINER_ENGINE: process.env.OCC_TEST_DEV_UP_CONTAINER_ENGINE ?? "docker",
      OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
      OCC_DEVELOPMENT_COMPOSE_PROJECT: project,
      OCC_DEVELOPMENT_KUBERNETES_CLUSTER: cluster,
      OCC_DEVELOPMENT_KUBERNETES_API_PORT: String(kubernetesPort),
      OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT:
        process.env.OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT ?? "1",
      OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "600",
    };
    delete environment.OCC_DEVELOPMENT_OPENSHELL_HELM_CHART;
    delete environment.OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART;
    delete environment.OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST;
    // Cleanup reuses the state and engine endpoint recorded by this invocation;
    // it must not discover or remove an unrelated cluster.
    t.after(async () => {
      try {
        if (!(await exists(stateDirectory))) {
          return;
        }
        await execute(occ, ["dev", "down"], {
          cwd: repository,
          env: environment,
          timeout: 300_000,
          maxBuffer: 8 * 1024 * 1024,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    const result = await execute(occ, ["dev", "up"], {
      cwd: repository,
      env: environment,
      timeout: 1_100_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.match(result.stdout, /Sandbox Driver: openshell/);
    assert.match(result.stdout, /OpenClaw Enterprise development stack is ready/);

    // Observe the real resources created through the supported OCC lifecycle,
    // without substituting the test-only OpenShell projection bridge.
    const state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
    assert.equal(state.cluster, cluster);
    assert.equal(state.sandboxDriver, "openshell");
    const kubectl = [
      "--kubeconfig",
      join(stateDirectory, "kubeconfig"),
      "--context",
      `k3d-${cluster}`,
    ];
    const namespaceList = JSON.parse(
      (
        await execute(
          "kubectl",
          [...kubectl, "get", "namespaces", "--selector", "openclaw.dev/namespace", "-o", "json"],
          {
            cwd: repository,
            env: environment,
            maxBuffer: 4 * 1024 * 1024,
          },
        )
      ).stdout,
    );
    assert.equal(namespaceList.items.length, 1);
    const namespace = namespaceList.items[0].metadata.name;
    assert.equal(namespaceList.items[0].metadata.labels["openshell.ai/openclaw-workspace"], "true");
    const service = JSON.parse(
      (
        await execute(
          "kubectl",
          [
            ...kubectl,
            "get",
            "service",
            "openshell-gateway",
            "--namespace",
            "openshell-system",
            "-o",
            "json",
          ],
          {
            cwd: repository,
            env: environment,
            maxBuffer: 4 * 1024 * 1024,
          },
        )
      ).stdout,
    );
    assert.equal(service.spec.type, "NodePort");
    assert.equal(service.spec.ports.find(({ name }) => name === "grpc")?.nodePort, 30051);
    await execute(
      "kubectl",
      [...kubectl, "get", "serviceaccount", "openshell-sandbox", "--namespace", namespace],
      { cwd: repository, env: environment },
    );
    await execute("kubectl", [...kubectl, "get", "runtimeclass", "openshell-sandbox"], {
      cwd: repository,
      env: environment,
    });
    await execute("kubectl", [...kubectl, "get", "crd", "sandboxes.agents.x-k8s.io"], {
      cwd: repository,
      env: environment,
    });

    // The namespace is not ready until the Sandbox Driver has created and
    // adopted its corresponding Gateway Workspace through the real gRPC API.
    const gatewayPort = await unusedPort();
    const forward = spawn(
      "kubectl",
      [
        ...kubectl,
        "port-forward",
        "--namespace",
        "openshell-system",
        "service/openshell-gateway",
        `${gatewayPort}:8080`,
      ],
      { cwd: repository, env: environment, stdio: ["ignore", "ignore", "pipe"] },
    );
    let forwardError = "";
    forward.stderr.on("data", (chunk) => {
      forwardError = `${forwardError}${chunk.toString()}`.slice(-4096);
    });
    t.after(() => stopPortForward(forward));
    await waitForPort(forward, gatewayPort, () => forwardError);
    const gateway = new GrpcOpenShellGatewayClient({
      endpoint: `http://127.0.0.1:${gatewayPort}`,
      auth: { mode: "unauthenticated" },
    });
    t.after(() => gateway.close());
    const workspace = await gateway.getWorkspace(namespace, AbortSignal.timeout(10_000));
    assert.equal(workspace?.name, namespace);
    assert.equal(workspace?.labels["app.kubernetes.io/managed-by"], "openclaw-enterprise");
    assert.equal(
      workspace?.labels["openclaw.dev/namespace-id"],
      namespaceList.items[0].metadata.annotations["openclaw.dev/namespace-id"],
    );

    // A Namespace created after startup must receive the same chart resources
    // through ensureNamespace; no host-side Helm release participates.
    const occEnvironment = {
      ...environment,
      OCC_URL: `http://127.0.0.1:${apiPort}`,
      OCC_SERVICE_KEY_FILE: join(stateDirectory, "initial-admin-service-key.json"),
    };
    const created = JSON.parse(
      (
        await execute(occ, ["namespace", "create", `operator-${suffix}`, "--output", "json"], {
          cwd: repository,
          env: occEnvironment,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout,
    );
    await waitForNamespaceReady(environment, apiPort, stateDirectory, created.id);
    const createdNamespaceList = JSON.parse(
      (
        await execute(
          "kubectl",
          [
            ...kubectl,
            "get",
            "namespaces",
            "--selector",
            `openclaw.dev/namespace=${created.id}`,
            "-o",
            "json",
          ],
          { cwd: repository, env: environment, maxBuffer: 4 * 1024 * 1024 },
        )
      ).stdout,
    );
    assert.equal(createdNamespaceList.items.length, 1);
    const createdPhysicalNamespace = createdNamespaceList.items[0].metadata.name;
    await execute(
      "kubectl",
      [
        ...kubectl,
        "get",
        "serviceaccount",
        "openshell-sandbox",
        "--namespace",
        createdPhysicalNamespace,
      ],
      { cwd: repository, env: environment },
    );
    const createdWorkspace = await gateway.getWorkspace(
      createdPhysicalNamespace,
      AbortSignal.timeout(10_000),
    );
    assert.equal(createdWorkspace?.labels["openclaw.dev/namespace-id"], created.id);

    const namespaces = await execute(occ, ["namespace", "list", "--output", "json"], {
      cwd: repository,
      env: occEnvironment,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.ok(
      JSON.parse(namespaces.stdout).some(
        ({ name, status }) => name === "default" && status === "ready",
      ),
      "the regular OCC workflow must observe the bootstrap Namespace as ready",
    );
  },
);
