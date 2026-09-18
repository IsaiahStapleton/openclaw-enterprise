import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { encodeRepositoryCredentialSessionFiles } from "../../apps/controller/src/drivers/repository-credentials/client/config.ts";

const deadlineWallMs = Date.now() + 86400000;
const client = {
  gatewayOrigin: "https://credentials.example.test",
  gitRemote: "https://credentials.example.test/example/project.git",
  gitUsername: "gateway-session",
  canonicalApiHost: "github.com",
  apiHost: "credentials.example.test",
  repository: "example/project",
};

function runtimeBinding(sessionId = "session_material_original") {
  return {
    kind: "new",
    repositoryRef: "project",
    sessionId,
    deadlineWallMs,
    files: encodeRepositoryCredentialSessionFiles({
      session: { sessionId, deadlineWallMs },
      bearer: `controlled_gateway_bearer_${sessionId}_0000000000000000000000`,
      client,
    }),
  };
}

function workloadPod(deployment, namespace, name, ready = true) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      ...structuredClone(deployment.spec.template.metadata),
      name,
      namespace,
    },
    spec: structuredClone(deployment.spec.template.spec),
    status: { phase: "Running", conditions: [{ type: "Ready", status: ready ? "True" : "False" }] },
  };
}

async function fixture() {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };
  const driver = new KubernetesComputeDriver({
    authentication: { mode: "inCluster" },
    images: { gateway: "gateway:local", agent: "agent:local", requireImmutableDigest: false },
    resources: {
      gateway: resources,
      agent: resources,
      namespace: { quota: { pods: "10" }, containerDefaults: resources },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { app: "dns" } },
      gatewayPort: 8080,
      gatewayClients: [{ namespace: "controller", podLabels: { app: "controller" } }],
      repositoryCredentials: {
        namespace: "credentials",
        podLabels: { app: "credentials" },
        port: 8443,
      },
    },
    servicePrincipalCredentials: { mode: "disabled" },
    runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
  });
  const revision = {
    id: "revision-repository-material",
    namespaceId: "namespace-repository-material",
    agentId: "agent-repository-material",
    revision: 1,
    providerId: null,
    configurationId: "configuration-repository-material",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {
      agents: { defaults: { model: "openai/gpt-5" } },
      logging: { level: "info", consoleLevel: "info", consoleStyle: "json" },
      diagnostics: { otel: { logs: false } },
    },
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    harnessAuth: {
      method: "api_key",
      source: { kind: "secret", namespaceId: "namespace-repository-material", id: "model-key" },
      secretDriverId: "kubernetes-secret",
    },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "principal-repository-material",
    createdAt: "2026-09-18T00:00:00.000Z",
    repositoryCredentials: {
      driver: { id: "repository-credentials", implementation: "repository-credentials" },
      deadlineWallMs,
      bindings: [
        {
          repositoryRef: "project",
          profile: "read",
          providerId: "github",
          grant: { providerInstanceId: "github-main", repositoryId: "project", grantId: "read" },
        },
      ],
    },
  };
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const objects = new Map();
  const calls = [];
  let pods = [];
  let observePods;
  const key = (kind, name) => `${kind}:${name}`;
  const failure = (statusCode) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
  const matching = (object, selector) =>
    (selector ?? "")
      .split(",")
      .filter(Boolean)
      .every((item) => {
        const [name, value] = item.split("=");
        return object.metadata?.labels?.[name] === value;
      });
  const save = (object) =>
    objects.set(key(object.kind, object.metadata.name), structuredClone(object));
  save({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      uid: "namespace-uid",
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": revision.namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": revision.namespaceId },
    },
    status: { phase: "Active" },
  });
  const clients = { core: {}, apps: {}, networking: {}, discovery: {} };
  clients.core.listNamespace = async ({ labelSelector }) => ({
    items: [...objects.values()].filter(
      (object) => object.kind === "Namespace" && matching(object, labelSelector),
    ),
  });
  clients.core.readNamespace = async ({ name }) =>
    structuredClone(objects.get(key("Namespace", name)));
  clients.core.patchNamespace = async ({ body }) => {
    const previous = objects.get(key("Namespace", body.metadata.name));
    save({ ...previous, ...body, metadata: { ...previous.metadata, ...body.metadata } });
  };
  clients.core.listNamespacedPod = async ({ labelSelector }) => {
    calls.push({ operation: "listPods" });
    if (observePods) await observePods();
    return { items: structuredClone(pods.filter((pod) => matching(pod, labelSelector))) };
  };
  for (const [api, kinds] of [
    [
      clients.core,
      [
        "Secret",
        "ConfigMap",
        "ServiceAccount",
        "Service",
        "PersistentVolumeClaim",
        "ResourceQuota",
        "LimitRange",
      ],
    ],
    [clients.apps, ["Deployment"]],
    [clients.networking, ["NetworkPolicy"]],
  ]) {
    for (const kind of kinds) {
      api[`readNamespaced${kind}`] = async ({ name }) => {
        const object = objects.get(key(kind, name));
        if (!object) throw failure(404);
        return structuredClone(object);
      };
      api[`listNamespaced${kind}`] = async ({ labelSelector }) => ({
        items: structuredClone(
          [...objects.values()].filter(
            (object) => object.kind === kind && matching(object, labelSelector),
          ),
        ),
      });
      const write = async ({ body }) => {
        calls.push({ operation: "write", kind, name: body.metadata.name });
        const previous = objects.get(key(kind, body.metadata.name));
        const object = structuredClone(body);
        object.metadata.uid = previous?.metadata.uid ?? `${kind}-${body.metadata.name}-uid`;
        object.metadata.generation =
          (previous?.metadata.generation ?? 0) +
          (previous && isDeepStrictEqual(previous.spec, object.spec) ? 0 : 1);
        if (previous?.status) object.status = structuredClone(previous.status);
        object.metadata.resourceVersion = String(object.metadata.generation);
        save(object);
        return structuredClone(object);
      };
      api[`patchNamespaced${kind}`] = write;
      api[`createNamespaced${kind}`] = async (request) => {
        if (objects.has(key(kind, request.body.metadata.name))) throw failure(409);
        return write(request);
      };
      api[`deleteNamespaced${kind}`] = async ({ name, body }) => {
        const object = objects.get(key(kind, name));
        if (!object) throw failure(404);
        if (body?.preconditions?.uid && body.preconditions.uid !== object.metadata.uid)
          throw failure(409);
        calls.push({ operation: "delete", kind, name });
        objects.delete(key(kind, name));
      };
    }
  }
  clients.discovery.listNamespacedEndpointSlice = async ({ labelSelector }) => {
    const name = labelSelector.split("=")[1];
    const service = objects.get(key("Service", name));
    return {
      items: [
        {
          metadata: {
            labels: { "kubernetes.io/service-name": name },
            ownerReferences: [{ kind: "Service", name, uid: service.metadata.uid }],
          },
          endpoints: [{ conditions: { ready: true } }],
        },
      ],
    };
  };
  driver.apiClients = Promise.resolve(clients);
  const preparedNamespace = await driver.ensureNamespace({
    id: revision.namespaceId,
    name: "Repository material tenant",
    status: "ready",
    createdAt: revision.createdAt,
  });
  assert.equal(preparedNamespace.namespaceReady, true, JSON.stringify(preparedNamespace));
  const context = (bindings) => ({
    secretEnvironment: [],
    harnessAuth: {
      ...revision.harnessAuth,
      backendRef: {
        namespaceName: namespace,
        name: "model-key",
        key: "value",
        uid: "model-key-uid",
      },
    },
    repositoryCredentials: bindings,
  });
  const deployments = () => [...objects.values()].filter((object) => object.kind === "Deployment");
  const secrets = () => [...objects.values()].filter((object) => object.kind === "Secret");
  const markReady = () => {
    for (const object of deployments()) {
      object.status = { observedGeneration: object.metadata.generation, readyReplicas: 1 };
      save(object);
    }
    pods = deployments().map((object) =>
      workloadPod(object, namespace, `${object.metadata.name}-ready`),
    );
  };
  return {
    driver,
    clients,
    revision,
    namespace,
    objects,
    calls,
    save,
    context,
    deployments,
    secrets,
    markReady,
    setPods(value) {
      pods = value;
    },
    observePods(value) {
      observePods = value;
    },
  };
}

