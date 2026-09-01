import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
  kubernetesNamespaceName,
  resolveKubernetesNamespace,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

const kubeconfigPath = "/tmp/openclaw-enterprise-conformance/kubeconfig";
const contextName = "openclaw-enterprise-local";
const tenant = {
  id: "ns_00000000-0000-4000-8000-000000000001",
  name: "Conformance tenant",
  status: "ready",
  createdAt: "2026-08-18T00:00:00.000Z",
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
    ...overrides,
  };
}

function labelsToSelectorForTest(labels) {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

test("Kubernetes namespace names are deterministic, DNS-safe, distinct, and bounded", () => {
  for (const id of ["Namespace_With.UPPERCASE!punctuation", "x".repeat(250), "---"]) {
    const name = kubernetesNamespaceName(id);
    const suffix = createHash("sha256").update(id).digest("hex").slice(0, 12);

    assert.equal(name, kubernetesNamespaceName(id));
    assert.match(name, /^oce-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    assert.ok(name.length <= 63);
    assert.ok(name.endsWith(suffix));
  }

  // Distinct tenant identifiers must not collide when their readable names normalize equally.
  assert.notEqual(kubernetesNamespaceName("Team A"), kubernetesNamespaceName("Team-A"));
});

test("namespace resolver selects exact, secure external ownership using a transport-only fixture", async () => {
  const external = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: "customer-support",
      labels: {
        "app.kubernetes.io/managed-by": "helm",
        "openclaw.dev/namespace": tenant.id,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: {
        "openclaw.dev/namespace-id": tenant.id,
        "openclaw.dev/namespace-lifecycle": "external",
      },
    },
    status: { phase: "Active" },
  };
  // The fixture supplies Kubernetes response data only; the actual resolver makes every decision.
  const discover = (items) =>
    resolveKubernetesNamespace(
      {
        async listNamespace(request) {
          assert.equal(request.labelSelector, `openclaw.dev/namespace=${tenant.id}`);
          return { apiVersion: "v1", kind: "NamespaceList", items };
        },
      },
      tenant.id,
    );

  assert.deepEqual(await discover([external]), { name: "customer-support", external: true });
  assert.deepEqual(await discover([]), {
    name: kubernetesNamespaceName(tenant.id),
    external: false,
  });

  const managed = structuredClone(external);
  managed.metadata.name = kubernetesNamespaceName(tenant.id);
  managed.metadata.labels["app.kubernetes.io/managed-by"] = "openclaw-enterprise";
  delete managed.metadata.annotations["openclaw.dev/namespace-lifecycle"];
  assert.deepEqual(await discover([managed]), { name: managed.metadata.name, external: false });

  await assert.rejects(discover([external, structuredClone(external)]), /multiple/i);
  for (const [mutate, expected] of [
    [(item) => (item.metadata.name = ""), /unowned/i],
    [
      (item) => (item.metadata.annotations["openclaw.dev/namespace-id"] = "another-tenant"),
      /unowned/i,
    ],
    [
      (item) => delete item.metadata.annotations["openclaw.dev/namespace-lifecycle"],
      /external ownership/i,
    ],
    [
      (item) => (item.metadata.labels["pod-security.kubernetes.io/enforce"] = "baseline"),
      /restricted/i,
    ],
    [(item) => (item.status.phase = "Pending"), /active/i],
    [(item) => (item.metadata.deletionTimestamp = "2026-08-25T00:00:00Z"), /active/i],
  ]) {
    // Each rejection exercises the real resolver against malformed, ambiguous, or unsafe ownership.
    const invalid = structuredClone(external);
    mutate(invalid);
    await assert.rejects(discover([invalid]), expected);
  }
});

test("explicit existing namespace adoption claims tenant identity only after security checks", async () => {
  const selection = { ...tenant, status: "provisioning", existingNamespace: "customer-support" };
  const prepared = () => ({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: selection.existingNamespace,
      resourceVersion: "7",
      labels: {
        "app.kubernetes.io/managed-by": "helm",
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: { "openclaw.dev/namespace-lifecycle": "external", "example.dev/keep": "yes" },
    },
    status: { phase: "Active" },
  });
  const httpError = (statusCode) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });

  const run = async ({
    mutate,
    policies,
    conflict,
    forbiddenPolicies,
    claims,
    deleting,
    unselected,
  } = {}) => {
    let observed = prepared();
    mutate?.(observed);
    const patches = [];
    const driver = createKubernetesComputeDriver(options());
    // The fixture supplies transport responses only; adoption, validation, and mutation order
    // are exercised through the production driver's real ensureNamespace implementation.
    driver.apiClients = Promise.resolve({
      core: {
        async listNamespace({ labelSelector }) {
          assert.equal(labelSelector, `openclaw.dev/namespace=${tenant.id}`);
          return { items: claims ?? [] };
        },
        async readNamespace({ name }) {
          assert.equal(name, selection.existingNamespace);
          if (observed === undefined) throw httpError(404);
          return structuredClone(observed);
        },
        async patchNamespace(request) {
          patches.push(structuredClone(request));
          if (conflict !== undefined) {
            conflict(observed);
            throw httpError(409);
          }
          const metadata = request.body.metadata;
          observed.metadata = {
            ...observed.metadata,
            labels: { ...observed.metadata.labels, ...metadata.labels },
            annotations: { ...observed.metadata.annotations, ...metadata.annotations },
          };
        },
        async readNamespacedResourceQuota() {
          // Stop at the first namespaced infrastructure request after successful adoption.
          throw httpError(403);
        },
      },
      networking: {
        async listNamespacedNetworkPolicy({ namespace }) {
          assert.equal(namespace, selection.existingNamespace);
          if (forbiddenPolicies) throw httpError(403);
          return { items: policies ?? [] };
        },
      },
    });
    if (mutate === null) observed = undefined;
    const result = deleting
      ? await driver.deleteNamespace({ ...selection, status: "deleting" })
      : await driver.ensureNamespace(
          unselected ? { ...tenant, status: "provisioning" } : selection,
        );
    return { result, observed, patches };
  };

  const adopted = await run();
  assert.deepEqual(adopted.result, { namespaceId: tenant.id, namespaceReady: false });
  assert.deepEqual(adopted.patches, [
    {
      name: selection.existingNamespace,
      body: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: selection.existingNamespace,
          resourceVersion: "7",
          labels: { "openclaw.dev/namespace": tenant.id },
          annotations: { "openclaw.dev/namespace-id": tenant.id },
        },
      },
      fieldManager: "openclaw-enterprise-compute",
      force: false,
    },
  ]);
  assert.equal(adopted.observed.metadata.labels["app.kubernetes.io/managed-by"], "helm");
  assert.equal(adopted.observed.metadata.annotations["example.dev/keep"], "yes");
  assert.equal(
    adopted.observed.metadata.annotations["openclaw.dev/namespace-lifecycle"],
    "external",
  );

  const neverAdopted = await run({ deleting: true });
  assert.deepEqual(neverAdopted.result, { namespaceId: tenant.id, namespaceDeleted: true });
  assert.deepEqual(neverAdopted.patches, []);

  for (const mutate of [
    (namespace) => (namespace.metadata.labels["openclaw.dev/namespace"] = tenant.id),
    (namespace) => (namespace.metadata.annotations["openclaw.dev/namespace-id"] = tenant.id),
    (namespace) => (namespace.metadata.annotations["openclaw.dev/namespace-id"] = "ns_other"),
  ]) {
    const ambiguous = await run({ mutate, deleting: true });
    assert.deepEqual(ambiguous.result, {
      namespaceId: tenant.id,
      namespaceDeleted: false,
      failure: "permanent",
    });
    assert.deepEqual(ambiguous.patches, []);
  }

  const duplicateClaim = await run({ claims: [{ metadata: { name: "another-namespace" } }] });
  assert.equal(duplicateClaim.result.failure, "permanent");
  assert.deepEqual(duplicateClaim.patches, []);

  const implicitlyClaimedNamespace = prepared();
  implicitlyClaimedNamespace.metadata.labels["openclaw.dev/namespace"] = tenant.id;
  implicitlyClaimedNamespace.metadata.annotations["openclaw.dev/namespace-id"] = tenant.id;
  const implicitAdoption = await run({ claims: [implicitlyClaimedNamespace], unselected: true });
  assert.deepEqual(implicitAdoption.result, {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "permanent",
  });
  assert.deepEqual(implicitAdoption.patches, []);

  for (const mutate of [
    null,
    (namespace) => delete namespace.metadata.annotations["openclaw.dev/namespace-lifecycle"],
    (namespace) => (namespace.metadata.labels["pod-security.kubernetes.io/enforce"] = "baseline"),
    (namespace) => (namespace.metadata.labels["openclaw.dev/namespace"] = "other-tenant"),
    (namespace) => (namespace.metadata.annotations["openclaw.dev/namespace-id"] = "ns_other"),
    (namespace) => (namespace.status.phase = "Terminating"),
    (namespace) => (namespace.metadata.deletionTimestamp = "2026-08-26T00:00:00.000Z"),
    (namespace) => delete namespace.metadata.resourceVersion,
  ]) {
    const rejected = await run({ mutate });
    assert.deepEqual(rejected.result, {
      namespaceId: tenant.id,
      namespaceReady: false,
      failure: "permanent",
    });
    assert.deepEqual(rejected.patches, []);
  }

  const foreignPolicies = await run({
    policies: [
      {
        kind: "NetworkPolicy",
        metadata: { name: "foreign", namespace: selection.existingNamespace },
      },
    ],
  });
  assert.equal(foreignPolicies.result.failure, "permanent");
  assert.deepEqual(foreignPolicies.patches, []);

  const inaccessible = await run({ forbiddenPolicies: true });
  assert.deepEqual(inaccessible.result, { namespaceId: tenant.id, namespaceReady: false });
  assert.deepEqual(inaccessible.patches, []);

  const competingTenant = await run({
    conflict(namespace) {
      namespace.metadata.labels["openclaw.dev/namespace"] = "another-tenant";
      namespace.metadata.annotations["openclaw.dev/namespace-id"] = "ns_another";
    },
  });
  assert.equal(competingTenant.result.failure, "permanent");
  assert.equal(competingTenant.patches.length, 1);

  const sameTenant = await run({
    conflict(namespace) {
      namespace.metadata.labels["openclaw.dev/namespace"] = tenant.id;
      namespace.metadata.annotations["openclaw.dev/namespace-id"] = tenant.id;
    },
  });
  assert.deepEqual(sameTenant.result, { namespaceId: tenant.id, namespaceReady: false });
  assert.equal(sameTenant.patches.length, 1);
});

