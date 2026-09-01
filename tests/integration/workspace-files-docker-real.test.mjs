import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";
import { loadWorkspaceFilesAccess } from "../../apps/controller/src/composition/workspace-files.ts";
import {
  composePostgresDevelopment,
  createDevelopmentDockerComputeDriver,
} from "../../apps/controller/src/composition/development-postgres.ts";
import { createFilesystemDevelopmentConfigurationDriverFromEnv } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  requestNativeGatewayModelTurn,
  startOperatorWorkspaceGatewayProxy,
} from "../helpers/operator-workspace-gateway.mjs";

const executeFile = promisify(execFile);
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const selected = process.env.OCC_TEST_WORKSPACE_FILES_DOCKER_REAL === "1";
const requiresWorkspaceFilesDocker = {
  skip:
    selected === true
      ? false
      : "Set OCC_TEST_WORKSPACE_FILES_DOCKER_REAL=1 to run the real Docker workspace-files proof.",
};

const LABEL_MANAGED = "org.openclaw.enterprise.managed";
const LABEL_DRIVER = "org.openclaw.enterprise.compute-driver";
const LABEL_NAMESPACE = "org.openclaw.enterprise.namespace-id";
const LABEL_AGENT = "org.openclaw.enterprise.agent-id";
const LABEL_REVISION = "org.openclaw.enterprise.revision-id";
const LABEL_ROLE = "org.openclaw.enterprise.role";
const providerModel = (process.env.OCC_TEST_OPENAI_MODEL ?? "gpt-5.1").replace(
  /^(?:openai|codex)\//u,
  "",
);
const adminEmail = "workspace-files-docker-admin@openclaw.local";
const adminPassword = "workspace-files-docker-password";
const authSecret = "workspace-files-docker-auth-secret-minimum-32-bytes";
const operatorIdentity = "occ-workspace-files";
const operatorUserHeader = "x-openclaw-user";
const nativeAgentId = "main";

function nonempty(value, name) {
  assert.equal(typeof value, "string", `${name} must be configured.`);
  assert.ok(value.trim().length > 0, `${name} must be nonempty.`);
  return value;
}

function sanitize(text, secrets) {
  return secrets.reduce(
    (current, secret) => (secret ? current.replaceAll(secret, "[REDACTED]") : current),
    text,
  );
}

async function command(file, args, { env, timeoutMs = 120_000, secrets = [] } = {}) {
  try {
    return await executeFile(file, args, {
      env: env === undefined ? process.env : env,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `${sanitize(`${file} ${args.join(" ")}`, secrets)} failed with exit ${
        error.code ?? "unknown"
      }.\n${sanitize(String(error.stdout ?? ""), secrets)}${sanitize(
        String(error.stderr ?? ""),
        secrets,
      )}`,
    );
  }
}

async function docker(args, options) {
  return command("docker", args, options);
}

async function dockerJson(args, options) {
  const { stdout } = await docker(args, options);
  return JSON.parse(stdout);
}

async function dockerLines(args, options) {
  const { stdout } = await docker(args, options);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

async function waitFor(description, operation, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined && result !== false) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(750);
  }
  assert.fail(
    `Timed out waiting for ${description}${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }.`,
  );
}

function labelFilters(labels) {
  return labels.flatMap(([name, value]) => ["--filter", `label=${name}=${value}`]);
}

function namespaceLabels(namespaceId) {
  return [
    [LABEL_MANAGED, "true"],
    [LABEL_DRIVER, "docker"],
    [LABEL_NAMESPACE, namespaceId],
  ];
}

async function inspectNetworks(namespaceId) {
  const ids = await dockerLines([
    "network",
    "ls",
    "-q",
    ...labelFilters(namespaceLabels(namespaceId)),
  ]).catch(() => []);
  return ids.length === 0 ? [] : await dockerJson(["network", "inspect", ...ids]);
}

async function inspectContainers(filters = []) {
  const ids = await dockerLines(["ps", "-aq", ...labelFilters(filters)]).catch(() => []);
  return ids.length === 0 ? [] : await dockerJson(["inspect", ...ids]);
}

