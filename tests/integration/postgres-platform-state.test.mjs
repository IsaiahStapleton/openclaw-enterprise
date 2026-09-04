import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { verifyPlatformStateStoreContract } from "../conformance/platform-state-store.contract.mjs";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import {
  createKubernetesInstallationConfiguration,
  kubernetesHash,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const entrypoint = fileURLToPath(new URL("../../apps/controller/src/server.mjs", import.meta.url));
const workerEntrypoint = fileURLToPath(
  new URL("../../apps/controller/src/worker.mjs", import.meta.url),
);
const execute = promisify(execFile);
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
const fixtureImage = process.env.OCC_TEST_KUBERNETES_IMAGE;
const adminEmail = "postgres-admin@openclaw.local";
const adminPassword = "postgres-development-password";
const authSecret = "openclaw-postgres-development-auth-secret-minimum-32-bytes";
const requiresPostgres = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
};
const requiresPostgresAndKubernetesConfiguration = {
  skip: !databaseUrl
    ? "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests."
    : process.env.OCC_TEST_KUBERNETES_CONFIGURATION === "1"
      ? false
      : "Set OCC_TEST_KUBERNETES_CONFIGURATION=1 to run PostgreSQL plus live Kubernetes Driver coverage.",
};
const useKubernetesDrivers = process.env.OCC_TEST_KUBERNETES_CONFIGURATION === "1";
const kubernetesStartupEnvironments = new WeakMap();
const kubernetesWorkloadResources = Object.freeze({
  requests: Object.freeze({ cpu: "25m", memory: "48Mi" }),
  limits: Object.freeze({ cpu: "250m", memory: "192Mi" }),
});
const defaultAgentConfigurationValues = Object.freeze({
  gateway: Object.freeze({ controlUi: Object.freeze({ enabled: false }) }),
});

async function kubectl(...args) {
  const { stdout } = await execute(
    "kubectl",
    ["--kubeconfig", kubeconfigPath, "--context", kubernetesContext, ...args],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

async function configuredDriverEnvironment(context, kubernetesDrivers) {
  if (!kubernetesDrivers) return {};
  assert.equal(
    useKubernetesDrivers,
    true,
    "OCC_TEST_KUBERNETES_CONFIGURATION=1 is required for live Kubernetes Driver coverage.",
  );
  return (await createKubernetesStartupEnvironment(context)).environment;
}

async function createKubernetesStartupEnvironment(context) {
  // The API and worker share a scoped controller identity; the base kubeconfig is used only
  // to create that identity and grant per-tenant access after each Namespace exists.
  const cached = kubernetesStartupEnvironments.get(context);
  if (cached !== undefined) return cached;

  assert.ok(fixtureImage, "OCC_TEST_KUBERNETES_IMAGE is required.");
  await validateExplicitK3dLoopbackContext({ kubeconfigPath, kubernetesContext });
  const installationId = `ins_${randomUUID()}`;
  const identifier = kubernetesHash(installationId);
  const account = "openclaw-controller";
  const namespaceRole = `oce-postgres-namespaces-${identifier}`;
  const tenantRole = `oce-postgres-tenant-${identifier}`;
  const binding = `oce-postgres-controller-${identifier}`;
  const platformNamespace = `oce-postgres-platform-${identifier}`;
  const directory = await mkdtemp(join(tmpdir(), "openclaw-postgres-kubernetes-"));
  context.after(async () => {
    const cleanup = await Promise.allSettled([
      kubectl("delete", "namespace", platformNamespace, "--ignore-not-found=true", "--wait=true"),
      kubectl("delete", "clusterrolebinding", binding, "--ignore-not-found=true"),
      kubectl("delete", "clusterrole", namespaceRole, tenantRole, "--ignore-not-found=true"),
      rm(directory, { recursive: true, force: true }),
    ]);
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length > 0) throw new AggregateError(failures.map(({ reason }) => reason));
  });

  await kubectl("create", "namespace", platformNamespace);
  await kubectl("create", "serviceaccount", account, "--namespace", platformNamespace);
  await kubectl(
    "create",
    "clusterrole",
    namespaceRole,
    "--verb=create,get,list,patch,update,delete",
    "--resource=namespaces",
  );
  await kubectl(
    "create",
    "clusterrole",
    tenantRole,
    "--verb=create,get,list,patch,update,delete",
    "--resource=deployments.apps,services,serviceaccounts,configmaps,endpointslices.discovery.k8s.io,networkpolicies.networking.k8s.io,resourcequotas,limitranges,secrets",
  );
  await kubectl(
    "patch",
    "clusterrole",
    tenantRole,
    "--type=json",
    "--patch",
    JSON.stringify([
      {
        op: "add",
        path: "/rules/-",
        value: {
          apiGroups: [""],
          resources: ["persistentvolumeclaims"],
          verbs: ["get", "create", "patch", "delete"],
        },
      },
    ]),
  );
  await kubectl(
    "create",
    "clusterrolebinding",
    binding,
    `--clusterrole=${namespaceRole}`,
    `--serviceaccount=${platformNamespace}:${account}`,
  );

  const token = (
    await kubectl("create", "token", account, "--namespace", platformNamespace)
  ).trim();
  const current = JSON.parse(
    await kubectl("config", "view", "--minify", "--flatten", "-o", "json"),
  );
  const scopedContext = `scoped-${identifier}`;
  const scopedKubeconfig = join(directory, "kubeconfig.json");
  await writeFile(
    scopedKubeconfig,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name: "local", cluster: current.clusters[0].cluster }],
      users: [{ name: account, user: { token } }],
      contexts: [{ name: scopedContext, context: { cluster: "local", user: account } }],
      "current-context": scopedContext,
    }),
    { mode: 0o600 },
  );

  const authentication = {
    mode: "kubeconfig",
    kubeconfigPath: scopedKubeconfig,
    context: scopedContext,
  };
  const installation = createKubernetesInstallationConfiguration({
    authentication,
    platformNamespace,
    gatewayImage: fixtureImage,
    codexImage: fixtureImage,
    cluster: `postgres-platform-state-${identifier}`,
  });
  installation.drivers.secret.configuration.authentication = structuredClone(authentication);
  installation.drivers.compute.configuration.images.requireImmutableDigest = false;
  installation.drivers.compute.configuration.resources.gateway = structuredClone(
    kubernetesWorkloadResources,
  );
  installation.drivers.compute.configuration.resources.agent = structuredClone(
    kubernetesWorkloadResources,
  );
  installation.drivers.compute.configuration.resources.namespace = {
    quota: {
      pods: "20",
      "requests.cpu": "1",
      "requests.memory": "1Gi",
      "limits.cpu": "4",
      "limits.memory": "3Gi",
    },
    containerDefaults: structuredClone(kubernetesWorkloadResources),
  };
  installation.drivers.compute.configuration.network.gatewayPort = 8080;
  delete installation.drivers.compute.configuration.runtime;
  const configurationPath = join(directory, "installation.yaml");
  await writeFile(configurationPath, JSON.stringify(installation), {
    encoding: "utf8",
    mode: 0o600,
  });

  const environment = { OCC_CONFIG_PATH: configurationPath };
  const startup = { environment, platformNamespace, account, tenantRole };
  kubernetesStartupEnvironments.set(context, startup);
  return startup;
}

async function waitForKubernetesNamespace(context, namespaceId) {
  const name = kubernetesNamespaceName(namespaceId);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await kubectl("get", "namespace", name, "-o", "json");
      return name;
    } catch (error) {
      if (!/NotFound|not found/i.test(error.stderr ?? error.message)) throw error;
      await delay(100);
    }
  }
  assert.fail(`Timed out waiting for Kubernetes Namespace ${name}.`);
}

async function grantTenantAccess(context, namespaceId) {
  // Kubernetes namespace creation succeeds before tenant resources can be reconciled;
  // this mirrors the operator-owned RoleBinding handoff required by the real driver.
  const { platformNamespace, account, tenantRole } =
    await createKubernetesStartupEnvironment(context);
  const name = await waitForKubernetesNamespace(context, namespaceId);
  try {
    await kubectl(
      "create",
      "rolebinding",
      "openclaw-controller",
      "--namespace",
      name,
      `--clusterrole=${tenantRole}`,
      `--serviceaccount=${platformNamespace}:${account}`,
    );
  } catch (error) {
    if (!/AlreadyExists|already exists/i.test(error.stderr ?? error.message)) throw error;
  }
}

function cleanupKubernetesNamespaces(context, namespaceIds) {
  context.after(async () => {
    const cleanup = await Promise.allSettled(
      namespaceIds.map((namespaceId) =>
        kubectl(
          "delete",
          "namespace",
          kubernetesNamespaceName(namespaceId),
          "--ignore-not-found=true",
          "--wait=true",
        ),
      ),
    );
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length > 0) throw new AggregateError(failures.map(({ reason }) => reason));
  });
}

