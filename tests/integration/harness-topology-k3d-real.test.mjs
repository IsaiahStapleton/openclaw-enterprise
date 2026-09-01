import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  authenticatedHeaders,
  createAuthenticatedControllerRequest,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { runGatewayAdministrationFailureProofs } from "../helpers/gateway-administration-proof.mjs";
import {
  gatewayAdministrationSecretName,
  parseGatewayAdministrationCredential,
} from "../../apps/controller/src/drivers/compute/kubernetes/gateway-administration.ts";
import {
  assertGatewayModelTurn,
  configureExistingK3dLocalPathSharedFileSystem,
  createKubernetesInstallationConfiguration,
  createRealKubernetesFixture,
  kubernetesHash as hash,
} from "../helpers/kubernetes-real.mjs";

const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
const runtimeImage = process.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE;
const gatewayImage = process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE ?? runtimeImage;
const codexImage =
  process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE ??
  process.env.OCC_TEST_KUBERNETES_CODEX_IMAGE ??
  runtimeImage;
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const providerModel = (process.env.OCC_TEST_OPENAI_MODEL ?? "gpt-4.1").replace(
  /^(?:openai|codex)\//,
  "",
);
const slackSelected = process.env.OCC_TEST_SLACK_LIVE === "1";
const selected =
  !slackSelected &&
  (process.env.OCC_TEST_HARNESS_K3D_REAL === "1" ||
    [runtimeImage, gatewayImage, codexImage].some(Boolean));
const requiresProductionCluster = {
  skip: selected
    ? false
    : "Set an explicit k3d kubeconfig/context, immutable real OpenClaw/Codex runtime image references, a dedicated openclaw_k8s_* PostgreSQL database, and OPENAI_API_KEY for production model-turn proof.",
};
const requiresLiveSlack = {
  skip: slackSelected
    ? false
    : "Set OCC_TEST_SLACK_LIVE=1 with the production k3d prerequisites, an approved exact Slack proxy, Slack app/bot credentials, a distinct sender bot token, and a shared test channel.",
};
const installationName = "OpenClaw Kubernetes harness topology integration";
const authSecret = "kubernetes-harness-topology-auth-secret-32-bytes";
const authBaseURL = "http://127.0.0.1";
const modelPrefix = "openclaw-agent-model";
const channelPrefix = "openclaw-agent-channels";
const secretRotationProbe = "SECRET_ROTATION_PROBE";
const peerSecretRotationProbe = "SECRET_ROTATION_PEER_PROBE";
const sharedSecretRotationProbe = "SECRET_ROTATION_SHARED_PROBE";
const deniedPort = 18791;
const sharedWorkspaceVolumeName = "openclaw-workspace";
const sharedWorkspaceClaimSize = "40Gi";
const sharedWorkspaceSubPaths = Object.freeze([
  "bundled-skills",
  "generated-images",
  "plugin-skills",
  "sessions",
  "workspace",
]);
const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const {
  kubectlArguments,
  kubectl,
  resource,
  resources,
  createControllerIdentity,
  waitFor,
  validatePrerequisites: validateKubernetesPrerequisites,
  provisionAgentTransportSecret,
  startPortForward,
} = createRealKubernetesFixture({
  kubeconfigPath,
  kubernetesContext,
  gatewayImage,
  codexImage,
  databaseUrl,
});

async function slackApi(method, token, body = {}) {
  const writesMessage = method === "chat.postMessage";
  const url = new URL(`https://slack.com/api/${method}`);
  if (!writesMessage) {
    for (const [key, value] of Object.entries(body)) url.searchParams.set(key, String(value));
  }
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(url, {
        method: writesMessage ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(writesMessage ? { "content-type": "application/json; charset=utf-8" } : {}),
        },
        ...(writesMessage ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const transient =
        error?.name === "TimeoutError" ||
        error?.message === "fetch failed" ||
        ["UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(
          error?.cause?.code ?? error?.code,
        );
      if (writesMessage || attempt === 2 || !transient) throw error;
      await delay(250 * 2 ** attempt);
      continue;
    }
    if (writesMessage || attempt === 2 || (response.status !== 429 && response.status < 500)) break;
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const retryDelay =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(retryAfterSeconds * 1_000, 5_000)
        : 250 * 2 ** attempt;
    await delay(retryDelay);
  }
  assert.equal(response.status, 200, `Slack ${method} returned HTTP ${response.status}.`);
  const result = await response.json();
  assert.equal(result.ok, true, `Slack ${method} failed: ${result.error ?? "unknown_error"}.`);
  return result;
}

async function validatePrerequisites() {
  assert.ok(
    process.env.OPENAI_API_KEY,
    "OPENAI_API_KEY is required: an actual production provider turn cannot be mocked or skipped.",
  );
  const kubeconfig = await validateKubernetesPrerequisites();
  await configureExistingK3dLocalPathSharedFileSystem({ kubeconfigPath, kubernetesContext });
  return kubeconfig;
}

async function createScopedController(context, identifier, platformNamespace, kubeconfig) {
  const suffix = hash(identifier);
  const account = "openclaw-production-controller";
  const namespaceRole = `oce-production-namespaces-${suffix}`;
  const tenantRole = `oce-production-tenant-${suffix}`;
  const binding = `oce-production-controller-${suffix}`;
  const apiBinding = `oce-production-secret-api-${suffix}`;
  const apiNamespaceRole = `oce-production-secret-namespaces-${suffix}`;
  const apiSecretRole = `oce-production-secrets-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), "openclaw-production-controller-"));
  context.after(async () => {
    await kubectl("delete", "clusterrolebinding", binding, apiBinding, "--ignore-not-found=true");
    await kubectl(
      "delete",
      "clusterrole",
      namespaceRole,
      tenantRole,
      apiNamespaceRole,
      apiSecretRole,
      "--ignore-not-found=true",
    );
    await rm(directory, { recursive: true, force: true });
  });

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
    "--resource=deployments.apps,services,serviceaccounts,configmaps,endpointslices.discovery.k8s.io,networkpolicies.networking.k8s.io,resourcequotas,limitranges",
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
  const identity = await createControllerIdentity({
    directory,
    platformNamespace,
    kubeconfig,
    account,
    clusterRole: namespaceRole,
    clusterRoleBinding: binding,
    context: `scoped-production-${suffix}`,
  });
  await kubectl(
    "create",
    "clusterrole",
    apiNamespaceRole,
    "--verb=get,list",
    "--resource=namespaces",
  );
  await kubectl(
    "create",
    "clusterrole",
    apiSecretRole,
    "--verb=get,create,update,patch,delete",
    "--resource=secrets",
  );
  const apiIdentity = await createControllerIdentity({
    directory,
    platformNamespace,
    kubeconfig,
    account: "openclaw-production-secret-api",
    clusterRole: apiNamespaceRole,
    clusterRoleBinding: apiBinding,
    context: `scoped-secret-api-${suffix}`,
  });
  return {
    ...identity,
    tenantRole,
    apiSecretRole,
    apiAccount: apiIdentity.account,
    apiAuthentication: apiIdentity.authentication,
  };
}

function installationConfiguration(authentication, platformNamespace, slack, options = {}) {
  const configuration = createKubernetesInstallationConfiguration({
    authentication,
    platformNamespace,
    gatewayImage,
    codexImage,
    cluster: "k3d-production-harness-topology",
  });
  configuration.drivers.secret.configuration.authentication = authentication;
  configuration.drivers.configuration.id = "configuration-kubernetes-production";
  configuration.drivers.compute.id = "compute-kubernetes-production";
  configuration.drivers.compute.configuration.resources.namespace.quota = {
    pods: "8",
    "requests.cpu": "2",
    "requests.memory": "2Gi",
    "limits.cpu": "8",
    "limits.memory": "4Gi",
  };
  configuration.drivers.compute.configuration.servicePrincipalCredentials.expirationSeconds = 3_600;
  if (slack !== undefined) {
    configuration.drivers.compute.configuration.runtime.channels = {
      secretPrefix: channelPrefix,
      proxyUrl: slack.proxyUrl,
    };
  }
  if (options.gatewayAdministration === true) {
    configuration.drivers.compute.configuration.runtime.gatewayAdministration = {
      controllerNamespace: platformNamespace,
    };
  }
  return configuration;
}

function nativeConfiguration(harnessId, slack, options = {}) {
  const configuration = createHarnessConfiguration(harnessId, providerModel);
  const provider = harnessId === "codex" ? "codex" : "openai";
  configuration.models.providers[provider].models[0].input = ["text", "image"];
  if (options.gatewayAdministration) {
    const proxyAddress = process.env.OCC_TEST_KUBERNETES_GATEWAY_PROXY_IP;
    assert.ok(
      proxyAddress && isIP(proxyAddress),
      "Gateway administration proof requires the exact verified apiserver-to-Pod source IP in OCC_TEST_KUBERNETES_GATEWAY_PROXY_IP",
    );
    assert.ok(!["127.0.0.1", "::1", "0.0.0.0", "::"].includes(proxyAddress));
    configuration.gateway.trustedProxies = [proxyAddress];
  }
  if (options.autoApproveLocal !== undefined) {
    const nodes = configuration.gateway.nodes ?? {};
    configuration.gateway.nodes = {
      ...nodes,
      pairing: {
        ...(nodes.pairing ?? {}),
        autoApproveLocal: options.autoApproveLocal,
      },
    };
  }
  if (harnessId === "openclaw") {
    const modelEnvName = options.modelEnvName ?? "OPENAI_API_KEY";
    configuration.secrets = {
      providers: {
        model: {
          source: "env",
          allowlist: Array.from(new Set(["OPENAI_API_KEY", modelEnvName])),
        },
      },
    };
    configuration.models.providers.openai.apiKey = {
      source: "env",
      provider: "model",
      id: modelEnvName,
    };
  }
  if (harnessId === "codex" && slack === undefined) {
    configuration.tools = {
      allow: ["read", "write", "edit"],
      fs: { workspaceOnly: true },
    };
  }
  if (slack === undefined) return configuration;

  configuration.plugins.allow.push("slack");
  configuration.plugins.entries.slack = { enabled: true };
  configuration.channels = {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      dmPolicy: "allowlist",
      allowFrom: [slack.allowedUserId],
      channels: {
        [slack.channelId]: {
          requireMention: true,
          allowBots: "mentions",
          users: [slack.allowedUserId],
          replyToMode: "off",
        },
      },
    },
  };
  return configuration;
}

async function createOperatorSecret(namespace, name, key, credential) {
  await new Promise((resolve, reject) => {
    const child = spawn("kubectl", kubectlArguments(["create", "-f", "-"]), {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2048);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Operator Secret provisioning failed (${code}): ${stderr}`));
    });
    // Read stdin directly: Node's Linux subprocess pipes cannot be reopened as /dev/stdin.
    // Secret bytes remain out of command arguments and temporary files.
    child.stdin.once("error", reject);
    child.stdin.end(
      JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { namespace, name },
        type: "Opaque",
        data: { [key]: Buffer.from(credential).toString("base64") },
      }),
    );
  });
}

async function applyKubernetesResource(document) {
  await new Promise((resolve, reject) => {
    const child = spawn("kubectl", kubectlArguments(["apply", "-f", "-"]), {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2048);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Kubernetes apply failed (${code}): ${stderr}`));
    });
    child.stdin.once("error", reject);
    child.stdin.end(`${JSON.stringify(document)}\n`);
  });
}

function assertNoSecretMaterial(value, secrets, description) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret === undefined || secret.length === 0) continue;
    assert.equal(serialized.includes(secret), false, description);
  }
}

function secretApiProtectedValues(topology, extra = []) {
  return [
    process.env.OPENAI_API_KEY,
    topology.secretApi?.initialProbeValue,
    topology.secretApi?.initialPeerProbeValue,
    topology.secretApi?.initialSharedProbeValue,
    topology.secretApi?.rotatedSharedProbeValue,
    topology.secretApi?.missingBackendValue,
    topology.secretApi?.unboundDeleteValue,
    ...extra,
  ];
}

function secretBinding(source) {
  return { source, delivery: { type: "env" } };
}

function assertSecretMetadata(secret, { namespaceId, name }) {
  assert.equal(secret.namespaceId, namespaceId);
  assert.equal(
    Object.hasOwn(secret, "agentId"),
    false,
    "Secret API responses must not expose an Agent owner",
  );
  assert.equal(secret.name, name);
  assert.deepEqual(secret.ref, { kind: "secret", namespaceId, id: secret.id });
  for (const key of [
    "value",
    "agentId",
    "backendRef",
    "backendName",
    "backendNamespaceName",
    "backendKey",
  ]) {
    assert.equal(Object.hasOwn(secret, key), false, `Secret API responses must omit ${key}`);
  }
}

async function createApiSecret(request, namespaceId, name, value) {
  const response = await request("POST", `/namespaces/${namespaceId}/secrets`, {
    name,
    value,
  });
  assertNoSecretMaterial(
    response,
    [value, process.env.OPENAI_API_KEY],
    "Secret create is metadata only",
  );
  assert.equal(
    response.status,
    201,
    `Secret create failed with HTTP ${response.status} (${response.error?.code ?? "unknown"})`,
  );
  assertSecretMetadata(response.data, { namespaceId, name });
  const read = await request("GET", `/namespaces/${namespaceId}/secrets/${response.data.id}`);
  assertNoSecretMaterial(read, [value, process.env.OPENAI_API_KEY], "Secret read is metadata only");
  assert.equal(
    read.status,
    200,
    `Secret read failed with HTTP ${read.status} (${read.error?.code ?? "unknown"})`,
  );
  assert.deepEqual(read.data, response.data);
  return response.data;
}

async function updateApiSecret(request, namespaceId, secret, value) {
  const response = await request("PATCH", `/namespaces/${namespaceId}/secrets/${secret.id}`, {
    value,
  });
  assertNoSecretMaterial(
    response,
    [value, process.env.OPENAI_API_KEY],
    "Secret update is metadata only",
  );
  assert.equal(
    response.status,
    200,
    `Secret update failed with HTTP ${response.status} (${response.error?.code ?? "unknown"})`,
  );
  assert.deepEqual(response.data, secret, "Secret update keeps the stable public ref");
  return response.data;
}

async function expectApiFailureWithoutSecret(request, method, path, body, secrets, description) {
  const response = await request(method, path, body);
  assert.ok(response.status >= 400, `${description} unexpectedly succeeded`);
  assertNoSecretMaterial(response, secrets, `${description} must not leak secret material`);
  return response;
}

async function grantSecretOperate(pool, namespaceId, subjectId, secretId) {
  const roleId = `role-secret-operate-${randomUUID()}`;
  const bindingId = `binding-secret-operate-${randomUUID()}`;
  await pool.query(
    "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, $2, $3, $4::jsonb)",
    [
      roleId,
      namespaceId,
      "Secret operate",
      JSON.stringify([{ action: "operate", resourceKind: "secret" }]),
    ],
  );
  await pool.query(
    `INSERT INTO occ.iam_access_bindings
     (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
     VALUES ($1, $2, $3, $4, 'secret', $5)`,
    [bindingId, namespaceId, subjectId, roleId, secretId],
  );
}

async function createSecretAssignmentCallerRequest({
  pool,
  createPostgresControllerAuth,
  productionApp,
  installation,
  namespaceId,
}) {
  const identifier = randomUUID();
  const credentials = {
    email: `secret-assignment-${hash(identifier)}@example.test`,
    password: `secret-assignment-${identifier}`,
  };
  const roleId = `role-secret-assignment-caller-${identifier}`;
  const bindingId = `binding-secret-assignment-caller-${identifier}`;
  const auth = await createPostgresControllerAuth({
    mode: "development",
    installationId: installation.id,
    secret: authSecret,
    baseURL: authBaseURL,
    pool,
    secureCookies: false,
  });
  const account = await auth.createAccount({
    email: credentials.email,
    password: credentials.password,
    name: "OpenClaw Secret Assignment Caller",
  });
  const seed = auth.principalSeed(account, { roleId });
  const permissions = [
    { action: "read", resourceKind: "namespace" },
    ...["create", "read", "update", "delete"].flatMap((action) => [
      { action, resourceKind: "configuration" },
      { action, resourceKind: "secret" },
    ]),
    ...["create", "read", "update", "deploy", "operate"].map((action) => ({
      action,
      resourceKind: "agent",
    })),
    { action: "read", resourceKind: "agent_revision" },
  ];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [roleId, namespaceId, "Namespace Secret assignment caller", JSON.stringify(permissions)],
    );
    await client.query(
      `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
       VALUES ($1, NULL, NULL, 'principal', $2, $3)`,
      [seed.principal.id, seed.principal.issuer, seed.principal.subject],
    );
    await client.query(
      `INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
       VALUES ($1, $2, $3, NULL, $4, NULL, NULL)`,
      [bindingId, namespaceId, seed.principal.id, roleId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    principalId: seed.principal.id,
    request: await createAuthenticatedControllerRequest(productionApp, credentials),
  };
}

async function createGatewayReaderCallerRequest({
  pool,
  productionApp,
  installation,
  namespaceId,
  agentId,
  servicePrincipalId,
  permissions = [
    { action: "read", resourceKind: "namespace" },
    { action: "read", resourceKind: "agent" },
  ],
  roleName = "Gateway reader without administration",
  resourceKind,
  resourceId,
  kind = "principal",
  createServiceKey = false,
  insertIdentity = true,
}) {
  const { createPostgresControllerAuth } = await import("../../apps/controller/src/auth/index.ts");
  const identifier = randomUUID();
  const credentials = {
    email: `gateway-reader-${hash(identifier)}@example.test`,
    password: `gateway-reader-${identifier}`,
  };
  const roleId = `role-gateway-reader-${identifier}`;
  const bindingId = `binding-gateway-reader-${identifier}`;
  const auth = await createPostgresControllerAuth({
    mode: "development",
    installationId: installation.id,
    secret: authSecret,
    baseURL: authBaseURL,
    pool,
    secureCookies: false,
  });
  let principal;
  let request;
  if (kind === "service_principal") {
    principal = {
      kind: "service_principal",
      id: servicePrincipalId ?? `sp_${randomUUID()}`,
      namespaceId,
      ...(agentId === undefined ? {} : { agentId }),
    };
  } else {
    const account = await auth.createAccount({
      email: credentials.email,
      password: credentials.password,
      name: "OpenClaw Gateway Reader",
    });
    const seed = auth.principalSeed(account, { roleId });
    principal = seed.principal;
    request = await createAuthenticatedControllerRequestWithHeaders(productionApp, credentials);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [roleId, namespaceId, roleName, JSON.stringify(permissions)],
    );
    if (insertIdentity) {
      await client.query(
        `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          principal.id,
          principal.kind === "service_principal" ? (principal.namespaceId ?? null) : null,
          principal.kind === "service_principal" ? (principal.agentId ?? null) : null,
          principal.kind,
          principal.kind === "principal" ? principal.issuer : null,
          principal.kind === "principal" ? principal.subject : null,
        ],
      );
    }
    await client.query(
      `INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
       VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
      [bindingId, namespaceId, principal.id, roleId, resourceKind ?? null, resourceId ?? null],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    principal,
    request,
    serviceKey:
      createServiceKey && principal.kind === "service_principal"
        ? await auth.createServiceKey({
            principal,
            name: `gateway-${hash(identifier)}`,
          })
        : undefined,
  };
}

async function createAuthenticatedControllerRequestWithHeaders(app, credentials) {
  const session = await signInToControllerApp(app, credentials);
  return async (method, url, payload, options = {}) => {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...authenticatedHeaders(session, options.headers ?? {}),
        host: "127.0.0.1",
      },
      ...(payload === undefined ? {} : { payload }),
    });
    return {
      status: response.statusCode,
      ...(response.body.length === 0 ? {} : response.json()),
    };
  };
}

function gatewayAdministrationResourceNames({ namespaceId, agentId }) {
  return {
    credential: gatewayAdministrationSecretName({ namespaceId, agentId }),
    transport: `openclaw-agent-transport-${hash(agentId)}`,
  };
}

const gatewayAdministrationChartRuleCache = new Map();

async function gatewayAdministrationChartRules(platformNamespace) {
  let cached = gatewayAdministrationChartRuleCache.get(platformNamespace);
  if (cached !== undefined) return cached;
  cached = renderGatewayAdministrationChartRules(platformNamespace);
  gatewayAdministrationChartRuleCache.set(platformNamespace, cached);
  return cached;
}

async function renderGatewayAdministrationChartRules(platformNamespace) {
  const release = `oce-gateway-admin-${hash(platformNamespace).slice(0, 12)}`;
  const helm = process.env.OCC_HELM_BIN ?? "helm";
  const { stdout } = await execute(
    helm,
    [
      "template",
      release,
      "deploy/helm/openclaw-enterprise",
      "--namespace",
      platformNamespace,
      "--set",
      `images.controller=registry.example.invalid/controller@sha256:${"a".repeat(64)}`,
      "--set",
      "auth.baseUrl=http://127.0.0.1",
      "--set",
      "auth.secretName=occ-auth",
      "--set",
      "auth.secretKey=secret",
      "--set",
      "bootstrap.adminEmail=admin@example.invalid",
      "--set",
      "bootstrap.password.claimName=occ-bootstrap-admin-password",
      "--set",
      "api.clients[0].namespace=operator-tools",
      "--set",
      "api.clients[0].podLabels.app=operator",
      "--set",
      "database.cidr=10.45.0.12/32",
      "--set",
      "cluster.cidr=10.43.0.1/32",
      "--set",
      `gatewayAdministration.controllerNamespace=${platformNamespace}`,
    ],
    { cwd: repository, maxBuffer: 2_000_000 },
  );
  const requireController = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  );
  const { loadAllYaml } = await import(requireController.resolve("@kubernetes/client-node"));
  const objects = loadAllYaml(stdout).filter(Boolean);
  const rulesFor = (kind, name) => {
    const object = objects.find(
      (candidate) => candidate.kind === kind && candidate.metadata?.name === name,
    );
    assert.ok(object, `expected rendered ${kind} ${name}`);
    return structuredClone(object.rules);
  };
  return {
    workerCredential: rulesFor("Role", `${release}-gateway-credentials-worker`),
    apiCredential: rulesFor("Role", `${release}-gateway-credentials-api`),
    workerTenant: rulesFor("ClusterRole", `${release}-openclaw-tenant-worker`),
    apiTenant: rulesFor("ClusterRole", `${release}-openclaw-tenant-api`),
  };
}

function gatewayCredentialRules(rules, { credentialCreate, credentialUpdate }) {
  return structuredClone(rules)
    .map((rule) =>
      rule.resources?.includes("secrets")
        ? {
            ...rule,
            verbs: rule.verbs.filter(
              (verb) =>
                (credentialCreate || verb !== "create") && (credentialUpdate || verb !== "update"),
            ),
          }
        : rule,
    )
    .filter((rule) => rule.verbs.length > 0);
}

async function createRole(namespace, name, rules) {
  await applyKubernetesResource({
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    metadata: { namespace, name },
    rules,
  });
}

async function createRoleBinding(
  namespace,
  name,
  roleName,
  serviceAccountNamespace,
  serviceAccountName,
) {
  await applyKubernetesResource({
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: { namespace, name },
    subjects: [
      {
        kind: "ServiceAccount",
        namespace: serviceAccountNamespace,
        name: serviceAccountName,
      },
    ],
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: roleName,
    },
  });
}

async function provisionGatewayAdministrationRbac({
  platformNamespace,
  placement,
  controller,
  namespaceId,
  agentId,
  credentialCreate = true,
  credentialUpdate = true,
}) {
  const suffix = hash(`${namespaceId}\0${agentId}`);
  const names = gatewayAdministrationResourceNames({ namespaceId, agentId });
  const workerPlatformRole = `gateway-admin-worker-platform-${suffix}`;
  const apiPlatformRole = `gateway-admin-api-platform-${suffix}`;
  const workerTenantRole = `gateway-admin-worker-tenant-${suffix}`;
  const apiTenantRole = `gateway-admin-api-tenant-${suffix}`;
  const chartRules = await gatewayAdministrationChartRules(platformNamespace);
  await Promise.all([
    createRole(
      platformNamespace,
      workerPlatformRole,
      gatewayCredentialRules(chartRules.workerCredential, { credentialCreate, credentialUpdate }),
    ),
    createRole(platformNamespace, apiPlatformRole, chartRules.apiCredential),
    createRole(placement, workerTenantRole, [
      ...structuredClone(chartRules.workerTenant),
      {
        apiGroups: [""],
        resources: ["secrets"],
        resourceNames: [names.transport],
        verbs: ["get"],
      },
    ]),
    createRole(placement, apiTenantRole, chartRules.apiTenant),
  ]);
  await Promise.all([
    createRoleBinding(
      platformNamespace,
      `${workerPlatformRole}-binding`,
      workerPlatformRole,
      platformNamespace,
      controller.account,
    ),
    createRoleBinding(
      platformNamespace,
      `${apiPlatformRole}-binding`,
      apiPlatformRole,
      platformNamespace,
      controller.apiAccount,
    ),
    createRoleBinding(
      placement,
      `${workerTenantRole}-binding`,
      workerTenantRole,
      platformNamespace,
      controller.account,
    ),
    createRoleBinding(
      placement,
      `${apiTenantRole}-binding`,
      apiTenantRole,
      platformNamespace,
      controller.apiAccount,
    ),
  ]);
  return names;
}

async function grantGatewayAdministrationCredentialCreate(topology) {
  const roleName = `gateway-admin-worker-platform-create-${hash(
    `${topology.agent.namespaceId}\0${topology.agent.id}`,
  )}`;
  await createRole(topology.platformNamespace, roleName, [
    { apiGroups: [""], resources: ["secrets"], verbs: ["create"] },
  ]);
  await createRoleBinding(
    topology.platformNamespace,
    `${roleName}-binding`,
    roleName,
    topology.platformNamespace,
    topology.controllerAccount,
  );
}

async function grantGatewayAdministrationCredentialUpdate(topology) {
  const roleName = `gateway-admin-worker-platform-update-${hash(
    `${topology.agent.namespaceId}\0${topology.agent.id}`,
  )}`;
  await createRole(topology.platformNamespace, roleName, [
    {
      apiGroups: [""],
      resources: ["secrets"],
      resourceNames: [topology.gatewayAdministrationRbac.credential],
      verbs: ["update"],
    },
  ]);
  await createRoleBinding(
    topology.platformNamespace,
    `${roleName}-binding`,
    roleName,
    topology.platformNamespace,
    topology.controllerAccount,
  );
}

async function ensureHarnessAdminPrincipal(
  pool,
  createPostgresControllerAuth,
  installation,
  credentials,
) {
  const auth = await createPostgresControllerAuth({
    mode: "development",
    installationId: installation.id,
    secret: authSecret,
    baseURL: authBaseURL,
    pool,
    secureCookies: false,
  });
  const account = await auth.createAccount({
    email: credentials.email,
    password: credentials.password,
    name: "OpenClaw Harness Administrator",
  });
  const seed = auth.principalSeed(account);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const role of seed.roles) {
      await client.query(
        `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
         VALUES ($1, NULL, $2, $3::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [role.id, role.name ?? null, JSON.stringify(role.permissions)],
      );
    }
    await client.query(
      `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
       VALUES ($1, NULL, NULL, 'principal', $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [seed.principal.id, seed.principal.issuer, seed.principal.subject],
    );
    for (const binding of seed.bindings) {
      await client.query(
        `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
         VALUES ($1, NULL, $2, NULL, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [
          binding.id,
          binding.subjectId,
          binding.roleId,
          binding.resourceKind ?? null,
          binding.resourceId ?? null,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function storedSecret(pool, namespaceId, secretId) {
  const { rows } = await pool.query(
    `SELECT id, namespace_id, name, driver_id,
            backend_namespace_name, backend_name, backend_key, backend_uid
       FROM occ.secrets
      WHERE namespace_id = $1 AND id = $2`,
    [namespaceId, secretId],
  );
  assert.equal(rows.length, 1, "the Secret metadata must be persisted exactly once");
  const [row] = rows;
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    name: row.name,
    driverId: row.driver_id,
    backendRef: {
      namespaceName: row.backend_namespace_name,
      name: row.backend_name,
      key: row.backend_key,
      uid: row.backend_uid,
    },
  };
}

async function createUndeployedAgent(request, namespaceId, mode, name, secretBindings) {
  const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
    kind: "agent",
    values: nativeConfiguration(mode === "dedicated" ? "codex" : "openclaw"),
    ...(secretBindings === undefined ? {} : { secretBindings }),
  });
  assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
  const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
    name,
    configurationId: configuration.data.id,
    executionMode: mode,
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.error));
  return { configuration: configuration.data, agent: agent.data };
}