test("dedicated Agent shared claims retain ownership inside an existing tenant namespace", () => {
  const driver = createKubernetesComputeDriver(options());
  const agentId = "agt_00000000-0000-4000-8000-000000000001";
  const ownership = { namespaceId: tenant.id, agentId };

  // Exercise the real PVC serializer against discovered placement, not a simulated cluster.
  const claim = driver.sharedWorkspaceClaim(agentId, ownership, "customer-support");
  assert.equal(claim.metadata.namespace, "customer-support");
  assert.equal(claim.metadata.annotations["openclaw.dev/namespace-id"], tenant.id);
  assert.equal(claim.metadata.annotations["openclaw.dev/agent-id"], agentId);
  assert.deepEqual(claim.spec.accessModes, ["ReadWriteMany"]);
  assert.equal(claim.spec.resources.requests.storage, "40Gi");
});

test("Kubernetes drivers require explicit authentication, images, and production policy", () => {
  for (const [invalid, expected] of [
    [{ authentication: undefined }, /authentication|credential/i],
    [{ authentication: { mode: "kubeconfig", kubeconfigPath, context: "" } }, /context/i],
    [
      {
        authentication: {
          mode: "kubeconfig",
          kubeconfigPath: "relative/config",
          context: contextName,
        },
      },
      /absolute/i,
    ],
    [{ authentication: { mode: "ambient" } }, /authentication|mode|credential/i],
    [{ images: { gateway: "", agent: "agent:local", requireImmutableDigest: false } }, /gateway/i],
    [{ images: { gateway: "gateway:local", agent: "", requireImmutableDigest: false } }, /agent/i],
    [{ resources: undefined }, /resource/i],
    [{ network: undefined }, /network/i],
    [{ servicePrincipalCredentials: undefined }, /credential|projection/i],
  ]) {
    assert.throws(() => createKubernetesComputeDriver(options(invalid)), expected);
  }

  assert.doesNotThrow(() =>
    createKubernetesComputeDriver(options({ authentication: { mode: "inCluster" } })),
  );
});

test("the canonical Kubernetes runtime isolates transport and model Agent Secrets", () => {
  const runtime = {
    transportSecretPrefix: "transport",
    gatewayStorageClassName: "local-path",
    modelSecretPrefix: "model",
  };
  assert.doesNotThrow(() => createKubernetesComputeDriver(options({ runtime })));
  for (const shared of [
    {
      transportSecretPrefix: "shared",
      gatewayStorageClassName: "local-path",
      modelSecretPrefix: "shared",
    },
    { ...runtime, channels: { secretPrefix: "transport", proxyUrl: "http://10.42.0.15:3128" } },
    { ...runtime, channels: { secretPrefix: "model", proxyUrl: "http://10.42.0.15:3128" } },
  ]) {
    assert.throws(
      () => createKubernetesComputeDriver(options({ runtime: shared })),
      /credentials must remain separate/i,
    );
  }

  for (const proxyUrl of ["http://10.42.0.15:3128", "https://[2001:db8::15]:8443"]) {
    const channels = { secretPrefix: "channel", proxyUrl };
    assert.doesNotThrow(() =>
      createKubernetesComputeDriver(options({ runtime: { ...runtime, channels } })),
    );
  }
  for (const proxyUrl of [
    "http://proxy.internal:3128",
    "https://192.0.2.15",
    "https://operator:secret@10.42.0.15:3128",
    "socks5://10.42.0.15:3128",
    "http://10.42.0.15:3128/unreviewed",
    "http://10.42.0.15:3128?token=secret",
  ]) {
    const channels = { secretPrefix: "channel", proxyUrl };
    assert.throws(
      () => createKubernetesComputeDriver(options({ runtime: { ...runtime, channels } })),
      /HTTP\(S\) IP endpoint/i,
    );
  }

  assert.throws(
    () =>
      createKubernetesComputeDriver(
        options({
          runtime: {
            ...runtime,
            channels: { secretPrefix: " ", proxyUrl: "http://10.42.0.15:3128" },
          },
        }),
      ),
    /channel Secret name prefix/i,
  );
});

