import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

const executeFile = promisify(execFile);

const selected =
  process.env.OCC_TEST_DOCKER_COMPUTE_REAL === "1" ||
  [
    process.env.OCC_DOCKER_RUNTIME_IMAGE,
    process.env.OCC_DOCKER_GATEWAY_IMAGE,
    process.env.OCC_DOCKER_AGENT_IMAGE,
  ].some((value) => typeof value === "string" && value.trim().length > 0);
const requiresDockerCompute = {
  skip: selected
    ? false
    : "Set OCC_TEST_DOCKER_COMPUTE_REAL=1 plus Docker Compose runtime image variables and OPENAI_API_KEY to run the real Docker Compute proof.",
};

const DEFAULT_RUNTIME_IMAGE = "oce-harness-real:pr26-compatible-runtime";
const COMPOSE_FILE = "compose.yaml";
const INTERNAL_API_PORT = "3000";
const LABEL_COMPOSE_PROJECT = "com.docker.compose.project";
const LABEL_MANAGED = "org.openclaw.enterprise.managed";
const LABEL_DRIVER = "org.openclaw.enterprise.compute-driver";
const LABEL_NAMESPACE = "org.openclaw.enterprise.namespace-id";
const LABEL_AGENT = "org.openclaw.enterprise.agent-id";
const LABEL_REVISION = "org.openclaw.enterprise.revision-id";
const LABEL_ROLE = "org.openclaw.enterprise.role";

// Dedicated Codex app-server execution sends Codex custom tools, which require
// the GPT-5 family on the OpenAI Responses API path.
const providerModel = (process.env.OCC_TEST_OPENAI_MODEL ?? "gpt-5.1").replace(
  /^(?:openai|codex)\//,
  "",
);

function nonempty(value, name) {
  assert.equal(typeof value, "string", `${name} must be configured.`);
  assert.ok(value.trim().length > 0, `${name} must be nonempty.`);
  return value;
}

function randomComposeSubnet() {
  const octet = 16 + (Number.parseInt(randomUUID().slice(0, 2), 16) % 64);
  return `172.30.${octet}.0/24`;
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
    const display = sanitize(`${file} ${args.join(" ")}`, secrets);
    const stdout = sanitize(String(error.stdout ?? ""), secrets);
    const stderr = sanitize(String(error.stderr ?? ""), secrets);
    throw new Error(`${display} failed with exit ${error.code ?? "unknown"}.\n${stdout}${stderr}`);
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
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
  });
  return port;
}

async function waitFor(description, operation, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined && value !== false) return value;
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

function composeArguments(project, commandName, args = []) {
  return ["compose", "--project-name", project, "--file", COMPOSE_FILE, commandName, ...args];
}

function labelFilters(labels) {
  return labels.flatMap(([name, value]) => ["--filter", `label=${name}=${value}`]);
}

function managedNamespaceLabels(namespaceId) {
  return [
    [LABEL_MANAGED, "true"],
    [LABEL_DRIVER, "docker"],
    [LABEL_NAMESPACE, namespaceId],
  ];
}

async function composeProjectGatewayTokens(project) {
  const ids = await dockerLines([
    "ps",
    "-aq",
    ...labelFilters([[LABEL_COMPOSE_PROJECT, project]]),
  ]).catch(() => []);
  if (ids.length === 0) return [];
  const inspected = await dockerJson(["inspect", ...ids]).catch(() => []);
  return inspected
    .flatMap((container) => (Array.isArray(container?.Config?.Env) ? container.Config.Env : []))
    .filter(
      (entry) =>
        typeof entry === "string" &&
        (entry.startsWith("OPENCLAW_GATEWAY_TOKEN=") || entry.startsWith("GATEWAY_TOKEN=")),
    )
    .map((entry) => entry.slice(entry.indexOf("=") + 1))
    .filter(Boolean);
}

async function composeFailureLogs(project, env, secrets) {
  const discoveredSecrets = [...secrets, ...(await composeProjectGatewayTokens(project))];
  try {
    const { stdout, stderr } = await docker(
      composeArguments(project, "logs", [
        "--no-color",
        "--tail",
        "80",
        "controller",
        "worker",
        "migrate",
      ]),
      { env, timeoutMs: 60_000, secrets: discoveredSecrets },
    );
    return sanitize(`${stdout}${stderr}`, discoveredSecrets);
  } catch (error) {
    return sanitize(
      `Failed to collect Docker Compose logs: ${
        error instanceof Error ? error.message : String(error)
      }`,
      discoveredSecrets,
    );
  }
}