test("Kubernetes preparation creates immutable material and mounts only private output in the runtime", async () => {
  const f = await fixture();
  const binding = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([binding]));
  assert.equal(f.secrets().length, 1);
  const secret = f.secrets()[0];
  assert.equal(secret.immutable, true);
  const pod = f.deployments()[0].spec.template.spec;
  const init = pod.initContainers.find((container) => container.name.includes("repository"));
  assert.ok(init, "repository material must pass through an init container");
  const output = pod.volumes.find((volume) => volume.emptyDir?.medium === "Memory");
  assert.ok(output, "runtime material requires a memory-backed private volume");
  const mount = pod.containers[0].volumeMounts.find((value) => value.name === output.name);
  assert.equal(mount.readOnly, true);
  assert.equal(mount.subPath, "private");
  assert.equal(mount.mountPath, "/run/oce/repository-credentials");
  assert.equal(JSON.stringify(pod).includes(binding.files.bearer), false);
  assert.equal(
    JSON.stringify(
      [...f.objects.values()].filter((object) => object.kind === "ConfigMap"),
    ).includes(binding.files.bearer),
    false,
  );
  const retained = {
    kind: "retained",
    repositoryRef: binding.repositoryRef,
    sessionId: binding.sessionId,
    deadlineWallMs,
  };
  await f.driver.prepareRevision(f.revision, f.context([retained]));
  assert.equal(
    f.calls.filter((call) => call.operation === "write" && call.kind === "Secret").length,
    1,
  );
});