test("account-owned Kubernetes Secrets reject invalid or foreign credentials before cluster access", async () => {
  const driver = createKubernetesComputeDriver(options());
  const serviceAccountId = "sa_00000000-0000-4000-8000-000000000001";
  const secretName = `service-account-${createHash("sha256")
    .update(serviceAccountId)
    .digest("hex")
    .slice(0, 32)}`;

  for (const invalid of [
    { namespaceId: "", serviceAccountId, accessToken: "token", workspaceId: "ws_1" },
    { namespaceId: tenant.id, serviceAccountId: "", accessToken: "token", workspaceId: "ws_1" },
    { namespaceId: tenant.id, serviceAccountId, accessToken: "", workspaceId: "ws_1" },
    { namespaceId: tenant.id, serviceAccountId, accessToken: "token", workspaceId: "" },
  ]) {
    // Incomplete account credentials cannot trigger Kubernetes requests or Secret mutations.
    await assert.rejects(driver.storeServiceAccountCredential(invalid), /must be explicitly/i);
  }

  for (const secretRef of [
    { name: "another-account-secret", key: "token" },
    { name: secretName, key: "another-key" },
  ]) {
    // Rollback and deletion are restricted to the deterministic Secret owned by this account.
    await assert.rejects(
      driver.deleteServiceAccountCredential({
        namespaceId: tenant.id,
        serviceAccountId,
        secretRef,
      }),
      /another ServiceAccount/i,
    );
  }
});

test("dedicated Codex projects the account-owned token and workspace without exposing either to its gateway", () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        modelSecretPrefix: "model",
        channels: { secretPrefix: "channel", proxyUrl: "http://10.42.0.15:3128" },
      },
    }),
  );
  const agentId = "agent-service-account";
  const serviceAccountId = "sa_00000000-0000-4000-8000-000000000001";
  const secretName = `service-account-${createHash("sha256")
    .update(serviceAccountId)
    .digest("hex")
    .slice(0, 32)}`;
  const account = {
    id: serviceAccountId,
    credential: { kind: "access_token", secretRef: { name: secretName, key: "token" } },
  };
  const namespace = kubernetesNamespaceName(tenant.id);
  const ownership = { namespaceId: tenant.id, agentId };
  const workload = driver.deployment(
    "codex-agent",
    ownership,
    namespace,
    "agent:local",
    "codex-agent",
    "agent",
    {},
    undefined,
    false,
    undefined,
    account,
  );
  const agentEnvironment = Object.fromEntries(
    workload.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );

  // Both values come from the one immutable account-owned reference; no Agent copy is created.
  assert.deepEqual(agentEnvironment.CODEX_ACCESS_TOKEN.valueFrom.secretKeyRef, {
    name: secretName,
    key: "token",
  });
  assert.deepEqual(agentEnvironment.CODEX_CHATGPT_WORKSPACE_ID.valueFrom.secretKeyRef, {
    name: secretName,
    key: "workspace-id",
  });
  assert.equal(agentEnvironment.OPENAI_API_KEY, undefined);
  assert.equal(agentEnvironment.SLACK_APP_TOKEN, undefined);
  assert.equal(agentEnvironment.SLACK_BOT_TOKEN, undefined);
  assert.equal(agentEnvironment.MSTEAMS_APP_PASSWORD, undefined);

  const channels = driver.enabledChannels({
    configuration: { channels: { slack: {}, msteams: {} } },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
  });

  const gateway = driver.deployment(
    "codex-gateway",
    ownership,
    namespace,
    "gateway:local",
    "codex-gateway",
    "gateway",
    {},
    undefined,
    false,
    undefined,
    undefined,
    channels,
  );
  const gatewayEnvironment = new Set(
    gateway.spec.template.spec.containers[0].env.map(({ name }) => name),
  );
  assert.equal(gatewayEnvironment.has("CODEX_ACCESS_TOKEN"), false);
  assert.equal(gatewayEnvironment.has("CODEX_CHATGPT_WORKSPACE_ID"), false);
  assert.equal(gatewayEnvironment.has("OPENAI_API_KEY"), false);
  assert.equal(gatewayEnvironment.has("SLACK_APP_TOKEN"), true);
  assert.equal(gatewayEnvironment.has("SLACK_BOT_TOKEN"), true);
  assert.equal(gatewayEnvironment.has("MSTEAMS_APP_PASSWORD"), true);
});

test("account-token authentication grants only the exact Codex revision outbound HTTPS", () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        modelSecretPrefix: "model",
      },
    }),
  );
  const revision = {
    id: "revision-account-token-1",
    namespaceId: tenant.id,
    agentId: "agent-account-token",
    servicePrincipalId: "service-principal-account-token",
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
  };
  const namespace = kubernetesNamespaceName(tenant.id);
  const digest = (value, length = 32) =>
    createHash("sha256").update(value).digest("hex").slice(0, length);
  const policy = driver.agentAuthenticationNetworkPolicy(revision, namespace);

  // Login needs public HTTPS before readiness; candidate transport must remain closed until activation.
  assert.equal(policy.metadata.name, `allow-agent-auth-${digest(revision.agentId, 12)}`);
  assert.equal(
    policy.metadata.annotations["openclaw.dev/service-principal-id"],
    revision.servicePrincipalId,
  );
  assert.deepEqual(policy.spec.podSelector.matchLabels, {
    "openclaw.dev/workload-role": "agent",
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/revision": revision.id,
  });
  assert.deepEqual(policy.spec.policyTypes, ["Egress"]);
  assert.equal(policy.spec.ingress, undefined);
  assert.deepEqual(
    policy.spec.egress,
    driver.agentNetworkPolicies(revision, namespace)[1].spec.egress,
  );
  assert.deepEqual(policy.spec.egress[0].ports, [{ protocol: "TCP", port: 443 }]);
  assert.deepEqual(policy.spec.egress[0].to[0].ipBlock.except, [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
  ]);

  const successor = driver.agentAuthenticationNetworkPolicy(
    { ...revision, id: "revision-account-token-2" },
    namespace,
  );
  // One Agent-owned policy moves between candidates without leaving stale-revision egress behind.
  assert.equal(successor.metadata.name, policy.metadata.name);
  assert.notDeepEqual(successor.spec.podSelector, policy.spec.podSelector);
});