async function storedAgent(pool, namespaceId, agentId) {
  const { rows } = await pool.query(
    `SELECT id, namespace_id, service_principal_id, active_revision_id
       FROM occ.agents
      WHERE namespace_id = $1 AND id = $2`,
    [namespaceId, agentId],
  );
  assert.equal(rows.length, 1, "the Agent must be persisted exactly once");
  const [row] = rows;
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    servicePrincipalId: row.service_principal_id,
    activeRevisionId: row.active_revision_id ?? undefined,
  };
}

async function materializeServiceAccountCredential(namespace, namespaceId, account, agentId) {
  assert.equal(account.namespaceId, namespaceId, "the account must own the exact tenant Namespace");
  assert.equal(account.credential.kind, "api_key", "only API-key credentials can be materialized");

  const reference = account.credential.secretRef;
  const source = await resource("secret", reference.name, namespace);
  assert.equal(source.metadata.namespace, namespace);
  assert.equal(source.metadata.labels?.["openclaw.dev/namespace"], namespaceId);
  assert.equal(source.metadata.annotations?.["openclaw.dev/namespace-id"], namespaceId);
  assert.equal(
    source.metadata.annotations?.["openclaw.dev/service-account-id"],
    account.id,
    "the source Secret must belong to the exact service account",
  );
  assert.ok(
    Object.hasOwn(source.data ?? {}, reference.key),
    "the account-owned source Secret must contain its exact persisted credential key",
  );

  // Only the independently authorized operator can resolve the account's exact source Secret.
  const credential = Buffer.from(source.data[reference.key], "base64");
  assert.ok(credential.length > 0, "the account's exact source credential must not be empty");
  const destinationName = `${modelPrefix}-${hash(agentId)}`;
  await createOperatorSecret(namespace, destinationName, "OPENAI_API_KEY", credential);
  await kubectl(
    "label",
    "secret",
    destinationName,
    "--namespace",
    namespace,
    `openclaw.dev/namespace=${namespaceId}`,
    `openclaw.dev/agent=${agentId}`,
  );
  await kubectl(
    "annotate",
    "secret",
    destinationName,
    "--namespace",
    namespace,
    `openclaw.dev/namespace-id=${namespaceId}`,
    `openclaw.dev/agent-id=${agentId}`,
    `openclaw.dev/service-account-id=${account.id}`,
  );

  const destination = await resource("secret", destinationName, namespace);
  assert.equal(destination.metadata.namespace, namespace);
  assert.equal(destination.metadata.annotations?.["openclaw.dev/agent-id"], agentId);
  assert.equal(destination.metadata.annotations?.["openclaw.dev/service-account-id"], account.id);
  assert.ok(Object.hasOwn(destination.data ?? {}, "OPENAI_API_KEY"));

  // One-way fingerprints prove source-to-workload provenance without logging credential bytes.
  const sourceFingerprint = createHash("sha256").update(credential).digest("hex");
  const destinationFingerprint = createHash("sha256")
    .update(Buffer.from(destination.data.OPENAI_API_KEY, "base64"))
    .digest("hex");
  assert.equal(
    destinationFingerprint,
    sourceFingerprint,
    "the Agent model Secret must contain only the exact persisted account-source credential",
  );
}

async function provisionAgentChannelSecret(directory, namespace, agentId, slack) {
  const suffix = hash(agentId);
  const tokenDirectory = await mkdtemp(join(directory, `channel-tokens-${suffix}-`));
  try {
    const appTokenPath = join(tokenDirectory, "slack-app-token");
    const botTokenPath = join(tokenDirectory, "slack-bot-token");
    await Promise.all([
      writeFile(appTokenPath, slack.appToken, { mode: 0o600 }),
      writeFile(botTokenPath, slack.botToken, { mode: 0o600 }),
    ]);
    await kubectl(
      "create",
      "secret",
      "generic",
      `${channelPrefix}-${suffix}`,
      "--namespace",
      namespace,
      `--from-file=SLACK_APP_TOKEN=${appTokenPath}`,
      `--from-file=SLACK_BOT_TOKEN=${botTokenPath}`,
    );
  } finally {
    await rm(tokenDirectory, { recursive: true, force: true });
  }
}