test("Kubernetes reports exact missing retained material without silently creating new custody", async () => {
  const f = await fixture();
  const missing = { repositoryRef: "project", sessionId: "session-missing" };
  const context = f.context([{ kind: "retained", ...missing, deadlineWallMs }]);
  assert.deepEqual(await f.driver.prepareRevision(f.revision, context), {
    namespaceId: f.revision.namespaceId,
    agentId: f.revision.agentId,
    revisionId: f.revision.id,
    ready: false,
    repositoryCredentialMaterialMissing: [missing],
  });
  await assert.rejects(f.driver.activateRevision(f.revision, context));
  assert.equal(f.secrets().length, 0);
  assert.equal(f.deployments().length, 0);
});

test("Kubernetes rejects mismatched session documents before publishing repository material", async () => {
  const f = await fixture();
  const binding = runtimeBinding();
  const document = JSON.parse(binding.files["client.json"]);
  document.sessionId = "another-session";
  binding.files["client.json"] = JSON.stringify(document);
  await assert.rejects(f.driver.prepareRevision(f.revision, f.context([binding])));
  assert.equal(f.secrets().length, 0);
  assert.equal(f.deployments().length, 0);
});

test("Kubernetes stop recovers material left by an interrupted multi-Secret create", async () => {
  const f = await fixture();
  f.revision.repositoryCredentials.bindings.push({
    ...f.revision.repositoryCredentials.bindings[0],
    repositoryRef: "second-project",
  });
  const first = runtimeBinding();
  const second = { ...runtimeBinding("session_material_second"), repositoryRef: "second-project" };
  const create = f.clients.core.createNamespacedSecret;
  let creations = 0;
  f.clients.core.createNamespacedSecret = async (request) => {
    // The API accepts one material object before the next request loses service.
    // No Pod exists, so recovery must discover material independently of Pods.
    if (++creations === 2) throw Object.assign(new Error("API unavailable"), { statusCode: 503 });
    return create(request);
  };
  await assert.rejects(f.driver.prepareRevision(f.revision, f.context([first, second])));
  assert.equal(f.secrets().length, 1);
  assert.equal(f.deployments().length, 0);
  await f.driver.stopRevision(f.revision);
  assert.equal(f.secrets().length, 0);
});

test("Kubernetes stop keeps material until the exact revision Pods disappear", async () => {
  const f = await fixture();
  await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
  const deployment = f.deployments()[0];
  f.setPods([
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        ...deployment.spec.template.metadata,
        name: "terminating-gateway",
        namespace: f.namespace,
        deletionTimestamp: "2026-09-18T00:00:00.000Z",
      },
      spec: deployment.spec.template.spec,
    },
  ]);
  let observed = 0;
  f.observePods(() => {
    assert.equal(f.secrets().length, 1, "material must survive every termination observation");
    if (++observed === 2) f.setPods([]);
  });
  await f.driver.stopRevision(f.revision);
  assert.ok(observed >= 2);
  assert.equal(f.secrets().length, 0);
});