test("native channel providers supply only owning gateway secrets and reviewed proxy egress", async () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        modelSecretPrefix: "model",
        channels: { secretPrefix: "channel", proxyUrl: "http://10.42.0.15:3128" },
      },
    }),
  );
  const namespace = kubernetesNamespaceName(tenant.id);
  const agentId = "agent-a";
  const suffix = createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  const revision = {
    id: "revision-a-1",
    namespaceId: tenant.id,
    agentId,
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-agent-a",
    createdAt: tenant.createdAt,
  };

  for (const [channels, expectedSecrets] of [
    [{ slack: {} }, ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]],
    [{ msteams: { enabled: true } }, ["MSTEAMS_APP_PASSWORD"]],
    [
      { slack: { enabled: true }, msteams: { enabled: true } },
      ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "MSTEAMS_APP_PASSWORD"],
    ],
    [
      {
        defaults: { groupPolicy: "allowlist" },
        modelByChannel: { "slack:channel-a": "codex/model" },
        slack: { enabled: false },
        msteams: { enabled: false },
        unsupported: { enabled: false },
      },
      [],
    ],
    [{ defaults: {}, modelByChannel: {} }, []],
  ]) {
    const configuredRevision = { ...revision, configuration: { channels } };
    const enabled = driver.enabledChannels(configuredRevision);
    const gateway = driver.deployment(
      `gateway-${suffix}`,
      { namespaceId: tenant.id, agentId },
      namespace,
      "openclaw-enterprise/gateway-fixture:local",
      `gateway-${suffix}`,
      "gateway",
      {},
      undefined,
      false,
      undefined,
      undefined,
      enabled,
    );
    const environment = gateway.spec.template.spec.containers[0].env;

    // Native Teams IDs are ordinary configuration values; only its password is a Secret.
    for (const key of [
      "SLACK_APP_TOKEN",
      "SLACK_BOT_TOKEN",
      "MSTEAMS_APP_PASSWORD",
      "MSTEAMS_APP_ID",
      "MSTEAMS_TENANT_ID",
    ]) {
      const variable = environment.find(({ name }) => name === key);
      if (expectedSecrets.includes(key)) {
        assert.deepEqual(variable.valueFrom.secretKeyRef, { name: `channel-${suffix}`, key });
        assert.equal(environment.filter(({ name }) => name === key).length, 1);
      } else {
        assert.equal(variable, undefined);
      }
    }
    const proxy = environment.filter(({ name }) => name === "HTTPS_PROXY");
    assert.deepEqual(
      proxy,
      expectedSecrets.length === 0
        ? []
        : [{ name: "HTTPS_PROXY", value: "http://10.42.0.15:3128" }],
    );

    const policy = driver.channelNetworkPolicy(configuredRevision, enabled, namespace);
    assert.deepEqual(
      policy.spec.egress,
      expectedSecrets.length === 0
        ? []
        : [
            {
              to: [{ ipBlock: { cidr: "10.42.0.15/32" } }],
              ports: [{ protocol: "TCP", port: 3128 }],
            },
          ],
    );

    // Dedicated Agents never receive gateway-owned channel credentials or their network proxy.
    const agent = driver.deployment(
      `agent-${suffix}`,
      { namespaceId: tenant.id, agentId, servicePrincipalId: revision.servicePrincipalId },
      namespace,
      "openclaw-enterprise/agent-fixture:local",
      `agent-${suffix}`,
      "agent",
    );
    const agentEnvironment = agent.spec.template.spec.containers[0].env;
    for (const key of [...expectedSecrets, "HTTPS_PROXY"]) {
      assert.equal(
        agentEnvironment.some(({ name }) => name === key),
        false,
      );
    }
  }

  // Removing channel runtime must revoke the exact existing grant without needing its old proxy.
  const activeRevision = { ...revision, configuration: { channels: { slack: {} } } };
  const previouslyGranted = driver.channelNetworkPolicy(
    activeRevision,
    driver.enabledChannels(activeRevision),
    namespace,
  );
  for (const runtime of [
    {
      transportSecretPrefix: "transport",
      gatewayStorageClassName: "local-path",
      modelSecretPrefix: "model",
    },
    undefined,
  ]) {
    const removed = createKubernetesComputeDriver(options({ runtime }));
    const disabledRevision = {
      ...revision,
      compute: { id: removed.id, implementation: removed.implementation },
      configuration: { channels: { slack: { enabled: false } } },
    };
    const revoked = removed.channelNetworkPolicy(
      disabledRevision,
      removed.enabledChannels(disabledRevision),
      namespace,
    );
    assert.equal(revoked.metadata.name, previouslyGranted.metadata.name);
    assert.deepEqual(revoked.metadata.labels, previouslyGranted.metadata.labels);
    assert.deepEqual(revoked.metadata.annotations, previouslyGranted.metadata.annotations);
    assert.deepEqual(revoked.spec.podSelector, previouslyGranted.spec.podSelector);
    assert.deepEqual(revoked.spec.policyTypes, ["Egress"]);
    assert.deepEqual(revoked.spec.egress, []);
  }

  await assert.rejects(
    driver.prepareRevision({
      ...revision,
      configuration: { channels: { discord: { enabled: true } } },
    }),
    /Unsupported OpenClaw channel provider "discord"\./,
  );

  const ipv6 = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        modelSecretPrefix: "model",
        channels: { secretPrefix: "channel", proxyUrl: "https://[2001:db8::15]:8443" },
      },
    }),
  );
  const teamsRevision = {
    ...revision,
    compute: { id: ipv6.id, implementation: ipv6.implementation },
    configuration: { channels: { msteams: {} } },
  };
  const ipv6Policy = ipv6.channelNetworkPolicy(
    teamsRevision,
    ipv6.enabledChannels(teamsRevision),
    namespace,
  );
  assert.deepEqual(ipv6Policy.spec.egress, [
    {
      to: [{ ipBlock: { cidr: "2001:db8::15/128" } }],
      ports: [{ protocol: "TCP", port: 8443 }],
    },
  ]);
});