async function arrangeProductionTopology(context, mode, slack, options = {}) {
  const modelCredential = options.modelCredential ?? "service-account";
  assert.ok(
    modelCredential === "service-account" ||
      (modelCredential === "secret-api" && mode === "embedded"),
    "Secret API model credentials are covered only by embedded OpenClaw topology",
  );
  const kubeconfig = await validatePrerequisites();
  const identifier = randomUUID();
  const credentials = {
    email: `admin-kubernetes-${hash(identifier)}@example.test`,
    password: `kubernetes-harness-${identifier}`,
  };
  const platformNamespace = `oce-production-${mode}-${hash(identifier)}`;
  await kubectl("create", "namespace", platformNamespace);
  context.after(async () => {
    await kubectl(
      "delete",
      "namespace",
      platformNamespace,
      "--ignore-not-found=true",
      "--wait=true",
      "--timeout=120s",
    );
  });
  const controller = await createScopedController(
    context,
    identifier,
    platformNamespace,
    kubeconfig,
  );
  const approvedClient = "approved-gateway-client";
  await kubectl(
    "run",
    approvedClient,
    "--namespace",
    platformNamespace,
    `--image=${gatewayImage}`,
    "--image-pull-policy=IfNotPresent",
    "--restart=Never",
    "--labels=app.kubernetes.io/name=approved-gateway-client",
    "--command",
    "--",
    "node",
    "-e",
    `require("node:net").createServer((socket) => socket.end()).listen(${deniedPort}, "0.0.0.0")`,
  );
  await kubectl(
    "wait",
    "--namespace",
    platformNamespace,
    "--for=condition=Ready",
    `pod/${approvedClient}`,
    "--timeout=180s",
  );
  const [
    { default: pg },
    { PostgresPlatformState },
    { createPostgresControllerAuth },
    { loadInstallationConfiguration },
    { composeProduction },
    { createControllerWorker },
    { kubernetesNamespaceName },
  ] = await Promise.all([
    import("pg"),
    import("../../packages/occ/src/state/postgres-state.ts"),
    import("../../apps/controller/src/auth/index.ts"),
    import("../../apps/controller/src/composition/installation-config.ts"),
    import("../../apps/controller/src/composition/production.ts"),
    import("../../apps/controller/src/worker.ts"),
    import("../../apps/controller/src/drivers/compute/kubernetes/index.ts"),
  ]);

  const directory = await mkdtemp(join(tmpdir(), `oce-k3d-production-${mode}-`));
  const startupPath = join(directory, "api-installation.yaml");
  const workerStartupPath = join(directory, "worker-installation.yaml");
  const workerConfiguration = installationConfiguration(
    controller.authentication,
    platformNamespace,
    slack,
    options,
  );
  const apiConfiguration = structuredClone(workerConfiguration);
  apiConfiguration.drivers.secret.configuration.authentication = controller.apiAuthentication;
  apiConfiguration.drivers.compute.configuration.authentication = controller.apiAuthentication;
  await writeFile(startupPath, JSON.stringify(apiConfiguration), { mode: 0o600 });
  await writeFile(workerStartupPath, JSON.stringify(workerConfiguration), { mode: 0o600 });
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: startupPath },
  });
  const workerDrivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: workerStartupPath },
  });
  const { installation, computeDriver, configurationDriver } = drivers;
  const observerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  let activeInstallation = installation;
  let workerPool;
  let worker;
  let productionApp;
  let placement;
  let forwarding;
  context.after(async () => {
    forwarding?.stop();
    if (worker !== undefined) await worker.stop();
    else if (workerPool !== undefined) await workerPool.end();
    if (productionApp !== undefined) await productionApp.close();
    await observerPool.end();
    if (placement !== undefined) {
      await kubectl(
        "delete",
        "namespace",
        placement,
        "--ignore-not-found=true",
        "--wait=true",
        "--timeout=120s",
      );
    }
    await rm(directory, { recursive: true, force: true });
  });

  const existing = await new PostgresPlatformState(observerPool).loadInstallation();
  if (existing !== undefined) {
    activeInstallation = existing;
    await ensureHarnessAdminPrincipal(
      observerPool,
      createPostgresControllerAuth,
      activeInstallation,
      credentials,
    );
    context.diagnostic(`reusing pre-initialized Installation ${activeInstallation.id}`);
  } else {
    // Bootstrap only establishes persistent IAM; every actual deployment uses production API/worker.
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      email: credentials.email,
      password: credentials.password,
      authSecret,
      authBaseURL,
      installationName,
    });
    // The startup declaration has no persistent Installation ID. Standalone
    // selected scenarios must use the identity created by bootstrap.
    activeInstallation = await new PostgresPlatformState(observerPool).loadInstallation();
    assert.ok(activeInstallation?.id, "bootstrap must persist the Installation identity");
  }

  productionApp = await composeProduction({
    mode: "production",
    host: "127.0.0.1",
    databaseUrl,
    authSecret,
    authBaseURL,
    drivers,
  });
  let adminRequest = await createAuthenticatedControllerRequest(productionApp, credentials);
  let request = adminRequest;
  async function restartProductionApp() {
    if (productionApp !== undefined) await productionApp.close();
    productionApp = await composeProduction({
      mode: "production",
      host: "127.0.0.1",
      databaseUrl,
      authSecret,
      authBaseURL,
      drivers,
    });
    adminRequest = await createAuthenticatedControllerRequest(productionApp, credentials);
    if (secretAssignmentPrincipalId === undefined) request = adminRequest;
    return { productionApp, adminRequest, request };
  }
  let secretAssignmentPrincipalId;
  const events = [];
  workerPool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  worker = createControllerWorker({
    mode: "production",
    pool: workerPool,
    drivers: workerDrivers,
    pollIntervalMs: 50,
    leaseDurationMs: 60_000,
    maxAttempts: 30,
    emit: (event) => events.push(event),
  });
  await worker.start();

  async function restartProductionWorker() {
    await worker.stop();
    workerPool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    const restartedDrivers = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: workerStartupPath },
    });
    worker = createControllerWorker({
      mode: "production",
      pool: workerPool,
      drivers: restartedDrivers,
      pollIntervalMs: 50,
      leaseDurationMs: 60_000,
      maxAttempts: 30,
      emit: (event) => events.push(event),
    });
    await worker.start();
  }

  const createdNamespace = await adminRequest("POST", "/namespaces", {
    name: `production-${mode}-${randomUUID()}`,
  });
  assert.equal(createdNamespace.status, 201);
  const namespaceId = createdNamespace.data.id;
  placement = kubernetesNamespaceName(namespaceId);

  // The real production worker must remain pending until an operator grants this exact tenant.
  await waitFor(`the production worker to create tenant namespace ${placement}`, async () => {
    try {
      return await resource("namespace", placement);
    } catch (error) {
      if (/NotFound|not found/i.test(error.stderr ?? error.message)) return undefined;
      throw error;
    }
  });
  await kubectl(
    "create",
    "rolebinding",
    "openclaw-production-controller",
    "--namespace",
    placement,
    `--clusterrole=${controller.tenantRole}`,
    `--serviceaccount=${platformNamespace}:${controller.account}`,
  );
  await kubectl(
    "create",
    "rolebinding",
    "openclaw-production-secret-api",
    "--namespace",
    placement,
    `--clusterrole=${controller.apiSecretRole}`,
    `--serviceaccount=${platformNamespace}:${controller.apiAccount}`,
  );
  for (const verb of ["get", "create"]) {
    const secretAccess = await kubectl(
      "auth",
      "can-i",
      verb,
      "secrets",
      "--namespace",
      placement,
      `--as=system:serviceaccount:${platformNamespace}:${controller.account}`,
    ).catch(({ stdout }) => stdout);
    assert.equal(
      secretAccess.trim(),
      "no",
      `the production worker must never receive Secret ${verb} access`,
    );

    const apiAccess = await kubectl(
      "auth",
      "can-i",
      verb,
      "secrets",
      "--namespace",
      placement,
      `--as=system:serviceaccount:${platformNamespace}:${controller.apiAccount}`,
    );
    assert.equal(apiAccess.trim(), "yes", `only the production API gains Secret ${verb} access`);

    // Independent operator bootstrap credentials remain separate from application identities.
    const operatorAccess = await kubectl(
      "auth",
      "can-i",
      verb,
      "secrets",
      "--namespace",
      placement,
    );
    assert.equal(operatorAccess.trim(), "yes", `the external test operator must authorize ${verb}`);
  }

  await waitFor(`the production worker to provision tenant ${placement}`, async () => {
    const observation = await request("GET", `/namespaces/${namespaceId}`);
    assert.equal(observation.status, 200);
    return observation.data.status === "ready" ? observation.data : undefined;
  });

  let secretApi;
  if (modelCredential === "secret-api") {
    const secretAssignmentCaller = await createSecretAssignmentCallerRequest({
      pool: observerPool,
      createPostgresControllerAuth,
      productionApp,
      installation: activeInstallation,
      namespaceId,
    });
    request = secretAssignmentCaller.request;
    secretAssignmentPrincipalId = secretAssignmentCaller.principalId;

    // Namespace-scoped Secrets are provisioned once the Namespace is ready, before any Agent exists.
    const modelSecret = await createApiSecret(
      request,
      namespaceId,
      "model-key",
      process.env.OPENAI_API_KEY,
    );
    const initialProbeValue = `secret-rotation-initial-${randomUUID()}`;
    const probeSecret = await createApiSecret(
      request,
      namespaceId,
      "rotation-probe",
      initialProbeValue,
    );
    const initialPeerProbeValue = `secret-rotation-peer-${randomUUID()}`;
    const peerProbeSecret = await createApiSecret(
      request,
      namespaceId,
      "rotation-peer-probe",
      initialPeerProbeValue,
    );
    const initialSharedProbeValue = `secret-rotation-shared-initial-${randomUUID()}`;
    const sharedProbeSecret = await createApiSecret(
      request,
      namespaceId,
      "rotation-shared-probe",
      initialSharedProbeValue,
    );
    const missingBackendValue = `missing-backend-secret-${randomUUID()}`;
    const missingBackendSecret = await createApiSecret(
      request,
      namespaceId,
      "missing-backend",
      missingBackendValue,
    );
    const unboundDeleteValue = `unbound-delete-${randomUUID()}`;
    const unboundDeleteSecret = await createApiSecret(
      request,
      namespaceId,
      "unbound-delete",
      unboundDeleteValue,
    );
    const deniedConfiguration = await expectApiFailureWithoutSecret(
      request,
      "POST",
      `/namespaces/${namespaceId}/configurations`,
      {
        kind: "agent",
        values: nativeConfiguration("openclaw", slack),
        secretBindings: { OPENAI_API_KEY: secretBinding(modelSecret.ref) },
      },
      [
        process.env.OPENAI_API_KEY,
        initialProbeValue,
        initialPeerProbeValue,
        initialSharedProbeValue,
        missingBackendValue,
        unboundDeleteValue,
      ],
      "Secret binding assignment without exact caller operate",
    );
    assert.equal(
      deniedConfiguration.status,
      403,
      `caller assignment without Secret operate returned HTTP ${deniedConfiguration.status}`,
    );
    await Promise.all(
      [
        modelSecret,
        probeSecret,
        peerProbeSecret,
        sharedProbeSecret,
        missingBackendSecret,
        unboundDeleteSecret,
      ].map((secret) =>
        grantSecretOperate(observerPool, namespaceId, secretAssignmentPrincipalId, secret.id),
      ),
    );
    secretApi = {
      assignmentPrincipalId: secretAssignmentPrincipalId,
      model: modelSecret,
      probe: probeSecret,
      peerProbe: peerProbeSecret,
      sharedProbe: sharedProbeSecret,
      missingBackend: missingBackendSecret,
      unboundDelete: unboundDeleteSecret,
      initialProbeValue,
      initialPeerProbeValue,
      initialSharedProbeValue,
      missingBackendValue,
      unboundDeleteValue,
    };
  }

  let createdAccount;
  let expectedCredential;
  let sourceName;
  if (modelCredential === "service-account") {
    // The provider credential begins only in an independently owned Secret for this exact account.
    createdAccount = await request("POST", `/namespaces/${namespaceId}/service-accounts`, {
      name: `production-${mode}-${randomUUID()}`,
    });
    assert.equal(createdAccount.status, 201, JSON.stringify(createdAccount.error));
    assert.equal(createdAccount.data.namespaceId, namespaceId);
    sourceName = `service-account-${hash(createdAccount.data.id)}`;
    const sourceKey = `${mode}-provider-api-key`;
    await createOperatorSecret(placement, sourceName, sourceKey, process.env.OPENAI_API_KEY);
    await kubectl(
      "label",
      "secret",
      sourceName,
      "--namespace",
      placement,
      `openclaw.dev/namespace=${namespaceId}`,
      `openclaw.dev/service-account=${createdAccount.data.id}`,
    );
    await kubectl(
      "annotate",
      "secret",
      sourceName,
      "--namespace",
      placement,
      `openclaw.dev/namespace-id=${namespaceId}`,
      `openclaw.dev/service-account-id=${createdAccount.data.id}`,
    );
    expectedCredential = {
      kind: "api_key",
      secretRef: { name: sourceName, key: sourceKey },
    };
    const updatedAccount = await request(
      "PATCH",
      `/namespaces/${namespaceId}/service-accounts/${createdAccount.data.id}/credential`,
      expectedCredential,
    );
    assert.equal(updatedAccount.status, 200, JSON.stringify(updatedAccount.error));
    assert.deepEqual(updatedAccount.data.credential, expectedCredential);
  }

  const harnessId = mode === "dedicated" ? "codex" : "openclaw";
  const secretBindings =
    secretApi === undefined
      ? undefined
      : {
          OPENAI_API_KEY: secretBinding(secretApi.model.ref),
          [secretRotationProbe]: secretBinding(secretApi.probe.ref),
          [sharedSecretRotationProbe]: secretBinding(secretApi.sharedProbe.ref),
        };
  const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
    kind: "agent",
    values: nativeConfiguration(harnessId, slack, options.nativeConfiguration ?? {}),
    ...(secretBindings === undefined ? {} : { secretBindings }),
  });
  assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
  if (secretBindings !== undefined)
    assert.deepEqual(configuration.data.secretBindings, secretBindings);
  const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
    name: `production-${mode}-${randomUUID()}`,
    configurationId: configuration.data.id,
    executionMode: mode,
    ...(createdAccount === undefined ? {} : { serviceAccountId: createdAccount.data.id }),
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.error));
  if (createdAccount === undefined) {
    assert.equal(Object.hasOwn(agent.data, "serviceAccountId"), false);
  } else {
    assert.equal(agent.data.serviceAccountId, createdAccount.data.id);
  }
  const persistedAgent = await storedAgent(observerPool, namespaceId, agent.data.id);

  let persistedAccount;
  if (createdAccount !== undefined) {
    // Resolve the source from persisted production state, never from fixture inputs or process env.
    persistedAccount = await request(
      "GET",
      `/namespaces/${namespaceId}/service-accounts/${agent.data.serviceAccountId}`,
    );
    assert.equal(persistedAccount.status, 200, JSON.stringify(persistedAccount.error));
    assert.deepEqual(persistedAccount.data.credential, expectedCredential);
  }
  const gatewayToken = await provisionAgentTransportSecret(directory, placement, agent.data.id);
  const gatewayAdministrationRbac =
    options.gatewayAdministration === true
      ? await provisionGatewayAdministrationRbac({
          platformNamespace,
          placement,
          controller,
          namespaceId,
          agentId: agent.data.id,
          credentialCreate: options.gatewayAdministrationCredentialCreate !== false,
          credentialUpdate: options.gatewayAdministrationCredentialUpdate !== false,
        })
      : undefined;
  if (slack !== undefined) {
    await provisionAgentChannelSecret(directory, placement, agent.data.id, slack);
  }
  if (modelCredential === "secret-api") {
    const revisionsBefore = await request(
      "GET",
      `/namespaces/${namespaceId}/agents/${agent.data.id}/revisions`,
    );
    assert.equal(revisionsBefore.status, 200, JSON.stringify(revisionsBefore.error));
    const deniedDeploy = await expectApiFailureWithoutSecret(
      request,
      "POST",
      `/namespaces/${namespaceId}/agents/${agent.data.id}/deploy`,
      undefined,
      secretApiProtectedValues({ secretApi }),
      "Secret-backed deploy before Agent service principal operate",
    );
    assert.equal(
      deniedDeploy.status,
      403,
      `Agent service principal denial returned HTTP ${deniedDeploy.status}`,
    );
    const revisionsAfter = await request(
      "GET",
      `/namespaces/${namespaceId}/agents/${agent.data.id}/revisions`,
    );
    assert.equal(revisionsAfter.status, 200, JSON.stringify(revisionsAfter.error));
    assert.deepEqual(
      revisionsAfter.data.map(({ id }) => id),
      revisionsBefore.data.map(({ id }) => id),
      "missing Agent service-principal Secret operate must reject deployment before revision admission",
    );
    await Promise.all([
      grantSecretOperate(
        observerPool,
        namespaceId,
        persistedAgent.servicePrincipalId,
        secretApi.model.id,
      ),
      grantSecretOperate(
        observerPool,
        namespaceId,
        persistedAgent.servicePrincipalId,
        secretApi.probe.id,
      ),
      grantSecretOperate(
        observerPool,
        namespaceId,
        persistedAgent.servicePrincipalId,
        secretApi.sharedProbe.id,
      ),
    ]);
    secretApi = {
      ...secretApi,
      configuration: configuration.data,
    };
  }

  if (mode === "embedded" && modelCredential === "service-account") {
    // A sibling account's real Secret cannot be adopted merely because its Namespace and key match.
    const siblingAccount = await request("POST", `/namespaces/${namespaceId}/service-accounts`, {
      name: `production-${mode}-sibling-${randomUUID()}`,
    });
    assert.equal(siblingAccount.status, 201, JSON.stringify(siblingAccount.error));
    await kubectl(
      "annotate",
      "secret",
      sourceName,
      "--namespace",
      placement,
      `openclaw.dev/service-account-id=${siblingAccount.data.id}`,
      "--overwrite",
    );
    await assert.rejects(
      () =>
        materializeServiceAccountCredential(
          placement,
          namespaceId,
          persistedAccount.data,
          agent.data.id,
        ),
      /the source Secret must belong to the exact service account/,
    );
    const modelSecretName = `${modelPrefix}-${hash(agent.data.id)}`;
    let destinationMissing = false;
    try {
      await kubectl("get", "secret", modelSecretName, "--namespace", placement, "-o", "name");
    } catch (error) {
      assert.match(error.stderr ?? error.message, /NotFound|not found/i);
      destinationMissing = true;
    }
    assert.equal(destinationMissing, true, "rejected source ownership must create no Agent Secret");
    await kubectl(
      "annotate",
      "secret",
      sourceName,
      "--namespace",
      placement,
      `openclaw.dev/service-account-id=${persistedAccount.data.id}`,
      "--overwrite",
    );
  } else {
    if (persistedAccount !== undefined) {
      await materializeServiceAccountCredential(
        placement,
        namespaceId,
        persistedAccount.data,
        agent.data.id,
      );
    }
  }

  const deployed = await request(
    "POST",
    `/namespaces/${namespaceId}/agents/${agent.data.id}/deploy`,
  );
  assert.equal(deployed.status, 202, JSON.stringify(deployed.error));
  assert.deepEqual(deployed.data.harness, { id: harnessId, version: "1.0.0", mode });
  if (createdAccount === undefined) {
    assert.equal(Object.hasOwn(deployed.data, "serviceAccount"), false);
  } else {
    assert.deepEqual(deployed.data.serviceAccount, {
      id: createdAccount.data.id,
      credential: expectedCredential,
    });
  }
  for (const [description, response] of [
    ...(persistedAccount === undefined ? [] : [["account", persistedAccount]]),
    ["Agent", agent],
    ["AgentRevision", deployed],
  ]) {
    assert.equal(
      JSON.stringify(response).includes(process.env.OPENAI_API_KEY),
      false,
      `the production ${description} response must never contain provider credential bytes`,
    );
  }

  if (options.expectGatewayAdministrationEnrollmentFailure === true) {
    assert.ok(
      gatewayAdministrationRbac,
      "gateway administration enrollment-failure topology requires gateway administration RBAC",
    );
    const gatewayServiceName = `gateway-${hash(agent.data.id)}`;
    const agentServiceName = `agent-${hash(agent.data.id)}`;
    const partialTopology = {
      mode,
      placement,
      platformNamespace,
      productionApp,
      restartProductionApp,
      restartProductionWorker,
      credentials,
      installation: activeInstallation,
      approvedClient,
      controllerAccount: controller.account,
      controllerTenantRole: controller.tenantRole,
      apiSecretRole: controller.apiSecretRole,
      apiAccount: controller.apiAccount,
      kubernetesNamespaceName,
      adminRequest,
      request,
      events,
      agent: agent.data,
      ...(persistedAccount === undefined ? {} : { account: persistedAccount.data }),
      persistedAgent,
      revision: deployed.data,
      gatewayServiceName,
      agentServiceName,
      gatewayToken,
      directory,
      observerPool,
      secretApi,
      gatewayAdministrationRbac,
    };
    partialTopology.gatewayPod = await waitForReadyGatewayPod(partialTopology, deployed.data.id);
    if (options.gatewayAdministrationCredentialCreate === false) return partialTopology;
    await waitForGatewayAdministrationKeyOnlyCredential(partialTopology, deployed.data.id);
    await waitForGatewayAdministrationIncompleteEnrollment(partialTopology, deployed.data.id);
    return partialTopology;
  }

  if (mode === "embedded" && modelCredential === "service-account") {
    const modelSecretName = `${modelPrefix}-${hash(agent.data.id)}`;
    // Missing operator materialization must hold this exact revision pending without activation.
    await waitFor(`embedded workload to reject missing Secret ${modelSecretName}`, async () => {
      const pod = (await resources("pods", placement)).find(
        ({ metadata }) =>
          metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
          metadata.labels?.["openclaw.dev/agent"] === agent.data.id,
      );
      const waiting = pod?.status.containerStatuses?.find(({ state }) => state?.waiting)?.state
        .waiting;
      if (waiting?.reason !== "CreateContainerConfigError") return undefined;
      assert.ok(
        waiting.message?.includes(modelSecretName),
        "the blocked Pod must identify only the exact absent Agent model Secret",
      );
      return pod;
    });
    await waitFor(`worker to defer incomplete embedded revision ${deployed.data.id}`, () =>
      events.find(
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === deployed.data.id &&
          event.outcome === "pending" &&
          event.code === "REVISION_INCOMPLETE",
      ),
    );
    const blockedAgent = await request("GET", `/namespaces/${namespaceId}/agents/${agent.data.id}`);
    assert.equal(blockedAgent.status, 200);
    assert.notEqual(
      blockedAgent.data.activeRevisionId,
      deployed.data.id,
      "the missing exact Agent model Secret must prevent revision activation",
    );

    // The same deferred revision recovers only after its real account source is materialized.
    await materializeServiceAccountCredential(
      placement,
      namespaceId,
      persistedAccount.data,
      agent.data.id,
    );
  }

  await waitFor(`production ${mode} AgentRevision ${deployed.data.id} activation`, async () => {
    const observation = await request("GET", `/namespaces/${namespaceId}/agents/${agent.data.id}`);
    assert.equal(observation.status, 200);
    return observation.data.activeRevisionId === deployed.data.id ? observation.data : undefined;
  });
  await waitFor(`production worker completion of ${deployed.data.id}`, () =>
    events.find(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === deployed.data.id &&
        event.outcome === "success",
    ),
  );
  const observedRevision = await request(
    "GET",
    `/namespaces/${namespaceId}/agents/${agent.data.id}/revisions/${deployed.data.id}`,
  );
  assert.equal(observedRevision.status, 200, JSON.stringify(observedRevision.error));
  assert.deepEqual(observedRevision.data.serviceAccount, deployed.data.serviceAccount);
  if (secretApi !== undefined) {
    assert.deepEqual(observedRevision.data.secretBindings, secretApi.configuration.secretBindings);
  }
  assert.equal(
    JSON.stringify(events).includes(process.env.OPENAI_API_KEY),
    false,
    "production worker evidence must never contain provider credential bytes",
  );
  assert.equal(
    JSON.stringify(await resources("configmaps", placement)).includes(process.env.OPENAI_API_KEY),
    false,
    "production ConfigMaps must never contain provider credential bytes",
  );

  const gatewayServiceName = `gateway-${hash(agent.data.id)}`;
  const agentServiceName = `agent-${hash(agent.data.id)}`;
  const workloadAccounts =
    mode === "dedicated" ? [gatewayServiceName, agentServiceName] : [agentServiceName];
  for (const accountName of workloadAccounts) {
    const workloadSecretAccess = await kubectl(
      "auth",
      "can-i",
      "get",
      "secrets",
      "--namespace",
      placement,
      `--as=system:serviceaccount:${placement}:${accountName}`,
    ).catch(({ stdout }) => stdout);
    assert.equal(
      workloadSecretAccess.trim(),
      "no",
      "workload identity must not acquire Kubernetes Secret API access",
    );
  }
  const pods = await waitFor(`production ${mode} workload Pods`, async () => {
    const running = (await resources("pods", placement)).filter((pod) =>
      pod.status.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
    );
    return running.length === (mode === "dedicated" ? 2 : 1) ? running : undefined;
  });
  const gatewayPod = pods.find(
    ({ metadata }) => metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
  );
  assert.ok(gatewayPod, "production execution must start the exact Agent-owned real gateway");
  const harnessPod = pods.find(
    ({ metadata }) => metadata.labels?.["openclaw.dev/workload-role"] === "agent",
  );
  const gatewayVersion = (
    await kubectl(
      "exec",
      gatewayPod.metadata.name,
      "--namespace",
      placement,
      "--",
      "node",
      "/app/openclaw.mjs",
      "--version",
    )
  ).trim();
  assert.ok(gatewayVersion, "production gateway image must contain the real OpenClaw executable");
  if (process.env.OCC_TEST_KUBERNETES_OPENCLAW_VERSION) {
    assert.ok(gatewayVersion.includes(process.env.OCC_TEST_KUBERNETES_OPENCLAW_VERSION));
  }
  context.diagnostic(`${mode}: ${gatewayVersion}`);

  if (slack === undefined) forwarding = await startPortForward(placement, gatewayServiceName);
  return {
    mode,
    placement,
    platformNamespace,
    productionApp,
    restartProductionApp,
    restartProductionWorker,
    apiComputeDriver: computeDriver,
    workerComputeDriver: workerDrivers.computeDriver,
    apiAuthentication: controller.apiAuthentication,
    workerAuthentication: controller.authentication,
    credentials,
    installation: activeInstallation,
    approvedClient,
    controllerAccount: controller.account,
    controllerTenantRole: controller.tenantRole,
    apiSecretRole: controller.apiSecretRole,
    apiAccount: controller.apiAccount,
    kubernetesNamespaceName,
    adminRequest,
    request,
    events,
    agent: agent.data,
    ...(persistedAccount === undefined ? {} : { account: persistedAccount.data }),
    persistedAgent,
    revision: deployed.data,
    gatewayServiceName,
    agentServiceName,
    gatewayPod,
    harnessPod,
    gatewayToken,
    directory,
    gatewayUrl: forwarding?.url,
    async refreshGatewayUrl() {
      // kubectl selects one Pod; a gateway restart invalidates the previous tunnel.
      forwarding?.stop();
      forwarding = await startPortForward(placement, gatewayServiceName);
      return forwarding.url;
    },
    observerPool,
    secretApi,
    gatewayAdministrationRbac,
  };
}

async function inspectWorkloadEnvironment(namespace, pod) {
  const script = `const keys=${JSON.stringify([
    "OPENAI_API_KEY",
    secretRotationProbe,
    "APP_SERVER_TOKEN",
    "APP_SERVER_URL",
    "OPENCLAW_GATEWAY_TOKEN",
  ])};process.stdout.write(JSON.stringify(Object.fromEntries(keys.map(k=>[k,Object.hasOwn(process.env,k)]))))`;
  return JSON.parse(
    await kubectl("exec", pod, "--namespace", namespace, "--", "node", "-e", script),
  );
}

async function inspectEnvironmentValue(namespace, pod, name, expected) {
  const script = `const name=${JSON.stringify(name)};const expected=${JSON.stringify(expected)};process.stdout.write(JSON.stringify({present:Object.hasOwn(process.env,name),matches:process.env[name]===expected}))`;
  return JSON.parse(
    await kubectl("exec", pod, "--namespace", namespace, "--", "node", "-e", script),
  );
}

async function inspectProjectedIdentity(namespace, pod) {
  const script =
    'const fs=require("node:fs");const p="/var/run/secrets/openclaw/service-principal/token";if(!fs.existsSync(p)){process.stdout.write("null");process.exit(0)}const c=JSON.parse(Buffer.from(fs.readFileSync(p,"utf8").split(".")[1],"base64url"));process.stdout.write(JSON.stringify({subject:c.sub,audience:c.aud}))';
  return JSON.parse(
    await kubectl("exec", pod, "--namespace", namespace, "--", "node", "-e", script),
  );
}

async function assertDeniedConnection(namespace, pod, targetIp) {
  const script = String.raw`
    const socket = require("node:net").createConnection(
      { host: ${JSON.stringify(targetIp)}, port: ${deniedPort}, timeout: 3500 },
      () => { process.stdout.write("ALLOWED"); socket.destroy(); },
    );
    socket.on("timeout", () => { process.stdout.write("DENIED"); socket.destroy(); });
    socket.on("error", () => { process.stdout.write("DENIED"); });
  `;
  const outcome = await kubectl("exec", pod, "--namespace", namespace, "--", "node", "-e", script);
  assert.equal(outcome, "DENIED", "enforced production tenant policies must deny unrelated Pods");
}

async function assertUnauthorizedCodexSocket(topology) {
  const script = String.raw`
    const { randomBytes } = require("node:crypto");
    const request = require("node:http").request(
      process.env.APP_SERVER_URL.replace(/^ws:/, "http:"),
      { headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
      } },
    );
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      process.stdout.write("101");
    });
    request.on("response", (response) => {
      response.resume();
      process.stdout.write(String(response.statusCode));
    });
    request.on("error", (error) => {
      process.stderr.write(String(error));
      process.exitCode = 1;
    });
    request.end();
  `;
  const status = await kubectl(
    "exec",
    topology.gatewayPod.metadata.name,
    "--namespace",
    topology.placement,
    "--",
    "node",
    "-e",
    script,
  );
  assert.ok(["401", "403"].includes(status), `unauthorized Codex WebSocket returned ${status}`);
}

async function assertActualModelTurn(topology) {
  topology.gatewayUrl = await topology.refreshGatewayUrl();
  try {
    await assertGatewayModelTurn({
      gatewayUrl: topology.gatewayUrl,
      gatewayToken: topology.gatewayToken,
      nonce: `OCC-K3D-${topology.mode.toUpperCase()}-${randomUUID()}`,
      secrets: [process.env.OPENAI_API_KEY],
    });
  } catch (error) {
    const transport = await resource(
      "secret",
      `openclaw-agent-transport-${hash(topology.agent.id)}`,
      topology.placement,
    );
    const protectedValues = [
      process.env.OPENAI_API_KEY,
      ...Object.values(transport.data).map((value) => Buffer.from(value, "base64").toString()),
    ];
    const logs = await Promise.all(
      [topology.gatewayPod, topology.harnessPod]
        .filter(Boolean)
        .map((pod) =>
          kubectl("logs", pod.metadata.name, "--namespace", topology.placement, "--tail=100"),
        ),
    );
    assertNoSecretMaterial(
      logs,
      protectedValues,
      "Runtime failure logs must not expose credentials",
    );
    throw new Error(`${error.message}\n${logs.join("\n")}`, { cause: error });
  }
}

function sharedWorkspaceClaimName(agentId) {
  return `workspace-${hash(agentId)}`;
}

function sharedVolumeClaimName(pod) {
  return pod.spec.volumes?.find(({ name }) => name === sharedWorkspaceVolumeName)
    ?.persistentVolumeClaim?.claimName;
}

function sharedVolumeSubPaths(pod) {
  return (pod.spec.containers[0].volumeMounts ?? [])
    .filter(({ name }) => name === sharedWorkspaceVolumeName)
    .map(({ subPath }) => subPath)
    .sort();
}