async function cleanupProject(project, env, namespaceIds = []) {
  await docker(composeArguments(project, "down", ["--volumes", "--remove-orphans"]), {
    env,
    timeoutMs: 120_000,
  }).catch(() => {});
  const containers = await idsByNamespace(namespaceIds, ["ps", "-aq"]);
  if (containers.length > 0) await docker(["rm", "-f", ...containers]).catch(() => {});

  const networks = await idsByNamespace(namespaceIds, ["network", "ls", "-q"]);
  for (const network of networks) {
    await docker(["network", "rm", network]).catch(() => {});
  }

  const volumes = await dockerLines([
    "volume",
    "ls",
    "-q",
    ...labelFilters([[LABEL_COMPOSE_PROJECT, project]]),
  ]).catch(() => []);
  if (volumes.length > 0) await docker(["volume", "rm", ...volumes]).catch(() => {});
}

async function idsByNamespace(namespaceIds, baseArgs) {
  return (
    await Promise.all(
      namespaceIds.map((namespaceId) =>
        dockerLines([...baseArgs, ...labelFilters(managedNamespaceLabels(namespaceId))]).catch(
          () => [],
        ),
      ),
    )
  ).flat();
}

function apiClient(baseUrl, session) {
  return async function request(method, path, body, options = {}) {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        ...(options.session === false ? {} : authenticatedHeaders(options.session ?? session)),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const text = await response.text();
    const parsed = text.length === 0 ? undefined : JSON.parse(text);
    return {
      status: response.status,
      headers: response.headers,
      ...(parsed === undefined ? {} : parsed),
    };
  };
}

async function inspectContainers(filters = []) {
  const ids = await dockerLines([
    "ps",
    "-aq",
    ...labelFilters([[LABEL_MANAGED, "true"], [LABEL_DRIVER, "docker"], ...filters]),
  ]);
  if (ids.length === 0) return [];
  return dockerJson(["inspect", ...ids]);
}

async function containerCount(filters) {
  return (await inspectContainers(filters)).length;
}

async function inspectNetworks(namespaceId) {
  const ids = await dockerLines([
    "network",
    "ls",
    "-q",
    ...labelFilters(managedNamespaceLabels(namespaceId)),
  ]);
  if (ids.length === 0) return [];
  return dockerJson(["network", "inspect", ...ids]);
}

function containerEnv(container, name) {
  const entry = (container.Config?.Env ?? []).find((value) => value.startsWith(`${name}=`));
  return entry === undefined ? undefined : entry.slice(name.length + 1);
}

function hasContainerEnv(container, name) {
  return containerEnv(container, name) !== undefined;
}

function containerSecretValues(containers) {
  const secretNames = new Set([
    "APP_SERVER_TOKEN",
    "CODEX_ACCESS_TOKEN",
    "OPENAI_API_KEY",
    "OPENCLAW_GATEWAY_TOKEN",
  ]);
  return containers
    .flatMap((container) => container.Config?.Env ?? [])
    .map((entry) => {
      const separator = entry.indexOf("=");
      if (separator === -1) return undefined;
      const name = entry.slice(0, separator);
      if (!secretNames.has(name)) return undefined;
      return entry.slice(separator + 1);
    })
    .filter((value) => typeof value === "string" && value.length > 0);
}

async function containerLogs(containers, extraSecrets = []) {
  const secrets = [...extraSecrets, ...containerSecretValues(containers)];
  const entries = await Promise.all(
    containers.map(async (container) => {
      const name = container.Name ?? container.Id;
      try {
        const { stdout, stderr } = await docker(["logs", "--tail", "160", container.Id], {
          timeoutMs: 60_000,
          secrets,
        });
        return `Logs for ${name}:\n${sanitize(`${stdout}${stderr}`, secrets)}`;
      } catch (error) {
        return `Logs for ${name} unavailable: ${
          error instanceof Error ? sanitize(error.message, secrets) : String(error)
        }`;
      }
    }),
  );
  return entries.join("\n\n");
}