test("embedded replacement preparation recovers past an unready active gateway without replacing it before activation", async () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        modelSecretPrefix: "model",
        gatewayStorageClassName: "local-path",
      },
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
    }),
  );
  const namespace = kubernetesNamespaceName(tenant.id);
  const agentId = "agent-embedded-recovery";
  const suffix = createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  const base = {
    namespaceId: tenant.id,
    agentId,
    configurationId: "cfg_00000000-0000-4000-8000-000000000077",
    configurationKind: "agent",
    configurationGeneration: 1,
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-embedded-recovery",
    createdAt: tenant.createdAt,
  };
  const oldRevision = {
    ...base,
    id: "revision-embedded-recovery-bad",
    revision: 7,
    configuration: { models: { providers: { openai: { apiKey: { source: "env" } } } } },
  };
  const replacement = {
    ...base,
    id: "revision-embedded-recovery-restored",
    revision: 8,
    configuration: { models: { providers: { openai: { apiKey: { source: "env" } } } } },
  };
  const tenantOwnership = { namespaceId: tenant.id };
  const gatewayOwnership = { namespaceId: tenant.id, agentId };
  const agentOwnership = {
    namespaceId: tenant.id,
    agentId,
    servicePrincipalId: replacement.servicePrincipalId,
  };
  const gatewayName = `gateway-${suffix}`;
  const agentName = `agent-${suffix}`;
  const objects = new Map();
  const key = (kind, name) => `${kind}:${name}`;
  const save = (object) =>
    objects.set(key(object.kind, object.metadata.name), structuredClone(object));
  const missing = (name) => Object.assign(new Error(`${name} not found`), { statusCode: 404 });

  save({
    ...driver.manifest("v1", "Namespace", namespace, tenantOwnership),
    status: { phase: "Active" },
  });
  for (const policy of driver.networkPolicies(tenantOwnership, namespace)) save(policy);
  save({
    ...driver.manifest("v1", "ServiceAccount", agentName, agentOwnership, namespace),
    automountServiceAccountToken: false,
  });
  save({
    ...driver.deployment(
      gatewayName,
      gatewayOwnership,
      namespace,
      "openclaw-enterprise/gateway-fixture:local",
      agentName,
      "gateway",
      {},
      driver.gatewayConfiguration(oldRevision),
      true,
      oldRevision.servicePrincipalId,
    ),
    metadata: {
      ...driver.deployment(
        gatewayName,
        gatewayOwnership,
        namespace,
        "openclaw-enterprise/gateway-fixture:local",
        agentName,
        "gateway",
        {},
        driver.gatewayConfiguration(oldRevision),
        true,
        oldRevision.servicePrincipalId,
      ).metadata,
      generation: 2,
    },
    status: { observedGeneration: 2, readyReplicas: 0 },
  });
  save(
    driver.service(gatewayName, gatewayOwnership, namespace, {
      "app.kubernetes.io/name": gatewayName,
    }),
  );

  const patches = [];
  let replacementDeploymentPatched = false;
  driver.apiClients = Promise.resolve({
    core: {
      async listNamespace({ labelSelector }) {
        assert.equal(labelSelector, `openclaw.dev/namespace=${tenant.id}`);
        return { items: [] };
      },
      async readNamespace({ name }) {
        return structuredClone(objects.get(key("Namespace", name)) ?? missing(name));
      },
      async readNamespacedConfigMap({ name }) {
        const current = objects.get(key("ConfigMap", name));
        if (current === undefined) throw missing(name);
        return structuredClone(current);
      },
      async patchNamespacedConfigMap({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save(body);
      },
      async readNamespacedServiceAccount({ name }) {
        const current = objects.get(key("ServiceAccount", name));
        if (current === undefined) throw missing(name);
        return structuredClone(current);
      },
      async patchNamespacedServiceAccount({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save(body);
      },
      async readNamespacedService({ name }) {
        const current = objects.get(key("Service", name));
        if (current === undefined) throw missing(name);
        return structuredClone(current);
      },
      async patchNamespacedService({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save(body);
      },
      async readNamespacedPersistentVolumeClaim({ name }) {
        const current = objects.get(key("PersistentVolumeClaim", name));
        if (current === undefined) throw missing(name);
        return structuredClone(current);
      },
      async patchNamespacedPersistentVolumeClaim({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save(body);
      },
    },
    apps: {
      async readNamespacedDeployment({ name }) {
        const current = objects.get(key("Deployment", name));
        if (current === undefined) throw missing(name);
        return structuredClone(current);
      },
      async patchNamespacedDeployment({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        replacementDeploymentPatched = true;
        save({
          ...body,
          metadata: { ...body.metadata, generation: 3 },
          status: { observedGeneration: 3, readyReplicas: 1 },
        });
      },
    },
    discovery: {
      async listNamespacedEndpointSlice() {
        assert.equal(
          replacementDeploymentPatched,
          true,
          "replacement preparation must not wait on the unready previous gateway",
        );
        return {
          items: [
            {
              metadata: { labels: { "kubernetes.io/service-name": gatewayName } },
              endpoints: [{ conditions: { ready: true } }],
            },
          ],
        };
      },
    },
    networking: {
      async readNamespacedNetworkPolicy({ name }) {
        const current = objects.get(key("NetworkPolicy", name));
        if (current === undefined) throw missing(name);
        return structuredClone(current);
      },
      async patchNamespacedNetworkPolicy({ body }) {
        patches.push({ kind: body.kind, name: body.metadata.name });
        save(body);
      },
    },
  });

  // The candidate revision is activation-ready after its immutable snapshot is staged;
  // the old crashed gateway stays in place until the worker wins the active-revision CAS.
  assert.deepEqual(await driver.prepareRevision(replacement), {
    namespaceId: tenant.id,
    agentId,
    revisionId: replacement.id,
    ready: true,
  });
  assert.deepEqual(
    patches.filter(({ kind }) => kind === "Deployment"),
    [],
  );
  assert.equal(
    objects.get(key("PersistentVolumeClaim", driver.gatewayPrivateStateClaimName(agentId)))
      ?.metadata.annotations["openclaw.dev/agent-id"],
    agentId,
  );
  assert.equal(
    objects.get(key("Deployment", gatewayName)).metadata.annotations[
      "openclaw.dev/agent-revision-id"
    ],
    oldRevision.id,
  );

  await driver.activateRevision(replacement);
  const replaced = objects.get(key("Deployment", gatewayName));
  assert.equal(replaced.metadata.annotations["openclaw.dev/agent-revision-id"], replacement.id);
  assert.deepEqual(
    patches.filter(({ kind }) => kind === "Deployment"),
    [{ kind: "Deployment", name: gatewayName }],
  );
});

test("SDK resource requirements still require explicit CPU and memory requests and limits", () => {
  const configured = options().resources;

  for (const [resources, expected] of [
    [
      { ...configured, gateway: { limits: { cpu: "250m", memory: "128Mi" } } },
      /Gateway requests and limits/i,
    ],
    [
      {
        ...configured,
        agent: { requests: { cpu: "100m", memory: "64Mi" }, limits: { cpu: "250m" } },
      },
      /Agent memory limit/i,
    ],
    [
      {
        ...configured,
        namespace: {
          ...configured.namespace,
          containerDefaults: {
            requests: { cpu: "100m" },
            limits: { cpu: "250m", memory: "128Mi" },
          },
        },
      },
      /Namespace default memory request/i,
    ],
  ]) {
    assert.throws(() => createKubernetesComputeDriver(options({ resources })), expected);
  }
});

test("production drivers reject injected clients and fail closed without their kubeconfig", async () => {
  for (const clients of [{}, undefined]) {
    assert.throws(
      () => createKubernetesComputeDriver({ ...options(), clients }),
      /client|inject|configuration/i,
    );
  }

  const inheritedClients = Object.assign(Object.create({ clients: {} }), options());
  assert.throws(() => createKubernetesComputeDriver(inheritedClients), /client|inject/i);

  const driver = createKubernetesComputeDriver(
    options({
      authentication: {
        mode: "kubeconfig",
        kubeconfigPath: `/tmp/openclaw-enterprise-conformance/missing-kubeconfig-${process.pid}`,
        context: contextName,
      },
    }),
  );

  assert.deepEqual(await driver.ensureNamespace(tenant), {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "retryable",
  });
});

test("Kubernetes lifecycle owners cannot be replaced after their first operation begins", async () => {
  const selected = {
    id: "configuration-selected",
    capability: "configuration",
    implementation: "local-selected",
    computeLifecycleHooks: { async afterNamespacePrepared() {} },
  };
  const driver = new KubernetesComputeDriver(options(), { lifecycleDrivers: [selected] });

  // Startup composition may configure trusted owners before any tenant resource is touched.
  assert.doesNotThrow(() => driver.setLifecycleDrivers([selected]));

  const operation = driver.ensureNamespace(tenant);

  // Freeze ownership synchronously so an in-flight reconciliation cannot lose its revocation owner.
  assert.throws(() => driver.setLifecycleDrivers([]), /owners cannot change.*operations begin/i);
  await operation;
  assert.throws(
    () => driver.setLifecycleDrivers([selected]),
    /owners cannot change.*operations begin/i,
  );
});

test("Kubernetes lifecycle hooks never run before cluster ownership and workload identity checks", async () => {
  const calls = [];
  const selected = {
    id: "configuration-selected",
    capability: "configuration",
    implementation: "local-selected",
    computeLifecycleHooks: {
      async afterNamespacePrepared() {
        calls.push("namespace-prepared");
      },
      async beforeWorkloadStart() {
        calls.push("workload-start");
      },
      async beforeWorkloadStop() {
        calls.push("workload-stop");
      },
      async beforeNamespaceDelete() {
        calls.push("namespace-delete");
      },
    },
  };
  const driver = new KubernetesComputeDriver(
    options({
      authentication: {
        mode: "kubeconfig",
        kubeconfigPath: `/tmp/openclaw-enterprise-conformance/missing-lifecycle-${process.pid}`,
        context: contextName,
      },
    }),
    { lifecycleDrivers: [selected] },
  );
  const foreignRevision = {
    id: "revision-foreign-1",
    namespaceId: tenant.id,
    agentId: "agent-foreign",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: { gateway: { controlUi: { enabled: false } }, logging: { level: "info" } },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    compute: { id: "another-driver", implementation: "another-implementation" },
    servicePrincipalId: "service-principal-agent-foreign",
    createdAt: tenant.createdAt,
  };

  // Hooks cannot prepare or revoke tenant infrastructure until its cluster ownership is verified.
  const namespacePreparation = await driver.ensureNamespace(tenant);
  assert.deepEqual(
    { ...namespacePreparation, failure: undefined },
    {
      namespaceId: tenant.id,
      namespaceReady: false,
      failure: undefined,
    },
  );
  assert.match(namespacePreparation.failure, /^(?:permanent|retryable)$/);
  const namespaceDeletion = await driver.deleteNamespace({ ...tenant, status: "deleting" });
  assert.deepEqual(
    { ...namespaceDeletion, failure: undefined },
    {
      namespaceId: tenant.id,
      namespaceDeleted: false,
      failure: undefined,
    },
  );
  assert.match(namespaceDeletion.failure, /^(?:permanent|retryable)$/);

  // Another Compute Driver's revision must never trigger this driver's credential lifecycle.
  assert.deepEqual(await driver.prepareRevision(foreignRevision), {
    namespaceId: tenant.id,
    agentId: foreignRevision.agentId,
    revisionId: foreignRevision.id,
    ready: false,
  });
  await assert.rejects(driver.retireRevision(foreignRevision), /another Compute Driver/i);
  assert.deepEqual(calls, []);
});

test("the official Kubernetes client rejects ambiguous identity and insecure API servers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-kubernetes-auth-conformance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const scenario of [
    { name: "unselected-context", context: "missing-context" },
    { name: "missing-credential-identity", users: [] },
    { name: "plaintext-api-endpoint", server: "http://127.0.0.1:1" },
    { name: "unverified-tls", skipTLSVerify: true },
    { name: "embedded-api-credentials", server: "https://user:password@127.0.0.1:1" },
    { name: "unexpected-api-path", server: "https://127.0.0.1:1/untrusted" },
  ]) {
    const path = join(directory, `${scenario.name}.json`);
    await writeFile(
      path,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            name: "conformance-cluster",
            cluster: {
              server: scenario.server ?? "https://127.0.0.1:1",
              ...(scenario.skipTLSVerify ? { "insecure-skip-tls-verify": true } : {}),
            },
          },
        ],
        users: scenario.users ?? [
          { name: "conformance-user", user: { token: "test-only-fixture-token" } },
        ],
        contexts: [
          {
            name: contextName,
            context: { cluster: "conformance-cluster", user: "conformance-user" },
          },
        ],
        "current-context": contextName,
      }),
    );

    const driver = createKubernetesComputeDriver(
      options({
        authentication: {
          mode: "kubeconfig",
          kubeconfigPath: path,
          context: scenario.context ?? contextName,
        },
      }),
    );

    // Unsafe cluster configuration is permanently rejected before contacting its API server.
    assert.deepEqual(
      await driver.ensureNamespace(tenant),
      {
        namespaceId: tenant.id,
        namespaceReady: false,
        failure: "permanent",
      },
      scenario.name,
    );
  }
});