function assertPrivateStateInitContainer(pod) {
  const main = pod.spec.containers[0];
  const [init] = pod.spec.initContainers ?? [];
  const { runAsUser, runAsGroup, fsGroup } = pod.spec.securityContext;
  assert.deepEqual(
    pod.spec.initContainers?.map(({ name }) => name),
    ["prepare-private-state"],
    "runtime gateway and Codex Pods must prepare private /home/node state exactly once",
  );
  assert.equal(init.image, main.image, "private-state init must use the main workload image");
  assert.deepEqual(
    [
      init.volumeMounts,
      init.env ?? [],
      init.envFrom ?? [],
      init.securityContext,
      { runAsUser, runAsGroup, fsGroup },
    ],
    [
      [
        { name: "runtime-state", mountPath: "/home/node" },
        ...(pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway"
          ? [{ name: "openclaw-gateway-state", mountPath: "/gateway-state" }]
          : []),
      ],
      [],
      [],
      {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      },
      { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
    ],
  );
}

async function assertScopedTenantPvcAccess(topology) {
  const verbs = ["get", "create", "patch", "delete", "list", "update"];
  assert.deepEqual(
    await Promise.all(
      verbs.map((verb) =>
        kubectl(
          "auth",
          "can-i",
          verb,
          "persistentvolumeclaims",
          "--namespace",
          topology.placement,
          `--as=system:serviceaccount:${topology.platformNamespace}:${topology.controllerAccount}`,
        ).then(
          (stdout) => stdout.trim(),
          ({ stdout }) => stdout.trim(),
        ),
      ),
    ),
    ["yes", "yes", "yes", "yes", "no", "no"],
    "the scoped tenant controller must receive only the four required PVC verbs",
  );
}

async function assertGatewayAdministrationRbacDenials(topology) {
  const { credential } = topology.gatewayAdministrationRbac;
  const rows = [
    [topology.controllerAccount, "list", "secrets", topology.platformNamespace],
    [topology.controllerAccount, "delete", "secrets", topology.platformNamespace, credential],
    ...["create", "list"].map((verb) => [
      topology.apiAccount,
      verb,
      "secrets",
      topology.platformNamespace,
    ]),
    ...["update", "patch", "delete"].map((verb) => [
      topology.apiAccount,
      verb,
      "secrets",
      topology.platformNamespace,
      credential,
    ]),
    [topology.controllerAccount, "create", "pods", topology.placement, undefined, "proxy"],
    [topology.apiAccount, "create", "pods", topology.placement, undefined, "proxy"],
    [topology.apiAccount, "create", "pods", topology.placement, undefined, "exec"],
  ];
  await Promise.all(
    rows.map(async ([accountName, verb, resource, namespace, resourceName, subresource]) => {
      const target = resourceName === undefined ? resource : `${resource}/${resourceName}`;
      const description = `${accountName} ${verb} ${target}${
        subresource === undefined ? "" : ` --subresource=${subresource}`
      } in ${namespace}`;
      let stdout;
      try {
        stdout = await kubectl(
          "auth",
          "can-i",
          verb,
          target,
          "--namespace",
          namespace,
          `--as=system:serviceaccount:${topology.platformNamespace}:${accountName}`,
          ...(subresource === undefined ? [] : [`--subresource=${subresource}`]),
        );
      } catch (error) {
        if (error.stdout?.trim() !== "no") throw error;
        stdout = error.stdout;
      }
      assert.equal(
        stdout.trim(),
        "no",
        `gateway administration RBAC unexpectedly allows ${description}`,
      );
    }),
  );
}

async function assertDedicatedSharedWorkspaceResources(topology) {
  await assertScopedTenantPvcAccess(topology);
  const claimName = sharedWorkspaceClaimName(topology.agent.id);
  const claim = await resource("persistentvolumeclaim", claimName, topology.placement);
  assert.deepEqual(
    [claim.spec.accessModes, claim.spec.resources.requests.storage, claim.status.phase],
    [["ReadWriteMany"], sharedWorkspaceClaimSize, "Bound"],
    "the Agent-owned shared workspace PVC must be bound with the expected spec",
  );
  assert.deepEqual(
    [sharedVolumeClaimName(topology.gatewayPod), sharedVolumeClaimName(topology.harnessPod)],
    [claimName, claimName],
  );
  assert.deepEqual(
    [sharedVolumeSubPaths(topology.gatewayPod), sharedVolumeSubPaths(topology.harnessPod)],
    [sharedWorkspaceSubPaths, sharedWorkspaceSubPaths],
  );
  return claim;
}

// The image enters through chat.send, so persistence must retain real application media.
const continuityImage =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPQqLhEU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAPHFyEwoyF0pAAAAAElFTkSuQmCC";
const gatewayPrivatePaths = [
  ["state", "/home/node/.openclaw/state"],
  ["agent", "/home/node/.openclaw/agents/main/agent"],
  ["media", "/home/node/.openclaw/media"],
];

async function assertGatewayPrivateResources(topology) {
  const name = `gateway-state-${hash(topology.agent.id)}`;
  const claim = await resource("persistentvolumeclaim", name, topology.placement);
  assert.deepEqual(
    [
      claim.spec.accessModes,
      claim.spec.resources.requests.storage,
      claim.spec.storageClassName,
      claim.status.phase,
    ],
    [["ReadWriteOnce"], "10Gi", "local-path", "Bound"],
  );
  assert.equal(claim.metadata.labels["openclaw.dev/agent"], topology.agent.id);
  assert.equal(claim.metadata.annotations["openclaw.dev/namespace-id"], topology.agent.namespaceId);
  assert.deepEqual(
    topology.gatewayPod.spec.volumes.find(({ name }) => name === "openclaw-gateway-state"),
    { name: "openclaw-gateway-state", persistentVolumeClaim: { claimName: name } },
  );
  assert.deepEqual(
    topology.gatewayPod.spec.containers[0].volumeMounts
      .filter(({ name }) => name === "openclaw-gateway-state")
      .map(({ subPath, mountPath }) => [subPath, mountPath]),
    [
      ...gatewayPrivatePaths,
      ...(topology.mode === "embedded" ? [["workspace", "/home/node/.openclaw/workspace"]] : []),
    ],
  );
  if (topology.harnessPod !== undefined) {
    assert.equal(
      JSON.stringify(topology.harnessPod.spec).includes(name),
      false,
      "the Codex Pod must never mount the gateway-private claim",
    );
  }
  return claim;
}

async function gatewayCall(topology, method, params) {
  // The real CLI authenticates from the Pod's env/config; credentials never enter kubectl args.
  return JSON.parse(
    await execNode(
      topology.placement,
      topology.gatewayPod.metadata.name,
      `
    const { execFileSync } = require("node:child_process");
    process.stdout.write(execFileSync(process.execPath, ["/app/openclaw.mjs", "gateway", "call",
      ${JSON.stringify(method)}, "--params", ${JSON.stringify(JSON.stringify(params))},
      "--json", "--timeout", "180000"], { encoding: "utf8", timeout: 210000 }));
  `,
    ),
  );
}

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter(({ type }) => type === "text")
    .map(({ text }) => text)
    .join("\n");
}

async function assertConversation(topology, sessionKey, nonce) {
  return waitFor(`provider transcript ${nonce}`, async () => {
    const history = await gatewayCall(topology, "chat.history", { sessionKey, limit: 30 });
    assert.equal(
      history.messages.some(
        ({ role, stopReason }) => role === "assistant" && stopReason === "error",
      ),
      false,
      "the actual provider turn must succeed",
    );
    const user = history.messages.find(
      (message) => message.role === "user" && messageText(message).includes(nonce),
    );
    const assistant = history.messages.find(
      (message) => message.role === "assistant" && messageText(message).includes(nonce),
    );
    return user && assistant ? history : undefined;
  });
}

function gatewayAdministrationPath(topology, agent = topology.agent) {
  return `/namespaces/${agent.namespaceId}/agents/${agent.id}/gateway/`;
}

async function dispatchOccGatewayCommand(topology, method, params, options = {}) {
  const request = options.request ?? topology.browserRequest;
  assert.equal(typeof request, "function", "OCC gateway command tests require an HTTP caller");
  const response = await request(
    "POST",
    options.path ?? gatewayAdministrationPath(topology),
    {
      method,
      ...(params === undefined ? {} : { params }),
      ...(options.extraBody ?? {}),
    },
    { headers: options.headers ?? { origin: authBaseURL } },
  );
  assertNoSecretMaterial(
    response,
    options.secrets ?? [process.env.OPENAI_API_KEY, topology.gatewayToken],
    "OCC gateway HTTP response must not expose credentials",
  );
  return response;
}

function assertOccGatewaySuccess(response, method) {
  assert.equal(response.status, 200, JSON.stringify(response.error));
  assert.equal(response.data.method, method);
  assert.equal(response.data.ok, true, JSON.stringify(response.data.error));
  assert.equal(Object.hasOwn(response.data, "payload"), true);
  return response.data.payload;
}

async function assertOccConversation(topology, sessionKey, nonce) {
  return waitFor(`OCC gateway provider transcript ${nonce}`, async () => {
    const response = await dispatchOccGatewayCommand(topology, "chat.history", {
      sessionKey,
      limit: 30,
    });
    const history = assertOccGatewaySuccess(response, "chat.history");
    assert.equal(
      history.messages.some(
        ({ role, stopReason }) => role === "assistant" && stopReason === "error",
      ),
      false,
      "the actual provider turn must succeed",
    );
    const user = history.messages.find(
      (message) => message.role === "user" && messageText(message).includes(nonce),
    );
    const assistant = history.messages.find(
      (message) => message.role === "assistant" && messageText(message).includes(nonce),
    );
    return user && assistant ? history : undefined;
  });
}

async function waitForGatewayAdministrationKeyOnlyCredential(
  topology,
  revisionId = topology.revision.id,
) {
  return waitFor(`gateway-admin key-only credential for ${revisionId}`, async () => {
    let credential;
    try {
      credential = await readGatewayAdministrationCredentialSecret(topology);
    } catch (error) {
      if (/NotFound|not found/i.test(error.stderr ?? error.message)) return undefined;
      throw error;
    }
    const parsed = gatewayAdministrationCredentialFromDecodedSecret(credential);
    return parsed.state === "keyOnly" ? parsed : undefined;
  });
}

async function waitForGatewayAdministrationIncompleteEnrollment(
  topology,
  revisionId = topology.revision.id,
) {
  return waitFor(`gateway-admin incomplete enrollment ${revisionId}`, () =>
    topology.events.find(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === revisionId &&
        event.outcome === "pending" &&
        event.code === "REVISION_INCOMPLETE",
    ),
  );
}

async function createUnrelatedPendingGatewayPairing(topology) {
  const requireFromController = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  );
  const [{ GatewayClient }, { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES }, nativeClient] =
    await Promise.all([
      import(requireFromController.resolve("@openclaw/gateway-client")),
      import(requireFromController.resolve("@openclaw/gateway-protocol/client-info")),
      import("../../apps/controller/src/gateway/native-client.ts"),
    ]);
  const identity = nativeClient.createOpenClawGatewayNativeDeviceIdentity();
  const { openKubernetesGatewayPodProxy } =
    await import("../../apps/controller/src/drivers/compute/kubernetes/pod-proxy.ts");
  const forwarding = await openKubernetesGatewayPodProxy(
    { mode: "kubeconfig", kubeconfigPath, context: kubernetesContext },
    (message) => new Error(message),
    {
      namespace: topology.placement,
      podName: topology.gatewayPod.metadata.name,
      targetPort: topology.gatewayPod.spec.containers
        .find((container) => container.name === "gateway")
        .ports.find((port) => port.name === "http").containerPort,
      signal: AbortSignal.timeout(90_000),
    },
  );
  const client = new GatewayClient({
    url: forwarding.url,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "OpenClaw Enterprise unrelated pending test client",
    clientVersion: "0.1.0",
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    role: "operator",
    scopes: ["operator.admin"],
    deviceIdentity: identity,
    token: topology.gatewayToken,
    requestTimeoutMs: 30_000,
    connectChallengeTimeoutMs: 30_000,
    hostDeps: {
      loadOrCreateDeviceIdentity: () => identity,
      signDevicePayload: nativeClient.signOpenClawGatewayNativePayload,
      publicKeyRawBase64UrlFromPem: nativeClient.publicKeyRawBase64UrlFromPem,
      loadDeviceAuthToken: () => null,
      storeDeviceAuthToken: () => {},
      clearDeviceAuthToken: () => {},
    },
    onConnectError: () => {},
    onClose: () => {},
  });
  try {
    client.start();
    const pending = await assertUnrelatedPendingGatewayPairing(topology, identity);
    return { identity, pending };
  } finally {
    try {
      await client.stopAndWait({ timeoutMs: 1_000 });
    } catch {
      client.stop();
    }
    await forwarding.close();
  }
}

async function assertUnrelatedPendingGatewayPairing(topology, identity) {
  return waitFor(`unrelated pending native pairing ${identity.deviceId}`, async () => {
    const pairing = await gatewayCall(topology, "device.pair.list", {});
    const pending = pairing.pending?.find((device) => device.deviceId === identity.deviceId);
    assert.equal(
      pairing.paired?.some((device) => device.deviceId === identity.deviceId),
      false,
      "unrelated native pairing must not be approved by gateway-admin enrollment",
    );
    return pending;
  });
}

async function readGatewayAdministrationCredentialSecret(topology) {
  const secret = await resource(
    "secret",
    topology.gatewayAdministrationRbac.credential,
    topology.platformNamespace,
  );
  return Object.fromEntries(
    Object.entries(secret.data ?? {}).map(([key, value]) => [
      key,
      Buffer.from(value, "base64").toString("utf8"),
    ]),
  );
}

function gatewayAdministrationCredentialFromDecodedSecret(decoded) {
  return parseGatewayAdministrationCredential({
    data: Object.fromEntries(
      Object.entries(decoded).map(([key, value]) => [key, Buffer.from(value).toString("base64")]),
    ),
  });
}

function gatewayAdministrationSecretMaterial(credential) {
  return [
    credential.identity.privateKeyPem,
    ...(credential.state === "established"
      ? [credential.deviceToken.token, JSON.stringify(credential.deviceToken.scopes)]
      : []),
  ];
}

async function readGatewayAdministrationCredential(topology) {
  const decoded = await readGatewayAdministrationCredentialSecret(topology);
  const credential = gatewayAdministrationCredentialFromDecodedSecret(decoded);
  assert.equal(credential.state, "established");
  assert.ok(credential.identity.deviceId, "gateway administration Secret must derive device id");
  assert.deepEqual(credential.deviceToken.scopes, ["operator.admin"]);
  assertNoSecretMaterial(
    [topology.gatewayPod.spec, topology.harnessPod?.spec],
    gatewayAdministrationSecretMaterial(credential),
    "gateway administration credentials must not be projected into Agent workloads",
  );
  return credential;
}

async function revokeGatewayAdministrationCredential(topology, credential) {
  const requireController = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  );
  const [{ GatewayClient }, { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES }, native] =
    await Promise.all([
      import(requireController.resolve("@openclaw/gateway-client")),
      import(requireController.resolve("@openclaw/gateway-protocol/client-info")),
      import("../../apps/controller/src/gateway/native-client.ts"),
    ]);
  const driver = topology.apiComputeDriver;
  const target = await driver.resolveCurrentGatewayTarget(topology.revision);
  const signal = AbortSignal.timeout(30_000);
  assert.equal(credential.state, "established");
  const identity = credential.identity;
  // Native revocation requires the caller to cover the target token's scopes.
  // Use the official SDK as the established admin, outside the deliberately
  // narrower OCC proxy, without projecting its credential into the Pod.
  const result = await driver.withGatewayPodProxy(target, signal, async (url) => {
    const ready = Promise.withResolvers();
    const abort = () => ready.reject(signal.reason);
    const client = new GatewayClient({
      url,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "OpenClaw Enterprise",
      clientVersion: "0.1.0",
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      role: "operator",
      scopes: credential.deviceToken.scopes,
      deviceIdentity: identity,
      deviceToken: credential.deviceToken.token,
      requestTimeoutMs: 30_000,
      connectChallengeTimeoutMs: 30_000,
      hostDeps: {
        loadOrCreateDeviceIdentity: () => identity,
        signDevicePayload: native.signOpenClawGatewayNativePayload,
        publicKeyRawBase64UrlFromPem: native.publicKeyRawBase64UrlFromPem,
        loadDeviceAuthToken: () => null,
        storeDeviceAuthToken: () => {},
        clearDeviceAuthToken: () => {},
      },
      onHelloOk: ready.resolve,
      onConnectError: ready.reject,
      onClose: () => ready.reject(new Error("Native revocation connection closed.")),
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      client.start();
      const hello = await ready.promise;
      assert.equal(hello.auth.role, "operator");
      assert.ok(hello.auth.scopes.includes("operator.admin"));
      return await client.request(
        "device.token.revoke",
        { deviceId: identity.deviceId, role: "operator" },
        { expectFinal: false, timeoutMs: 30_000, signal },
      );
    } finally {
      signal.removeEventListener("abort", abort);
      try {
        await client.stopAndWait({ timeoutMs: 1_000 });
      } catch {
        client.stop();
      }
    }
  });
  assertNoSecretMaterial(
    result,
    gatewayAdministrationSecretMaterial(credential),
    "native device revocation output must not expose the OCC credential",
  );
  assert.equal(result.deviceId, identity.deviceId);
  assert.equal(result.role, "operator");
  assert.equal(typeof result.revokedAtMs, "number");
  return result;
}

async function gatewayAuditRows(topology) {
  const { rows } = await topology.observerPool.query(
    `SELECT kind, outcome, details::text AS details
       FROM occ.audit_events
      WHERE namespace_id = $1 AND action = 'openclaw.agents.gateway.dispatch'
      ORDER BY occurred_at ASC`,
    [topology.agent.namespaceId],
  );
  return rows;
}

async function assertGatewayAuditSanitized(topology, secrets) {
  const rows = await gatewayAuditRows(topology);
  assert.ok(rows.length >= 2, "gateway dispatches must emit request and outcome audit evidence");
  assertNoSecretMaterial(rows, secrets, "gateway dispatch audit evidence must not expose secrets");
  for (const row of rows) {
    const details = JSON.parse(row.details);
    assert.equal(Object.hasOwn(details, "params"), false);
    assert.equal(Object.hasOwn(details, "payload"), false);
    assert.equal(Object.hasOwn(details, "result"), false);
    // Admission denials do not claim a native dispatch. Only admitted
    // mutation records carry the selected native method.
    if (row.kind === "mutation") assert.equal(typeof details.nativeMethod, "string");
  }
  return rows;
}

async function inspectGatewayPersistence(topology, imageDigest, sessionKey) {
  // Read existing databases only. Missing/corrupt databases fail; the probe never creates one.
  return JSON.parse(
    await execNode(
      topology.placement,
      topology.gatewayPod.metadata.name,
      `
    const { DatabaseSync } = require("node:sqlite");
    const fs = require("node:fs");
    const path = require("node:path");
    const { createHash } = require("node:crypto");
    const agentDatabase = "/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite";
    let transcript;
    const databases = ["/home/node/.openclaw/state/openclaw.sqlite", agentDatabase].map(file => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout=5000");
        if (file === agentDatabase) {
          const session = db.prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
            .get(${JSON.stringify(sessionKey)});
          if (!session) throw new Error("actual chat session missing from the agent SQLite database");
          const rows = db.prepare("SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
            .all(session.current_session_id);
          transcript = { sessionId: session.current_session_id, messages: rows.flatMap(({seq, event_json}) => {
            const event = JSON.parse(event_json);
            return event.type === "message" ? [{seq, role: event.message.role,
              text: typeof event.message.content === "string" ? event.message.content : (event.message.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\\n")}] : [];
          }) };
        }
        return { file, integrity: db.prepare("PRAGMA integrity_check").all().map(row => Object.values(row)[0]) };
      } finally { db.close(); }
    });
    function files(dir) { return fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => {
      const file=path.join(dir,entry.name); return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
    }); }
    const media = files("/home/node/.openclaw/media").filter(file =>
      createHash("sha256").update(fs.readFileSync(file)).digest("hex") === ${JSON.stringify(imageDigest)});
    process.stdout.write(JSON.stringify({databases, media, transcript}));
  `,
    ),
  );
}