test("Kubernetes activation rotates same-revision material while retaining the old Pod's Secret", async () => {
  const f = await fixture();
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));
  const oldSecret = f.secrets()[0].metadata.name;
  const deployment = f.deployments()[0];
  f.setPods([
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        ...deployment.spec.template.metadata,
        name: "old-session-gateway",
        namespace: f.namespace,
      },
      spec: deployment.spec.template.spec,
    },
  ]);

  // Session rotation keeps the revision ID; deleting by revision label alone
  // would revoke a Secret still mounted by the terminating predecessor.
  const replacement = runtimeBinding("session_material_rotated");
  await assert.rejects(
    f.driver.activateRevision(f.revision, f.context([replacement])),
    /not ready/,
  );
  assert.notDeepEqual(f.deployments()[0].spec.template, deployment.spec.template);
  assert.equal(JSON.stringify(f.deployments()[0].spec.template).includes(oldSecret), false);
  assert.equal(f.secrets().length, 2);
  assert.ok(f.secrets().some((secret) => secret.metadata.name === oldSecret));
  f.setPods([]);
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([replacement]));
  assert.equal(f.secrets().length, 1);
  assert.notEqual(f.secrets()[0].metadata.name, oldSecret);
  assert.equal(JSON.stringify(f.deployments()[0].spec.template).includes(oldSecret), false);
});

test("repository material readiness waits for the replacement Pod when the old Pod is still ready", async () => {
  const f = await fixture();
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));
  const oldPod = workloadPod(f.deployments()[0], f.namespace, "old-material-ready");
  const replacement = runtimeBinding("session_material_replacement");
  await f.driver.prepareRevision(f.revision, f.context([replacement]));

  // Deployment status can acknowledge the new template while its ready replica
  // still belongs to the old material generation. Observe both Pods separately.
  const deployment = f.deployments()[0];
  deployment.status = { observedGeneration: deployment.metadata.generation, readyReplicas: 1 };
  f.save(deployment);
  const replacementPod = workloadPod(deployment, f.namespace, "replacement-starting", false);
  f.setPods([oldPod, replacementPod]);
  const waiting = await f.driver.prepareRevision(f.revision, f.context([replacement]));
  assert.equal(waiting.ready, false);
  await assert.rejects(f.driver.activateRevision(f.revision, f.context([replacement])));

  replacementPod.status.conditions = [{ type: "Ready", status: "True" }];
  f.setPods([replacementPod]);
  const ready = await f.driver.prepareRevision(f.revision, f.context([replacement]));
  assert.equal(ready.ready, true);
  await f.driver.activateRevision(f.revision, f.context([replacement]));
});

test("Kubernetes retirement finds material after its Deployment was already removed", async () => {
  const f = await fixture();
  await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
  const deployment = f.deployments()[0];
  f.objects.delete(`Deployment:${deployment.metadata.name}`);
  f.setPods([
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        ...deployment.spec.template.metadata,
        name: "orphaned-old-gateway",
        namespace: f.namespace,
      },
      spec: deployment.spec.template.spec,
    },
  ]);
  let observations = 0;
  f.observePods(() => {
    assert.equal(f.secrets().length, 1);
    if (++observations === 2) f.setPods([]);
  });
  await f.driver.retireRevision(f.revision);
  assert.ok(observations >= 2);
  assert.equal(f.secrets().length, 0);
});

test("external namespace cleanup removes owned repository material and preserves unrelated Secrets", async () => {
  const f = await fixture();
  await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
  const tenant = f.objects.get(`Namespace:${f.namespace}`);
  tenant.metadata.annotations["openclaw.dev/namespace-lifecycle"] = "external";
  f.save(tenant);
  for (const deployment of f.deployments())
    f.objects.delete(`Deployment:${deployment.metadata.name}`);
  f.save({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "external-owner", namespace: f.namespace, uid: "external-owner-uid" },
    data: { value: "cHJlc2VydmU=" },
  });
  const result = await f.driver.deleteNamespace({
    id: f.revision.namespaceId,
    name: "External material tenant",
    status: "deleting",
    existingNamespace: f.namespace,
    createdAt: f.revision.createdAt,
  });
  assert.equal(result.namespaceDeleted, true, JSON.stringify(result));
  assert.deepEqual(
    f.secrets().map((secret) => secret.metadata.name),
    ["external-owner"],
  );
  assert.ok(f.objects.has(`Namespace:${f.namespace}`));
});