test("immutable image policy accepts digests and rejects mutable tags", () => {
  assert.throws(
    () =>
      createKubernetesComputeDriver(
        options({
          images: {
            gateway: "registry.example/gateway:latest",
            agent: "registry.example/agent:latest",
            requireImmutableDigest: true,
          },
        }),
      ),
    /digest|immutable/i,
  );

  assert.doesNotThrow(() =>
    createKubernetesComputeDriver(
      options({
        images: {
          gateway: `registry.example/gateway@sha256:${"a".repeat(64)}`,
          agent: `registry.example/agent@sha256:${"b".repeat(64)}`,
          requireImmutableDigest: true,
        },
      }),
    ),
  );
});

test("projected ServicePrincipal tokens require an audience and bounded expiration", () => {
  for (const credentials of [
    { mode: "projectedServiceAccountToken", audience: "", expirationSeconds: 900 },
    { mode: "projectedServiceAccountToken", audience: "occ", expirationSeconds: 599 },
    { mode: "projectedServiceAccountToken", audience: "occ", expirationSeconds: 86_401 },
  ]) {
    assert.throws(
      () => createKubernetesComputeDriver(options({ servicePrincipalCredentials: credentials })),
      /audience|expiration|token/i,
    );
  }

  assert.doesNotThrow(() =>
    createKubernetesComputeDriver(
      options({
        servicePrincipalCredentials: {
          mode: "projectedServiceAccountToken",
          audience: "openclaw-controller",
          expirationSeconds: 900,
        },
      }),
    ),
  );
});

test("provider-owned Harness requirements preserve the exact projected ServicePrincipal identity", () => {
  const runtime = {
    transportSecretPrefix: "transport",
    gatewayStorageClassName: "local-path",
    modelSecretPrefix: "model",
  };
  const driver = createKubernetesComputeDriver(
    options({
      runtime,
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
    }),
  );
  const ownership = {
    namespaceId: tenant.id,
    agentId: "agt_00000000-0000-4000-8000-000000000001",
    revisionId: "rev_00000000-0000-4000-8000-000000000001",
    serviceAccountId: "sa_00000000-0000-4000-8000-000000000001",
    servicePrincipalId: "service-agent-agt_00000000-0000-4000-8000-000000000001",
  };
  const workload = driver.deployment(
    "agent-projected-identity",
    ownership,
    kubernetesNamespaceName(tenant.id),
    "agent:local",
    "agent-projected-identity",
    "agent",
  );

  const requirements = driver.harnessRequirementsFromDeployment(workload);
  // Provider requirements must carry readable identities unchanged into Pod labels and selectors.
  for (const [key, value] of Object.entries({
    "openclaw.dev/namespace": ownership.namespaceId,
    "openclaw.dev/agent": ownership.agentId,
    "openclaw.dev/revision": ownership.revisionId,
    "openclaw.dev/service-account": ownership.serviceAccountId,
    "openclaw.dev/service-principal": ownership.servicePrincipalId,
  })) {
    assert.equal(workload.metadata.labels[key], value);
    assert.equal(workload.spec.template.metadata.labels[key], value);
    assert.equal(requirements.labels[key], value);
  }
  assert.deepEqual(requirements.serviceAccountToken, {
    audience: "openclaw-controller",
    expirationSeconds: 900,
    mountPath: "/var/run/secrets/openclaw/service-principal",
    path: "token",
    readOnly: true,
  });

  for (const mutate of [
    (spec) => {
      spec.volumes = spec.volumes.filter(({ name }) => name !== "openclaw-service-principal");
    },
    (spec) => {
      spec.volumes.find(
        ({ name }) => name === "openclaw-service-principal",
      ).projected.sources[0].serviceAccountToken.audience = "another-audience";
    },
    (spec) => {
      spec.volumes.find(
        ({ name }) => name === "openclaw-service-principal",
      ).projected.sources[0].serviceAccountToken.expirationSeconds = 901;
    },
    (spec) => {
      spec.volumes.find(
        ({ name }) => name === "openclaw-service-principal",
      ).projected.sources[0].serviceAccountToken.path = "another-token";
    },
    (spec) => {
      spec.containers[0].volumeMounts.find(
        ({ name }) => name === "openclaw-service-principal",
      ).readOnly = false;
    },
    (spec) => {
      spec.containers[0].volumeMounts.find(
        ({ name }) => name === "openclaw-service-principal",
      ).mountPath = "/another-token-path";
    },
  ]) {
    // A provider must receive exactly the same audience, expiry, token path, and readonly mount.
    const altered = structuredClone(workload);
    mutate(altered.spec.template.spec);
    assert.throws(() => driver.harnessRequirementsFromDeployment(altered), /ServicePrincipal/i);
  }

  const withoutProjection = createKubernetesComputeDriver(options({ runtime }));
  const unprojected = withoutProjection.deployment(
    "agent-projected-identity",
    ownership,
    kubernetesNamespaceName(tenant.id),
    "agent:local",
    "agent-projected-identity",
    "agent",
  );
  assert.throws(
    () => withoutProjection.harnessRequirementsFromDeployment(unprojected),
    /projected ServicePrincipal token/i,
  );
});

