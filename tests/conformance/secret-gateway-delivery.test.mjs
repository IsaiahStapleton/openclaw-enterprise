import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createKubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

const kubeconfigPath = "/tmp/openclaw-enterprise-conformance/kubeconfig";
const contextName = "openclaw-enterprise-local";
const tenant = {
  id: "ns_00000000-0000-4000-8000-000000000014",
  name: "Secret gateway delivery tenant",
  status: "ready",
  createdAt: "2026-08-28T00:00:00.000Z",
};

function options(overrides = {}) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };

  return {
    authentication: { mode: "kubeconfig", kubeconfigPath, context: contextName },
    images: {
      gateway: "openclaw-enterprise/gateway-fixture:local",
      agent: "openclaw-enterprise/agent-fixture:local",
      requireImmutableDigest: false,
    },
    resources: {
      gateway: resources,
      agent: resources,
      namespace: {
        quota: { pods: "10", "requests.cpu": "2", "requests.memory": "1Gi" },
        containerDefaults: resources,
      },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayPort: 8080,
      gatewayClients: [
        { namespace: "openclaw-controller", podLabels: { "app.kubernetes.io/name": "controller" } },
      ],
    },
    servicePrincipalCredentials: { mode: "disabled" },
    runtime: {
      transportSecretPrefix: "transport",
      modelSecretPrefix: "model",
      gatewayStorageClassName: "local-path",
    },
    ...overrides,
  };
}

function revision(driver, overrides = {}) {
  return {
    id: "revision-secret-gateway-delivery-1",
    namespaceId: tenant.id,
    agentId: "agent-secret-gateway-delivery",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000014",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
        redactSensitive: "tools",
      },
      diagnostics: { otel: { logs: false } },
      secrets: {
        providers: {
          model: { source: "env", allowlist: ["OPENAI_API_KEY"] },
        },
      },
      models: {
        providers: {
          openai: {
            apiKey: { source: "env", provider: "model", id: "OPENAI_API_KEY" },
          },
        },
      },
    },
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-secret-gateway-delivery",
    secretDriverId: "secret-kubernetes",
    secretBindings: {
      OPENAI_API_KEY: {
        source: {
          kind: "secret",
          namespaceId: tenant.id,
          id: "sec_00000000-0000-4000-8000-000000000014",
        },
      },
    },
    createdAt: tenant.createdAt,
    ...overrides,
  };
}

function projection(overrides = {}) {
  return {
    name: "OPENAI_API_KEY",
    secretId: "sec_00000000-0000-4000-8000-000000000014",
    namespaceId: tenant.id,
    agentId: "agent-secret-gateway-delivery",
    backendRef: {
      namespaceName: kubernetesNamespaceName(tenant.id),
      name: "stored-model-key",
      key: "value",
      uid: "uid-secret-gateway-delivery",
    },
    ...overrides,
  };
}

test("secret-gateway-delivery renders exact bound Namespace Secret env only into the gateway", () => {
  const driver = createKubernetesComputeDriver(options());
  const candidate = revision(driver);
  const namespace = kubernetesNamespaceName(tenant.id);
  const suffix = createHash("sha256").update(candidate.agentId).digest("hex").slice(0, 12);
  const secretEnvironment = driver.secretEnvironmentForRevision(
    candidate,
    {
      secretEnvironment: [projection()],
    },
    namespace,
  );

  const gateway = driver.deployment(
    `gateway-${suffix}`,
    { namespaceId: tenant.id, agentId: candidate.agentId },
    namespace,
    "openclaw-enterprise/gateway-fixture:local",
    `agent-${suffix}`,
    "gateway",
    {},
    driver.gatewayConfiguration(candidate).loggingLevel,
    driver.gatewayConfiguration(candidate),
    true,
    candidate.servicePrincipalId,
    undefined,
    [],
    secretEnvironment,
  );
  const environment = Object.fromEntries(
    gateway.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );

  // The explicit binding replaces the legacy per-Agent model Secret and remains required.
  assert.deepEqual(environment.OPENAI_API_KEY.valueFrom.secretKeyRef, {
    name: "stored-model-key",
    key: "value",
    optional: false,
  });
  assert.notEqual(environment.OPENAI_API_KEY.valueFrom.secretKeyRef.name, `model-${suffix}`);
  assert.ok(environment.OPENCLAW_GATEWAY_TOKEN);
  assert.equal(environment.APP_SERVER_TOKEN, undefined);
  assert.equal(environment.CODEX_ACCESS_TOKEN, undefined);

  assert.throws(
    () =>
      driver.deployment(
        `agent-${suffix}`,
        { namespaceId: tenant.id, agentId: candidate.agentId, revisionId: candidate.id },
        namespace,
        "openclaw-enterprise/agent-fixture:local",
        `agent-${suffix}`,
        "agent",
        {},
        "info",
        undefined,
        false,
        undefined,
        undefined,
        [],
        secretEnvironment,
      ),
    /only be delivered to Agent gateways/i,
  );

  const sharedConsumer = revision(driver, {
    id: "revision-secret-gateway-delivery-shared",
    agentId: "agent-secret-gateway-delivery-shared",
    servicePrincipalId: "service-principal-secret-gateway-delivery-shared",
  });
  assert.deepEqual(
    driver.secretEnvironmentForRevision(
      sharedConsumer,
      {
        secretEnvironment: [projection({ agentId: sharedConsumer.agentId })],
      },
      namespace,
    ),
    [projection({ agentId: sharedConsumer.agentId })],
  );
});

test("secret-gateway-delivery rejects missing, foreign, and dedicated model projections", () => {
  const driver = createKubernetesComputeDriver(options());
  const candidate = revision(driver);
  const namespace = kubernetesNamespaceName(tenant.id);

  assert.throws(
    () => driver.secretEnvironmentForRevision(candidate, undefined, namespace),
    /does not match AgentRevision bindings/i,
  );
  assert.throws(
    () =>
      driver.secretEnvironmentForRevision(
        candidate,
        {
          secretEnvironment: [projection({ agentId: "another-agent" })],
        },
        namespace,
      ),
    /does not match AgentRevision bindings/i,
  );
  assert.throws(
    () =>
      driver.secretEnvironmentForRevision(
        candidate,
        {
          secretEnvironment: [projection({ backendRef: { ...projection().backendRef, name: "" } })],
        },
        namespace,
      ),
    /does not match AgentRevision bindings/i,
  );
  assert.throws(
    () =>
      driver.secretEnvironmentForRevision(
        revision(driver, {
          harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
        }),
        { secretEnvironment: [projection()] },
        namespace,
      ),
    /Dedicated Codex runtimes cannot bind gateway model credentials/i,
  );
  assert.throws(
    () =>
      driver.secretEnvironmentForRevision(
        revision(driver, {
          secretBindings: {
            APP_SERVER_TOKEN: {
              source: {
                kind: "secret",
                namespaceId: tenant.id,
                id: "sec_00000000-0000-4000-8000-000000000014",
              },
            },
          },
        }),
        { secretEnvironment: [projection({ name: "APP_SERVER_TOKEN" })] },
        namespace,
      ),
    /Secret bindings are invalid/i,
  );
});
