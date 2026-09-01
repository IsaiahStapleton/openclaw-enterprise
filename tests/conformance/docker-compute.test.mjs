import assert from "node:assert/strict";
import test from "node:test";
import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";

const tenant = {
  id: "ns_00000000-0000-4000-8000-000000000001",
  name: "Docker conformance tenant",
  status: "ready",
  createdAt: "2026-09-01T00:00:00.000Z",
};

test("Docker Compute gateway containers keep token auth by default and omit it for trusted proxy auth", async () => {
  const defaultEnvironment = await gatewayContainerEnvironment();
  assert.match(defaultEnvironment.OPENCLAW_GATEWAY_TOKEN ?? "", /^[0-9a-f]{64}$/);
  assert.equal(defaultEnvironment.OPENCLAW_GATEWAY_PORT, "8080");

  const trustedProxyEnvironment = await gatewayContainerEnvironment({
    gateway: { auth: { mode: "trusted-proxy" } },
  });
  assert.equal(trustedProxyEnvironment.OPENCLAW_GATEWAY_TOKEN, undefined);
  assert.equal(trustedProxyEnvironment.OPENCLAW_GATEWAY_PORT, "8080");
});

async function gatewayContainerEnvironment(configuration = {}) {
  const driver = new DockerComputeDriver({
    images: { gateway: "gateway:local", agent: "agent:local" },
  });
  const revision = {
    id: `revision-${configuration.gateway?.auth?.mode ?? "default-token"}`,
    namespaceId: tenant.id,
    agentId: "agent-docker-token",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration,
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-docker-token",
    createdAt: tenant.createdAt,
  };
  const createdContainers = [];
  const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-api-key";
  driver.network = async () => ({
    Labels: {
      "org.openclaw.enterprise.managed": "true",
      "org.openclaw.enterprise.compute-driver": "docker",
      "org.openclaw.enterprise.namespace-id": tenant.id,
    },
  });
  driver.container = async () => {
    const latest = createdContainers.at(-1);
    if (latest === undefined) return undefined;
    return {
      Config: { Labels: latest.Labels },
      State: { Running: true, Health: { Status: "healthy" } },
    };
  };
  driver.request = async (method, path, body) => {
    if (method === "POST" && path.startsWith("/containers/create?")) {
      createdContainers.push(structuredClone(body));
      return "";
    }
    if (method === "POST" && path.startsWith("/containers/") && path.endsWith("/start")) {
      return "";
    }
    throw new Error(`Unexpected Docker API request ${method} ${path}`);
  };
  try {
    assert.deepEqual(await driver.prepareRevision(revision), {
      namespaceId: tenant.id,
      agentId: revision.agentId,
      revisionId: revision.id,
      ready: true,
    });
  } finally {
    if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
  }

  assert.equal(createdContainers.length, 1);
  return Object.fromEntries(createdContainers[0].Env.map((entry) => splitEnvironment(entry)));
}

function splitEnvironment(entry) {
  const separator = entry.indexOf("=");
  assert.ok(separator > 0, `Docker Env entry must be NAME=value: ${entry}`);
  return [entry.slice(0, separator), entry.slice(separator + 1)];
}
