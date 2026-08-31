import { sha256Hex } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createInstallationDriverConfiguration } from "./installation-driver-configuration.mjs";

const execute = promisify(execFile);
const k3dSharedFileSystemPath = "/var/lib/rancher/k3s/storage";
const localPathConfigMapName = "local-path-config";
const localPathConfigMapNamespace = "kube-system";
const localPathProvisionerDeployment = "local-path-provisioner";
const localPathStorageClass = "local-path";

function kubectlArguments({ kubeconfigPath, kubernetesContext }, args) {
  return ["--kubeconfig", kubeconfigPath, "--context", kubernetesContext, ...args];
}

async function kubectlFor(selection, ...args) {
  const { stdout } = await execute("kubectl", kubectlArguments(selection, args), {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

export async function validateExplicitK3dLoopbackContext(selection) {
  const { kubeconfigPath, kubernetesContext } = selection;
  assert.ok(
    kubeconfigPath,
    "OCC_TEST_KUBERNETES_KUBECONFIG must explicitly select disposable k3d.",
  );
  assert.match(kubernetesContext ?? "", /^k3d-/, "a dedicated k3d-* context is required");
  const configuration = JSON.parse(
    await kubectlFor(selection, "config", "view", "--minify", "--flatten", "-o", "json"),
  );
  assert.equal(configuration.contexts?.length, 1);
  assert.equal(configuration.contexts[0].name, kubernetesContext);
  assert.equal(configuration.clusters?.length, 1);
  const endpoint = new URL(configuration.clusters[0].cluster.server);
  assert.equal(endpoint.protocol, "https:");
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname),
    "refusing to run destructive integration against a non-loopback Kubernetes API",
  );
  assert.notEqual(endpoint.port, "", "the disposable Kubernetes API requires an explicit port");
  return configuration;
}

export async function configureExistingK3dLocalPathSharedFileSystem({
  kubeconfigPath,
  kubernetesContext,
}) {
  const selection = { kubeconfigPath, kubernetesContext };
  await validateExplicitK3dLoopbackContext(selection);

  await kubectlFor(
    selection,
    "annotate",
    "storageclass",
    localPathStorageClass,
    "defaultVolumeType=hostPath",
    "--overwrite",
  );
  const rawConfig = JSON.parse(
    await kubectlFor(
      selection,
      "get",
      "configmap",
      localPathConfigMapName,
      "--namespace",
      localPathConfigMapNamespace,
      "-o",
      "json",
    ),
  ).data?.["config.json"];
  assert.equal(typeof rawConfig, "string", "local-path-config must expose data.config.json");
  await kubectlFor(
    selection,
    "patch",
    "configmap",
    localPathConfigMapName,
    "--namespace",
    localPathConfigMapNamespace,
    "--type",
    "merge",
    "--patch",
    JSON.stringify({
      data: {
        "config.json": JSON.stringify(
          {
            ...JSON.parse(rawConfig),
            nodePathMap: [],
            sharedFileSystemPath: k3dSharedFileSystemPath,
            defaultVolumeType: "hostPath",
          },
          null,
          2,
        ),
      },
    }),
  );
  await kubectlFor(
    selection,
    "rollout",
    "restart",
    `deployment/${localPathProvisionerDeployment}`,
    "--namespace",
    localPathConfigMapNamespace,
  );
  await kubectlFor(
    selection,
    "rollout",
    "status",
    `deployment/${localPathProvisionerDeployment}`,
    "--namespace",
    localPathConfigMapNamespace,
    "--timeout=120s",
  );
}

export function kubernetesHash(value, length = 12) {
  return sha256Hex(value, length);
}

export function createKubernetesInstallationConfiguration({
  authentication,
  platformNamespace,
  gatewayImage,
  codexImage,
  cluster,
}) {
  const configuration = createInstallationDriverConfiguration();
  const compute = configuration.drivers.compute.configuration;
  const workload = {
    requests: { cpu: "100m", memory: "256Mi" },
    limits: { cpu: "2", memory: "1Gi" },
  };
  configuration.occ.cluster = cluster;
  configuration.drivers.configuration.configuration.authentication =
    structuredClone(authentication);
  compute.authentication = structuredClone(authentication);
  compute.images.gateway = gatewayImage;
  compute.images.agent = codexImage;
  compute.resources.gateway = structuredClone(workload);
  compute.resources.agent = structuredClone(workload);
  compute.resources.namespace.containerDefaults = structuredClone(workload);
  compute.network.gatewayClients = [
    {
      namespace: platformNamespace,
      podLabels: { "app.kubernetes.io/name": "approved-gateway-client" },
    },
  ];
  return configuration;
}

export async function assertGatewayModelTurn({ gatewayUrl, gatewayToken, nonce, secrets = [] }) {
  const endpoint = `${gatewayUrl}/v1/chat/completions`;
  const denied = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "openclaw/default", messages: [] }),
  });
  assert.ok([401, 403].includes(denied.status), "the real gateway must reject unauthenticated use");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${gatewayToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "openclaw/default",
      stream: false,
      messages: [
        { role: "user", content: `Reply with exactly this nonce and no other text: ${nonce}` },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.text();
  for (const secret of [gatewayToken, ...secrets]) {
    if (secret)
      assert.equal(
        body.includes(secret),
        false,
        "the gateway response must not expose credentials",
      );
  }
  assert.equal(response.status, 200, `real provider-backed model turn failed: ${body}`);
  assert.match(JSON.parse(body).choices?.[0]?.message?.content ?? "", new RegExp(nonce));
}

export function createRealKubernetesFixture({
  kubeconfigPath,
  kubernetesContext,
  gatewayImage,
  codexImage,
  databaseUrl,
}) {
  const selection = { kubeconfigPath, kubernetesContext };

  function scopedKubectlArguments(args) {
    return kubectlArguments(selection, args);
  }

  async function kubectl(...args) {
    return kubectlFor(selection, ...args);
  }

  async function resource(kind, name, namespace) {
    const args = ["get", kind, name, "-o", "json"];
    if (namespace !== undefined) args.push("--namespace", namespace);
    return JSON.parse(await kubectl(...args));
  }

  async function resources(kind, namespace) {
    return JSON.parse(await kubectl("get", kind, "--namespace", namespace, "-o", "json")).items;
  }

  async function createControllerIdentity({
    directory,
    platformNamespace,
    kubeconfig,
    account,
    clusterRole,
    clusterRoleBinding,
    context,
  }) {
    await kubectl("create", "serviceaccount", account, "--namespace", platformNamespace);
    await kubectl(
      "create",
      "clusterrolebinding",
      clusterRoleBinding,
      `--clusterrole=${clusterRole}`,
      `--serviceaccount=${platformNamespace}:${account}`,
    );
    const token = (
      await kubectl("create", "token", account, "--namespace", platformNamespace)
    ).trim();
    const path = join(directory, `${context}-kubeconfig.json`);
    await writeFile(
      path,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [{ name: "local", cluster: kubeconfig.clusters[0].cluster }],
        users: [{ name: account, user: { token } }],
        contexts: [{ name: context, context: { cluster: "local", user: account } }],
        "current-context": context,
      }),
      { mode: 0o600 },
    );
    return { account, authentication: { mode: "kubeconfig", kubeconfigPath: path, context } };
  }

  async function waitFor(description, operation, timeoutMs = 240_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await operation();
      if (result !== undefined && result !== false) return result;
      await delay(750);
    }
    assert.fail(`Timed out waiting for ${description}.`);
  }

  async function validatePrerequisites() {
    const configuration = await validateExplicitK3dLoopbackContext(selection);
    for (const [name, image] of [
      ["OCC_TEST_KUBERNETES_GATEWAY_IMAGE", gatewayImage],
      ["OCC_TEST_KUBERNETES_AGENT_IMAGE", codexImage],
    ]) {
      assert.match(
        image ?? "",
        /@sha256:[a-f0-9]{64}$/i,
        `${name} must select a real imported image by immutable SHA-256 digest.`,
      );
    }
    assert.ok(
      databaseUrl,
      "OCC_TEST_DATABASE_URL must select a dedicated openclaw_k8s_* database.",
    );
    const database = new URL(databaseUrl);
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(database.hostname),
      "the disposable integration database must use loopback",
    );
    assert.match(
      database.pathname,
      /^\/openclaw_k8s_[a-z0-9_]+$/,
      "refusing to modify a database not explicitly dedicated to Kubernetes integration",
    );

    return configuration;
  }

  async function provisionAgentTransportSecret(directory, namespace, agentId) {
    const suffix = kubernetesHash(agentId);
    const tokenDirectory = join(directory, `tokens-${suffix}`);
    const transportToken = randomBytes(32).toString("hex");
    const gatewayToken = randomBytes(32).toString("hex");
    await mkdir(tokenDirectory, { mode: 0o700 });
    try {
      await Promise.all([
        writeFile(join(tokenDirectory, "app-server-token"), transportToken, { mode: 0o600 }),
        writeFile(join(tokenDirectory, "gateway-token"), gatewayToken, { mode: 0o600 }),
      ]);
      await kubectl(
        "create",
        "secret",
        "generic",
        `openclaw-agent-transport-${suffix}`,
        "--namespace",
        namespace,
        `--from-file=app-server-token=${join(tokenDirectory, "app-server-token")}`,
        `--from-file=gateway-token=${join(tokenDirectory, "gateway-token")}`,
      );
    } finally {
      await rm(tokenDirectory, { recursive: true, force: true });
    }
    return gatewayToken;
  }

  async function startPortForward(namespace, serviceName) {
    const child = spawn(
      "kubectl",
      scopedKubectlArguments([
        "port-forward",
        "--namespace",
        namespace,
        "--address",
        "127.0.0.1",
        `service/${serviceName}`,
        "0:8080",
      ]),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2048);
    });
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`The production gateway port-forward did not become ready: ${stderr}`));
      }, 30_000);
      child.stdout.on("data", (chunk) => {
        const match = chunk.toString().match(/Forwarding from 127\.0\.0\.1:(\d+)/);
        if (match !== null) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Production gateway port-forward exited (${code}): ${stderr}`));
      });
    });
    return { url, stop: () => child.kill() };
  }

  return {
    kubectlArguments: scopedKubectlArguments,
    kubectl,
    resource,
    resources,
    createControllerIdentity,
    waitFor,
    validatePrerequisites,
    provisionAgentTransportSecret,
    startPortForward,
  };
}