async function assertRetainedImage(topology, sessionKey, expectedId) {
  const artifact = await waitFor("the model reply's managed image artifact", async () => {
    const { artifacts } = await gatewayCall(topology, "artifacts.list", { sessionKey });
    return artifacts.find(
      ({ type, id }) =>
        type === "image" &&
        id.startsWith("artifact_managed_image_") &&
        (expectedId === undefined || id === expectedId),
    );
  });
  assert.equal(artifact.download.mode, "url");
  // Mint a fresh ticket after each restart. The capability stays inside the Pod, out of kubectl args/logs.
  const downloaded = JSON.parse(
    await execNode(
      topology.placement,
      topology.gatewayPod.metadata.name,
      `
    const assert = require("node:assert/strict");
    const { execFileSync } = require("node:child_process");
    const result = JSON.parse(execFileSync(process.execPath, ["/app/openclaw.mjs", "gateway", "call",
      "artifacts.download", "--params", ${JSON.stringify(JSON.stringify({ sessionKey, artifactId: artifact.id }))},
      "--json", "--timeout", "180000"], { encoding: "utf8", timeout: 210000 }));
    const origin = "http://127.0.0.1:" + process.env.OPENCLAW_GATEWAY_PORT;
    const url = new URL(result.url, origin);
    assert.equal(url.origin, origin);
    assert.ok(url.pathname.startsWith("/api/chat/media/outgoing/"));
    assert.ok(url.searchParams.has("mediaTicket"));
    assert.ok(Date.parse(result.expiresAt) > Date.now());
    (async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 200, "the current artifact ticket must download the retained bytes");
      assert.match(response.headers.get("content-type"), /^image\\/png/);
      process.stdout.write(JSON.stringify({data: Buffer.from(await response.arrayBuffer()).toString("base64")}));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    ),
  );
  assert.deepEqual(Buffer.from(downloaded.data, "base64"), Buffer.from(continuityImage, "base64"));
  return artifact.id;
}

async function assertGatewayPodContinuity(context, topology, privateClaim) {
  const sessionKey = `agent:main:durability-${randomUUID()}`;
  const nonce = `OCE-BEFORE-${randomUUID()}`;
  await gatewayCall(topology, "chat.send", {
    sessionKey,
    idempotencyKey: randomUUID(),
    message: `Reply with exactly ${nonce}. Do not use tools; the attached PNG tests image retention.`,
    attachments: [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "durability.png",
        content: continuityImage,
      },
    ],
  });
  const history = await assertConversation(topology, sessionKey, nonce);
  const digest = createHash("sha256").update(Buffer.from(continuityImage, "base64")).digest("hex");
  const uploaded = await inspectGatewayPersistence(topology, digest, sessionKey);
  const inboundPath = uploaded.media.find((file) => file.includes("/media/inbound/"));
  assert.ok(inboundPath, "chat.send must persist the actual PNG under private media");
  // A real model returns the uploaded PNG through the supported MEDIA directive. No image-generation bill
  // or hand-written output file is needed to exercise managed outgoing records and their ticketed download.
  const imageNonce = `OCE-IMAGE-${randomUUID()}`;
  await gatewayCall(topology, "chat.send", {
    sessionKey,
    idempotencyKey: randomUUID(),
    message: `Return these exact two lines without tools or code fences:\n${imageNonce}\nMEDIA:${inboundPath}`,
  });
  await assertConversation(topology, sessionKey, imageNonce);
  const artifactId = await assertRetainedImage(topology, sessionKey);
  const before = await inspectGatewayPersistence(topology, digest, sessionKey);
  for (const database of before.databases) assert.deepEqual(database.integrity, ["ok"]);
  assert.equal(before.transcript.sessionId, history.sessionId);
  for (const role of ["user", "assistant"]) {
    assert.ok(
      before.transcript.messages.some(
        (message) => message.role === role && message.text.includes(nonce),
      ),
      `the exact ${role} turn must be persisted in agent SQLite transcript_events`,
    );
  }
  if (topology.harnessPod !== undefined) {
    const hidden = await execNode(
      topology.placement,
      topology.harnessPod.metadata.name,
      `
      const fs = require("node:fs");
      process.stdout.write(JSON.stringify(${JSON.stringify([...before.databases.map(({ file }) => file), ...before.media])}.filter(file => fs.existsSync(file))));
    `,
    );
    assert.deepEqual(
      JSON.parse(hidden),
      [],
      "Codex must not see the gateway databases or retained image files",
    );
  }

  // Deleting the Pod destroys emptyDir state; only the owning durable claim can preserve these outcomes.
  const previousUid = topology.gatewayPod.metadata.uid;
  await kubectl(
    "delete",
    "pod",
    topology.gatewayPod.metadata.name,
    "--namespace",
    topology.placement,
    "--wait=true",
    "--timeout=120s",
  );
  topology.gatewayPod = await waitFor("a replacement gateway Pod with a new UID", async () =>
    (await resources("pods", topology.placement)).find(
      (pod) =>
        pod.metadata.uid !== previousUid &&
        !pod.metadata.deletionTimestamp &&
        pod.metadata.labels?.["openclaw.dev/agent"] === topology.agent.id &&
        pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
        pod.status.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
    ),
  );
  const retained = await assertGatewayPrivateResources(topology);
  assert.equal(retained.metadata.uid, privateClaim.metadata.uid);
  await assertConversation(topology, sessionKey, nonce);
  await assertRetainedImage(topology, sessionKey, artifactId);
  const restored = await inspectGatewayPersistence(topology, digest, sessionKey);
  for (const database of restored.databases) assert.deepEqual(database.integrity, ["ok"]);
  assert.deepEqual(
    restored.transcript,
    before.transcript,
    "the exact SQLite session messages must survive Pod replacement",
  );
  for (const file of before.media)
    assert.ok(restored.media.includes(file), "all retained PNG files must survive");
  const afterNonce = `OCE-AFTER-${randomUUID()}`;
  await gatewayCall(topology, "chat.send", {
    sessionKey,
    idempotencyKey: randomUUID(),
    message: `Reply with exactly ${afterNonce}. Do not use tools.`,
  });
  await assertConversation(topology, sessionKey, afterNonce);
  const continued = await inspectGatewayPersistence(topology, digest, sessionKey);
  assert.equal(continued.transcript.sessionId, before.transcript.sessionId);
  for (const role of ["user", "assistant"]) {
    assert.ok(
      continued.transcript.messages.some(
        (message) => message.role === role && message.text.includes(afterNonce),
      ),
      `the continued ${role} turn must write to the retained agent SQLite session`,
    );
  }
  context.diagnostic(
    `Gateway transcript, PNG ${artifactId}, and SQLite integrity survived Pod UID ${previousUid} -> ${topology.gatewayPod.metadata.uid}.`,
  );
}

async function assertEmbeddedCreatesNoSharedWorkspaceClaim(topology) {
  const claimName = sharedWorkspaceClaimName(topology.agent.id);
  const claims = await resources("persistentvolumeclaims", topology.placement);
  assert.equal(
    claims.some(({ metadata }) => metadata.name === claimName),
    false,
    "embedded execution must not create an Agent shared workspace PVC",
  );
  assert.equal(sharedVolumeClaimName(topology.gatewayPod), undefined);
  assert.deepEqual(sharedVolumeSubPaths(topology.gatewayPod), []);
}

async function execNode(namespace, pod, script) {
  return kubectl("exec", pod, "--namespace", namespace, "--", "node", "-e", script);
}

async function writeFileInPod(namespace, pod, file, content) {
  const script = `
    const { mkdirSync, writeFileSync } = require("node:fs");
    const { dirname } = require("node:path");
    const file = ${JSON.stringify(file)};
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, ${JSON.stringify(content)});
  `;
  await execNode(namespace, pod, script);
}

async function readFileInPod(namespace, pod, file) {
  return execNode(
    namespace,
    pod,
    `const { readFileSync } = require("node:fs");process.stdout.write(readFileSync(${JSON.stringify(file)}, "utf8"));`,
  );
}

async function requestDedicatedAgentTurn(topology, sessionKey, prompt) {
  const response = await fetch(`${topology.gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${topology.gatewayToken}`,
      "content-type": "application/json",
      "x-openclaw-session-key": sessionKey,
    },
    body: JSON.stringify({
      model: "openclaw/default",
      stream: false,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.text();
  assertNoSecretMaterial(
    body,
    [topology.gatewayToken, process.env.OPENAI_API_KEY],
    "Dedicated Agent responses must not expose credentials",
  );
  assert.equal(response.status, 200, `dedicated Agent model turn failed: ${body}`);
  return JSON.parse(body).choices?.[0]?.message?.content ?? "";
}

async function requestFreshDedicatedHarnessTurn(topology) {
  return execNode(
    topology.placement,
    topology.gatewayPod.metadata.name,
    `
      const socket = new WebSocket(process.env.APP_SERVER_URL, {
        headers: { Authorization: "Bearer " + process.env.APP_SERVER_TOKEN },
      });
      const pending = new Map();
      let requestId = 0;
      let assistant = "";
      let finished = false;
      const timeout = setTimeout(() => fail(new Error("Codex harness turn timed out")), 180_000);

      function fail(error) {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        socket.close();
        process.stderr.write(error.message || String(error));
        process.exitCode = 1;
      }

      function request(method, params) {
        const id = ++requestId;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      }

      socket.addEventListener("open", async () => {
        try {
          await request("initialize", {
            clientInfo: { name: "openclaw-enterprise-integration", version: "1.0.0" },
          });
          socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
          const started = await request("thread/start", {
            cwd: "/home/node/workspace",
            model: ${JSON.stringify(providerModel)},
            approvalPolicy: "on-request",
            sandbox: "read-only",
            config: { project_doc_max_bytes: 131072 },
          });
          if (!started.instructionSources?.includes("/home/node/workspace/AGENTS.md")) {
            throw new Error("Fresh Codex harness thread did not load workspace AGENTS.md");
          }
          await request("turn/start", {
            threadId: started.thread.id,
            input: [{ type: "text", text: "What is 2 + 2? Answer briefly." }],
            sandboxPolicy: { type: "readOnly", networkAccess: false },
          });
        } catch (error) {
          fail(error);
        }
      });

      socket.addEventListener("message", ({ data }) => {
        const message = JSON.parse(String(data));
        if (message.id !== undefined) {
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (request) {
            if (message.error) request.reject(new Error(message.error.message));
            else request.resolve(message.result);
          }
        } else if (message.method === "item/completed") {
          if (message.params?.item?.type === "agentMessage") {
            assistant = message.params.item.text;
          }
        } else if (message.method === "turn/completed") {
          if (message.params?.turn?.status !== "completed") {
            fail(new Error("Codex harness turn did not complete successfully"));
            return;
          }
          finished = true;
          clearTimeout(timeout);
          process.stdout.write(assistant);
          socket.close();
        } else if (message.method === "error") {
          fail(new Error(message.params?.error?.message || "Codex harness turn failed"));
        }
      });
      socket.addEventListener("error", () => fail(new Error("Codex harness connection failed")));
      socket.addEventListener("close", () => {
        if (!finished) fail(new Error("Codex harness connection closed before the turn completed"));
      });
    `,
  );
}

async function assertDedicatedAgentsInstructionsInFreshSession(topology) {
  const instructionsPath = "/home/node/workspace/AGENTS.md";
  const suffix = "enterprise openclaw";
  const sessionKey = `enterprise-agents-${randomUUID()}`;

  // The actual Codex Agent must edit its shared workspace, not a test-injected fixture.
  const editResponse = await requestDedicatedAgentTurn(
    topology,
    sessionKey,
    `Use your file-editing tools to update ${instructionsPath}. Preserve its existing contents and append this exact instruction on a new line: End every response with the exact lowercase phrase ${suffix}. If the file does not exist, create it. Edit the file before you respond.`,
  );
  const [gatewayInstructions, harnessInstructions] = await Promise.all([
    readFileInPod(topology.placement, topology.gatewayPod.metadata.name, instructionsPath),
    readFileInPod(topology.placement, topology.harnessPod.metadata.name, instructionsPath),
  ]);
  assert.equal(
    /^End every response with the exact lowercase phrase enterprise openclaw\.$/m.test(
      harnessInstructions,
    ),
    true,
    `The Agent did not persist its requested instruction. Response: ${editResponse.slice(0, 1500)}`,
  );
  assert.equal(gatewayInstructions, harnessInstructions);

  // A new native harness thread must load persisted instructions absent from its neutral prompt.
  const response = await requestFreshDedicatedHarnessTurn(topology);
  assert.match(response.trimEnd(), /enterprise openclaw[.!?]*$/);
}

async function assertSharedText(
  namespace,
  { writerPod, readerPod, writerPath, readerPath, content },
) {
  await writeFileInPod(namespace, writerPod, writerPath, content);
  assert.equal(await readFileInPod(namespace, readerPod, readerPath ?? writerPath), content);
}

async function assertWriteDenied(namespace, pod, file) {
  const outcome = await execNode(
    namespace,
    pod,
    `const { writeFileSync } = require("node:fs");try{writeFileSync(${JSON.stringify(file)}, "denied");process.stdout.write("ALLOWED");}catch(error){process.stdout.write(error.code || error.name || "DENIED");}`,
  );
  assert.match(outcome, /^(?:EACCES|EROFS|EPERM)$/);
}

async function waitForReadyAgentPod(topology, revisionId, previousUid) {
  return waitFor(`dedicated Codex Pod for revision ${revisionId}`, async () => {
    const ready = (await resources("pods", topology.placement)).find(
      (pod) =>
        pod.metadata.uid !== previousUid &&
        pod.metadata.labels?.["openclaw.dev/workload-role"] === "agent" &&
        pod.metadata.labels?.["openclaw.dev/agent"] === topology.agent.id &&
        pod.metadata.labels?.["openclaw.dev/revision"] === revisionId &&
        pod.status.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
    );
    return ready;
  });
}

async function waitForReadyGatewayPod(topology, revisionId, previousUid) {
  return waitFor(`embedded OpenClaw gateway Pod for revision ${revisionId}`, async () => {
    const ready = (await resources("pods", topology.placement)).find(
      (pod) =>
        (previousUid === undefined || pod.metadata.uid !== previousUid) &&
        pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
        pod.metadata.labels?.["openclaw.dev/agent"] === topology.agent.id &&
        gatewayConsumesRevision(pod, topology.agent.id, revisionId) &&
        pod.status.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
    );
    return ready;
  });
}

async function deployEmbeddedAgentAndWait(topology, agentId, description, options = {}) {
  const deployed = await topology.request(
    "POST",
    `/namespaces/${topology.agent.namespaceId}/agents/${agentId}/deploy`,
  );
  assertNoSecretMaterial(
    deployed,
    options.protectedValues ?? secretApiProtectedValues(topology),
    `${description} deploy response must not leak secret material`,
  );
  assert.equal(deployed.status, 202, JSON.stringify(deployed.error));
  await waitFor(`${description} revision ${deployed.data.id} activation`, async () => {
    const observation = await topology.request(
      "GET",
      `/namespaces/${topology.agent.namespaceId}/agents/${agentId}`,
    );
    assert.equal(observation.status, 200);
    return observation.data.activeRevisionId === deployed.data.id ? observation.data : undefined;
  });
  await waitFor(`worker completion of ${description} ${deployed.data.id}`, () =>
    topology.events.find(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === deployed.data.id &&
        event.outcome === "success",
    ),
  );
  return {
    revision: deployed.data,
    gatewayPod: await waitForReadyGatewayPod(
      { ...topology, agent: { ...topology.agent, id: agentId } },
      deployed.data.id,
      options.previousUid,
    ),
  };
}

function gatewayConsumesRevision(pod, agentId, revisionId) {
  // Gateways have stable labels; the immutable mounted ConfigMap selects the revision.
  return pod.spec.volumes?.some(
    ({ configMap }) => configMap?.name === `gateway-${hash(agentId)}-rev-${hash(revisionId)}`,
  );
}

async function assertOpenAiKeyProjectedFromSecret(topology, pod) {
  const storage = await storedSecret(
    topology.observerPool,
    topology.agent.namespaceId,
    topology.secretApi.model.id,
  );
  const projection = pod.spec.containers[0].env.find(({ name }) => name === "OPENAI_API_KEY");
  assert.deepEqual(
    projection?.valueFrom?.secretKeyRef,
    { name: storage.backendRef.name, key: storage.backendRef.key, optional: false },
    "OPENAI_API_KEY must remain projected from the valid Secret API backend",
  );
  const backend = await resource(
    "secret",
    storage.backendRef.name,
    storage.backendRef.namespaceName,
  );
  assert.equal(
    Object.hasOwn(backend.data ?? {}, storage.backendRef.key),
    true,
    "the Secret API backend must still contain the projected OPENAI_API_KEY key",
  );
  assert.equal(
    backend.data[storage.backendRef.key] ===
      Buffer.from(process.env.OPENAI_API_KEY).toString("base64"),
    true,
    "the selected valid model credential must remain unchanged in backing storage",
  );
}

async function nativeFailureEvidence(namespace, podName, invalidModelEnv) {
  const outputs = [];
  for (const args of [
    ["logs", podName, "--namespace", namespace, "--tail=80"],
    ["logs", podName, "--namespace", namespace, "--previous", "--tail=80"],
  ]) {
    try {
      outputs.push(await kubectl(...args));
    } catch (error) {
      outputs.push(`${error.stdout ?? ""}\n${error.stderr ?? ""}`);
    }
  }
  const joined = outputs.join("\n");
  assertNoSecretMaterial(
    joined,
    [process.env.OPENAI_API_KEY],
    "Native resolution logs must not expose the model key",
  );
  return (
    joined.includes(invalidModelEnv) &&
    /SECRET_REF_(?:NOT_FOUND|POLICY_DENIED)|missing or empty|not allowlisted/.test(joined)
  );
}

async function assertNoLegacyModelSecret(topology) {
  const legacyName = `${modelPrefix}-${hash(topology.agent.id)}`;
  let missing = false;
  try {
    await kubectl("get", "secret", legacyName, "--namespace", topology.placement, "-o", "name");
  } catch (error) {
    assert.match(error.stderr ?? error.message, /NotFound|not found/i);
    missing = true;
  }
  assert.equal(missing, true, "Secret API model binding must replace the operator model Secret");
}

async function assertSecretApiNoLeakage(topology, secrets) {
  const [revisions, audit, configMaps] = await Promise.all([
    topology.observerPool.query(
      "SELECT admitted_spec::text AS value FROM occ.agent_revisions WHERE namespace_id = $1",
      [topology.agent.namespaceId],
    ),
    topology.observerPool.query(
      "SELECT action, resource_kind, resource_id, details::text AS details FROM occ.audit_events WHERE namespace_id = $1",
      [topology.agent.namespaceId],
    ),
    resources("configmaps", topology.placement),
  ]);
  assertNoSecretMaterial(
    revisions.rows,
    secrets,
    "PostgreSQL AgentRevision snapshots are ref-only",
  );
  assertNoSecretMaterial(audit.rows, secrets, "audit evidence must not contain secret material");
  assertNoSecretMaterial(
    configMaps,
    secrets,
    "gateway ConfigMaps must not contain secret material",
  );
  const approvedClientEnvironment = await inspectWorkloadEnvironment(
    topology.platformNamespace,
    topology.approvedClient,
  );
  assert.deepEqual(approvedClientEnvironment, {
    OPENAI_API_KEY: false,
    [secretRotationProbe]: false,
    APP_SERVER_TOKEN: false,
    APP_SERVER_URL: false,
    OPENCLAW_GATEWAY_TOKEN: false,
  });
}

async function assertCrossNamespaceSecretBindingDenied(context, topology) {
  const namespace = await topology.adminRequest("POST", "/namespaces", {
    name: `secret-api-cross-namespace-${randomUUID()}`,
  });
  assert.equal(namespace.status, 201, JSON.stringify(namespace.error));
  const placement = topology.kubernetesNamespaceName(namespace.data.id);
  context.after(async () => {
    await kubectl(
      "delete",
      "namespace",
      placement,
      "--ignore-not-found=true",
      "--wait=true",
      "--timeout=120s",
    );
  });
  await waitFor(`the production worker to create cross-Namespace tenant ${placement}`, async () => {
    try {
      return await resource("namespace", placement);
    } catch (error) {
      if (/NotFound|not found/i.test(error.stderr ?? error.message)) return undefined;
      throw error;
    }
  });
  await kubectl(
    "create",
    "rolebinding",
    "openclaw-production-controller",
    "--namespace",
    placement,
    `--clusterrole=${topology.controllerTenantRole}`,
    `--serviceaccount=${topology.platformNamespace}:${topology.controllerAccount}`,
  );
  await kubectl(
    "create",
    "rolebinding",
    "openclaw-production-secret-api",
    "--namespace",
    placement,
    `--clusterrole=${topology.apiSecretRole}`,
    `--serviceaccount=${topology.platformNamespace}:${topology.apiAccount}`,
  );
  await waitFor(
    `the production worker to provision cross-Namespace tenant ${placement}`,
    async () => {
      const observation = await topology.adminRequest("GET", `/namespaces/${namespace.data.id}`);
      assert.equal(observation.status, 200);
      return observation.data.status === "ready" ? observation.data : undefined;
    },
  );
  const crossValue = `cross-namespace-secret-${randomUUID()}`;
  const crossSecret = await createApiSecret(
    topology.adminRequest,
    namespace.data.id,
    "cross-namespace",
    crossValue,
  );
  await createUndeployedAgent(
    topology.adminRequest,
    namespace.data.id,
    "embedded",
    `secret-api-cross-agent-${randomUUID()}`,
  );
  await grantSecretOperate(
    topology.observerPool,
    namespace.data.id,
    topology.secretApi.assignmentPrincipalId,
    crossSecret.id,
  );
  const denied = await expectApiFailureWithoutSecret(
    topology.request,
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/configurations/${topology.agent.configurationId}`,
    {
      values: nativeConfiguration("openclaw"),
      secretBindings: { OPENAI_API_KEY: secretBinding(crossSecret.ref) },
    },
    secretApiProtectedValues(topology, [crossValue]),
    "cross-Namespace Secret binding",
  );
  assert.equal(denied.status, 404, `unexpected cross-Namespace denial ${denied.status}`);
  const observed = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/configurations/${topology.agent.configurationId}`,
  );
  assert.equal(observed.status, 200, JSON.stringify(observed.error));
  assert.deepEqual(
    observed.data.secretBindings,
    topology.secretApi.configuration.secretBindings,
    "cross-Namespace denial must preserve the valid same-Namespace bindings",
  );
  context.diagnostic(`secret-api cross-namespace: denied with HTTP ${denied.status}`);
}

async function assertMissingBackendSecretBindingFailsBounded(context, topology) {
  const secret = topology.secretApi.missingBackend;
  const missingValue = topology.secretApi.missingBackendValue;
  const missing = await createUndeployedAgent(
    topology.request,
    topology.agent.namespaceId,
    "embedded",
    `secret-api-missing-backend-${randomUUID()}`,
  );
  const missingAgent = await storedAgent(
    topology.observerPool,
    topology.agent.namespaceId,
    missing.agent.id,
  );
  await Promise.all([
    grantSecretOperate(
      topology.observerPool,
      topology.agent.namespaceId,
      topology.secretApi.assignmentPrincipalId,
      secret.id,
    ),
    grantSecretOperate(
      topology.observerPool,
      topology.agent.namespaceId,
      missingAgent.servicePrincipalId,
      secret.id,
    ),
  ]);
  const stored = await storedSecret(topology.observerPool, topology.agent.namespaceId, secret.id);
  const bound = await topology.request(
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/configurations/${missing.configuration.id}`,
    {
      values: nativeConfiguration("openclaw"),
      secretBindings: { OPENAI_API_KEY: secretBinding(secret.ref) },
    },
  );
  assert.equal(bound.status, 200, JSON.stringify(bound.error));
  assertNoSecretMaterial(
    bound,
    secretApiProtectedValues(topology),
    "missing-backend Configuration response must not leak secret material",
  );
  await kubectl(
    "delete",
    "secret",
    stored.backendRef.name,
    "--namespace",
    stored.backendRef.namespaceName,
    "--wait=true",
    "--timeout=120s",
  );
  const revisionsBefore = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${missing.agent.id}/revisions`,
  );
  assert.equal(revisionsBefore.status, 200, JSON.stringify(revisionsBefore.error));
  const deployed = await topology.request(
    "POST",
    `/namespaces/${topology.agent.namespaceId}/agents/${missing.agent.id}/deploy`,
  );
  assertNoSecretMaterial(
    deployed,
    secretApiProtectedValues(topology),
    "missing-backend deploy response must not leak secret material",
  );
  assert.equal(deployed.status, 503, `missing backend deploy returned HTTP ${deployed.status}`);
  const revisionsAfter = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${missing.agent.id}/revisions`,
  );
  assert.equal(revisionsAfter.status, 200, JSON.stringify(revisionsAfter.error));
  assert.deepEqual(
    revisionsAfter.data.map(({ id }) => id),
    revisionsBefore.data.map(({ id }) => id),
    "missing Secret backend must be rejected before admitting a revision",
  );
  context.diagnostic(
    `secret-api missing-backend: deploy rejected with HTTP ${deployed.status} after deleting backend ${stored.backendRef.name}`,
  );
  const agent = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${missing.agent.id}`,
  );
  assert.equal(agent.status, 200, JSON.stringify(agent.error));
  assert.equal(
    agent.data.activeRevisionId,
    undefined,
    "a missing Secret backend must not become the active Agent revision",
  );
  assertNoSecretMaterial(
    [bound, deployed, agent],
    secretApiProtectedValues(topology),
    "missing-backend diagnostics must not leak secret material",
  );
}

async function assertSecretApiNegativeRows(context, topology) {
  await assertCrossNamespaceSecretBindingDenied(context, topology);
  await assertMissingBackendSecretBindingFailsBounded(context, topology);
}

async function assertSameNamespaceSecretSharing(context, topology) {
  const peerBindings = {
    OPENAI_API_KEY: secretBinding(topology.secretApi.model.ref),
    [peerSecretRotationProbe]: secretBinding(topology.secretApi.peerProbe.ref),
    [sharedSecretRotationProbe]: secretBinding(topology.secretApi.sharedProbe.ref),
  };
  const configuration = await topology.request(
    "POST",
    `/namespaces/${topology.agent.namespaceId}/configurations`,
    {
      kind: "agent",
      values: nativeConfiguration("openclaw"),
    },
  );
  assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
  const agent = await topology.request("POST", `/namespaces/${topology.agent.namespaceId}/agents`, {
    name: `secret-api-shared-consumer-${randomUUID()}`,
    configurationId: configuration.data.id,
    executionMode: "embedded",
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.error));
  const boundConfiguration = await topology.request(
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/configurations/${configuration.data.id}`,
    {
      values: nativeConfiguration("openclaw"),
      secretBindings: peerBindings,
    },
  );
  assert.equal(boundConfiguration.status, 200, JSON.stringify(boundConfiguration.error));
  assert.deepEqual(boundConfiguration.data.secretBindings, peerBindings);
  const updatedAgent = await topology.request(
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/agents/${agent.data.id}`,
    {
      configurationId: boundConfiguration.data.id,
      executionMode: "embedded",
    },
  );
  assert.equal(updatedAgent.status, 200, JSON.stringify(updatedAgent.error));
  assert.equal(updatedAgent.data.configurationId, boundConfiguration.data.id);
  const persistedAgent = await storedAgent(
    topology.observerPool,
    topology.agent.namespaceId,
    agent.data.id,
  );
  await Promise.all([
    grantSecretOperate(
      topology.observerPool,
      topology.agent.namespaceId,
      persistedAgent.servicePrincipalId,
      topology.secretApi.model.id,
    ),
    grantSecretOperate(
      topology.observerPool,
      topology.agent.namespaceId,
      persistedAgent.servicePrincipalId,
      topology.secretApi.peerProbe.id,
    ),
    grantSecretOperate(
      topology.observerPool,
      topology.agent.namespaceId,
      persistedAgent.servicePrincipalId,
      topology.secretApi.sharedProbe.id,
    ),
  ]);
  const gatewayToken = await provisionAgentTransportSecret(
    topology.directory,
    topology.placement,
    agent.data.id,
  );
  const deployed = await deployEmbeddedAgentAndWait(
    { ...topology, agent: agent.data },
    agent.data.id,
    "shared Secret consumer",
  );
  const peerTopology = {
    ...topology,
    agent: agent.data,
    persistedAgent,
    revision: deployed.revision,
    gatewayServiceName: `gateway-${hash(agent.data.id)}`,
    agentServiceName: `agent-${hash(agent.data.id)}`,
    gatewayPod: deployed.gatewayPod,
    gatewayToken,
  };
  let forwarding = await startPortForward(topology.placement, peerTopology.gatewayServiceName);
  context.after(() => forwarding?.stop());
  peerTopology.gatewayUrl = forwarding.url;
  peerTopology.refreshGatewayUrl = async () => {
    forwarding?.stop();
    forwarding = await startPortForward(topology.placement, peerTopology.gatewayServiceName);
    return forwarding.url;
  };

  const assertEnvironmentValues = async (checks) => {
    for (const { pod, name, value, expected, message } of checks) {
      assert.deepEqual(
        await inspectEnvironmentValue(topology.placement, pod, name, value),
        expected,
        message,
      );
    }
  };

  await assertEnvironmentValues([
    {
      pod: topology.gatewayPod.metadata.name,
      name: sharedSecretRotationProbe,
      value: topology.secretApi.initialSharedProbeValue,
      expected: { present: true, matches: true },
      message: "the primary gateway must receive the shared sentinel before rotation",
    },
    {
      pod: peerTopology.gatewayPod.metadata.name,
      name: sharedSecretRotationProbe,
      value: topology.secretApi.initialSharedProbeValue,
      expected: { present: true, matches: true },
      message: "the peer gateway must receive the shared sentinel before rotation",
    },
    {
      pod: topology.gatewayPod.metadata.name,
      name: peerSecretRotationProbe,
      value: topology.secretApi.initialPeerProbeValue,
      expected: { present: false, matches: false },
      message: "the primary gateway must not receive the peer Agent's private Secret binding",
    },
    {
      pod: peerTopology.gatewayPod.metadata.name,
      name: secretRotationProbe,
      value: topology.secretApi.initialProbeValue,
      expected: { present: false, matches: false },
      message: "the peer gateway must not receive the primary Agent's private Secret binding",
    },
    {
      pod: peerTopology.gatewayPod.metadata.name,
      name: peerSecretRotationProbe,
      value: topology.secretApi.initialPeerProbeValue,
      expected: { present: true, matches: true },
      message: "the peer gateway must receive its private Secret binding",
    },
  ]);

  const primaryPodUid = topology.gatewayPod.metadata.uid;
  const peerPodUid = peerTopology.gatewayPod.metadata.uid;
  const rotatedSharedProbeValue = `secret-rotation-shared-rotated-${randomUUID()}`;
  await updateApiSecret(
    topology.request,
    topology.agent.namespaceId,
    topology.secretApi.sharedProbe,
    rotatedSharedProbeValue,
  );
  topology.secretApi.rotatedSharedProbeValue = rotatedSharedProbeValue;
  assert.equal(
    (await resource("pod", topology.gatewayPod.metadata.name, topology.placement)).metadata.uid,
    primaryPodUid,
    "updating a shared Secret must not restart the primary consumer",
  );
  assert.equal(
    (await resource("pod", peerTopology.gatewayPod.metadata.name, topology.placement)).metadata.uid,
    peerPodUid,
    "updating a shared Secret must not restart the peer consumer",
  );
  await assertEnvironmentValues(
    [
      [topology.gatewayPod.metadata.name, "primary"],
      [peerTopology.gatewayPod.metadata.name, "peer"],
    ].flatMap(([pod, description]) => [
      {
        pod,
        name: sharedSecretRotationProbe,
        value: topology.secretApi.initialSharedProbeValue,
        expected: { present: true, matches: true },
        message: `${description} gateway must retain the old shared sentinel until it restarts`,
      },
      {
        pod,
        name: sharedSecretRotationProbe,
        value: rotatedSharedProbeValue,
        expected: { present: true, matches: false },
        message: `${description} gateway must not observe the rotated shared sentinel before restart`,
      },
    ]),
  );

  const peerRedeployed = await deployEmbeddedAgentAndWait(
    { ...topology, agent: agent.data },
    agent.data.id,
    "shared Secret consumer redeploy",
    { previousUid: peerTopology.gatewayPod.metadata.uid },
  );
  peerTopology.gatewayPod = peerRedeployed.gatewayPod;
  peerTopology.revision = peerRedeployed.revision;
  await assertEnvironmentValues([
    {
      pod: peerTopology.gatewayPod.metadata.name,
      name: sharedSecretRotationProbe,
      value: rotatedSharedProbeValue,
      expected: { present: true, matches: true },
      message: "the peer gateway must observe the rotated shared sentinel after its redeploy",
    },
    {
      pod: topology.gatewayPod.metadata.name,
      name: sharedSecretRotationProbe,
      value: topology.secretApi.initialSharedProbeValue,
      expected: { present: true, matches: true },
      message:
        "the primary gateway must keep the old shared sentinel while only the peer redeploys",
    },
  ]);
  await assertActualModelTurn(peerTopology);

  const primaryRedeployed = await deployEmbeddedAgentAndWait(
    topology,
    topology.agent.id,
    "primary shared Secret consumer redeploy",
    { previousUid: topology.gatewayPod.metadata.uid },
  );
  topology.gatewayPod = primaryRedeployed.gatewayPod;
  topology.revision = primaryRedeployed.revision;
  await assertEnvironmentValues([
    {
      pod: topology.gatewayPod.metadata.name,
      name: sharedSecretRotationProbe,
      value: rotatedSharedProbeValue,
      expected: { present: true, matches: true },
      message:
        "the primary gateway must observe the rotated shared sentinel after its own redeploy",
    },
  ]);

  for (const [secret, value, description] of [
    [topology.secretApi.model, process.env.OPENAI_API_KEY, "shared model Secret delete"],
    [topology.secretApi.sharedProbe, rotatedSharedProbeValue, "shared sentinel Secret delete"],
    [
      topology.secretApi.peerProbe,
      topology.secretApi.initialPeerProbeValue,
      "peer probe Secret delete",
    ],
  ]) {
    const deleted = await expectApiFailureWithoutSecret(
      topology.request,
      "DELETE",
      `/namespaces/${topology.agent.namespaceId}/secrets/${secret.id}`,
      undefined,
      [value],
      description,
    );
    assert.equal(deleted.status, 409);
  }
  await assertSecretApiNoLeakage(topology, secretApiProtectedValues(topology));
  context.diagnostic(
    `secret-api sharing: shared model ${topology.secretApi.model.ref.id} powered selected Agents ${topology.agent.id} and ${agent.data.id}`,
  );
}

async function assertUnboundSecretDeletion(context, topology) {
  const value = topology.secretApi.unboundDeleteValue;
  const secret = topology.secretApi.unboundDelete;
  const stored = await storedSecret(topology.observerPool, topology.agent.namespaceId, secret.id);
  // An unbound Secret can be removed through OCC; the real driver must delete its exact backend.
  const deleted = await topology.request(
    "DELETE",
    `/namespaces/${topology.agent.namespaceId}/secrets/${secret.id}`,
  );
  assertNoSecretMaterial(deleted, [value], "Secret deletion must return no material");
  assert.equal(deleted.status, 204);
  const read = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/secrets/${secret.id}`,
  );
  assert.equal(read.status, 404);
  await assert.rejects(
    () =>
      kubectl(
        "get",
        "secret",
        stored.backendRef.name,
        "--namespace",
        topology.placement,
        "-o",
        "name",
      ),
    (error) => /NotFound/.test(error.stderr ?? ""),
  );
  context.diagnostic(
    "secret-api deletion: unbound OCC metadata and exact Kubernetes backend removed",
  );
}