function assertNamespaceOnlyAttachment(container, networkName) {
  const networks = Object.keys(container.NetworkSettings?.Networks ?? {});
  assert.deepEqual(
    networks,
    [networkName],
    `container ${container.Name} must join only ${networkName}`,
  );
  const attachment = container.NetworkSettings.Networks[networkName];
  assert.equal(
    Boolean(attachment?.IPAddress),
    true,
    `container ${container.Name} must have a Namespace network address`,
  );
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

function gatewayUrl(gateway) {
  const gatewayPort = containerEnv(gateway, "OPENCLAW_GATEWAY_PORT");
  assert.ok(gatewayPort, "gateway container must expose OPENCLAW_GATEWAY_PORT");
  assert.match(String(gatewayPort), /^\d+$/, "gateway port must be inspectable");
  const bindings = gateway.NetworkSettings?.Ports?.[`${gatewayPort}/tcp`];
  assert.equal(
    Array.isArray(bindings) && bindings.length === 1,
    true,
    "gateway port must be published exactly once",
  );
  const binding = bindings[0];
  assert.equal(binding.HostIp, "127.0.0.1", "gateway port must publish only on loopback");
  assert.match(String(binding.HostPort), /^\d+$/, "gateway host port must be inspectable");
  return `http://127.0.0.1:${binding.HostPort}`;
}

async function invokeGateway({ networkName, gateway, gatewayToken, mode, onFailure }) {
  assertNamespaceOnlyAttachment(gateway, networkName);
  const nonce = `OCC-DOCKER-${mode.toUpperCase()}-${randomUUID()}`;
  const endpoint = new URL("/v1/chat/completions", gatewayUrl(gateway));
  const denied = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "openclaw/default", messages: [] }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok([401, 403].includes(denied.status), "gateway must reject missing bearer token");
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
        {
          role: "user",
          content: `Reply with exactly this nonce and no other text: ${nonce}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(240_000),
  });
  const body = sanitize(await response.text(), [gatewayToken]);
  if (response.status !== 200) {
    const diagnostics = onFailure === undefined ? "" : `\n\n${await onFailure()}`;
    assert.fail(
      `${mode} gateway model call must succeed: ${body.slice(0, 2000)}\n\n${response.status} !== 200${diagnostics}`,
    );
  }
  const text = JSON.parse(body).choices?.[0]?.message?.content ?? "";
  assert.ok(text.includes(nonce), `${mode} gateway model response must include fresh nonce`);
}

async function createAgentJourney({ request, namespaceId, mode, label }) {
  const harnessId = mode === "dedicated" ? "codex" : "openclaw";
  const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
    kind: "agent",
    values: createHarnessConfiguration(harnessId, providerModel),
  });
  assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
  const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
    name: `${label}-${randomUUID()}`,
    configurationId: configuration.data.id,
    executionMode: mode,
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.error));
  const revision = await request(
    "POST",
    `/namespaces/${namespaceId}/agents/${agent.data.id}/deploy`,
  );
  assert.equal(revision.status, 202, JSON.stringify(revision.error));
  assert.match(
    revision.data.compute.implementation,
    /docker/i,
    "admitted revisions must select the Docker Compute Driver",
  );
  await waitFor(`Agent ${agent.data.id} to activate ${revision.data.id}`, async () => {
    const current = await request("GET", `/namespaces/${namespaceId}/agents/${agent.data.id}`);
    assert.equal(current.status, 200, JSON.stringify(current.error));
    return current.data.activeRevisionId === revision.data.id ? current.data : undefined;
  });
  return { agent: agent.data, revision: revision.data };
}

test(
  "Docker Compose development drives Docker Compute networks, containers, auth, cleanup, and real model turns",
  { ...requiresDockerCompute, timeout: 720_000 },
  async (context) => {
    const providerKey = nonempty(
      process.env.OPENAI_API_KEY,
      "OPENAI_API_KEY for real Docker Compute model turns",
    );
    const runtimeImage = process.env.OCC_DOCKER_RUNTIME_IMAGE ?? DEFAULT_RUNTIME_IMAGE;
    const gatewayImage = process.env.OCC_DOCKER_GATEWAY_IMAGE ?? runtimeImage;
    const agentImage = process.env.OCC_DOCKER_AGENT_IMAGE ?? runtimeImage;
    await docker(["version"], { timeoutMs: 30_000 });
    await docker(["compose", "version"], { timeoutMs: 30_000 });
    await Promise.all(
      [gatewayImage, agentImage].map((image) =>
        docker(["image", "inspect", image], { timeoutMs: 30_000 }),
      ),
    );

    const apiPort = await reserveLoopbackPort();
    const postgresPort = await reserveLoopbackPort();
    const project = `oce-docker-${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    const namespaceIds = [];
    const adminEmail = `admin-${project}@example.test`;
    const adminPassword = `docker-admin-${randomUUID()}`;
    const baseUrl = `http://127.0.0.1:${apiPort}`;
    const composeSubnet = randomComposeSubnet();
    const env = {
      ...process.env,
      COMPOSE_PROJECT_NAME: project,
      NODE_BASE_IMAGE: process.env.NODE_BASE_IMAGE ?? "node:24-bookworm",
      NODE_ENV: "development",
      OCC_HOST: "0.0.0.0",
      OCC_PORT: INTERNAL_API_PORT,
      OPENCLAW_DEV_PORT: String(apiPort),
      OCC_POSTGRES_PORT: String(postgresPort),
      OCC_DATABASE_URL: "postgresql://occ_app:occ-app-local@postgres:5432/openclaw_enterprise",
      OCC_MIGRATION_DATABASE_URL:
        "postgresql://occ_migrator:occ-migrator-local@postgres:5432/openclaw_enterprise",
      OCC_AUTH_BASE_URL: baseUrl,
      OPENCLAW_DEV_EMAIL: adminEmail,
      OPENCLAW_DEV_PASSWORD: adminPassword,
      OPENCLAW_DEV_INSTALLATION_NAME: `OpenClaw Docker Compute ${project}`,
      OCC_DOCKER_RUNTIME_IMAGE: runtimeImage,
      OCC_DOCKER_GATEWAY_IMAGE: gatewayImage,
      OCC_DOCKER_AGENT_IMAGE: agentImage,
      OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR: composeSubnet,
      OPENAI_API_KEY: providerKey,
    };

    context.after(async () => {
      await cleanupProject(project, env, namespaceIds);
    });
    await cleanupProject(project, env);
    const composeSecrets = [providerKey, adminPassword];
    try {
      await docker(composeArguments(project, "up", ["--build", "--detach", "--wait"]), {
        env,
        timeoutMs: 300_000,
        secrets: composeSecrets,
      });
    } catch (error) {
      const logs = await composeFailureLogs(project, env, composeSecrets);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n\nDocker Compose failure logs for ${project}:\n${logs}`,
      );
    }

    await waitFor("OCC API to accept HTTP requests", async () => {
      const response = await fetch(new URL("/api/auth/session", baseUrl), {
        signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined);
      return response?.status === 200 ? true : undefined;
    });
    const session = await waitFor("development administrator sign-in", () =>
      signInWithEmailPassword({
        origin: baseUrl,
        email: adminEmail,
        password: adminPassword,
      }).catch(() => undefined),
    );
    const request = apiClient(baseUrl, session);

    const installation = await request("GET", "/installation");
    assert.equal(installation.status, 200, JSON.stringify(installation.error));
    assert.equal(installation.data.name, env.OPENCLAW_DEV_INSTALLATION_NAME);
    const bootstrap = await request("POST", "/installation/bootstrap", {
      name: `OpenClaw Docker Compute ${project}`,
    });
    assert.equal(bootstrap.status, 409, JSON.stringify(bootstrap.error));

    // Preserve development admission boundaries against the real Compose API listener.
    const unauthenticated = await request(
      "POST",
      "/namespaces",
      { name: `denied-unauthenticated-${project}` },
      { session: false },
    );
    assert.equal(unauthenticated.status, 401, JSON.stringify(unauthenticated));
    const forwarded = await request(
      "POST",
      "/namespaces",
      { name: `denied-forwarded-${project}` },
      { headers: { forwarded: "for=203.0.113.10;proto=https;host=attacker.invalid" } },
    );
    assert.equal(forwarded.status, 403, JSON.stringify(forwarded));

    const namespaces = [];
    for (const label of ["embedded", "dedicated", "cleanup"]) {
      const created = await request("POST", "/namespaces", {
        name: `${label}-${project}`,
      });
      assert.equal(
        created.status,
        201,
        `direct Better Auth session namespace mutation must succeed: ${JSON.stringify(created.error)}`,
      );
      namespaceIds.push(created.data.id);
      namespaces.push(created.data);
    }
    await Promise.all(
      namespaces.map((namespace) =>
        waitFor(`Namespace ${namespace.id} to become ready`, async () => {
          const current = await request("GET", `/namespaces/${namespace.id}`);
          assert.equal(current.status, 200, JSON.stringify(current.error));
          return current.data.status === "ready" ? current.data : undefined;
        }),
      ),
    );
    const [embeddedNamespace, dedicatedNamespace, cleanupNamespace] = namespaces;
    const embeddedNetwork = await waitForNamespaceNetwork(embeddedNamespace.id);
    const dedicatedNetwork = await waitForNamespaceNetwork(dedicatedNamespace.id);
    const cleanupNetwork = await waitForNamespaceNetwork(cleanupNamespace.id);
    assert.equal(
      new Set([embeddedNetwork.Name, dedicatedNetwork.Name, cleanupNetwork.Name]).size,
      3,
      "each Namespace must receive a dedicated Docker network",
    );
    for (const namespace of [embeddedNamespace, dedicatedNamespace, cleanupNamespace]) {
      assert.equal(
        await containerCount([[LABEL_NAMESPACE, namespace.id]]),
        0,
        "Namespace provisioning must not start Agent-owned containers",
      );
    }

    const embedded = await createAgentJourney({
      request,
      namespaceId: embeddedNamespace.id,
      mode: "embedded",
      label: "embedded",
    });
    const dedicated = await createAgentJourney({
      request,
      namespaceId: dedicatedNamespace.id,
      mode: "dedicated",
      label: "dedicated",
    });

    const [embeddedGateway] = await waitForContainers(
      [
        [LABEL_NAMESPACE, embeddedNamespace.id],
        [LABEL_AGENT, embedded.agent.id],
        [LABEL_REVISION, embedded.revision.id],
        [LABEL_ROLE, "gateway"],
      ],
      1,
      "embedded OpenClaw gateway container",
    );
    assert.ok(
      hasContainerEnv(embeddedGateway, "OPENAI_API_KEY"),
      "embedded gateway must receive the model credential",
    );
    assert.equal(
      await containerCount([
        [LABEL_NAMESPACE, embeddedNamespace.id],
        [LABEL_AGENT, embedded.agent.id],
        [LABEL_ROLE, "agent"],
      ]),
      0,
      "embedded execution must not start a separate Codex container",
    );

    const dedicatedGateway = (
      await waitForContainers(
        [
          [LABEL_NAMESPACE, dedicatedNamespace.id],
          [LABEL_AGENT, dedicated.agent.id],
          [LABEL_REVISION, dedicated.revision.id],
          [LABEL_ROLE, "gateway"],
        ],
        1,
        "dedicated gateway container",
      )
    )[0];
    const dedicatedAgent = (
      await waitForContainers(
        [
          [LABEL_NAMESPACE, dedicatedNamespace.id],
          [LABEL_AGENT, dedicated.agent.id],
          [LABEL_REVISION, dedicated.revision.id],
          [LABEL_ROLE, "agent"],
        ],
        1,
        "dedicated Codex app-server container",
      )
    )[0];
    assert.ok(
      !hasContainerEnv(dedicatedGateway, "OPENAI_API_KEY"),
      "dedicated gateway must not receive the model credential",
    );
    assert.ok(
      hasContainerEnv(dedicatedAgent, "OPENAI_API_KEY"),
      "dedicated Codex app-server must receive the model credential",
    );
    assert.ok(
      hasContainerEnv(dedicatedGateway, "APP_SERVER_URL") &&
        hasContainerEnv(dedicatedGateway, "APP_SERVER_TOKEN"),
      "dedicated gateway must receive only authenticated app-server transport",
    );
    assert.ok(
      hasContainerEnv(dedicatedAgent, "APP_SERVER_TOKEN"),
      "dedicated Codex app-server must receive the matching app-server token",
    );
    assertNamespaceOnlyAttachment(dedicatedAgent, dedicatedNetwork.Name);

    const embeddedToken = nonempty(
      containerEnv(embeddedGateway, "OPENCLAW_GATEWAY_TOKEN"),
      "embedded gateway token",
    );
    const dedicatedToken = nonempty(
      containerEnv(dedicatedGateway, "OPENCLAW_GATEWAY_TOKEN"),
      "dedicated gateway token",
    );
    await invokeGateway({
      networkName: embeddedNetwork.Name,
      gateway: embeddedGateway,
      gatewayToken: embeddedToken,
      mode: "embedded",
      onFailure: () => containerLogs([embeddedGateway], [embeddedToken]),
    });
    await invokeGateway({
      networkName: dedicatedNetwork.Name,
      gateway: dedicatedGateway,
      gatewayToken: dedicatedToken,
      mode: "dedicated",
      onFailure: () => containerLogs([dedicatedGateway, dedicatedAgent], [dedicatedToken]),
    });

    const deleted = await request("DELETE", `/namespaces/${cleanupNamespace.id}`);
    assert.equal(deleted.status, 202, JSON.stringify(deleted.error));
    await waitFor(`cleanup Namespace ${cleanupNamespace.id} network removal`, async () => {
      return (await inspectNetworks(cleanupNamespace.id)).length === 0 ? true : undefined;
    });
    assert.equal((await inspectNetworks(embeddedNamespace.id)).length, 1);
    assert.equal((await inspectNetworks(dedicatedNamespace.id)).length, 1);
    assert.equal(
      await containerCount([
        [LABEL_NAMESPACE, embeddedNamespace.id],
        [LABEL_ROLE, "gateway"],
      ]),
      1,
    );
    assert.equal(
      await containerCount([
        [LABEL_NAMESPACE, dedicatedNamespace.id],
        [LABEL_ROLE, "gateway"],
      ]),
      1,
    );
  },
);