async function waitForNamespaceReady(api, namespaceId, worker) {
  const ready = await pollUntil(
    `Namespace ${namespaceId} to become ready through the independent worker`,
    async () => {
      const current = await request(api, "GET", `/namespaces/${namespaceId}`);
      assert.equal(current.status, 200);
      return current.data.status === "ready" ? current.data : undefined;
    },
    { worker, timeoutMs: 60_000 },
  );
  assert.equal(ready.id, namespaceId);
  assert.equal(ready.status, "ready");
  return ready;
}

async function createConfiguration(api, namespaceId, values = defaultAgentConfigurationValues) {
  const configuration = await request(api, "POST", `/namespaces/${namespaceId}/configurations`, {
    kind: "agent",
    values,
  });
  assert.equal(configuration.status, 201);
  return configuration.data;
}

async function updateConfiguration(api, namespaceId, configurationId, values) {
  const configuration = await request(
    api,
    "PATCH",
    `/namespaces/${namespaceId}/configurations/${configurationId}`,
    { values },
  );
  assert.equal(configuration.status, 200);
  return configuration.data;
}

async function createConfiguredAgent(api, namespaceId, name, values, body = {}) {
  const configuration = await createConfiguration(api, namespaceId, values);
  const agent = await request(api, "POST", `/namespaces/${namespaceId}/agents`, {
    name,
    configurationId: configuration.id,
    ...body,
  });
  assert.equal(agent.status, 201);
  return { configuration, agent: agent.data };
}

function admitted(values) {
  return admitLoggingConfiguration(values, "info");
}

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function stopController(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
  force.unref();
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}

async function startController(context, { kubernetesDrivers = false } = {}) {
  const port = await availablePort();
  const driverEnvironment = await configuredDriverEnvironment(context, kubernetesDrivers);
  const configurationRoot = await mkdtemp(join(tmpdir(), "openclaw-postgres-configurations-"));
  context.after(async () => {
    await rm(configurationRoot, { recursive: true, force: true });
  });
  await ensureDevelopmentBootstrap(context, {
    databaseUrl,
    email: adminEmail,
    password: adminPassword,
    authSecret,
    authBaseURL: `http://127.0.0.1:${port}`,
    installationName: "PostgreSQL platform state integration",
  });
  const child = spawn(process.execPath, [entrypoint], {
    cwd: repository,
    env: {
      ...process.env,
      NODE_ENV: "development",
      OCC_HOST: "127.0.0.1",
      OCC_PORT: String(port),
      OCC_DATABASE_URL: databaseUrl,
      OCC_AUTH_BASE_URL: `http://127.0.0.1:${port}`,
      OCC_AUTH_SECRET: authSecret,
      OCC_DEVELOPMENT_CONFIGURATION_ROOT: configurationRoot,
      OCC_DOCKER_RUNTIME_IMAGE: "openclaw-enterprise-runtime:not-used-by-postgres-platform-state",
      ...driverEnvironment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => stopController(child));

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, `The durable OCC subprocess exited early:\n${output}`);
    try {
      const session = await signInWithEmailPassword({
        fetch,
        origin,
        email: adminEmail,
        password: adminPassword,
      });
      return { child, origin, session };
    } catch {
      await delay(40);
    }
  }
  assert.fail(`The durable OCC subprocess never became ready:\n${output}`);
}