async function cleanupDockerNamespaces(namespaceIds) {
  for (const namespaceId of namespaceIds) {
    const containers = await dockerLines([
      "ps",
      "-aq",
      ...labelFilters(namespaceLabels(namespaceId)),
    ]).catch(() => []);
    if (containers.length > 0) await docker(["rm", "-f", ...containers]).catch(() => {});
    const networks = await dockerLines([
      "network",
      "ls",
      "-q",
      ...labelFilters(namespaceLabels(namespaceId)),
    ]).catch(() => []);
    for (const network of networks) await docker(["network", "rm", network]).catch(() => {});
  }
}

async function waitForNamespaceNetwork(namespaceId) {
  const networks = await waitFor(`Docker network for Namespace ${namespaceId}`, async () => {
    const current = await inspectNetworks(namespaceId);
    return current.length === 1 ? current : undefined;
  });
  return networks[0];
}

async function waitForContainers(filters, expected, description) {
  return waitFor(description, async () => {
    const containers = await inspectContainers(filters);
    const running = containers.filter((container) => container.State?.Running === true);
    return running.length === expected ? running : undefined;
  });
}

function containerEnv(container, name) {
  const prefix = `${name}=`;
  const entry = (container.Config?.Env ?? []).find((value) => value.startsWith(prefix));
  return entry === undefined ? undefined : entry.slice(prefix.length);
}

function gatewayUrl(gateway) {
  const gatewayPort = containerEnv(gateway, "OPENCLAW_GATEWAY_PORT");
  assert.match(String(gatewayPort), /^\d+$/u, "gateway port must be inspectable");
  const bindings = gateway.NetworkSettings?.Ports?.[`${gatewayPort}/tcp`];
  assert.equal(
    Array.isArray(bindings) && bindings.length === 1,
    true,
    "gateway port must be published exactly once",
  );
  const binding = bindings[0];
  assert.equal(binding.HostIp, "127.0.0.1", "gateway port must publish only on loopback");
  assert.match(String(binding.HostPort), /^\d+$/u, "gateway host port must be inspectable");
  return `http://127.0.0.1:${binding.HostPort}`;
}

async function waitForGatewayReady(gateway, description) {
  return waitFor(description, async () => {
    const response = await fetch(new URL("/readyz", gatewayUrl(gateway)), {
      signal: AbortSignal.timeout(10_000),
    });
    return response.status === 200 ? response : undefined;
  });
}

function dockerGatewayContainerName(namespaceId, agentId) {
  return `oce-${sha256Hex(namespaceId, 12)}-gateway-${sha256Hex(agentId, 12)}`;
}

function sha256Hex(value, length) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function apiClient(baseUrl, session) {
  return async function request(method, path, body, options = {}) {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        ...(options.session === false
          ? {}
          : authenticatedHeaders(options.session ?? session, { origin: baseUrl })),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const text = await response.text();
    const parsed = text.length === 0 ? undefined : JSON.parse(text);
    return { status: response.status, ...(parsed === undefined ? {} : parsed) };
  };
}

function proxyIpForNetwork(network) {
  const gateway = network.IPAM?.Config?.find((entry) => typeof entry.Gateway === "string")?.Gateway;
  assert.match(String(gateway), /^\d+\.\d+\.\d+\.\d+$/u, "Docker network gateway IP is required");
  const parts = gateway.split(".");
  parts[3] = "3";
  return { gatewayIp: gateway, proxyIp: parts.join(".") };
}

function embeddedOpenClawConfiguration({ proxyIp }) {
  const configuration = createHarnessConfiguration("openclaw", providerModel);
  configuration.gateway = {
    ...configuration.gateway,
    trustedProxies: [proxyIp],
    auth: {
      mode: "trusted-proxy",
      trustedProxy: { userHeader: operatorUserHeader, allowUsers: [operatorIdentity] },
      identityScopes: { [operatorIdentity]: ["operator.admin"] },
    },
  };
  configuration.agents.defaults = {
    ...configuration.agents.defaults,
    workspace: "/home/node/workspace",
    skipBootstrap: true,
  };
  return configuration;
}