test("revision lifecycle rejects another driver or missing identity before cluster access", async () => {
  const driver = createKubernetesComputeDriver(options());
  const revision = {
    id: "revision-a-1",
    namespaceId: tenant.id,
    agentId: "agent-a",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: { gateway: { controlUi: { enabled: false } }, logging: { level: "info" } },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-agent-a",
    createdAt: tenant.createdAt,
  };

  for (const provider of ["slack", "msteams"]) {
    for (const configuration of [{ enabled: true }, { accounts: { support: { enabled: true } } }]) {
      await assert.rejects(
        driver.prepareRevision({
          ...revision,
          configuration: { channels: { [provider]: configuration } },
        }),
        /isolated credentials and a reviewed proxy/i,
      );
    }
  }

  for (const invalid of [
    { ...revision, compute: { id: "another-driver", implementation: "another-implementation" } },
    { ...revision, servicePrincipalId: undefined },
    { ...revision, servicePrincipalId: " " },
  ]) {
    assert.deepEqual(await driver.prepareRevision(invalid), {
      namespaceId: tenant.id,
      agentId: revision.agentId,
      revisionId: revision.id,
      ready: false,
    });
  }

  for (const invalid of [
    { ...revision, configurationId: " " },
    { ...revision, configurationKind: "gateway" },
    { ...revision, revision: 0 },
    { ...revision, configurationGeneration: 0 },
    { ...revision, configurationGeneration: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    // Reject incompatible immutable snapshots before touching an Agent's Kubernetes resources.
    await assert.rejects(driver.prepareRevision(invalid), /Configuration/i);
  }

  for (const harness of [
    { id: "openclaw", version: "1.0.0", mode: "dedicated" },
    { id: "codex", version: "1.0.0", mode: "embedded" },
    { id: "codex", version: "1.0.0" },
    { id: "codex", version: "1.0.0", mode: "remote" },
  ]) {
    // Invalid explicit topology must fail before a missing kubeconfig can touch cluster resources.
    await assert.rejects(driver.prepareRevision({ ...revision, harness }), /Harness|topology/i);
  }

  const production = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        modelSecretPrefix: "model",
        channels: { secretPrefix: "channel", proxyUrl: "http://10.42.0.15:3128" },
      },
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
    }),
  );
  const serviceAccountId = "sa_00000000-0000-4000-8000-000000000001";
  const serviceAccount = {
    id: serviceAccountId,
    credential: {
      kind: "access_token",
      secretRef: {
        name: `service-account-${createHash("sha256")
          .update(serviceAccountId)
          .digest("hex")
          .slice(0, 32)}`,
        key: "token",
      },
    },
  };
  const accessTokenRevision = {
    ...revision,
    compute: { id: production.id, implementation: production.implementation },
    serviceAccount,
  };

  // Unsupported access-token execution and cross-account references fail before cluster access.
  await assert.rejects(
    production.prepareRevision({
      ...accessTokenRevision,
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    }),
    /dedicated Codex runtime/i,
  );
  for (const secretRef of [
    { ...serviceAccount.credential.secretRef, name: "service-account-another" },
    { ...serviceAccount.credential.secretRef, key: "another-key" },
  ]) {
    await assert.rejects(
      production.prepareRevision({
        ...accessTokenRevision,
        serviceAccount: {
          ...serviceAccount,
          credential: { ...serviceAccount.credential, secretRef },
        },
      }),
      /another ServiceAccount/i,
    );
  }
  const embeddedRevision = {
    ...revision,
    compute: { id: production.id, implementation: production.implementation },
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
  };
  // Channel credentials must never enter the combined embedded Agent and gateway workload.
  for (const provider of ["slack", "msteams"]) {
    await assert.rejects(
      production.prepareRevision({
        ...embeddedRevision,
        configuration: { channels: { [provider]: { enabled: true } } },
      }),
      /channels require a dedicated Agent workload\./i,
    );
  }
  const namespace = kubernetesNamespaceName(tenant.id);
  const agentHash = createHash("sha256").update(revision.agentId).digest("hex");
  const gateway = production.deployment(
    `gateway-${agentHash.slice(0, 12)}`,
    { namespaceId: tenant.id, agentId: revision.agentId },
    namespace,
    "openclaw-enterprise/gateway-fixture:local",
    `agent-${agentHash.slice(0, 12)}`,
    "gateway",
    {},
    production.gatewayConfiguration(embeddedRevision),
    true,
    revision.servicePrincipalId,
  );
  const pod = gateway.spec.template.spec;
  const environment = Object.fromEntries(pod.containers[0].env.map((entry) => [entry.name, entry]));

  // The approved combined Agent workload receives only its own projected identity and model Secret.
  assert.equal(pod.serviceAccountName, `agent-${agentHash.slice(0, 12)}`);
  assert.ok(pod.volumes.some(({ name }) => name === "openclaw-service-principal"));
  assert.deepEqual(environment.OPENAI_API_KEY.valueFrom.secretKeyRef, {
    name: `model-${agentHash.slice(0, 12)}`,
    key: "OPENAI_API_KEY",
  });
  assert.ok(environment.OPENCLAW_GATEWAY_TOKEN);
  assert.equal(environment.HOME.value, "/home/node");
  assert.equal(environment.APP_SERVER_TOKEN, undefined);
  assert.equal(environment.APP_SERVER_URL, undefined);

  const policies = production.agentNetworkPolicies(embeddedRevision, namespace);
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0].spec.podSelector.matchLabels, {
    "openclaw.dev/workload-role": "gateway",
    "openclaw.dev/agent": revision.agentId,
  });
  assert.deepEqual(policies[0].spec.policyTypes, ["Egress"]);
  assert.deepEqual(policies[0].spec.egress[0].ports, [{ protocol: "TCP", port: 443 }]);

  await assert.rejects(
    driver.retireRevision({
      ...revision,
      compute: { id: "another-driver", implementation: "another-implementation" },
    }),
    /another Compute Driver/i,
  );
});

test("real gateways require an explicit SQLite-compatible storage class", () => {
  for (const gatewayStorageClassName of [undefined, "", " "]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(
          options({
            runtime: {
              transportSecretPrefix: "transport",
              modelSecretPrefix: "model",
              gatewayStorageClassName,
            },
          }),
        ),
      /SQLite-compatible gateway storage class must be explicitly configured/,
    );
  }
});