async function spawnWorker(context, { kubernetesDrivers = false } = {}) {
  const driverEnvironment = await configuredDriverEnvironment(context, kubernetesDrivers);
  const child = spawn(process.execPath, [workerEntrypoint], {
    cwd: repository,
    env: {
      ...process.env,
      NODE_ENV: "development",
      DATABASE_URL: databaseUrl,
      OCC_DATABASE_URL: databaseUrl,
      OCC_TEST_DATABASE_URL: databaseUrl,
      OCC_WORKER_POLL_INTERVAL_MS: "20",
      OCC_WORKER_LEASE_DURATION_MS: "5000",
      OCC_AUTH_BASE_URL: "http://127.0.0.1",
      OCC_AUTH_SECRET: authSecret,
      ...driverEnvironment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => stopController(child));

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  return { child, output: () => output };
}

async function startWorker(context, options) {
  const worker = await spawnWorker(context, options);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    assert.equal(
      worker.child.exitCode,
      null,
      `The separate OCC worker subprocess exited early:\n${worker.output()}`,
    );
    if (/"event"\s*:\s*"worker\.started"/.test(worker.output())) return worker;
    await delay(25);
  }
  assert.fail(`The separate OCC worker subprocess never became ready:\n${worker.output()}`);
}

async function startKubernetesController(context) {
  return startController(context, { kubernetesDrivers: true });
}

async function startKubernetesWorker(context) {
  return startWorker(context, { kubernetesDrivers: true });
}

async function pollUntil(description, operation, { worker, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (worker !== undefined) {
      assert.equal(
        worker.child.exitCode,
        null,
        `The OCC worker exited while waiting for ${description}:\n${worker.output()}`,
      );
    }
    const result = await operation();
    if (result !== undefined) return result;
    await delay(35);
  }
  assert.fail(
    `Timed out waiting for ${description}.${worker === undefined ? "" : `\n${worker.output()}`}`,
  );
}

function parseJsonLines(output) {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function request(controller, method, path, body, options = {}) {
  const response = await fetch(`${controller.origin}${path}`, {
    method,
    headers: {
      ...(options.authenticated === false
        ? {}
        : authenticatedHeaders(options.session ?? controller.session)),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  const payload = await response.json();
  return { status: response.status, data: payload.data, error: payload.error };
}

async function createDurableController(pool) {
  const [
    { NativeIAMDriver },
    { OpenClawController },
    { PostgresPlatformState },
    { createDevelopmentComputeDriver },
    { DEVELOPMENT_HARNESS_DESCRIPTOR, resolveApprovedHarness: resolveApprovedDevelopmentHarness },
  ] = await Promise.all([
    import("../../packages/iam/src/index.ts"),
    import("../../packages/occ/src/index.ts"),
    import("../../packages/occ/src/state/postgres-state.ts"),
    import("../helpers/development.mjs"),
    import("../../apps/controller/src/composition/production-harness.ts"),
  ]);
  const state = new PostgresPlatformState(pool);
  const installation = await state.loadInstallation();
  assert.ok(installation, "the real OCC subprocess must bootstrap the singleton Installation");

  const iam = new NativeIAMDriver(state, {
    id: "native-iam",
    implementation: "native",
  });
  const compute = createDevelopmentComputeDriver();
  const controller = new OpenClawController(installation, { state, recordOperations: true });
  for (const driver of [iam, compute]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }

  return {
    controller,
    state,
    harness: DEVELOPMENT_HARNESS_DESCRIPTOR,
    resolveHarness: resolveApprovedDevelopmentHarness,
  };
}

test(
  "PostgreSQL rejects platform writes until the singleton Installation is bootstrapped",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { PostgresPlatformState }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    if ((await state.loadInstallation()) !== undefined) {
      context.skip("The configured PostgreSQL database has already been bootstrapped.");
      return;
    }

    const prematureWorker = await spawnWorker(context);
    const [prematureExit] = await once(prematureWorker.child, "exit", {
      signal: AbortSignal.timeout(10_000),
    });
    assert.notEqual(prematureExit, 0);
    const startupFailure = parseJsonLines(prematureWorker.output()).find(
      (line) => line.event === "worker.startup-error",
    );
    assert.deepEqual(
      {
        service: startupFailure?.service,
        event: startupFailure?.event,
        code: startupFailure?.code,
      },
      {
        service: "occ-worker",
        event: "worker.startup-error",
        code: "WORKER_STARTUP_FAILED",
      },
    );

    const namespaceId = `ns_${randomUUID()}`;
    const agentId = `agt_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const namespace = { id: namespaceId, name: "Uninitialized", status: "provisioning", createdAt };
    const agent = {
      id: agentId,
      namespaceId,
      name: "Uninitialized agent",
      configurationId: `cfg_${randomUUID()}`,
      providerId: null,
      draft_spec: {},
      executionMode: "embedded",
      servicePrincipalId: `service-agent-${randomUUID()}`,
      createdAt,
    };
    const revision = {
      id: `rev_${randomUUID()}`,
      namespaceId,
      agentId,
      revision: 1,
      providerId: null,
      configurationId: `cfg_${randomUUID()}`,
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: {},
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
      compute: {
        id: "compute-local-development",
        implementation: "deterministic-local-development",
      },
      servicePrincipalId: agent.servicePrincipalId,
      createdAt,
    };
    const operation = {
      kind: "namespace",
      action: "reconcile",
      target: "ready",
      namespaceId,
      resourceId: namespaceId,
      actorId: "principal-uninitialized",
    };
    const stateCounts = `SELECT
         (SELECT count(*)::integer FROM occ.installation) AS installations,
         (SELECT count(*)::integer FROM occ.namespaces) AS namespaces,
         (SELECT count(*)::integer FROM occ.agents) AS agents,
         (SELECT count(*)::integer FROM occ.agent_revisions) AS revisions,
         (SELECT count(*)::integer FROM occ.controller_work) AS work`;
    const baseline = await pool.query(stateCounts);
    assert.equal(baseline.rows[0].installations, 0);

    for (const write of [
      (transaction) => transaction.namespaces.createNamespace(namespace),
      (transaction) => transaction.agents.createAgent(agent),
      (transaction) => transaction.revisions.createRevision(revision),
      (transaction) => transaction.operations.append(operation),
      (transaction) => transaction.operations.list(),
    ]) {
      await assert.rejects(state.transact(write), { name: "ScopeViolationError" });
    }

    const persisted = await pool.query(stateCounts);
    assert.deepEqual(persisted.rows[0], baseline.rows[0]);
  },
);

test(
  "real OCC subprocesses retain Installation, Namespace, Agent, IAM, audit, and work after restart",
  requiresPostgresAndKubernetesConfiguration,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());

    const first = await startKubernetesController(context);
    const existing = await request(first, "GET", "/installation");
    let installation;
    if (existing.status === 200) {
      installation = existing.data;
    } else {
      assert.equal(existing.status, 404);
      const created = await request(first, "POST", "/installation/bootstrap", {
        name: "PostgreSQL restart integration",
      });
      assert.equal(created.status, 201);
      installation = created.data;
    }

    const namespace = await request(first, "POST", "/namespaces", {
      name: `restart-${randomUUID()}`,
    });
    assert.equal(namespace.status, 201);
    assert.equal(Object.hasOwn(namespace.data, "installationId"), false);
    cleanupKubernetesNamespaces(context, [namespace.data.id]);

    const worker = await startKubernetesWorker(context);
    await grantTenantAccess(context, namespace.data.id);
    const readyNamespace = await waitForNamespaceReady(first, namespace.data.id, worker);

    const { agent } = await createConfiguredAgent(
      first,
      namespace.data.id,
      `agent-${randomUUID()}`,
    );
    assert.equal(Object.hasOwn(agent, "installationId"), false);
    assert.equal(Object.hasOwn(agent, "servicePrincipalId"), false);
    assert.equal(agent.namespaceId, namespace.data.id);

    const persisted = await pool.query(
      `SELECT
       (SELECT count(*)::integer FROM occ.audit_events
         WHERE resource_id = $1 OR resource_id = $2 OR resource_id = $3) AS audit_events,
       (SELECT count(*)::integer FROM occ.controller_work
         WHERE namespace_id = $1) AS queued_operations,
       (SELECT count(*)::integer FROM occ.configurations
         WHERE namespace_id = $1 AND id = $3) AS configurations,
       (SELECT count(*)::integer FROM occ.iam_identities
         WHERE namespace_id = $1 AND agent_id = $2
           AND kind = 'service_principal') AS agent_service_principals`,
      [namespace.data.id, agent.id, agent.configurationId],
    );
    assert.ok(persisted.rows[0].audit_events >= 3);
    assert.equal(persisted.rows[0].queued_operations, 1);
    assert.equal(persisted.rows[0].configurations, 1);
    assert.equal(persisted.rows[0].agent_service_principals, 1);

    const auditBeforeUnauthenticatedRequest = await pool.query(
      "SELECT count(*)::integer AS count FROM occ.audit_events",
    );
    const unauthenticated = await request(first, "GET", "/namespaces", undefined, {
      authenticated: false,
    });
    assert.equal(unauthenticated.status, 401);
    const auditAfterUnauthenticatedRequest = await pool.query(
      "SELECT count(*)::integer AS count FROM occ.audit_events",
    );
    assert.equal(
      auditAfterUnauthenticatedRequest.rows[0].count,
      auditBeforeUnauthenticatedRequest.rows[0].count,
      "unauthenticated requests have no attributable actor and cannot write audit rows",
    );

    await stopController(first.child);
    const restarted = await startKubernetesController(context);

    const reloadedInstallation = await request(restarted, "GET", "/installation");
    assert.equal(reloadedInstallation.status, 200);
    assert.deepEqual(reloadedInstallation.data, installation);

    const reloadedNamespace = await request(restarted, "GET", `/namespaces/${namespace.data.id}`);
    assert.equal(reloadedNamespace.status, 200);
    assert.deepEqual(reloadedNamespace.data, readyNamespace);

    const reloadedAgent = await request(
      restarted,
      "GET",
      `/namespaces/${namespace.data.id}/agents/${agent.id}`,
    );
    assert.equal(reloadedAgent.status, 200);
    assert.deepEqual(reloadedAgent.data, agent);

    const duplicateBootstrap = await request(restarted, "POST", "/installation/bootstrap", {
      name: "Forbidden second Installation",
    });
    assert.equal(duplicateBootstrap.status, 409);
    const installations = await pool.query(
      "SELECT count(*)::integer AS count FROM occ.installation",
    );
    assert.equal(installations.rows[0].count, 1);
  },
);

test(
  "real OCC Namespace lifecycle persists provisioning, readiness, deletion, and its tombstone",
  requiresPostgres,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const process = await startController(context);
    const installation = await request(process, "GET", "/installation");
    if (installation.status === 404) {
      const bootstrapped = await request(process, "POST", "/installation/bootstrap", {
        name: "PostgreSQL namespace lifecycle integration",
      });
      assert.equal(bootstrapped.status, 201);
    } else {
      assert.equal(installation.status, 200);
    }
    const { controller } = await createDurableController(pool);
    const actor = await pool.query(
      `SELECT identity.id
       FROM occ.iam_identities AS identity
       JOIN occ."user" AS auth_user ON auth_user.id = identity.subject
       WHERE auth_user.email = $1`,
      [adminEmail],
    );
    assert.equal(actor.rowCount, 1);
    const principalId = actor.rows[0].id;

    const created = await request(process, "POST", "/namespaces", {
      name: `durable-lifecycle-${randomUUID()}`,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.status, "provisioning");
    const namespaceId = created.data.id;

    const provisioning = await request(process, "GET", `/namespaces/${namespaceId}`);
    assert.equal(provisioning.status, 200);
    assert.deepEqual(provisioning.data, created.data);

    const persistedProvisioning = await pool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespaceId],
    );
    assert.deepEqual(persistedProvisioning.rows, [{ status: "provisioning", deleted_at: null }]);
    const provisionWork = await pool.query(
      "SELECT namespace_target FROM occ.controller_work WHERE namespace_id = $1",
      [namespaceId],
    );
    assert.deepEqual(provisionWork.rows, [{ namespace_target: "ready" }]);

    const reconciled = await controller.handleNamespaceLifecycle(principalId, namespaceId, "ready");
    assert.equal(reconciled?.status, "ready");
    const ready = await request(process, "GET", `/namespaces/${namespaceId}`);
    assert.equal(ready.status, 200);
    assert.equal(ready.data.status, "ready");
    const persistedReady = await pool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespaceId],
    );
    assert.deepEqual(persistedReady.rows, [{ status: "ready", deleted_at: null }]);

    const deleting = await request(process, "DELETE", `/namespaces/${namespaceId}`);
    assert.equal(deleting.status, 202);
    assert.equal(deleting.data.status, "deleting");
    const visibleDeletion = await request(process, "GET", `/namespaces/${namespaceId}`);
    assert.equal(visibleDeletion.status, 200);
    assert.equal(visibleDeletion.data.status, "deleting");
    const persistedDeleting = await pool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespaceId],
    );
    assert.deepEqual(persistedDeleting.rows, [{ status: "deleting", deleted_at: null }]);

    const lifecycleWork = await pool.query(
      `SELECT idempotency_key, namespace_target
       FROM occ.controller_work WHERE namespace_id = $1 ORDER BY namespace_target`,
      [namespaceId],
    );
    assert.deepEqual(
      lifecycleWork.rows.map(({ namespace_target }) => namespace_target),
      ["deleted", "ready"],
    );
    assert.notEqual(lifecycleWork.rows[0].idempotency_key, lifecycleWork.rows[1].idempotency_key);

    const tombstoned = await controller.handleNamespaceLifecycle(
      principalId,
      namespaceId,
      "deleted",
    );
    assert.equal(tombstoned?.status, "deleting");
    assert.equal(typeof tombstoned?.deletedAt, "string");
    const persistedTombstone = await pool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespaceId],
    );
    assert.equal(persistedTombstone.rowCount, 1);
    assert.equal(persistedTombstone.rows[0].status, "deleting");
    assert.ok(persistedTombstone.rows[0].deleted_at instanceof Date);
    assert.equal(persistedTombstone.rows[0].deleted_at.toISOString(), tombstoned.deletedAt);

    const hidden = await request(process, "GET", `/namespaces/${namespaceId}`);
    assert.equal(hidden.status, 404);
    const listed = await request(process, "GET", "/namespaces");
    assert.equal(listed.status, 200);
    assert.ok(listed.data.every(({ id }) => id !== namespaceId));

    const audits = await pool.query(
      "SELECT action, outcome FROM occ.audit_events WHERE resource_id = $1",
      [namespaceId],
    );
    assert.deepEqual(
      audits.rows.map(({ action }) => action).sort(),
      [
        "openclaw.namespaces.create",
        "openclaw.namespaces.delete",
        "openclaw.namespaces.lifecycle.delete",
        "openclaw.namespaces.lifecycle.ensure",
      ].sort(),
    );
    assert.ok(audits.rows.every(({ outcome }) => outcome === "success"));
  },
);

test(
  "real OCC creates concurrent Namespace Agents and durably associates revisions with their owner",
  requiresPostgresAndKubernetesConfiguration,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const process = await startKubernetesController(context);

    const namespace = await request(process, "POST", "/namespaces", {
      name: `concurrent-agents-${randomUUID()}`,
    });
    assert.equal(namespace.status, 201);
    assert.equal(namespace.data.status, "provisioning");
    cleanupKubernetesNamespaces(context, [namespace.data.id]);

    const worker = await startKubernetesWorker(context);
    await grantTenantAccess(context, namespace.data.id);
    await waitForNamespaceReady(process, namespace.data.id, worker);

    const firstValues = { ...defaultAgentConfigurationValues, model: { id: "gpt-integration" } };
    const secondValues = {
      ...defaultAgentConfigurationValues,
      model: { id: "gpt-integration-sibling" },
    };
    const [firstConfiguration, secondConfiguration] = await Promise.all([
      createConfiguration(process, namespace.data.id, firstValues),
      createConfiguration(process, namespace.data.id, secondValues),
    ]);
    const [first, second] = await Promise.all([
      request(process, "POST", `/namespaces/${namespace.data.id}/agents`, {
        name: `first-${randomUUID()}`,
        configurationId: firstConfiguration.id,
      }),
      request(process, "POST", `/namespaces/${namespace.data.id}/agents`, {
        name: `second-${randomUUID()}`,
        configurationId: secondConfiguration.id,
      }),
    ]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.data.id, second.data.id);
    assert.equal(first.data.namespaceId, namespace.data.id);
    assert.equal(second.data.namespaceId, namespace.data.id);
    assert.equal(Object.hasOwn(first.data, "servicePrincipalId"), false);
    assert.equal(Object.hasOwn(second.data, "servicePrincipalId"), false);

    const stillReady = await request(process, "GET", `/namespaces/${namespace.data.id}`);
    assert.equal(stillReady.status, 200);
    assert.equal(stillReady.data.status, "ready");
    const listed = await request(process, "GET", `/namespaces/${namespace.data.id}/agents`);
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.data.map(({ id }) => id).sort(),
      [first.data.id, second.data.id].sort(),
    );

    const persistedAgents = await pool.query(
      `SELECT agent.id, agent.namespace_id, agent.execution_mode, agent.service_principal_id,
              identity.kind, identity.agent_id
       FROM occ.agents AS agent
       JOIN occ.iam_identities AS identity
         ON identity.id = agent.service_principal_id
        AND identity.namespace_id = agent.namespace_id
        AND identity.agent_id = agent.id
       WHERE agent.namespace_id = $1 ORDER BY agent.id`,
      [namespace.data.id],
    );
    assert.equal(persistedAgents.rowCount, 2);
    assert.deepEqual(
      persistedAgents.rows.map(({ id }) => id),
      [first.data.id, second.data.id].sort(),
    );
    assert.notEqual(
      persistedAgents.rows[0].service_principal_id,
      persistedAgents.rows[1].service_principal_id,
    );
    assert.ok(persistedAgents.rows.every(({ execution_mode }) => execution_mode === "embedded"));
    assert.ok(persistedAgents.rows.every(({ kind }) => kind === "service_principal"));

    const historyBefore = await request(
      process,
      "GET",
      `/namespaces/${namespace.data.id}/agents/${first.data.id}/revisions`,
    );
    assert.equal(historyBefore.status, 200);
    assert.deepEqual(historyBefore.data, []);

    const deployment = await request(
      process,
      "POST",
      `/namespaces/${namespace.data.id}/agents/${first.data.id}/deploy`,
    );
    assert.equal(deployment.status, 202);
    const revision = deployment.data;
    assert.equal(revision.namespaceId, namespace.data.id);
    assert.equal(revision.agentId, first.data.id);
    assert.equal(revision.revision, 1);
    assert.equal(revision.configurationId, firstConfiguration.id);
    assert.equal(revision.configurationKind, "agent");
    assert.equal(revision.configurationGeneration, 1);
    assert.deepEqual(revision.configuration, admitted(firstValues));
    assert.deepEqual(revision.harness, { id: "openclaw", version: "1.0.0", mode: "embedded" });
    assert.deepEqual(revision.compute, {
      id: "compute-kubernetes",
      implementation: "occ/kubernetes",
    });

    const activeAgent = await pollUntil(
      `independent worker to activate admitted revision ${revision.id}`,
      async () => {
        const current = await request(
          process,
          "GET",
          `/namespaces/${namespace.data.id}/agents/${first.data.id}`,
        );
        assert.equal(current.status, 200);
        return current.data.activeRevisionId === revision.id ? current.data : undefined;
      },
      { worker, timeoutMs: 60_000 },
    );

    const [firstHistory, secondHistory] = await Promise.all([
      request(process, "GET", `/namespaces/${namespace.data.id}/agents/${first.data.id}/revisions`),
      request(
        process,
        "GET",
        `/namespaces/${namespace.data.id}/agents/${second.data.id}/revisions`,
      ),
    ]);
    assert.equal(firstHistory.status, 200);
    assert.equal(secondHistory.status, 200);
    assert.deepEqual(firstHistory.data, [revision]);
    assert.deepEqual(secondHistory.data, []);

    const actor = await pool.query(
      `SELECT identity.id
       FROM occ.iam_identities AS identity
       JOIN occ."user" AS auth_user ON auth_user.id = identity.subject
       WHERE auth_user.email = $1`,
      [adminEmail],
    );
    assert.equal(actor.rowCount, 1);
    const principalId = actor.rows[0].id;

    const persistedRevision = await pool.query(
      `SELECT agent.id AS agent_id, agent.namespace_id, agent.active_revision_id,
              revision.id AS revision_id, revision.revision_number, revision.admitted_spec
       FROM occ.agents AS agent
       JOIN occ.agent_revisions AS revision
         ON revision.namespace_id = agent.namespace_id AND revision.agent_id = agent.id
       WHERE agent.namespace_id = $1 AND agent.id = $2`,
      [namespace.data.id, first.data.id],
    );
    assert.equal(persistedRevision.rowCount, 1);
    assert.equal(persistedRevision.rows[0].agent_id, first.data.id);
    assert.equal(persistedRevision.rows[0].namespace_id, namespace.data.id);
    assert.equal(persistedRevision.rows[0].revision_id, revision.id);
    assert.equal(Number(persistedRevision.rows[0].revision_number), 1);
    assert.deepEqual(persistedRevision.rows[0].admitted_spec, {
      configuration_id: revision.configurationId,
      configuration_kind: revision.configurationKind,
      configuration_generation: revision.configurationGeneration,
      draft_spec: admitted(firstValues),
      harness: revision.harness,
      compute: revision.compute,
    });
    assert.equal(persistedRevision.rows[0].active_revision_id, revision.id);
    assert.equal(activeAgent.activeRevisionId, revision.id);

    const revisionWork = await pool.query(
      `SELECT namespace_id, agent_id, revision_id, actor_id, state
       FROM occ.controller_work WHERE revision_id = $1`,
      [revision.id],
    );
    assert.deepEqual(revisionWork.rows, [
      {
        namespace_id: namespace.data.id,
        agent_id: first.data.id,
        revision_id: revision.id,
        actor_id: principalId,
        state: "succeeded",
      },
    ]);
  },
);

test(
  "PostgreSQL platform state satisfies memory adapter ownership, immutability, and atomicity",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { PostgresPlatformState }, { NativeIAMDriver }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../packages/iam/src/index.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const installation = await state.loadInstallation();
    assert.ok(installation, "the prior API integration must bootstrap the sole Installation");

    const fixture = await verifyPlatformStateStoreContract(state, { installation });
    const durable = await pool.query(
      `SELECT
       (SELECT count(*)::integer FROM occ.agent_revisions WHERE id = $1) AS revisions,
       (SELECT count(*)::integer FROM occ.audit_events WHERE id = $2) AS audit_events,
       (SELECT count(*)::integer FROM occ.controller_work WHERE revision_id = $1) AS operations,
       (SELECT count(*)::integer FROM occ.namespaces
         WHERE id = $3 AND deleted_at IS NOT NULL) AS tombstones`,
      [fixture.revision.id, fixture.audit.id, fixture.lifecycleNamespace.id],
    );
    assert.deepEqual(durable.rows[0], {
      revisions: 1,
      audit_events: 1,
      operations: 1,
      tombstones: 1,
    });
    const durableAccount = await pool.query(
      "SELECT id, namespace_id, name, credential " + "FROM occ.service_accounts WHERE id = $1",
      [fixture.serviceAccount.id],
    );
    assert.deepEqual(durableAccount.rows, [
      {
        id: fixture.serviceAccount.id,
        namespace_id: fixture.serviceAccountNamespace.id,
        name: fixture.serviceAccount.name,
        credential: fixture.serviceAccount.credential,
      },
    ]);

    const sandboxDriverId = "openshell-sandbox";
    const sandboxRevision = await state.transact((unit) =>
      unit.revisions.createRevision({
        ...fixture.revision,
        id: `rev_${randomUUID()}`,
        revision: fixture.revision.revision + 1,
        sandboxDriverId,
      }),
    );
    const reloadedSandboxRevision = await state.read((unit) =>
      unit.revisions.findRevision(
        sandboxRevision.namespaceId,
        sandboxRevision.agentId,
        sandboxRevision.id,
      ),
    );
    assert.ok(reloadedSandboxRevision);
    assert.equal(reloadedSandboxRevision.sandboxDriverId, sandboxDriverId);
    assert.equal(Object.isFrozen(reloadedSandboxRevision), true);
    const durableSandboxRevision = await pool.query(
      "SELECT admitted_spec FROM occ.agent_revisions WHERE id = $1",
      [sandboxRevision.id],
    );
    assert.equal(durableSandboxRevision.rows[0].admitted_spec.sandbox_driver_id, sandboxDriverId);
    assert.equal(Object.hasOwn(durableSandboxRevision.rows[0].admitted_spec, "sandbox"), false);

    // The database accepts only a nonempty SandboxDriver identity, not descriptors or blank values.
    for (const [offset, invalid] of [null, "", " ", 1, { id: sandboxDriverId }].entries()) {
      await assert.rejects(
        pool.query(
          `INSERT INTO occ.agent_revisions
             (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at)
           SELECT $2, namespace_id, agent_id, $3,
                  jsonb_set(admitted_spec, '{sandbox_driver_id}', $1::jsonb, true), admitted_at
           FROM occ.agent_revisions WHERE id = $4`,
          [
            JSON.stringify(invalid),
            `rev_${randomUUID()}`,
            sandboxRevision.revision + 100 + offset,
            sandboxRevision.id,
          ],
        ),
        ({ code, constraint }) =>
          code === "23514" && constraint === "agent_revisions_admitted_snapshot",
      );
    }

    // The database, not adapter-only validation, rejects malformed or cross-scope credential JSON.
    for (const invalid of [
      null,
      {},
      { kind: "api_key", secretRef: { name: "valid-source" } },
      { kind: "bearer", secretRef: { name: "valid-source", key: "api-key" } },
      { kind: "api_key", secretRef: { name: "INVALID", key: "api-key" } },
      ...["../token", ".", ".."].map((key) => ({
        kind: "api_key",
        secretRef: { name: "valid-source", key },
      })),
      {
        kind: "api_key",
        secretRef: { name: "valid-source", key: "api-key", namespace: "another-tenant" },
      },
      {
        kind: "api_key",
        secretRef: { name: "valid-source", key: "api-key" },
        token: "plaintext-must-not-persist",
      },
    ]) {
      await assert.rejects(
        pool.query("UPDATE occ.service_accounts SET credential = $1::jsonb WHERE id = $2", [
          JSON.stringify(invalid),
          fixture.serviceAccount.id,
        ]),
        ({ code, constraint }) =>
          code === "23514" && constraint === "service_accounts_credential_valid",
      );
    }

    const accountPrivileges = await pool.query(
      "SELECT " +
        "has_table_privilege(current_user, 'occ.service_accounts', 'SELECT') AS can_read, " +
        "has_table_privilege(current_user, 'occ.service_accounts', 'INSERT') AS can_insert, " +
        "has_table_privilege(current_user, 'occ.service_accounts', 'DELETE') AS can_delete, " +
        "has_column_privilege(current_user, 'occ.service_accounts', 'credential', 'UPDATE') " +
        "AS can_update_credential, " +
        "has_column_privilege(current_user, 'occ.service_accounts', 'id', 'UPDATE') " +
        "AS can_update_identity, " +
        "has_column_privilege(current_user, 'occ.service_accounts', 'namespace_id', 'UPDATE') " +
        "AS can_update_owner",
    );
    assert.deepEqual(accountPrivileges.rows, [
      {
        can_read: true,
        can_insert: true,
        can_delete: true,
        can_update_credential: true,
        can_update_identity: false,
        can_update_owner: false,
      },
    ]);

    const principalId = `principal-${randomUUID()}`;
    const groupId = `group-${randomUUID()}`;
    const roleId = `role-${randomUUID()}`;
    const sharedRoleId = `role-${randomUUID()}`;
    const bindingId = `binding-${randomUUID()}`;
    const agentBindingId = `binding-${randomUUID()}`;
    const restrictionId = `restriction-${randomUUID()}`;
    const accountRoleId = "role-" + randomUUID();
    const accountBindingId = "binding-" + randomUUID();
    const accountCreationBindingId = "binding-" + randomUUID();
    const accountRestrictionId = "restriction-" + randomUUID();
    const platformActions = [
      "create",
      "read",
      "update",
      "delete",
      "deploy",
      "operate",
      "administer",
    ];
    const siblingId = `agt_${randomUUID()}`;
    const sibling = await state.transact((unit) =>
      unit.agents.createAgent({
        id: siblingId,
        namespaceId: fixture.namespace.id,
        name: `Sibling ${randomUUID()}`,
        configurationId: fixture.configuration.id,
        providerId: null,
        executionMode: "embedded",
        servicePrincipalId: `service-agent-${siblingId}`,
        createdAt: new Date().toISOString(),
      }),
    );
    await state.seedNativeIAM({
      identities: [
        {
          id: principalId,
          kind: "principal",
          issuer: `postgres-platform-${randomUUID()}`,
          subject: `principal-${randomUUID()}`,
        },
      ],
      groups: [
        {
          id: groupId,
          namespaceId: fixture.namespace.id,
          name: `Operators ${randomUUID()}`,
        },
      ],
      memberships: [
        {
          namespaceId: fixture.namespace.id,
          groupId,
          principalId,
        },
      ],
      roles: [
        {
          id: roleId,
          namespaceId: fixture.namespace.id,
          name: `Reader ${randomUUID()}`,
          permissions: [{ action: "read", resourceKind: "agent" }],
        },
        {
          id: sharedRoleId,
          namespaceId: fixture.namespace.id,
          name: `Agent operators ${randomUUID()}`,
          permissions: platformActions.map((action) => ({ action, resourceKind: "agent" })),
        },
        {
          id: accountRoleId,
          namespaceId: fixture.serviceAccountNamespace.id,
          name: "Exact account access " + randomUUID(),
          permissions: [
            { action: "create", resourceKind: "service_account" },
            { action: "read", resourceKind: "service_account" },
            { action: "update", resourceKind: "service_account" },
          ],
        },
      ],
      bindings: [
        {
          id: bindingId,
          namespaceId: fixture.namespace.id,
          subjectKind: "group",
          subjectId: groupId,
          roleId,
          resourceKind: "agent",
          resourceId: fixture.agent.id,
        },
        {
          id: `binding-${randomUUID()}`,
          namespaceId: fixture.namespace.id,
          subjectKind: "identity",
          subjectId: principalId,
          roleId: sharedRoleId,
        },
        {
          id: accountBindingId,
          namespaceId: fixture.serviceAccountNamespace.id,
          subjectKind: "identity",
          subjectId: principalId,
          roleId: accountRoleId,
          resourceKind: "service_account",
          resourceId: fixture.serviceAccount.id,
        },
        {
          id: accountCreationBindingId,
          namespaceId: fixture.serviceAccountNamespace.id,
          subjectKind: "identity",
          subjectId: principalId,
          roleId: accountRoleId,
          resourceKind: "service_account",
          resourceId: fixture.serviceAccountNamespace.id,
        },
      ],
      restrictions: [
        {
          id: restrictionId,
          namespaceId: fixture.namespace.id,
          action: "deploy",
          resourceKind: "agent",
          resourceId: fixture.agent.id,
          effect: "deny",
        },
        {
          id: accountRestrictionId,
          namespaceId: fixture.serviceAccountNamespace.id,
          action: "update",
          resourceKind: "service_account",
          resourceId: fixture.serviceAccount.id,
          effect: "deny",
        },
      ],
    });
    await pool.query(
      `INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, role_id)
       VALUES ($1, $2, $3, $4)`,
      [agentBindingId, fixture.namespace.id, fixture.agent.servicePrincipalId, sharedRoleId],
    );

    const reopened = new PostgresPlatformState(pool);
    await reopened.read(async (view) => {
      const revision = await view.revisions.findRevision(
        fixture.namespace.id,
        fixture.agent.id,
        fixture.revision.id,
      );
      assert.deepEqual(revision, fixture.revision);
    });
    const reloadedIAM = await reopened.loadNativeIAMState(installation.id);
    assert.deepEqual(
      reloadedIAM.identities.find(({ id }) => id === fixture.agent.servicePrincipalId),
      {
        id: fixture.agent.servicePrincipalId,
        kind: "service_principal",
        namespaceId: fixture.namespace.id,
        agentId: fixture.agent.id,
      },
      "The Agent service principal and its exact owner survive a PostgreSQL restart.",
    );
    assert.ok(
      reloadedIAM.identities.every((identity) => !Object.hasOwn(identity, "installationId")),
    );
    assert.ok(reloadedIAM.groups.some(({ id }) => id === groupId));
    assert.ok(
      reloadedIAM.memberships.some(
        ({ groupId: storedGroupId, principalId: storedPrincipalId }) =>
          storedGroupId === groupId && storedPrincipalId === principalId,
      ),
    );
    assert.ok(
      reloadedIAM.bindings.some(
        ({ id, subjectKind }) => id === bindingId && subjectKind === "group",
      ),
    );
    assert.ok(
      reloadedIAM.bindings.some(
        ({ id, subjectId }) =>
          id === agentBindingId && subjectId === fixture.agent.servicePrincipalId,
      ),
    );
    assert.ok(reloadedIAM.restrictions.some(({ id }) => id === restrictionId));
    assert.ok(
      reloadedIAM.bindings.some(
        ({ id, resourceKind, resourceId }) =>
          id === accountBindingId &&
          resourceKind === "service_account" &&
          resourceId === fixture.serviceAccount.id,
      ),
    );
    assert.ok(
      reloadedIAM.bindings.some(
        ({ id, resourceKind, resourceId }) =>
          id === accountCreationBindingId &&
          resourceKind === "service_account" &&
          resourceId === fixture.serviceAccountNamespace.id,
      ),
    );
    assert.ok(
      reloadedIAM.restrictions.some(
        ({ id, resourceKind }) => id === accountRestrictionId && resourceKind === "service_account",
      ),
    );

    const iam = new NativeIAMDriver(reopened);
    assert.equal(
      (
        await iam.authorize({
          principalId,
          action: "create",
          resource: {
            kind: "service_account",
            id: fixture.serviceAccountNamespace.id,
            namespaceId: fixture.serviceAccountNamespace.id,
          },
        })
      ).allowed,
      true,
      "An exact persisted collection binding authorizes ServiceAccount creation.",
    );
    assert.equal(
      (
        await iam.authorize({
          principalId,
          action: "read",
          resource: {
            kind: "service_account",
            id: fixture.serviceAccount.id,
            namespaceId: fixture.serviceAccountNamespace.id,
          },
        })
      ).allowed,
      true,
      "An exact persisted account binding grants only the named account.",
    );
    assert.equal(
      (
        await iam.authorize({
          principalId,
          action: "update",
          resource: {
            kind: "service_account",
            id: fixture.serviceAccount.id,
            namespaceId: fixture.serviceAccountNamespace.id,
          },
        })
      ).allowed,
      false,
      "An exact persisted account Restriction overrides its granted update.",
    );
    for (const identityId of [principalId, fixture.agent.servicePrincipalId]) {
      for (const action of platformActions) {
        const ownAgentDecision = await iam.authorize({
          principalId: identityId,
          action,
          resource: {
            kind: "agent",
            id: fixture.agent.id,
            namespaceId: fixture.namespace.id,
          },
        });
        assert.equal(
          ownAgentDecision.allowed,
          action !== "deploy",
          `${identityId} should receive its granted ${action} action unless an exact Restriction denies it`,
        );

        const siblingDecision = await iam.authorize({
          principalId: identityId,
          action,
          resource: { kind: "agent", id: sibling.id, namespaceId: fixture.namespace.id },
        });
        assert.equal(
          siblingDecision.allowed,
          true,
          `${identityId} should receive its granted ${action} action for a same-Namespace sibling`,
        );
      }

      const foreignNamespaceDecision = await iam.authorize({
        principalId: identityId,
        action: "read",
        resource: {
          kind: "agent",
          id: `agt_${randomUUID()}`,
          namespaceId: `ns_${randomUUID()}`,
        },
      });
      assert.equal(foreignNamespaceDecision.allowed, false);
    }
  },
);

test(
  "independent PostgreSQL API and worker provision isolated Namespaces, activate admitted revisions, and tombstone deletion",
  requiresPostgresAndKubernetesConfiguration,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const api = await startKubernetesController(context);

    const installation = await request(api, "GET", "/installation");
    if (installation.status === 404) {
      const created = await request(api, "POST", "/installation/bootstrap", {
        name: "Independent PostgreSQL worker integration",
      });
      assert.equal(created.status, 201);
    } else {
      assert.equal(installation.status, 200);
    }

    const [removed, retained] = await Promise.all([
      request(api, "POST", "/namespaces", { name: `worker-remove-${randomUUID()}` }),
      request(api, "POST", "/namespaces", { name: `worker-retain-${randomUUID()}` }),
    ]);
    for (const namespace of [removed, retained]) {
      assert.equal(namespace.status, 201);
      assert.equal(namespace.data.status, "provisioning");
      assert.equal(Object.hasOwn(namespace.data, "installationId"), false);
    }
    assert.notEqual(removed.data.id, retained.data.id);
    cleanupKubernetesNamespaces(context, [removed.data.id, retained.data.id]);

    const worker = await startKubernetesWorker(context);
    await Promise.all([
      grantTenantAccess(context, removed.data.id),
      grantTenantAccess(context, retained.data.id),
    ]);
    for (const namespace of [removed, retained]) {
      await waitForNamespaceReady(api, namespace.data.id, worker);
    }

    const { agent } = await createConfiguredAgent(
      api,
      retained.data.id,
      `worker-agent-${randomUUID()}`,
    );
    const preDeploymentWork = await pool.query(
      `SELECT idempotency_key FROM occ.controller_work
       WHERE namespace_id = $1 AND agent_id = $2`,
      [retained.data.id, agent.id],
    );
    assert.equal(preDeploymentWork.rowCount, 0, "Agent creation must not enqueue deployment work");

    const deployment = await request(
      api,
      "POST",
      `/namespaces/${retained.data.id}/agents/${agent.id}/deploy`,
    );
    assert.equal(deployment.status, 202);
    const revision = deployment.data;
    assert.deepEqual(revision.harness, { id: "openclaw", version: "1.0.0", mode: "embedded" });
    assert.deepEqual(revision.compute, {
      id: "compute-kubernetes",
      implementation: "occ/kubernetes",
    });

    await pollUntil(
      `independent worker to activate admitted revision ${revision.id}`,
      async () => {
        const current = await request(
          api,
          "GET",
          `/namespaces/${retained.data.id}/agents/${agent.id}`,
        );
        assert.equal(current.status, 200);
        return current.data.activeRevisionId === revision.id ? current.data : undefined;
      },
      { worker, timeoutMs: 60_000 },
    );

    const deletion = await request(api, "DELETE", `/namespaces/${removed.data.id}`);
    assert.equal(deletion.status, 202);
    assert.equal(deletion.data.status, "deleting");

    const tombstone = await pollUntil(
      `Namespace ${removed.data.id} to receive its exact durable deletion tombstone`,
      async () => {
        const rows = await pool.query(
          "SELECT id, status, deleted_at FROM occ.namespaces WHERE id = $1",
          [removed.data.id],
        );
        assert.equal(rows.rowCount, 1);
        return rows.rows[0].deleted_at === null ? undefined : rows.rows[0];
      },
      { worker, timeoutMs: 60_000 },
    );
    assert.equal(tombstone.id, removed.data.id);
    assert.equal(tombstone.status, "deleting");
    assert.ok(tombstone.deleted_at instanceof Date);
    assert.equal((await request(api, "GET", `/namespaces/${removed.data.id}`)).status, 404);

    const unaffected = await request(api, "GET", `/namespaces/${retained.data.id}`);
    assert.equal(unaffected.status, 200);
    assert.equal(unaffected.data.id, retained.data.id);
    assert.equal(unaffected.data.status, "ready");

    const work = await pool.query(
      `SELECT namespace_id, namespace_target, state
       FROM occ.controller_work
       WHERE namespace_id = ANY($1::text[]) AND agent_id IS NULL
       ORDER BY namespace_id, namespace_target`,
      [[removed.data.id, retained.data.id]],
    );
    assert.deepEqual(
      work.rows.map(({ namespace_id, namespace_target, state }) => ({
        namespaceId: namespace_id,
        target: namespace_target,
        state,
      })),
      [
        { namespaceId: removed.data.id, target: "deleted", state: "succeeded" },
        { namespaceId: removed.data.id, target: "ready", state: "succeeded" },
        { namespaceId: retained.data.id, target: "ready", state: "succeeded" },
      ].sort((left, right) => {
        const owners = left.namespaceId.localeCompare(right.namespaceId);
        return owners === 0 ? left.target.localeCompare(right.target) : owners;
      }),
    );

    const admittedWork = await pool.query(
      `SELECT idempotency_key, state, attempt_count, claim_token,
              lease_expires_at, completed_at
       FROM occ.controller_work WHERE revision_id = $1`,
      [revision.id],
    );
    assert.equal(admittedWork.rowCount, 1);
    assert.equal(admittedWork.rows[0].idempotency_key, `agent_revision:${revision.id}:reconcile`);
    assert.equal(admittedWork.rows[0].state, "succeeded");
    assert.equal(admittedWork.rows[0].attempt_count, 1);
    assert.equal(admittedWork.rows[0].claim_token, null);
    assert.equal(admittedWork.rows[0].lease_expires_at, null);
    assert.ok(admittedWork.rows[0].completed_at instanceof Date);
  },
);

test(
  "the PostgreSQL worker reloads exact Namespace restrictions and never dispatches revoked provisioning",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { createControllerWorker }, { createDevelopmentComputeDriver }] =
      await Promise.all([
        import("pg"),
        import("../../apps/controller/src/worker.ts"),
        import("../helpers/development.mjs"),
      ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const api = await startController(context);

    const installation = await request(api, "GET", "/installation");
    if (installation.status === 404) {
      const created = await request(api, "POST", "/installation/bootstrap", {
        name: "Revoked provisioning integration",
      });
      assert.equal(created.status, 201);
    } else {
      assert.equal(installation.status, 200);
    }
    const actor = await pool.query(
      `SELECT identity.id
       FROM occ.iam_identities AS identity
       JOIN occ."user" AS auth_user ON auth_user.id = identity.subject
       WHERE auth_user.email = $1`,
      [adminEmail],
    );
    assert.equal(actor.rowCount, 1);
    const principalId = actor.rows[0].id;

    const namespace = await request(api, "POST", "/namespaces", {
      name: `revoked-before-dispatch-${randomUUID()}`,
    });
    assert.equal(namespace.status, 201);
    const authorizedNamespace = await request(api, "POST", "/namespaces", {
      name: `authorized-positive-control-${randomUUID()}`,
    });
    assert.equal(authorizedNamespace.status, 201);

    const restrictionId = `restriction-worker-${randomUUID()}`;
    await pool.query(
      `INSERT INTO occ.iam_restrictions
       (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'create', 'namespace', $2, 'deny')`,
      [restrictionId, namespace.data.id],
    );

    const observedComputeEffects = [];
    const developmentCompute = createDevelopmentComputeDriver();
    const worker = createControllerWorker({
      pool: new Pool({ connectionString: databaseUrl }),
      pollIntervalMs: 20,
      computeDriver: {
        ...developmentCompute,
        async ensureNamespace(candidate) {
          observedComputeEffects.push(candidate.id);
          return developmentCompute.ensureNamespace(candidate);
        },
      },
      emit() {},
    });
    context.after(() => worker.stop());
    await worker.start();

    const rejected = await pollUntil(
      `revoked provisioning for Namespace ${namespace.data.id} to fail permanently`,
      async () => {
        const rows = await pool.query(
          `SELECT state, attempt_count FROM occ.controller_work
           WHERE namespace_id = $1 AND namespace_target = 'ready'`,
          [namespace.data.id],
        );
        assert.equal(rows.rowCount, 1);
        return rows.rows[0].state === "failed_permanent" ? rows.rows[0] : undefined;
      },
    );
    assert.equal(rejected.attempt_count, 1);

    await pollUntil(
      `authorized positive-control Namespace ${authorizedNamespace.data.id} to become ready`,
      async () => {
        const rows = await pool.query("SELECT status FROM occ.namespaces WHERE id = $1", [
          authorizedNamespace.data.id,
        ]);
        assert.equal(rows.rowCount, 1);
        return rows.rows[0].status === "ready" ? rows.rows[0] : undefined;
      },
    );
    assert.ok(
      observedComputeEffects.includes(authorizedNamespace.data.id),
      "the positive-control Namespace must invoke the injected ComputeDriver",
    );
    assert.ok(
      !observedComputeEffects.includes(namespace.data.id),
      "denied provisioning must not invoke the injected ComputeDriver",
    );

    const persistedNamespace = await pool.query(
      "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
      [namespace.data.id],
    );
    assert.deepEqual(persistedNamespace.rows, [{ status: "failed", deleted_at: null }]);

    const lifecycleEffects = await pool.query(
      `SELECT action, outcome, actor_id FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'openclaw.namespaces.lifecycle.ensure'
         AND outcome = 'success'`,
      [namespace.data.id],
    );
    assert.equal(lifecycleEffects.rowCount, 0);

    const denial = await pool.query(
      `SELECT actor_id, outcome, details FROM occ.audit_events
       WHERE resource_id = $1 AND actor_id = $2 AND outcome IN ('denied', 'failure')`,
      [namespace.data.id, principalId],
    );
    assert.ok(denial.rowCount > 0, "revocation must produce attributable durable failure evidence");
  },
);

test(
  "PostgreSQL API and worker preserve immutable deployments, stable identities, and tenant isolation",
  requiresPostgresAndKubernetesConfiguration,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    let api = await startKubernetesController(context);

    const existingInstallation = await request(api, "GET", "/installation");
    if (existingInstallation.status === 404) {
      const bootstrapped = await request(api, "POST", "/installation/bootstrap", {
        name: "Immutable revision integration",
      });
      assert.equal(bootstrapped.status, 201);
    } else {
      assert.equal(existingInstallation.status, 200);
    }

    const [firstNamespace, secondNamespace] = await Promise.all([
      request(api, "POST", "/namespaces", { name: `revision-tenant-a-${randomUUID()}` }),
      request(api, "POST", "/namespaces", { name: `revision-tenant-b-${randomUUID()}` }),
    ]);
    assert.equal(firstNamespace.status, 201);
    assert.equal(secondNamespace.status, 201);
    const namespaceA = firstNamespace.data.id;
    const namespaceB = secondNamespace.data.id;
    cleanupKubernetesNamespaces(context, [namespaceA, namespaceB]);

    const worker = await startKubernetesWorker(context);
    await Promise.all([
      grantTenantAccess(context, namespaceA),
      grantTenantAccess(context, namespaceB),
    ]);
    for (const namespaceId of [namespaceA, namespaceB]) {
      await waitForNamespaceReady(api, namespaceId, worker);
    }

    const originalConfigValues = {
      ...defaultAgentConfigurationValues,
      model: { id: "draft-original" },
      tools: ["lookup"],
    };
    const [
      { configuration: primaryConfiguration, agent: primary },
      { agent: sibling },
      { agent: foreign },
      { agent: restricted },
    ] = await Promise.all([
      createConfiguredAgent(
        api,
        namespaceA,
        `revision-primary-${randomUUID()}`,
        originalConfigValues,
      ),
      createConfiguredAgent(api, namespaceA, `revision-sibling-${randomUUID()}`, {
        ...defaultAgentConfigurationValues,
        model: { id: "tenant-a-sibling" },
      }),
      createConfiguredAgent(api, namespaceB, `revision-foreign-${randomUUID()}`, {
        ...defaultAgentConfigurationValues,
        model: { id: "tenant-b" },
      }),
      createConfiguredAgent(api, namespaceA, `revision-restricted-${randomUUID()}`),
    ]);
    for (const created of [primary, sibling, foreign, restricted]) {
      assert.equal(Object.hasOwn(created, "servicePrincipalId"), false);
    }
    assert.equal(primary.configurationId, primaryConfiguration.id);

    const persistedConfigValues = {
      ...defaultAgentConfigurationValues,
      model: { id: "draft-persisted" },
      tools: ["lookup", "search"],
    };
    const persistedConfiguration = await updateConfiguration(
      api,
      namespaceA,
      primaryConfiguration.id,
      persistedConfigValues,
    );
    assert.equal(persistedConfiguration.id, primaryConfiguration.id);
    assert.equal(persistedConfiguration.generation, 2);
    assert.deepEqual(persistedConfiguration.values, persistedConfigValues);

    const noMetadataEffects = await pool.query(
      `SELECT count(*)::integer AS count FROM occ.controller_work
       WHERE namespace_id = ANY($1::text[]) AND agent_id IS NOT NULL`,
      [[namespaceA, namespaceB]],
    );
    assert.equal(noMetadataEffects.rows[0].count, 0);

    const deniedTargetConfiguration = await createConfiguration(api, namespaceA, {
      ...defaultAgentConfigurationValues,
      model: { id: "unauthorized-update" },
    });
    await pool.query(
      `INSERT INTO occ.iam_restrictions
       (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $3, 'update', 'agent', $4, 'deny'),
              ($2, $3, 'deploy', 'agent', $4, 'deny')`,
      [
        `restriction-update-${randomUUID()}`,
        `restriction-deploy-${randomUUID()}`,
        namespaceA,
        restricted.id,
      ],
    );

    await stopController(api.child);
    api = await startKubernetesController(context);
    const afterRestart = await request(
      api,
      "GET",
      `/namespaces/${namespaceA}/configurations/${primaryConfiguration.id}`,
    );
    assert.equal(afterRestart.status, 200);
    assert.equal(afterRestart.data.generation, 2);
    assert.deepEqual(afterRestart.data.values, persistedConfigValues);

    const deniedUpdate = await request(
      api,
      "PATCH",
      `/namespaces/${namespaceA}/agents/${restricted.id}`,
      { configurationId: deniedTargetConfiguration.id },
    );
    assert.equal(deniedUpdate.status, 403);
    const deniedDeployment = await request(
      api,
      "POST",
      `/namespaces/${namespaceA}/agents/${restricted.id}/deploy`,
    );
    assert.equal(deniedDeployment.status, 403);
    const deniedMutation = await pool.query(
      `SELECT agent.configuration_id,
              (SELECT count(*)::integer FROM occ.agent_revisions WHERE agent_id = agent.id)
                AS revisions,
              (SELECT count(*)::integer FROM occ.controller_work WHERE agent_id = agent.id)
                AS work
       FROM occ.agents AS agent WHERE agent.id = $1`,
      [restricted.id],
    );
    assert.deepEqual(deniedMutation.rows, [
      { configuration_id: restricted.configurationId, revisions: 0, work: 0 },
    ]);

    const firstDeployment = await request(
      api,
      "POST",
      `/namespaces/${namespaceA}/agents/${primary.id}/deploy`,
    );
    assert.equal(firstDeployment.status, 202);
    const firstRevision = firstDeployment.data;
    assert.deepEqual(Object.keys(firstRevision).sort(), [
      "agentId",
      "compute",
      "configuration",
      "configurationGeneration",
      "configurationId",
      "configurationKind",
      "createdAt",
      "harness",
      "id",
      "namespaceId",
      "providerId",
      "revision",
    ]);
    assert.equal(firstRevision.namespaceId, namespaceA);
    assert.equal(firstRevision.agentId, primary.id);
    assert.equal(firstRevision.revision, 1);
    assert.equal(firstRevision.configurationId, primaryConfiguration.id);
    assert.equal(firstRevision.configurationKind, "agent");
    assert.equal(firstRevision.configurationGeneration, 2);
    assert.deepEqual(firstRevision.configuration, admitted(persistedConfigValues));
    assert.deepEqual(firstRevision.harness, { id: "openclaw", version: "1.0.0", mode: "embedded" });
    assert.deepEqual(firstRevision.compute, {
      id: "compute-kubernetes",
      implementation: "occ/kubernetes",
    });
    assert.equal(Object.hasOwn(firstRevision, "servicePrincipalId"), false);

    await pollUntil(
      `first revision ${firstRevision.id} to become active`,
      async () => {
        const current = await request(api, "GET", `/namespaces/${namespaceA}/agents/${primary.id}`);
        assert.equal(current.status, 200);
        return current.data.activeRevisionId === firstRevision.id ? current.data : undefined;
      },
      { worker, timeoutMs: 60_000 },
    );

    const replacementConfigValues = {
      ...defaultAgentConfigurationValues,
      model: { id: "draft-replacement" },
      tools: ["replace"],
    };
    const replacement = await updateConfiguration(
      api,
      namespaceA,
      primaryConfiguration.id,
      replacementConfigValues,
    );
    assert.equal(replacement.generation, 3);

    const [secondDeployment, siblingDeployment, foreignDeployment] = await Promise.all([
      request(api, "POST", `/namespaces/${namespaceA}/agents/${primary.id}/deploy`),
      request(api, "POST", `/namespaces/${namespaceA}/agents/${sibling.id}/deploy`),
      request(api, "POST", `/namespaces/${namespaceB}/agents/${foreign.id}/deploy`),
    ]);
    for (const deployment of [secondDeployment, siblingDeployment, foreignDeployment]) {
      assert.equal(deployment.status, 202);
    }
    const secondRevision = secondDeployment.data;
    assert.equal(secondRevision.revision, 2);
    assert.notEqual(secondRevision.id, firstRevision.id);
    assert.equal(secondRevision.configurationId, primaryConfiguration.id);
    assert.equal(secondRevision.configurationGeneration, 3);
    assert.deepEqual(secondRevision.configuration, admitted(replacementConfigValues));

    for (const [namespaceId, agent, revision] of [
      [namespaceA, primary, secondRevision],
      [namespaceA, sibling, siblingDeployment.data],
      [namespaceB, foreign, foreignDeployment.data],
    ]) {
      await pollUntil(
        `Agent ${agent.id} to activate revision ${revision.id}`,
        async () => {
          const current = await request(
            api,
            "GET",
            `/namespaces/${namespaceId}/agents/${agent.id}`,
          );
          assert.equal(current.status, 200);
          return current.data.activeRevisionId === revision.id ? current.data : undefined;
        },
        { worker, timeoutMs: 60_000 },
      );
    }

    const history = await request(
      api,
      "GET",
      `/namespaces/${namespaceA}/agents/${primary.id}/revisions`,
    );
    assert.equal(history.status, 200);
    assert.deepEqual(history.data, [firstRevision, secondRevision]);
    const firstRevisionRead = await request(
      api,
      "GET",
      `/namespaces/${namespaceA}/agents/${primary.id}/revisions/${firstRevision.id}`,
    );
    assert.equal(firstRevisionRead.status, 200);
    assert.deepEqual(firstRevisionRead.data, firstRevision);
    const foreignRead = await request(
      api,
      "GET",
      `/namespaces/${namespaceB}/agents/${foreign.id}/revisions/${firstRevision.id}`,
    );
    assert.equal(foreignRead.status, 404);

    const persistedRevisions = await pool.query(
      `SELECT revision.id, revision.namespace_id, revision.agent_id,
              revision.revision_number, revision.admitted_spec,
              agent.service_principal_id
       FROM occ.agent_revisions AS revision
       JOIN occ.agents AS agent
         ON agent.namespace_id = revision.namespace_id AND agent.id = revision.agent_id
       WHERE revision.agent_id = $1 ORDER BY revision.revision_number`,
      [primary.id],
    );
    assert.equal(persistedRevisions.rowCount, 2);
    assert.deepEqual(persistedRevisions.rows[0].admitted_spec, {
      configuration_id: firstRevision.configurationId,
      configuration_kind: firstRevision.configurationKind,
      configuration_generation: firstRevision.configurationGeneration,
      draft_spec: admitted(persistedConfigValues),
      harness: firstRevision.harness,
      compute: firstRevision.compute,
    });
    assert.deepEqual(persistedRevisions.rows[1].admitted_spec, {
      configuration_id: secondRevision.configurationId,
      configuration_kind: secondRevision.configurationKind,
      configuration_generation: secondRevision.configurationGeneration,
      draft_spec: admitted(replacementConfigValues),
      harness: secondRevision.harness,
      compute: secondRevision.compute,
    });
    assert.equal(
      persistedRevisions.rows[0].service_principal_id,
      persistedRevisions.rows[1].service_principal_id,
    );

    const identities = await pool.query(
      `SELECT namespace_id, agent_id, id FROM occ.iam_identities
       WHERE kind = 'service_principal' AND agent_id = ANY($1::text[])
       ORDER BY agent_id`,
      [[primary.id, sibling.id, foreign.id]],
    );
    assert.equal(identities.rowCount, 3);
    assert.equal(new Set(identities.rows.map(({ id }) => id)).size, 3);
    const primaryIdentity = identities.rows.find(({ agent_id }) => agent_id === primary.id);
    assert.equal(primaryIdentity.namespace_id, namespaceA);
    assert.equal(primaryIdentity.id, persistedRevisions.rows[0].service_principal_id);

    const work = await pool.query(
      `SELECT namespace_id, agent_id, revision_id, idempotency_key, state
       FROM occ.controller_work WHERE agent_id = ANY($1::text[])
       ORDER BY agent_id, idempotency_key`,
      [[primary.id, sibling.id, foreign.id]],
    );
    assert.equal(work.rowCount, 4);
    for (const item of work.rows) {
      assert.equal(item.state, "succeeded");
      assert.equal(item.idempotency_key, `agent_revision:${item.revision_id}:reconcile`);
    }

    const namespaceWork = await pool.query(
      `SELECT namespace_id, namespace_target, state FROM occ.controller_work
       WHERE namespace_id = ANY($1::text[]) AND agent_id IS NULL`,
      [[namespaceA, namespaceB]],
    );
    assert.equal(namespaceWork.rowCount, 2);
    assert.ok(
      namespaceWork.rows.every(
        ({ namespace_target, state }) => namespace_target === "ready" && state === "succeeded",
      ),
    );

    const lifecycle = await pool.query(
      `SELECT resource_id, action, outcome, details
       FROM occ.audit_events
       WHERE resource_id = ANY($1::text[])
         AND action IN ('openclaw.agents.deploy', 'openclaw.agents.lifecycle.activate')
       ORDER BY occurred_at`,
      [[firstRevision.id, secondRevision.id]],
    );
    assert.equal(lifecycle.rowCount, 4);
    assert.ok(lifecycle.rows.every(({ outcome }) => outcome === "success"));
    const secondActivation = lifecycle.rows.find(
      ({ resource_id, action }) =>
        resource_id === secondRevision.id && action === "openclaw.agents.lifecycle.activate",
    );
    assert.equal(secondActivation.details.previousRevisionId, firstRevision.id);
  },
);