async function ensureBootstrapped(context, config, outputDirectory) {
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
  context.after(async () => pool.end());
  const state = new PostgresPlatformState(pool);
  const installation = await state.loadInstallation();
  if (installation !== undefined) return;
  await ensureDevelopmentBootstrap(context, {
    databaseUrl: config.databaseUrl,
    directory: outputDirectory,
    email: adminEmail,
    password: adminPassword,
    authSecret: config.authSecret,
    authBaseURL: config.authBaseURL,
    installationName: "OpenClaw Docker workspace files integration",
  });
}

async function startApi({ config, configurationRoot, workspaceFilesAccess }) {
  const app = await composePostgresDevelopment(
    {
      ...config,
      ...(workspaceFilesAccess === undefined ? {} : { workspaceFilesAccess }),
    },
    {
      computeDriver: createDevelopmentDockerComputeDriver(process.env),
      configurationDriver: createFilesystemDevelopmentConfigurationDriverFromEnv({
        OCC_DEVELOPMENT_CONFIGURATION_ROOT: configurationRoot,
      }),
    },
  );
  const port = Number(new URL(config.authBaseURL).port);
  const address = await app.listen({ host: "127.0.0.1", port });
  return { app, baseUrl: address };
}

test(
  "Docker Compute exposes real Agent workspace files through OCC and native trusted-proxy WSS",
  { ...requiresWorkspaceFilesDocker, timeout: 900_000 },
  async (context) => {
    nonempty(process.env.OPENAI_API_KEY, "OPENAI_API_KEY for real embedded OpenClaw model turns");
    nonempty(databaseUrl, "OCC_TEST_DATABASE_URL for real Docker workspace-files proof");
    const runtimeImage = nonempty(
      process.env.OCC_DOCKER_GATEWAY_IMAGE ?? process.env.OCC_DOCKER_RUNTIME_IMAGE,
      "OCC_DOCKER_GATEWAY_IMAGE or OCC_DOCKER_RUNTIME_IMAGE",
    );
    process.env.OCC_DOCKER_GATEWAY_IMAGE = runtimeImage;
    process.env.OCC_DOCKER_AGENT_IMAGE = process.env.OCC_DOCKER_AGENT_IMAGE ?? runtimeImage;
    await docker(["version"], { timeoutMs: 30_000 });
    await docker(["image", "inspect", runtimeImage], { timeoutMs: 30_000 });

    const workingDirectory = await mkdtemp(join(tmpdir(), "occ-workspace-files-docker-"));
    context.after(async () => rm(workingDirectory, { recursive: true, force: true }));
    const configurationRoot = join(workingDirectory, "configuration");
    const apiPort = await reserveLoopbackPort();
    const authBaseURL = `http://127.0.0.1:${apiPort}`;
    const config = {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authSecret,
      authBaseURL,
    };
    const namespaceIds = [];
    let api;
    let worker;
    let workerPool;
    let proxy;
    context.after(async () => {
      if (proxy !== undefined) await proxy.close();
      if (api !== undefined) await api.app.close();
      if (worker !== undefined) await worker.stop();
      await cleanupDockerNamespaces(namespaceIds);
    });

    await ensureBootstrapped(context, config, workingDirectory);

    api = await startApi({ config, configurationRoot });
    const session = await signInWithEmailPassword({
      fetch,
      origin: api.baseUrl,
      email: adminEmail,
      password: adminPassword,
    });
    workerPool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    worker = createControllerWorker({
      pool: workerPool,
      computeDriver: createDevelopmentDockerComputeDriver(process.env),
      pollIntervalMs: 50,
      leaseDurationMs: 30_000,
      maxAttempts: 20,
      emit: () => {},
    });
    await worker.start();
    let request = apiClient(api.baseUrl, session);

    const namespace = await request("POST", "/namespaces", {
      name: `workspace-files-docker-${randomUUID()}`,
    });
    assert.equal(namespace.status, 201, JSON.stringify(namespace.error));
    namespaceIds.push(namespace.data.id);
    await waitFor(`Namespace ${namespace.data.id} readiness`, async () => {
      const current = await request("GET", `/namespaces/${namespace.data.id}`);
      assert.equal(current.status, 200, JSON.stringify(current.error));
      return current.data.status === "ready" ? current.data : undefined;
    });
    const network = await waitForNamespaceNetwork(namespace.data.id);
    const { gatewayIp, proxyIp } = proxyIpForNetwork(network);
    assert.notEqual(proxyIp, gatewayIp, "operator proxy must not use the Docker bridge gateway IP");

    const marker = `OCC_WORKSPACE_FILES_MARKER_${randomUUID()}`;
    const configuration = await request("POST", `/namespaces/${namespace.data.id}/configurations`, {
      kind: "agent",
      values: embeddedOpenClawConfiguration({ proxyIp }),
    });
    assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
    const agent = await request("POST", `/namespaces/${namespace.data.id}/agents`, {
      name: `workspace-files-${randomUUID()}`,
      configurationId: configuration.data.id,
      executionMode: "embedded",
    });
    assert.equal(agent.status, 201, JSON.stringify(agent.error));
    const revision = await request(
      "POST",
      `/namespaces/${namespace.data.id}/agents/${agent.data.id}/deploy`,
    );
    assert.equal(revision.status, 202, JSON.stringify(revision.error));
    assert.match(revision.data.compute.implementation, /docker/iu);

    await waitFor(`Agent ${agent.data.id} activation`, async () => {
      const current = await request(
        "GET",
        `/namespaces/${namespace.data.id}/agents/${agent.data.id}`,
      );
      assert.equal(current.status, 200, JSON.stringify(current.error));
      return current.data.activeRevisionId === revision.data.id ? current.data : undefined;
    });
    const gatewayFilters = [
      [LABEL_NAMESPACE, namespace.data.id],
      [LABEL_AGENT, agent.data.id],
      [LABEL_REVISION, revision.data.id],
      [LABEL_ROLE, "gateway"],
    ];
    const [gateway] = await waitForContainers(
      gatewayFilters,
      1,
      "embedded OpenClaw gateway container",
    );
    assert.equal(
      containerEnv(gateway, "OPENCLAW_GATEWAY_TOKEN"),
      undefined,
      "trusted-proxy gateway auth must not project a bearer token",
    );
    assert.equal(
      containerEnv(gateway, "OPENAI_API_KEY") !== undefined,
      true,
      "embedded OpenClaw gateway must receive the model credential",
    );

    const gatewayContainerName = dockerGatewayContainerName(namespace.data.id, agent.data.id);
    proxy = await startOperatorWorkspaceGatewayProxy({
      name: `oce-workspace-files-${randomUUID().replaceAll("-", "").slice(0, 18)}`,
      dockerNetwork: network.Name,
      targetUrl: `ws://${gatewayContainerName}:${containerEnv(gateway, "OPENCLAW_GATEWAY_PORT")}/`,
      proxyIp,
      userHeader: operatorUserHeader,
      identity: operatorIdentity,
      allowedClientIps: [gatewayIp],
      image: runtimeImage,
    });
    assert.equal(proxy.proxyIp, proxyIp, "operator proxy must use the static trusted IP");

    const workspaceFilesConfigPath = join(workingDirectory, "workspace-files.yaml");
    await writeFile(
      workspaceFilesConfigPath,
      `${JSON.stringify({
        endpoints: [
          {
            namespaceId: namespace.data.id,
            agentId: agent.data.id,
            url: proxy.url,
            nativeAgentId,
            identity: operatorIdentity,
            userHeader: operatorUserHeader,
            tlsFingerprint: proxy.tlsFingerprint,
          },
        ],
      })}\n`,
      "utf8",
    );
    const workspaceFilesAccess = await loadWorkspaceFilesAccess(workspaceFilesConfigPath);
    await api.app.close();
    api = await startApi({ config, configurationRoot, workspaceFilesAccess });
    request = apiClient(api.baseUrl, session);

    const agInstructions =
      `The configured workspace marker is ${marker}.\n` +
      "When asked for the configured workspace marker, reply with exactly that marker and no other text.\n";
    const unauthenticated = await request(
      "GET",
      `/namespaces/${namespace.data.id}/agents/${agent.data.id}/workspace/files/AGENTS.md`,
      undefined,
      { session: false },
    );
    assert.equal(unauthenticated.status, 401, JSON.stringify(unauthenticated));
    const invalidPath = await request(
      "PUT",
      `/namespaces/${namespace.data.id}/agents/${agent.data.id}/workspace/files/README.md`,
      { content: agInstructions },
    );
    assert.equal(invalidPath.status, 400, JSON.stringify(invalidPath));

    const write = await request(
      "PUT",
      `/namespaces/${namespace.data.id}/agents/${agent.data.id}/workspace/files/AGENTS.md`,
      { content: agInstructions },
    );
    assert.equal(write.status, 200, JSON.stringify(write.error));
    const read = await request(
      "GET",
      `/namespaces/${namespace.data.id}/agents/${agent.data.id}/workspace/files/AGENTS.md`,
    );
    assert.equal(read.status, 200, JSON.stringify(read.error));
    assert.equal(read.data.content, agInstructions);
    assert.equal(read.data.name, "AGENTS.md");

    const stats = await proxy.stats();
    const accepted = stats.connections.filter((connection) => connection.accepted === true);
    assert.ok(accepted.length >= 2, "OCC workspace file routes must traverse the TLS proxy");
    assert.ok(
      accepted.every((connection) => connection.forwardedFor === gatewayIp),
      "proxy must derive forwarded-for from the actual host-to-container peer",
    );
    assert.ok(
      accepted.every((connection) => connection.forwardedFor !== "127.0.0.1"),
      "proxy must not forward loopback as the native client address",
    );

    await requestNativeGatewayModelTurn({
      url: proxy.url,
      tlsFingerprint: proxy.tlsFingerprint,
      identity: operatorIdentity,
      userHeader: operatorUserHeader,
      nativeAgentId,
      expectedMarker: marker,
      prompt:
        "What is the configured workspace marker? Reply with exactly the marker and no other text.",
      timeoutMs: 240_000,
    });

    await docker(["restart", gateway.Id], { timeoutMs: 60_000 });
    const [restartedGateway] = await waitForContainers(
      gatewayFilters,
      1,
      "restarted embedded OpenClaw gateway container",
    );
    assert.equal(
      restartedGateway.Id,
      gateway.Id,
      "docker restart must preserve the same gateway container identity",
    );
    assert.notEqual(
      restartedGateway.State?.StartedAt,
      gateway.State?.StartedAt,
      "docker restart must update the gateway container start time",
    );
    await waitForGatewayReady(restartedGateway, "restarted embedded OpenClaw gateway readiness");
    // The development Docker Driver mounts /home/node as tmpfs, so the native
    // workspace file written above is only guaranteed for the current gateway
    // runtime lifetime. Kubernetes-backed gateways cover persistent workspace
    // storage; this Docker proof records the current restart limitation.
    const restartRead = await waitFor(
      "OCC workspace file loss after exact gateway container restart",
      async () => {
        const current = await request(
          "GET",
          `/namespaces/${namespace.data.id}/agents/${agent.data.id}/workspace/files/AGENTS.md`,
        );
        assert.notEqual(current.status, 401, JSON.stringify(current.error));
        return current.status === 404 ? current : undefined;
      },
      60_000,
    );
    assert.equal(restartRead.status, 404, JSON.stringify(restartRead.error));
    assert.equal(
      restartRead.error.code,
      "NOT_FOUND",
      "Docker tmpfs workspace files must not be reported as persisted after restart",
    );
    await waitForGatewayReady(
      restartedGateway,
      "gateway readiness after post-restart workspace proof",
    );

    await proxy.close();
    proxy = undefined;
    await cleanupDockerNamespaces(namespaceIds);
    await waitFor(`Namespace ${namespace.data.id} Docker network cleanup`, async () =>
      (await inspectNetworks(namespace.data.id)).length === 0 ? true : undefined,
    );
  },
);