test("gateway SQLite and media mounts are private, durable, and preserve ephemeral Codex credentials", () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        modelSecretPrefix: "model",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const agentId = "agent-private-storage";
  const ownership = { namespaceId: tenant.id, agentId };
  const namespace = kubernetesNamespaceName(tenant.id);
  const claim = driver.gatewayPrivateStateClaim(agentId, ownership, namespace);
  assert.deepEqual(claim.spec, {
    accessModes: ["ReadWriteOnce"],
    volumeMode: "Filesystem",
    storageClassName: "local-path",
    resources: { requests: { storage: "10Gi" } },
  });
  assert.equal(claim.metadata.annotations["openclaw.dev/agent-id"], agentId);
  assert.equal(claim.metadata.annotations["openclaw.dev/namespace-id"], tenant.id);
  assert.equal(claim.metadata.annotations["openclaw.dev/revision-id"], undefined);
  assert.notEqual(
    claim.metadata.name,
    driver.gatewayPrivateStateClaim(
      "another-agent",
      { ...ownership, agentId: "another-agent" },
      namespace,
    ).metadata.name,
  );
  assert.notEqual(
    claim.metadata.name,
    driver.sharedWorkspaceClaim(agentId, ownership, namespace).metadata.name,
  );

  // Whole directories retain SQLite WAL/SHM siblings; only the gateway receives the private claim.
  for (const embedded of [false, true]) {
    const gateway = driver.deployment(
      "gateway",
      ownership,
      namespace,
      "gateway:local",
      "gateway",
      "gateway",
      {},
      undefined,
      embedded,
    );
    const pod = gateway.spec.template.spec;
    const privateVolume = pod.volumes.find(({ name }) => name === "openclaw-gateway-state");
    assert.deepEqual(privateVolume.persistentVolumeClaim, { claimName: claim.metadata.name });
    assert.deepEqual(
      pod.containers[0].volumeMounts.filter(({ name }) => name === privateVolume.name),
      [
        {
          name: privateVolume.name,
          mountPath: "/home/node/.openclaw/state",
          subPath: "state",
          readOnly: false,
        },
        {
          name: privateVolume.name,
          mountPath: "/home/node/.openclaw/agents/main/agent",
          subPath: "agent",
          readOnly: false,
        },
        {
          name: privateVolume.name,
          mountPath: "/home/node/.openclaw/media",
          subPath: "media",
          readOnly: false,
        },
        ...(embedded
          ? [
              {
                name: privateVolume.name,
                mountPath: "/home/node/.openclaw/workspace",
                subPath: "workspace",
                readOnly: false,
              },
            ]
          : []),
      ],
    );
    if (embedded) {
      // Revision replacement must reuse the attested workspace, not merely preserve its SQLite row.
      const replacement = driver.deployment(
        "gateway",
        ownership,
        namespace,
        "gateway:local",
        "gateway",
        "gateway",
        {},
        { name: "configuration-2", revision: 2, revisionId: "revision-2", annotations: {} },
        true,
      ).spec.template.spec;
      assert.deepEqual(
        replacement.volumes.find(({ name }) => name === privateVolume.name),
        privateVolume,
      );
      assert.deepEqual(
        replacement.containers[0].volumeMounts.find(({ subPath }) => subPath === "workspace"),
        pod.containers[0].volumeMounts.find(({ subPath }) => subPath === "workspace"),
      );
    }
    assert.deepEqual(
      pod.containers[0].volumeMounts.find(({ mountPath }) =>
        mountPath.endsWith("/agent/codex-home"),
      ),
      {
        name: "runtime-state",
        mountPath: "/home/node/.openclaw/agents/main/agent/codex-home",
        subPath: "gateway-codex-home",
      },
    );
    assert.deepEqual(pod.initContainers[0].volumeMounts, [
      { name: "runtime-state", mountPath: "/home/node" },
      { name: privateVolume.name, mountPath: "/gateway-state" },
    ]);
    assert.equal(pod.initContainers[0].env, undefined);
    assert.equal(pod.securityContext.runAsUser, 1000);
    assert.equal(pod.securityContext.fsGroup, 1000);
    assert.equal(gateway.spec.strategy.type, "Recreate");
    assert.equal(
      pod.volumes.some(({ name }) => name === "openclaw-workspace"),
      !embedded,
    );
  }
  const harness = driver.deployment("agent", ownership, namespace, "agent:local", "agent", "agent");
  assert.equal(JSON.stringify(harness).includes(claim.metadata.name), false);
  assert.equal(JSON.stringify(harness).includes("openclaw-gateway-state"), false);
});

test("private gateway claim reuse and deletion verify exact ownership and storage before mutation", async () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        modelSecretPrefix: "model",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const agentId = "agent-claim-ownership";
  const ownership = { namespaceId: tenant.id, agentId };
  const namespace = kubernetesNamespaceName(tenant.id);
  const desired = driver.gatewayPrivateStateClaim(agentId, ownership, namespace);
  let observed = {
    ...structuredClone(desired),
    metadata: { ...desired.metadata, uid: "claim-uid" },
  };
  const mutations = [];
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespacedPersistentVolumeClaim() {
        if (observed === undefined) throw Object.assign(new Error("Not found"), { code: 404 });
        return structuredClone(observed);
      },
      async patchNamespacedPersistentVolumeClaim(request) {
        mutations.push(["patch", request]);
      },
      async deleteNamespacedPersistentVolumeClaim(request) {
        mutations.push(["delete", request]);
      },
    },
  });
  const valid = structuredClone(observed);
  // An already owned, compatible claim is reused without applying mutable revision state.
  await driver.reconcile(desired, ownership, namespace);
  assert.deepEqual(mutations, []);
  for (const mutate of [
    (claim) => {
      claim.metadata.labels["openclaw.dev/agent"] = "another-agent";
    },
    (claim) => {
      claim.metadata.annotations["openclaw.dev/namespace-id"] = "another-namespace";
    },
    (claim) => {
      claim.spec.accessModes = ["ReadWriteMany"];
    },
    (claim) => {
      claim.spec.volumeMode = "Block";
    },
    (claim) => {
      claim.spec.storageClassName = "network-filesystem";
    },
    (claim) => {
      claim.spec.resources.requests.storage = "40Gi";
    },
  ]) {
    observed = structuredClone(valid);
    mutate(observed);
    await assert.rejects(driver.reconcile(desired, ownership, namespace), /Refusing/);
    await assert.rejects(driver.deleteGatewayPrivateStateClaim(ownership, namespace), /Refusing/);
    assert.deepEqual(mutations, []);
  }
  observed = structuredClone(valid);
  delete observed.metadata.uid;
  await assert.rejects(
    driver.deleteGatewayPrivateStateClaim(ownership, namespace),
    /UID must be explicitly/,
  );
  assert.deepEqual(mutations, []);
  observed = structuredClone(valid);
  await driver.deleteGatewayPrivateStateClaim(ownership, namespace);
  assert.deepEqual(mutations, [
    [
      "delete",
      {
        name: desired.metadata.name,
        namespace,
        body: { preconditions: { uid: "claim-uid" } },
      },
    ],
  ]);
  observed = undefined;
  await driver.deleteGatewayPrivateStateClaim(ownership, namespace);
  assert.equal(mutations.length, 1);
});

test("retiring a predecessor preserves both claims and final retirement deletes exact claim UIDs", async () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        modelSecretPrefix: "model",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const agentId = "agent-revision-storage";
  const ownership = { namespaceId: tenant.id, agentId };
  const namespace = kubernetesNamespaceName(tenant.id);
  const gatewayName = "gateway-" + createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  const gateway = driver.manifest("apps/v1", "Deployment", gatewayName, ownership, namespace);
  gateway.metadata.uid = "gateway-uid";
  gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = "revision-2";
  const claims = [
    driver.gatewayPrivateStateClaim(agentId, ownership, namespace),
    driver.sharedWorkspaceClaim(agentId, ownership, namespace),
  ];
  for (const claim of claims) claim.metadata.uid = claim.metadata.name + "-uid";
  const deletions = [];
  const missing = async () => {
    throw Object.assign(new Error("Not found"), { code: 404 });
  };
  driver.apiClients = Promise.resolve({
    apps: {
      async readNamespacedDeployment() {
        return structuredClone(gateway);
      },
      async deleteNamespacedDeployment(request) {
        deletions.push(["Deployment", request]);
      },
    },
    core: {
      async readNamespacedPersistentVolumeClaim({ name }) {
        const claim = claims.find(({ metadata }) => metadata.name === name);
        if (claim === undefined) return missing();
        return structuredClone(claim);
      },
      async deleteNamespacedPersistentVolumeClaim(request) {
        deletions.push(["PersistentVolumeClaim", request]);
      },
      readNamespacedService: missing,
      readNamespacedServiceAccount: missing,
    },
  });
  await driver.removeRetiredGateway(
    { id: "revision-1", agentId, namespaceId: tenant.id, harness: { mode: "dedicated" } },
    namespace,
  );
  assert.deepEqual(deletions, []);
  await driver.removeRetiredGateway(
    { id: "revision-2", agentId, namespaceId: tenant.id, harness: { mode: "dedicated" } },
    namespace,
  );
  assert.deepEqual(deletions, [
    ...claims.map(({ metadata }) => [
      "PersistentVolumeClaim",
      { name: metadata.name, namespace, body: { preconditions: { uid: metadata.uid } } },
    ]),
    [
      "Deployment",
      { name: gatewayName, namespace, body: { preconditions: { uid: "gateway-uid" } } },
    ],
  ]);
});