async function assertSecretApiRotationAndRedeploy(context, topology) {
  const { model, probe, initialProbeValue } = topology.secretApi;
  const [modelStorage, probeStorage] = await Promise.all([
    storedSecret(topology.observerPool, topology.agent.namespaceId, model.id),
    storedSecret(topology.observerPool, topology.agent.namespaceId, probe.id),
  ]);
  assert.equal(Object.hasOwn(modelStorage, "agentId"), false);
  assert.equal(Object.hasOwn(probeStorage, "agentId"), false);

  const modelProjection = topology.gatewayPod.spec.containers[0].env.find(
    ({ name }) => name === "OPENAI_API_KEY",
  );
  assert.deepEqual(modelProjection.valueFrom.secretKeyRef, {
    name: modelStorage.backendRef.name,
    key: modelStorage.backendRef.key,
    optional: false,
  });
  assert.notEqual(modelStorage.backendRef.name, `${modelPrefix}-${hash(topology.agent.id)}`);
  await assertNoLegacyModelSecret(topology);

  const initialProbe = await inspectEnvironmentValue(
    topology.placement,
    topology.gatewayPod.metadata.name,
    secretRotationProbe,
    initialProbeValue,
  );
  assert.deepEqual(initialProbe, { present: true, matches: true });

  const rotatedProbeValue = `secret-rotation-rotated-${randomUUID()}`;
  const beforePodUid = topology.gatewayPod.metadata.uid;
  const beforeRevisions = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/revisions`,
  );
  assert.equal(beforeRevisions.status, 200, JSON.stringify(beforeRevisions.error));
  await updateApiSecret(topology.request, topology.agent.namespaceId, probe, rotatedProbeValue);
  const afterAgent = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`,
  );
  assert.equal(afterAgent.status, 200, JSON.stringify(afterAgent.error));
  assert.equal(afterAgent.data.activeRevisionId, topology.revision.id);
  const samePod = await resource("pod", topology.gatewayPod.metadata.name, topology.placement);
  assert.equal(samePod.metadata.uid, beforePodUid);
  const afterRevisions = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/revisions`,
  );
  assert.equal(afterRevisions.status, 200, JSON.stringify(afterRevisions.error));
  assert.deepEqual(
    afterRevisions.data.map(({ id }) => id),
    beforeRevisions.data.map(({ id }) => id),
    "Secret update must not admit a new revision or restart the running gateway",
  );
  assert.deepEqual(
    await inspectEnvironmentValue(
      topology.placement,
      topology.gatewayPod.metadata.name,
      secretRotationProbe,
      initialProbeValue,
    ),
    { present: true, matches: true },
  );
  assert.deepEqual(
    await inspectEnvironmentValue(
      topology.placement,
      topology.gatewayPod.metadata.name,
      secretRotationProbe,
      rotatedProbeValue,
    ),
    { present: true, matches: false },
  );

  // Deleting only this task-owned Pod proves an already-admitted revision restarts with the latest Secret.
  await kubectl(
    "delete",
    "pod",
    topology.gatewayPod.metadata.name,
    "--namespace",
    topology.placement,
    "--wait=true",
    "--timeout=120s",
  );
  topology.gatewayPod = await waitForReadyGatewayPod(topology, topology.revision.id, beforePodUid);
  assert.deepEqual(
    await inspectEnvironmentValue(
      topology.placement,
      topology.gatewayPod.metadata.name,
      secretRotationProbe,
      rotatedProbeValue,
    ),
    { present: true, matches: true },
  );

  const secondRevision = await deployEmbeddedAgentAndWait(
    topology,
    topology.agent.id,
    "Secret-backed embedded redeploy",
    {
      previousUid: topology.gatewayPod.metadata.uid,
      protectedValues: secretApiProtectedValues(topology, [rotatedProbeValue]),
    },
  );
  assert.notEqual(secondRevision.revision.id, topology.revision.id);
  topology.gatewayPod = secondRevision.gatewayPod;
  topology.revision = secondRevision.revision;
  assert.deepEqual(
    await inspectEnvironmentValue(
      topology.placement,
      topology.gatewayPod.metadata.name,
      secretRotationProbe,
      rotatedProbeValue,
    ),
    { present: true, matches: true },
  );
  await assertSecretApiNoLeakage(topology, [
    process.env.OPENAI_API_KEY,
    initialProbeValue,
    rotatedProbeValue,
  ]);
  const deleteBound = await expectApiFailureWithoutSecret(
    topology.request,
    "DELETE",
    `/namespaces/${topology.agent.namespaceId}/secrets/${probe.id}`,
    undefined,
    [process.env.OPENAI_API_KEY, rotatedProbeValue],
    "bound Secret delete",
  );
  assert.equal(deleteBound.status, 409);
  context.diagnostic(
    `secret-api rotation: stable ref ${probe.ref.id}; same-revision restart and explicit deploy consumed latest value`,
  );
}

async function assertNativeReferenceNegativeControl(context, topology) {
  const invalidModelEnv = "SECRET_API_DISABLED_OPENAI_KEY";
  const invalidConfiguration = await topology.request(
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/configurations/${topology.agent.configurationId}`,
    {
      values: nativeConfiguration("openclaw", undefined, { modelEnvName: invalidModelEnv }),
      secretBindings: topology.secretApi.configuration.secretBindings,
    },
  );
  assertNoSecretMaterial(
    invalidConfiguration,
    [process.env.OPENAI_API_KEY, topology.secretApi.initialProbeValue],
    "invalid native-ref configuration response must not leak secret material",
  );
  assert.equal(
    invalidConfiguration.status,
    200,
    `native-ref Configuration was rejected before native OpenClaw resolution (${invalidConfiguration.error?.code ?? "unknown"})`,
  );

  const deniedRevision = await topology.request(
    "POST",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/deploy`,
  );
  assertNoSecretMaterial(
    deniedRevision,
    [process.env.OPENAI_API_KEY, topology.secretApi.initialProbeValue],
    "invalid native-ref deploy response must not leak secret material",
  );
  assert.equal(
    deniedRevision.status,
    202,
    `native-ref deploy was rejected before native OpenClaw resolution (${deniedRevision.error?.code ?? "unknown"})`,
  );
  const outcome = await waitFor(
    `invalid native-ref revision ${deniedRevision.data.id} to reach native OpenClaw`,
    async () => {
      const gateway = (await resources("pods", topology.placement)).find(
        (pod) =>
          pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
          pod.metadata.labels?.["openclaw.dev/agent"] === topology.agent.id &&
          gatewayConsumesRevision(pod, topology.agent.id, deniedRevision.data.id),
      );
      if (gateway !== undefined) {
        const ready = gateway.status.conditions?.some(
          ({ type, status }) => type === "Ready" && status === "True",
        );
        if (ready) return { kind: "gateway", gateway };
        const status = gateway.status.containerStatuses?.[0];
        const waiting = status?.state?.waiting;
        const terminated = status?.state?.terminated ?? status?.lastState?.terminated;
        if (
          waiting?.reason === "CrashLoopBackOff" ||
          waiting?.reason === "Error" ||
          terminated !== undefined
        ) {
          return {
            kind: "startup",
            gateway,
            reason: waiting?.reason ?? terminated?.reason ?? "terminated",
          };
        }
      }
      const completion = topology.events.find(
        (event) =>
          event.event === "worker.completed" && event.revisionId === deniedRevision.data.id,
      );
      if (completion?.outcome === "permanent") return { kind: "worker", completion };
      return undefined;
    },
    90_000,
  );

  if (outcome.kind === "worker") {
    assert.fail(
      `native-ref negative failed before native OpenClaw consumer (${outcome.completion.outcome}/${outcome.completion.code})`,
    );
  }
  await assertOpenAiKeyProjectedFromSecret(topology, outcome.gateway);
  if (outcome.kind === "startup") {
    assert.equal(
      await nativeFailureEvidence(
        topology.placement,
        outcome.gateway.metadata.name,
        invalidModelEnv,
      ),
      true,
      "native startup failure must identify the invalid native env SecretRef without logging secret bytes",
    );
    context.diagnostic(
      `native-ref negative: gateway startup failed with ${outcome.reason} and a native SecretRef resolution error for ${invalidModelEnv}`,
    );
  } else {
    topology.gatewayUrl = await topology.refreshGatewayUrl();
    const projected = await inspectEnvironmentValue(
      topology.placement,
      outcome.gateway.metadata.name,
      "OPENAI_API_KEY",
      process.env.OPENAI_API_KEY,
    );
    assert.deepEqual(
      projected,
      { present: true, matches: true },
      "the valid Secret-backed OPENAI_API_KEY must remain projected for the invalid-native-ref control",
    );
    const response = await fetch(`${topology.gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${topology.gatewayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openclaw/default",
        stream: false,
        messages: [{ role: "user", content: "Reply with only: should-not-succeed" }],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = await response.text();
    assertNoSecretMaterial(
      body,
      [process.env.OPENAI_API_KEY],
      "Native resolution response must not expose the model key",
    );
    assert.notEqual(
      response.status,
      200,
      "invalid native provider env reference unexpectedly reached a successful model turn",
    );
    assert.equal(
      body.includes(invalidModelEnv) &&
        /SECRET_REF_(?:NOT_FOUND|POLICY_DENIED)|missing or empty|not allowlisted/.test(body),
      true,
      "native turn failure must identify the invalid native env SecretRef without logging secret bytes",
    );
    context.diagnostic(
      `native-ref negative: gateway reached, chat failed with HTTP ${response.status}`,
    );
  }

  const restored = await topology.request(
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/configurations/${topology.agent.configurationId}`,
    {
      values: nativeConfiguration("openclaw"),
      secretBindings: topology.secretApi.configuration.secretBindings,
    },
  );
  assert.equal(restored.status, 200, JSON.stringify(restored.error));
  const recovered = await topology.request(
    "POST",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/deploy`,
  );
  assert.equal(recovered.status, 202, JSON.stringify(recovered.error));
  await waitFor(`restored native-ref revision ${recovered.data.id} activation`, async () => {
    const observation = await topology.request(
      "GET",
      `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`,
    );
    assert.equal(observation.status, 200);
    return observation.data.activeRevisionId === recovered.data.id ? observation.data : undefined;
  });
  await waitFor(`worker completion of restored revision ${recovered.data.id}`, () =>
    topology.events.find(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === recovered.data.id &&
        event.outcome === "success",
    ),
  );
  topology.gatewayPod = await waitForReadyGatewayPod(
    topology,
    recovered.data.id,
    topology.gatewayPod.metadata.uid,
  );
  topology.revision = recovered.data;
  await assertActualModelTurn(topology);
}

async function assertDedicatedModelSecretBindingDenied(topology) {
  const value = `dedicated-denied-secret-${randomUUID()}`;
  const secret = await createApiSecret(
    topology.request,
    topology.agent.namespaceId,
    "dedicated-model-denied",
    value,
  );
  await grantSecretOperate(
    topology.observerPool,
    topology.agent.namespaceId,
    topology.persistedAgent.servicePrincipalId,
    secret.id,
  );
  const revisionsBefore = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/revisions`,
  );
  assert.equal(revisionsBefore.status, 200, JSON.stringify(revisionsBefore.error));
  const bound = await topology.request(
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/configurations/${topology.agent.configurationId}`,
    {
      values: nativeConfiguration("codex"),
      secretBindings: { OPENAI_API_KEY: secretBinding(secret.ref) },
    },
  );
  assert.equal(bound.status, 200, JSON.stringify(bound.error));
  const denied = await expectApiFailureWithoutSecret(
    topology.request,
    "POST",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/deploy`,
    undefined,
    [value, process.env.OPENAI_API_KEY],
    "dedicated Codex model Secret binding",
  );
  assert.equal(denied.status, 404, `unexpected dedicated denial ${denied.status}`);
  const revisionsAfter = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/revisions`,
  );
  assert.equal(revisionsAfter.status, 200, JSON.stringify(revisionsAfter.error));
  assert.deepEqual(
    revisionsAfter.data.map(({ id }) => id),
    revisionsBefore.data.map(({ id }) => id),
    "dedicated model Secret binding denial must happen before revision mutation",
  );
  const gateway = await resource("pod", topology.gatewayPod.metadata.name, topology.placement);
  const harness = await resource("pod", topology.harnessPod.metadata.name, topology.placement);
  assert.equal(gateway.metadata.uid, topology.gatewayPod.metadata.uid);
  assert.equal(harness.metadata.uid, topology.harnessPod.metadata.uid);
}

async function assertDedicatedSharedWorkspaceRuntime(context, topology, claim, privateClaim) {
  const nonce = `shared-${randomUUID()}`;
  const gatewayPod = topology.gatewayPod.metadata.name;
  let harnessPod = topology.harnessPod.metadata.name;
  const workspaceFromGateway = `/home/node/workspace/gateway-${nonce}.txt`;
  const workspaceFromHarness = `/home/node/workspace/harness-${nonce}.txt`;
  for (const probe of [
    {
      writerPod: gatewayPod,
      readerPod: harnessPod,
      writerPath: workspaceFromGateway,
      content: `gateway:${nonce}`,
    },
    {
      writerPod: harnessPod,
      readerPod: gatewayPod,
      writerPath: workspaceFromHarness,
      content: `harness:${nonce}`,
    },
    {
      writerPod: gatewayPod,
      readerPod: harnessPod,
      writerPath: `/home/node/.openclaw/agents/main/sessions/gateway-${nonce}.json`,
      content: JSON.stringify({ nonce }),
    },
    {
      writerPod: harnessPod,
      readerPod: gatewayPod,
      writerPath: `/home/node/.codex/generated_images/codex-${nonce}.png`,
      readerPath: `/home/node/.openclaw/codex-artifacts/generated_images/codex-${nonce}.png`,
      content: `image:${nonce}`,
    },
  ]) {
    await assertSharedText(topology.placement, probe);
  }
  for (const [pod, file] of [
    [harnessPod, `/home/node/.openclaw/agents/main/sessions/harness-denied-${nonce}.json`],
    [
      gatewayPod,
      `/home/node/.openclaw/codex-artifacts/generated_images/gateway-denied-${nonce}.png`,
    ],
  ]) {
    await assertWriteDenied(topology.placement, pod, file);
  }

  assert.notEqual(
    await execNode(
      topology.placement,
      harnessPod,
      'process.stdout.write(String(require("node:fs").readdirSync("/home/node/openclaw-runtime-assets/bundled-skills").length))',
    ),
    "0",
    "Codex must see image-published bundled skills before runtime marker writes",
  );
  for (const [name, content] of [
    ["/home/node/openclaw-runtime-assets/bundled-skills", `bundled:${nonce}`],
    ["/home/node/openclaw-runtime-assets/plugin-skills", `plugin:${nonce}`],
  ]) {
    await assertSharedText(topology.placement, {
      writerPod: gatewayPod,
      readerPod: harnessPod,
      writerPath: `${name}/gateway-${nonce}.txt`,
      content,
    });
    await assertWriteDenied(topology.placement, harnessPod, `${name}/harness-denied-${nonce}.txt`);
  }

  const [harnessPrivate, gatewayPrivate] = await Promise.all([
    execNode(
      topology.placement,
      harnessPod,
      'process.stdout.write(String(require("node:fs").existsSync("/home/node/.openclaw/openclaw.json")))',
    ),
    execNode(
      topology.placement,
      gatewayPod,
      'const fs=require("node:fs");process.stdout.write(JSON.stringify({auth:fs.existsSync("/home/node/.codex/auth.json"),config:fs.existsSync("/home/node/.codex/config.toml")}))',
    ),
  ]);
  assert.equal(harnessPrivate, "false", "Codex must not see private gateway state");
  assert.deepEqual(JSON.parse(gatewayPrivate), { auth: false, config: false });

  await kubectl(
    "delete",
    "pod",
    harnessPod,
    "--namespace",
    topology.placement,
    "--wait=true",
    "--timeout=120s",
  );
  const restartedHarness = await waitForReadyAgentPod(
    topology,
    topology.revision.id,
    topology.harnessPod.metadata.uid,
  );
  harnessPod = restartedHarness.metadata.name;
  assert.equal(
    await readFileInPod(topology.placement, harnessPod, workspaceFromGateway),
    `gateway:${nonce}`,
  );

  const secondRevision = await topology.request(
    "POST",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/deploy`,
  );
  assert.equal(secondRevision.status, 202, JSON.stringify(secondRevision.error));
  assert.notEqual(secondRevision.data.id, topology.revision.id);
  await waitFor(`second dedicated revision ${secondRevision.data.id} activation`, async () => {
    const observation = await topology.request(
      "GET",
      `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`,
    );
    assert.equal(observation.status, 200);
    return observation.data.activeRevisionId === secondRevision.data.id
      ? observation.data
      : undefined;
  });
  await waitFor(`worker completion of second dedicated revision ${secondRevision.data.id}`, () =>
    topology.events.find(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === secondRevision.data.id &&
        event.outcome === "success",
    ),
  );
  const preservedClaim = await resource(
    "persistentvolumeclaim",
    claim.metadata.name,
    topology.placement,
  );
  assert.equal(
    preservedClaim.metadata.uid,
    claim.metadata.uid,
    "Agent revisions must reuse the same PVC",
  );
  assert.equal(
    (await resource("persistentvolumeclaim", privateClaim.metadata.name, topology.placement))
      .metadata.uid,
    privateClaim.metadata.uid,
    "replacing an Agent revision must preserve the exact gateway-private claim",
  );
  const nextHarness = await waitForReadyAgentPod(
    topology,
    secondRevision.data.id,
    restartedHarness.metadata.uid,
  );
  assert.equal(
    await readFileInPod(topology.placement, nextHarness.metadata.name, workspaceFromHarness),
    `harness:${nonce}`,
  );
  context.diagnostic(
    `dedicated shared workspace PVC persisted across restart and revision: ${claim.metadata.name}`,
  );
}

test(
  "OCC gateway administration preserves key-only enrollment after token persistence RBAC failure",
  { ...requiresProductionCluster, timeout: 720_000 },
  async (context) => {
    const topology = await arrangeProductionTopology(context, "dedicated", undefined, {
      gatewayAdministration: true,
      gatewayAdministrationCredentialCreate: false,
      gatewayAdministrationCredentialUpdate: false,
      expectGatewayAdministrationEnrollmentFailure: true,
      nativeConfiguration: { autoApproveLocal: false, gatewayAdministration: true },
    });
    topology.browserRequest = await createAuthenticatedControllerRequestWithHeaders(
      topology.productionApp,
      topology.credentials,
    );

    const unrelated = await createUnrelatedPendingGatewayPairing(topology);
    await grantGatewayAdministrationCredentialCreate(topology);
    const keyOnly = await waitForGatewayAdministrationKeyOnlyCredential(topology);
    // Earlier readiness deferrals may race the RBAC grant. Observe a worker
    // completion after the key exists, so native approval has actually finished.
    const pendingEventsAtKeyOnly = topology.events.filter(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === topology.revision.id &&
        event.outcome === "pending" &&
        event.code === "REVISION_INCOMPLETE",
    ).length;
    await waitFor(`gateway-admin key-only incomplete enrollment ${topology.revision.id}`, () => {
      const pendingEvents = topology.events.filter(
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === topology.revision.id &&
          event.outcome === "pending" &&
          event.code === "REVISION_INCOMPLETE",
      ).length;
      return pendingEvents > pendingEventsAtKeyOnly ? pendingEvents : undefined;
    });
    await assertUnrelatedPendingGatewayPairing(topology, unrelated.identity);
    assert.ok(
      keyOnly.identity.deviceId,
      "partial enrollment must derive the exact native device id",
    );
    assert.ok(
      keyOnly.identity.privateKeyPem,
      "partial enrollment must persist the exact native device private key",
    );
    assert.equal(
      keyOnly.state,
      "keyOnly",
      "token persistence RBAC denial must leave only the pre-approved native device identity",
    );
    // A key-only record alone could mean enrollment failed before approval. Prove
    // the native grant exists so this actually exercises the persistence gap.
    const pairing = await gatewayCall(topology, "device.pair.list", {});
    const approvedDevice = pairing.paired.find(
      (device) => device.deviceId === keyOnly.identity.deviceId,
    );
    assert.ok(approvedDevice, "native approval must complete before the token write fails");
    assert.ok(
      approvedDevice.tokens.some(
        (token) =>
          token.role === "operator" &&
          token.scopes.includes("operator.admin") &&
          token.revokedAtMs === undefined,
      ),
      "the native gateway must retain the issued admin grant despite failed OCC persistence",
    );
    context.diagnostic(
      `gateway-admin partial enrollment target namespace=${topology.placement} namespaceId=${topology.agent.namespaceId} agentId=${topology.agent.id} revisionId=${topology.revision.id} credentialSecret=${topology.gatewayAdministrationRbac.credential} gatewayPod=${topology.gatewayPod.metadata.name} deviceId=${keyOnly.identity.deviceId}`,
    );

    const unavailable = await dispatchOccGatewayCommand(topology, "status", undefined, {
      secrets: [
        process.env.OPENAI_API_KEY,
        topology.gatewayToken,
        ...gatewayAdministrationSecretMaterial(keyOnly),
      ],
    });
    assert.equal(unavailable.status, 503);

    await grantGatewayAdministrationCredentialUpdate(topology);
    // A fresh worker and Driver instance has no captured token or enrollment
    // memory. Durable key-only state must still prohibit another approval.
    await topology.restartProductionWorker();
    const pendingEventsBeforeRetry = topology.events.filter(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === topology.revision.id &&
        event.outcome === "pending" &&
        event.code === "REVISION_INCOMPLETE",
    ).length;
    await waitFor(`gateway-admin key-only retry remains incomplete ${topology.revision.id}`, () => {
      const pendingEvents = topology.events.filter(
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === topology.revision.id &&
          event.outcome === "pending" &&
          event.code === "REVISION_INCOMPLETE",
      ).length;
      return pendingEvents > pendingEventsBeforeRetry ? pendingEvents : undefined;
    });
    await assertUnrelatedPendingGatewayPairing(topology, unrelated.identity);

    const afterRetry = gatewayAdministrationCredentialFromDecodedSecret(
      await readGatewayAdministrationCredentialSecret(topology),
    );
    assert.equal(
      afterRetry.identity.deviceId,
      keyOnly.identity.deviceId,
      "retry after restoring update RBAC must keep the original native device identity",
    );
    assert.equal(
      afterRetry.state,
      "keyOnly",
      "retry after restoring update RBAC must not re-run helper enrollment for key-only state",
    );
    const agentAfterRetry = await topology.request(
      "GET",
      `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`,
    );
    assert.equal(agentAfterRetry.status, 200);
    assert.notEqual(
      agentAfterRetry.data.activeRevisionId,
      topology.revision.id,
      "partial enrollment must not activate the revision after retry",
    );
    const stillUnavailable = await dispatchOccGatewayCommand(topology, "status", undefined, {
      secrets: [
        process.env.OPENAI_API_KEY,
        topology.gatewayToken,
        ...gatewayAdministrationSecretMaterial(afterRetry),
      ],
    });
    assert.equal(stillUnavailable.status, 503);
  },
);

test(
  "OCC gateway administration dispatches real Kubernetes gateway commands through the active Agent HTTP route",
  { ...requiresProductionCluster, timeout: 1_200_000 },
  async (context) => {
    const topology = await arrangeProductionTopology(context, "dedicated", undefined, {
      gatewayAdministration: true,
      nativeConfiguration: { autoApproveLocal: false, gatewayAdministration: true },
    });
    assert.ok(topology.harnessPod, "gateway administration coverage uses dedicated Codex topology");
    topology.browserRequest = await createAuthenticatedControllerRequestWithHeaders(
      topology.productionApp,
      topology.credentials,
    );
    await assertGatewayAdministrationRbacDenials(topology);
    const credential = await readGatewayAdministrationCredential(topology);

    const status = assertOccGatewaySuccess(
      await dispatchOccGatewayCommand(topology, "status"),
      "status",
    );
    assert.equal(typeof status, "object", "native status must return a real payload");
    // Exercise every approved read method against the real native gateway,
    // so the allowlist stays tied to the supported runtime contract.
    for (const [method, params] of [
      ["health", {}],
      ["config.get", {}],
      ["config.schema.lookup", { path: "gateway.bind" }],
      ["agents.list", {}],
      ["channels.status", { probe: false }],
      ["agents.files.list", { agentId: "main" }],
    ]) {
      const payload = assertOccGatewaySuccess(
        await dispatchOccGatewayCommand(topology, method, params),
        method,
      );
      assert.equal(typeof payload, "object", `${method} must return its native payload`);
    }

    await runGatewayAdministrationFailureProofs(topology, {
      dispatchOccGatewayCommand,
      assertOccGatewaySuccess,
      readGatewayAdministrationCredentialSecret,
      gatewayCall,
      diagnostic: (message) => context.diagnostic(message),
    });

    // Recompose the production API from the same PostgreSQL/Kubernetes state;
    // established native access must not depend on an API process's memory.
    Object.assign(topology, await topology.restartProductionApp());
    topology.browserRequest = await createAuthenticatedControllerRequestWithHeaders(
      topology.productionApp,
      topology.credentials,
    );
    assert.equal(
      (await readGatewayAdministrationCredential(topology)).identity.deviceId,
      credential.identity.deviceId,
    );
    assertOccGatewaySuccess(await dispatchOccGatewayCommand(topology, "status"), "status");

    // A ready endpoint is insufficient when its Pod claims another revision.
    // Changing only this annotation preserves the live process and endpoint,
    // so the denial specifically exercises OCC's owned-Pod selection.
    await kubectl(
      "annotate",
      "pod",
      topology.gatewayPod.metadata.name,
      "--namespace",
      topology.placement,
      `openclaw.dev/agent-revision-id=rev_${randomUUID()}`,
      "--overwrite",
    );
    try {
      const wrongPod = await dispatchOccGatewayCommand(topology, "status");
      assert.equal(wrongPod.status, 503);
    } finally {
      await kubectl(
        "annotate",
        "pod",
        topology.gatewayPod.metadata.name,
        "--namespace",
        topology.placement,
        `openclaw.dev/agent-revision-id=${topology.revision.id}`,
        "--overwrite",
      );
    }
    assertOccGatewaySuccess(await dispatchOccGatewayCommand(topology, "status"), "status");

    const fileName = "USER.md";
    const fileContent = `OCC gateway administration file proof ${randomUUID()}\n`;
    const write = assertOccGatewaySuccess(
      await dispatchOccGatewayCommand(topology, "agents.files.set", {
        agentId: "main",
        name: fileName,
        content: fileContent,
      }),
      "agents.files.set",
    );
    assert.equal(write.file.name, fileName);
    assert.equal(write.file.content, fileContent);
    const read = assertOccGatewaySuccess(
      await dispatchOccGatewayCommand(topology, "agents.files.get", {
        agentId: "main",
        name: fileName,
      }),
      "agents.files.get",
    );
    assert.equal(read.file.name, fileName);
    assert.equal(read.file.content, fileContent);

    const nativeRejection = await dispatchOccGatewayCommand(topology, "agents.files.set", {
      agentId: "main",
      name: `invalid-${randomUUID()}.txt`,
    });
    assert.equal(nativeRejection.status, 200, JSON.stringify(nativeRejection.error));
    assert.equal(nativeRejection.data.method, "agents.files.set");
    assert.equal(nativeRejection.data.ok, false);
    assert.equal(typeof nativeRejection.data.error.code, "string");
    assert.equal(typeof nativeRejection.data.error.message, "string");

    const sessionKey = `agent:main:occ-gateway-admin-${randomUUID()}`;
    const nonce = `OCC-GATEWAY-ADMIN-${randomUUID()}`;
    const send = assertOccGatewaySuccess(
      await dispatchOccGatewayCommand(topology, "chat.send", {
        sessionKey,
        idempotencyKey: randomUUID(),
        message: `Reply with exactly ${nonce}. Do not use tools.`,
      }),
      "chat.send",
    );
    assert.ok(
      JSON.stringify(send).includes("accepted") || JSON.stringify(send).includes("run"),
      "chat.send must return the native first response rather than waiting for completion",
    );
    await assertOccConversation(topology, sessionKey, nonce);
    // Aborting an already completed run is a safe native no-op; its result
    // still proves the admitted abort method reaches the owned gateway.
    const abort = assertOccGatewaySuccess(
      await dispatchOccGatewayCommand(topology, "chat.abort", { sessionKey }),
      "chat.abort",
    );
    assert.equal(abort.aborted, false);

    const pathname = gatewayAdministrationPath(topology);
    const serviceKeyRequest = async (key, body, options = {}) => {
      const response = await topology.productionApp.inject({
        method: "POST",
        url: options.path ?? pathname,
        headers: {
          host: "127.0.0.1",
          "x-api-key": key,
          ...(options.headers ?? {}),
        },
        payload: body,
        remoteAddress: "127.0.0.1",
      });
      const parsed = {
        status: response.statusCode,
        ...(response.body.length === 0 ? {} : response.json()),
      };
      assertNoSecretMaterial(
        parsed,
        options.secrets ?? [process.env.OPENAI_API_KEY, topology.gatewayToken],
        "service API-key gateway response must not expose credentials",
      );
      return parsed;
    };
    const missingOrigin = await topology.browserRequest("POST", pathname, { method: "status" });
    assert.equal(missingOrigin.status, 403);
    const wrongOrigin = await topology.browserRequest(
      "POST",
      pathname,
      { method: "status" },
      { headers: { origin: "http://attacker.example" } },
    );
    assert.equal(wrongOrigin.status, 403);
    const extraBody = await dispatchOccGatewayCommand(topology, "status", undefined, {
      extraBody: { targetUrl: "ws://127.0.0.1:1" },
    });
    assert.equal(extraBody.status, 400);
    const unsupportedMethod = await dispatchOccGatewayCommand(topology, "config.patch", {});
    assert.equal(unsupportedMethod.status, 400);

    const inactive = await topology.browserRequest(
      "POST",
      `/namespaces/${topology.agent.namespaceId}/agents`,
      {
        name: `inactive-gateway-admin-${randomUUID()}`,
        configurationId: topology.agent.configurationId,
        executionMode: "dedicated",
        ...(topology.agent.serviceAccountId === undefined
          ? {}
          : { serviceAccountId: topology.agent.serviceAccountId }),
      },
      { headers: { origin: authBaseURL } },
    );
    assert.equal(inactive.status, 201, JSON.stringify(inactive.error));
    const inactiveGateway = await dispatchOccGatewayCommand(topology, "status", undefined, {
      path: gatewayAdministrationPath(topology, inactive.data),
    });
    assert.equal(inactiveGateway.status, 503);

    const readerRequest = await createGatewayReaderCallerRequest({
      pool: topology.observerPool,
      productionApp: topology.productionApp,
      installation: topology.installation,
      namespaceId: topology.agent.namespaceId,
    });
    const forbidden = await dispatchOccGatewayCommand(topology, "status", undefined, {
      request: readerRequest.request,
    });
    assert.equal(forbidden.status, 403);
    const operateOnly = await createGatewayReaderCallerRequest({
      pool: topology.observerPool,
      productionApp: topology.productionApp,
      installation: topology.installation,
      namespaceId: topology.agent.namespaceId,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "operate", resourceKind: "agent" },
      ],
      roleName: "Gateway operate without administration",
      resourceKind: "agent",
      resourceId: topology.agent.id,
    });
    const operateForbidden = await dispatchOccGatewayCommand(topology, "status", undefined, {
      request: operateOnly.request,
    });
    assert.equal(operateForbidden.status, 403);

    // API-key callers skip browser CSRF but still use exact IAM and admitted Namespace scope.
    const serviceApi = await createGatewayReaderCallerRequest({
      pool: topology.observerPool,
      productionApp: topology.productionApp,
      installation: topology.installation,
      namespaceId: topology.agent.namespaceId,
      kind: "service_principal",
      createServiceKey: true,
      permissions: [{ action: "administer", resourceKind: "agent" }],
      roleName: "Gateway service API exact Agent administrator",
      resourceKind: "agent",
      resourceId: topology.agent.id,
    });
    assertOccGatewaySuccess(
      await serviceKeyRequest(serviceApi.serviceKey.key, { method: "status" }),
      "status",
    );
    const invalidApiKey = await topology.browserRequest(
      "POST",
      pathname,
      { method: "status" },
      { headers: { "x-api-key": `invalid-${randomUUID()}`, origin: authBaseURL } },
    );
    assert.equal(
      invalidApiKey.status,
      401,
      "invalid service API key must not fall through to the human session",
    );
    const otherNamespace = await topology.request("POST", "/namespaces", {
      name: `gateway-cross-namespace-${randomUUID()}`,
    });
    assert.equal(otherNamespace.status, 201, JSON.stringify(otherNamespace.error));
    const crossNamespaceApi = await createGatewayReaderCallerRequest({
      pool: topology.observerPool,
      productionApp: topology.productionApp,
      installation: topology.installation,
      namespaceId: otherNamespace.data.id,
      kind: "service_principal",
      createServiceKey: true,
      permissions: [{ action: "administer", resourceKind: "agent" }],
      roleName: "Cross-Namespace gateway service API administrator",
      // Grant administration inside the caller's own Namespace. A binding
      // directly naming a foreign Agent is invalid at the database boundary.
    });
    const crossNamespaceForbidden = await serviceKeyRequest(crossNamespaceApi.serviceKey.key, {
      method: "status",
    });
    assert.equal(crossNamespaceForbidden.status, 403);
    const foreignAgentApi = await createGatewayReaderCallerRequest({
      pool: topology.observerPool,
      productionApp: topology.productionApp,
      installation: topology.installation,
      namespaceId: topology.agent.namespaceId,
      kind: "service_principal",
      createServiceKey: true,
      permissions: [{ action: "administer", resourceKind: "agent" }],
      roleName: "Foreign-Agent gateway service API administrator",
      resourceKind: "agent",
      resourceId: inactive.data.id,
    });
    const foreignAgentForbidden = await serviceKeyRequest(foreignAgentApi.serviceKey.key, {
      method: "status",
    });
    assert.equal(foreignAgentForbidden.status, 403);
    const agentPrincipalApi = await createGatewayReaderCallerRequest({
      pool: topology.observerPool,
      productionApp: topology.productionApp,
      installation: topology.installation,
      namespaceId: topology.agent.namespaceId,
      agentId: topology.agent.id,
      // The public Agent response intentionally omits its workload principal.
      servicePrincipalId: topology.persistedAgent.servicePrincipalId,
      kind: "service_principal",
      createServiceKey: true,
      insertIdentity: false,
      permissions: [{ action: "administer", resourceKind: "agent" }],
      roleName: "Agent-owned gateway service principal administrator",
      resourceKind: "agent",
      resourceId: topology.agent.id,
    });
    const agentPrincipalForbidden = await serviceKeyRequest(agentPrincipalApi.serviceKey.key, {
      method: "status",
    });
    assert.equal(agentPrincipalForbidden.status, 403);

    const beforeGatewayUid = topology.gatewayPod.metadata.uid;
    await kubectl(
      "delete",
      "pod",
      topology.gatewayPod.metadata.name,
      "--namespace",
      topology.placement,
      "--wait=true",
      "--timeout=120s",
    );
    topology.gatewayPod = await waitForReadyGatewayPod(
      topology,
      topology.revision.id,
      beforeGatewayUid,
    );
    assert.equal(
      (await readGatewayAdministrationCredential(topology)).identity.deviceId,
      credential.identity.deviceId,
      "gateway Pod replacement must preserve the OCC native device identity",
    );
    assertOccGatewaySuccess(await dispatchOccGatewayCommand(topology, "status"), "status");

    const secondRevision = await topology.request(
      "POST",
      `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/deploy`,
    );
    assert.equal(secondRevision.status, 202, JSON.stringify(secondRevision.error));
    assert.notEqual(secondRevision.data.id, topology.revision.id);
    await waitFor(`gateway-admin revision ${secondRevision.data.id} activation`, async () => {
      const observation = await topology.request(
        "GET",
        `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`,
      );
      assert.equal(observation.status, 200);
      return observation.data.activeRevisionId === secondRevision.data.id
        ? observation.data
        : undefined;
    });
    await waitFor(`gateway-admin worker completion of ${secondRevision.data.id}`, () =>
      topology.events.find(
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === secondRevision.data.id &&
          event.outcome === "success",
      ),
    );
    topology.gatewayPod = await waitForReadyGatewayPod(
      topology,
      secondRevision.data.id,
      topology.gatewayPod.metadata.uid,
    );
    topology.revision = secondRevision.data;
    assert.equal(
      (await readGatewayAdministrationCredential(topology)).identity.deviceId,
      credential.identity.deviceId,
      "revision replacement must preserve the OCC native device identity",
    );
    assertOccGatewaySuccess(await dispatchOccGatewayCommand(topology, "status"), "status");

    const auditRows = await assertGatewayAuditSanitized(topology, [
      process.env.OPENAI_API_KEY,
      topology.gatewayToken,
      fileContent,
      ...gatewayAdministrationSecretMaterial(credential),
    ]);
    assert.ok(
      auditRows.some((row) => JSON.parse(row.details).nativeMethod === "chat.send"),
      "audit evidence must identify the admitted native method without native arguments",
    );

    await revokeGatewayAdministrationCredential(topology, credential);
    const revokedCredential = await dispatchOccGatewayCommand(topology, "status", undefined, {
      secrets: [
        process.env.OPENAI_API_KEY,
        topology.gatewayToken,
        ...gatewayAdministrationSecretMaterial(credential),
      ],
    });
    assert.equal(revokedCredential.status, 503);

    const revokedGatewayUid = topology.gatewayPod.metadata.uid;
    await kubectl(
      "delete",
      "pod",
      topology.gatewayPod.metadata.name,
      "--namespace",
      topology.placement,
      "--wait=true",
      "--timeout=120s",
    );
    topology.gatewayPod = await waitForReadyGatewayPod(
      topology,
      topology.revision.id,
      revokedGatewayUid,
    );
    const stillRevokedAfterRestart = await dispatchOccGatewayCommand(
      topology,
      "status",
      undefined,
      {
        secrets: [
          process.env.OPENAI_API_KEY,
          topology.gatewayToken,
          ...gatewayAdministrationSecretMaterial(credential),
        ],
      },
    );
    assert.equal(stillRevokedAfterRestart.status, 503);

    const afterRevokeRevision = await topology.request(
      "POST",
      `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/deploy`,
    );
    assert.equal(afterRevokeRevision.status, 202, JSON.stringify(afterRevokeRevision.error));
    // Preparation preserves the current ready gateway until activation. A
    // revoked device must block that preparation without replacing the Pod.
    const gatewayBeforeRevokedDeploy = topology.gatewayPod.metadata.uid;
    topology.gatewayPod = await waitForReadyGatewayPod(topology, topology.revision.id);
    assert.equal(topology.gatewayPod.metadata.uid, gatewayBeforeRevokedDeploy);
    const revokedAttemptsBeforeReady = topology.events.filter(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === afterRevokeRevision.data.id &&
        event.outcome === "pending" &&
        event.code === "REVISION_INCOMPLETE",
    ).length;
    await waitFor(
      `gateway-admin revoked token blocks ${afterRevokeRevision.data.id}`,
      () =>
        topology.events.filter(
          (event) =>
            event.event === "worker.completed" &&
            event.revisionId === afterRevokeRevision.data.id &&
            event.outcome === "pending" &&
            event.code === "REVISION_INCOMPLETE",
        ).length > revokedAttemptsBeforeReady,
    );
    const blockedAfterRevoke = await topology.request(
      "GET",
      `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`,
    );
    assert.equal(blockedAfterRevoke.status, 200);
    assert.notEqual(
      blockedAfterRevoke.data.activeRevisionId,
      afterRevokeRevision.data.id,
      "revoked OCC native access must not trigger automatic helper re-enrollment on reconcile",
    );
    assert.equal(
      (await readGatewayAdministrationCredential(topology)).identity.deviceId,
      credential.identity.deviceId,
      "revoked OCC native access must preserve the original device identity for deliberate recovery",
    );

    // Losing the credential Secret must not look like first enrollment. The
    // public identity pin survives on the existing Agent-owned gateway PVC.
    const privateClaim = topology.gatewayPod.spec.volumes.find(
      (volume) => volume.name === "openclaw-gateway-state",
    ).persistentVolumeClaim.claimName;
    const identityPin = "openclaw.dev/occ-gateway-device-id";
    assert.equal(
      (await resource("pvc", privateClaim, topology.placement)).metadata.annotations[identityPin],
      credential.identity.deviceId,
    );
    await kubectl(
      "delete",
      "secret",
      topology.gatewayAdministrationRbac.credential,
      "--namespace",
      topology.platformNamespace,
      "--wait=true",
    );
    await topology.restartProductionWorker();
    const pendingBeforeLoss = topology.events.filter(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === afterRevokeRevision.data.id &&
        event.outcome === "retry" &&
        event.code === "DEPENDENCY_UNAVAILABLE",
    ).length;
    await waitFor(
      "lost gateway credential stays unavailable after worker restart",
      () =>
        topology.events.filter(
          (event) =>
            event.event === "worker.completed" &&
            event.revisionId === afterRevokeRevision.data.id &&
            event.outcome === "retry" &&
            event.code === "DEPENDENCY_UNAVAILABLE",
        ).length > pendingBeforeLoss,
    );
    let credentialStillMissing = false;
    try {
      await kubectl(
        "get",
        "secret",
        topology.gatewayAdministrationRbac.credential,
        "--namespace",
        topology.platformNamespace,
        "-o",
        "name",
      );
    } catch (error) {
      assert.match(error.stderr ?? error.message, /NotFound|not found/i);
      credentialStillMissing = true;
    }
    assert.equal(
      credentialStillMissing,
      true,
      "credential loss must never regenerate the OCC identity",
    );
    assert.equal(
      (await resource("pvc", privateClaim, topology.placement)).metadata.annotations[identityPin],
      credential.identity.deviceId,
    );
    assert.equal((await dispatchOccGatewayCommand(topology, "status")).status, 503);
  },
);

test(
  "production dedicated Codex preserves gateway SQLite conversations and retained images across Pod replacement",
  { ...requiresProductionCluster, timeout: 1_200_000 },
  async (context) => {
    const topology = await arrangeProductionTopology(context, "dedicated");
    assert.ok(topology.harnessPod, "dedicated production must start a real separate Codex Pod");
    assert.notEqual(topology.gatewayPod.metadata.uid, topology.harnessPod.metadata.uid);
    assert.equal(topology.gatewayPod.spec.serviceAccountName, topology.gatewayServiceName);
    assert.equal(topology.harnessPod.spec.serviceAccountName, topology.agentServiceName);
    assert.notEqual(
      topology.gatewayPod.spec.serviceAccountName,
      topology.harnessPod.spec.serviceAccountName,
    );
    assertPrivateStateInitContainer(topology.gatewayPod);
    assertPrivateStateInitContainer(topology.harnessPod);
    const sharedWorkspaceClaim = await assertDedicatedSharedWorkspaceResources(topology);
    const privateClaim = await assertGatewayPrivateResources(topology);

    const [gatewayEnvironment, harnessEnvironment, gatewayIdentity, harnessIdentity] =
      await Promise.all([
        inspectWorkloadEnvironment(topology.placement, topology.gatewayPod.metadata.name),
        inspectWorkloadEnvironment(topology.placement, topology.harnessPod.metadata.name),
        inspectProjectedIdentity(topology.placement, topology.gatewayPod.metadata.name),
        inspectProjectedIdentity(topology.placement, topology.harnessPod.metadata.name),
      ]);
    assert.deepEqual(gatewayEnvironment, {
      OPENAI_API_KEY: false,
      [secretRotationProbe]: false,
      APP_SERVER_TOKEN: true,
      APP_SERVER_URL: true,
      OPENCLAW_GATEWAY_TOKEN: true,
    });
    assert.deepEqual(harnessEnvironment, {
      OPENAI_API_KEY: true,
      [secretRotationProbe]: false,
      APP_SERVER_TOKEN: true,
      APP_SERVER_URL: false,
      OPENCLAW_GATEWAY_TOKEN: false,
    });
    const modelProjection = topology.harnessPod.spec.containers[0].env.find(
      ({ name }) => name === "OPENAI_API_KEY",
    );
    assert.deepEqual(modelProjection.valueFrom.secretKeyRef, {
      name: `${modelPrefix}-${hash(topology.agent.id)}`,
      key: "OPENAI_API_KEY",
    });
    assert.equal(gatewayIdentity, null, "the dedicated gateway must never receive Agent identity");
    assert.equal(
      harnessIdentity.subject,
      `system:serviceaccount:${topology.placement}:${topology.agentServiceName}`,
    );
    assert.deepEqual(harnessIdentity.audience, ["openclaw-enterprise"]);
    const agentService = await resource("service", topology.agentServiceName, topology.placement);
    assert.deepEqual(agentService.spec.selector, {
      "app.kubernetes.io/name": `${topology.agentServiceName}-rev-${hash(topology.revision.id)}`,
      "openclaw.dev/agent": topology.agent.id,
      "openclaw.dev/revision": topology.revision.id,
      "openclaw.dev/workload-role": "agent",
    });
    const codexVersion = (
      await kubectl(
        "exec",
        topology.harnessPod.metadata.name,
        "--namespace",
        topology.placement,
        "--",
        "codex",
        "--version",
      )
    ).trim();
    const expectedCodexVersion = process.env.OCC_TEST_KUBERNETES_CODEX_VERSION ?? "0.147.0";
    assert.ok(codexVersion.includes(expectedCodexVersion));
    context.diagnostic(`dedicated: ${codexVersion}`);
    await assertUnauthorizedCodexSocket(topology);
    await resource("networkpolicy", "default-deny", topology.placement);
    const target = await resource("pod", topology.approvedClient, topology.platformNamespace);
    await assertDeniedConnection(
      topology.placement,
      topology.gatewayPod.metadata.name,
      target.status.podIP,
    );
    await assertDeniedConnection(
      topology.placement,
      topology.harnessPod.metadata.name,
      target.status.podIP,
    );
    await assertActualModelTurn(topology);
    await assertDedicatedModelSecretBindingDenied(topology);
    await assertDedicatedAgentsInstructionsInFreshSession(topology);
    await assertGatewayPodContinuity(context, topology, privateClaim);
    await assertDedicatedSharedWorkspaceRuntime(
      context,
      topology,
      sharedWorkspaceClaim,
      privateClaim,
    );
  },
);

test(
  "production service account powers embedded OpenClaw through its exact persisted provider credential",
  { ...requiresProductionCluster, timeout: 900_000 },
  async (context) => {
    const topology = await arrangeProductionTopology(context, "embedded");
    assert.equal(topology.harnessPod, undefined, "embedded execution must not create a Codex Pod");
    assert.equal(topology.gatewayPod.spec.serviceAccountName, topology.agentServiceName);
    assert.equal((await resources("deployments", topology.placement)).length, 1);
    assertPrivateStateInitContainer(topology.gatewayPod);
    await assertEmbeddedCreatesNoSharedWorkspaceClaim(topology);
    const privateClaim = await assertGatewayPrivateResources(topology);

    const [environment, identity] = await Promise.all([
      inspectWorkloadEnvironment(topology.placement, topology.gatewayPod.metadata.name),
      inspectProjectedIdentity(topology.placement, topology.gatewayPod.metadata.name),
    ]);
    assert.deepEqual(environment, {
      OPENAI_API_KEY: true,
      APP_SERVER_TOKEN: false,
      APP_SERVER_URL: false,
      OPENCLAW_GATEWAY_TOKEN: true,
    });
    const modelProjection = topology.gatewayPod.spec.containers[0].env.find(
      ({ name }) => name === "OPENAI_API_KEY",
    );
    assert.deepEqual(modelProjection.valueFrom.secretKeyRef, {
      name: `${modelPrefix}-${hash(topology.agent.id)}`,
      key: "OPENAI_API_KEY",
    });
    assert.equal(
      identity.subject,
      `system:serviceaccount:${topology.placement}:${topology.agentServiceName}`,
    );
    assert.deepEqual(identity.audience, ["openclaw-enterprise"]);
    await resource("networkpolicy", "default-deny", topology.placement);
    const modelPolicy = await resource(
      "networkpolicy",
      `allow-agent-runtime-${hash(topology.agent.id)}`,
      topology.placement,
    );
    assert.equal(modelPolicy.spec.podSelector.matchLabels["openclaw.dev/workload-role"], "gateway");
    assert.equal(modelPolicy.spec.podSelector.matchLabels["openclaw.dev/agent"], topology.agent.id);
    assert.deepEqual(modelPolicy.spec.egress[0].ports, [{ protocol: "TCP", port: 443 }]);
    const target = await resource("pod", topology.approvedClient, topology.platformNamespace);
    await assertDeniedConnection(
      topology.placement,
      topology.gatewayPod.metadata.name,
      target.status.podIP,
    );
    await assertGatewayPodContinuity(context, topology, privateClaim);
  },
);

test(
  "production Secret API powers embedded OpenClaw through exact Namespace-owned native bindings",
  { ...requiresProductionCluster, timeout: 480_000 },
  async (context) => {
    const topology = await arrangeProductionTopology(context, "embedded", undefined, {
      modelCredential: "secret-api",
    });
    assert.equal(topology.harnessPod, undefined, "embedded execution must not create a Codex Pod");
    assert.equal(topology.gatewayPod.spec.serviceAccountName, topology.agentServiceName);
    assert.equal((await resources("deployments", topology.placement)).length, 1);
    assertPrivateStateInitContainer(topology.gatewayPod);
    await assertEmbeddedCreatesNoSharedWorkspaceClaim(topology);
    await assertGatewayPrivateResources(topology);

    const [environment, identity] = await Promise.all([
      inspectWorkloadEnvironment(topology.placement, topology.gatewayPod.metadata.name),
      inspectProjectedIdentity(topology.placement, topology.gatewayPod.metadata.name),
    ]);
    assert.deepEqual(environment, {
      OPENAI_API_KEY: true,
      [secretRotationProbe]: true,
      APP_SERVER_TOKEN: false,
      APP_SERVER_URL: false,
      OPENCLAW_GATEWAY_TOKEN: true,
    });
    const modelProjection = topology.gatewayPod.spec.containers[0].env.find(
      ({ name }) => name === "OPENAI_API_KEY",
    );
    assert.equal(modelProjection.valueFrom.secretKeyRef.name.startsWith(`${modelPrefix}-`), false);
    assert.equal(
      identity.subject,
      `system:serviceaccount:${topology.placement}:${topology.agentServiceName}`,
    );
    assert.deepEqual(identity.audience, ["openclaw-enterprise"]);
    await resource("networkpolicy", "default-deny", topology.placement);
    const modelPolicy = await resource(
      "networkpolicy",
      `allow-agent-runtime-${hash(topology.agent.id)}`,
      topology.placement,
    );
    assert.equal(modelPolicy.spec.podSelector.matchLabels["openclaw.dev/workload-role"], "gateway");
    assert.equal(modelPolicy.spec.podSelector.matchLabels["openclaw.dev/agent"], topology.agent.id);
    assert.deepEqual(modelPolicy.spec.egress[0].ports, [{ protocol: "TCP", port: 443 }]);
    const target = await resource("pod", topology.approvedClient, topology.platformNamespace);
    await assertDeniedConnection(
      topology.placement,
      topology.gatewayPod.metadata.name,
      target.status.podIP,
    );
    await assertActualModelTurn(topology);
    await assertSameNamespaceSecretSharing(context, topology);
    await assertSecretApiNegativeRows(context, topology);
    await assertUnboundSecretDeletion(context, topology);
    await assertSecretApiRotationAndRedeploy(context, topology);
    await assertNativeReferenceNegativeControl(context, topology);
  },
);

test(
  "production k3d gateway replies to a real Slack message through its approved proxy and Codex Agent",
  { ...requiresLiveSlack, timeout: 780_000 },
  async (context) => {
    for (const key of [
      "OCC_TEST_SLACK_PROXY_URL",
      "OCC_TEST_SLACK_CHANNEL_ID",
      "OCC_TEST_SLACK_SENDER_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "SLACK_BOT_TOKEN",
    ]) {
      assert.ok(process.env[key], `${key} is required for explicitly requested live Slack proof.`);
    }
    const proxy = new URL(process.env.OCC_TEST_SLACK_PROXY_URL);
    const address = proxy.hostname.replace(/^\[|\]$/g, "");
    const family = isIP(address);
    assert.notEqual(family, 0, "the approved channel proxy must use an exact literal IP");
    assert.notEqual(proxy.port, "", "the approved channel proxy requires an explicit port");
    const [gatewayIdentity, senderIdentity] = await Promise.all([
      slackApi("auth.test", process.env.SLACK_BOT_TOKEN),
      slackApi("auth.test", process.env.OCC_TEST_SLACK_SENDER_BOT_TOKEN),
    ]);
    assert.equal(
      gatewayIdentity.team_id,
      senderIdentity.team_id,
      "the gateway and Slack test sender must belong to the same workspace",
    );
    assert.notEqual(
      gatewayIdentity.user_id,
      senderIdentity.user_id,
      "Slack integration requires a distinct sender because OpenClaw rejects its own bot messages",
    );
    const slack = {
      proxyUrl: process.env.OCC_TEST_SLACK_PROXY_URL,
      allowedUserId: senderIdentity.user_id,
      channelId: process.env.OCC_TEST_SLACK_CHANNEL_ID,
      appToken: process.env.SLACK_APP_TOKEN,
      botToken: process.env.SLACK_BOT_TOKEN,
      senderBotToken: process.env.OCC_TEST_SLACK_SENDER_BOT_TOKEN,
    };
    assert.equal(
      slack.appToken.startsWith("xapp-"),
      true,
      "Slack requires a Socket Mode app token",
    );
    assert.equal(slack.botToken.startsWith("xoxb-"), true, "Slack requires an approved bot token");
    assert.equal(
      slack.senderBotToken.startsWith("xoxb-"),
      true,
      "Slack end-to-end proof requires an approved second bot token",
    );
    const [gatewayChannel, senderChannel] = await Promise.all([
      slackApi("conversations.info", slack.botToken, { channel: slack.channelId }),
      slackApi("conversations.info", slack.senderBotToken, { channel: slack.channelId }),
    ]);
    assert.equal(gatewayChannel.channel?.is_member, true, "the gateway must join the test channel");
    assert.equal(senderChannel.channel?.is_member, true, "the sender must join the test channel");

    const topology = await arrangeProductionTopology(context, "dedicated", slack);
    assert.ok(topology.harnessPod, "channels must preserve their separate dedicated Codex Agent");
    const suffix = hash(topology.agent.id);
    const gateway = await resource("deployment", `gateway-${suffix}`, topology.placement);
    const agent = await resource(
      "deployment",
      `agent-${suffix}-rev-${hash(topology.revision.id)}`,
      topology.placement,
    );
    const gatewayEnvironment = gateway.spec.template.spec.containers[0].env;
    const agentEnvironment = agent.spec.template.spec.containers[0].env;
    for (const key of ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]) {
      assert.deepEqual(
        gatewayEnvironment.find(({ name }) => name === key)?.valueFrom?.secretKeyRef,
        { name: `${channelPrefix}-${suffix}`, key },
        "only the owning gateway may receive operator-owned channel credential references",
      );
      assert.equal(
        agentEnvironment.some(({ name }) => name === key),
        false,
      );
      assert.equal(
        JSON.stringify(topology.revision.configuration).includes(
          slack[key === "SLACK_APP_TOKEN" ? "appToken" : "botToken"],
        ),
        false,
      );
    }
    for (const environment of [gatewayEnvironment, agentEnvironment]) {
      assert.equal(
        environment.some(({ name }) => name === "OCC_TEST_SLACK_SENDER_BOT_TOKEN"),
        false,
        "the external sender credential must remain outside every platform workload",
      );
    }
    assert.equal(
      JSON.stringify(topology.revision.configuration).includes(slack.senderBotToken),
      false,
      "Agent revisions must not persist the external sender credential",
    );
    assert.equal(
      gatewayEnvironment.find(({ name }) => name === "HTTPS_PROXY")?.value,
      slack.proxyUrl,
    );
    const policy = await resource(
      "networkpolicy",
      `allow-gateway-channels-${suffix}`,
      topology.placement,
    );
    assert.deepEqual(policy.spec.podSelector.matchLabels, {
      "openclaw.dev/workload-role": "gateway",
      "openclaw.dev/agent": topology.agent.id,
    });
    assert.deepEqual(policy.spec.egress, [
      {
        to: [{ ipBlock: { cidr: `${address}/${family === 4 ? 32 : 128}` } }],
        ports: [{ protocol: "TCP", port: Number(proxy.port) }],
      },
    ]);
    const target = await resource("pod", topology.approvedClient, topology.platformNamespace);
    await assertDeniedConnection(
      topology.placement,
      topology.gatewayPod.metadata.name,
      target.status.podIP,
    );

    await waitFor("a genuine authenticated Slack Socket Mode connection", async () => {
      const logs = await kubectl(
        "logs",
        topology.gatewayPod.metadata.name,
        "--namespace",
        topology.placement,
      );
      assert.equal(logs.includes(slack.appToken), false, "gateway logs must not expose app tokens");
      assert.equal(logs.includes(slack.botToken), false, "gateway logs must not expose bot tokens");
      assert.equal(
        logs.includes(slack.senderBotToken),
        false,
        "gateway logs must not expose the external sender's token",
      );
      return /\[?slack\]?\s+socket mode connected/i.test(logs) || undefined;
    });
    const baselineLogs = await kubectl(
      "logs",
      topology.gatewayPod.metadata.name,
      "--namespace",
      topology.placement,
    );
    const nonce = `OCC-SLACK-${randomUUID()}`;
    const message = {
      channel: slack.channelId,
      text: `<@${gatewayIdentity.user_id}> Reply with exactly this nonce and no other text: ${nonce}`,
    };
    // A distinct explicitly allowed bot proves actual Slack ingress, Codex execution, and egress.
    const sent = await slackApi("chat.postMessage", slack.senderBotToken, message);
    let attempts = 1;
    let nextAttemptAt = Date.now() + 45_000;
    const reply = await waitFor(
      "the genuine gateway-authored Slack response from its dedicated Codex Agent",
      async () => {
        const history = await slackApi("conversations.history", slack.senderBotToken, {
          channel: slack.channelId,
          oldest: sent.ts,
          inclusive: false,
          limit: 30,
        });
        const response = history.messages?.find(
          (candidate) =>
            candidate.user === gatewayIdentity.user_id &&
            Number(candidate.ts) > Number(sent.ts) &&
            typeof candidate.text === "string" &&
            candidate.text.includes(nonce),
        );
        if (response !== undefined) return response;
        // Slack distributes shared-app events across connections, so an unrelated gateway can win.
        if (attempts < 3 && Date.now() >= nextAttemptAt) {
          await slackApi("chat.postMessage", slack.senderBotToken, message);
          attempts += 1;
          nextAttemptAt = Date.now() + 45_000;
        }
        await delay(2_250);
        return undefined;
      },
      240_000,
    );
    assert.equal(reply.user, gatewayIdentity.user_id);
    assert.match(reply.text, new RegExp(nonce));
    const gatewayLogs = await kubectl(
      "logs",
      topology.gatewayPod.metadata.name,
      "--namespace",
      topology.placement,
    );
    const turnLogs = gatewayLogs.slice(baselineLogs.length);
    const ingress = turnLogs
      .split("\n")
      .find((line) =>
        line.includes(
          `Inbound app_mention slack:${gatewayIdentity.team_id}:channel:${slack.channelId}:user:${senderIdentity.user_id} -> bot:${gatewayIdentity.user_id}`,
        ),
      );
    if (ingress !== undefined) {
      assert.match(ingress, new RegExp(`\\((?:channel|group), ${message.text.length} chars\\)`));
    }
    assert.ok(
      turnLogs.includes(
        "codex app-server approval reviewer updated from active thread model provider",
      ),
      "this gateway must route the Slack message through its own dedicated Codex Agent",
    );
    const transcriptProbe = String.raw`
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync(
        "/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite",
        { readOnly: true },
      );
      const { matches } = database
        .prepare("SELECT COUNT(*) AS matches FROM transcript_events WHERE instr(event_json, ?) > 0")
        .get(${JSON.stringify(nonce)});
      process.stdout.write(String(matches));
    `;
    const transcriptMatches = Number(
      await kubectl(
        "exec",
        topology.gatewayPod.metadata.name,
        "--namespace",
        topology.placement,
        "--",
        "node",
        "-e",
        transcriptProbe,
      ),
    );
    assert.ok(
      transcriptMatches >= 2,
      "this exact gateway must persist both the unique Slack prompt and its Codex Agent response",
    );
    context.diagnostic(
      `Real Slack -> gateway -> dedicated Codex -> Slack response: agent=${topology.agent.id}; channel=${slack.channelId}; sender=${slack.allowedUserId}; attempts=${attempts}; nonce=${nonce}.`,
    );
    if (process.env.OCC_TEST_SLACK_MANUAL_WAIT_SECONDS !== undefined) {
      const seconds = Number(process.env.OCC_TEST_SLACK_MANUAL_WAIT_SECONDS);
      assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 300);
      context.diagnostic(`Keeping the real Slack gateway available for ${seconds} seconds.`);
      await delay(seconds * 1_000);
    }
  },
);
