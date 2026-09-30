import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createControllerApp } from "../../apps/controller/src/index.ts";
import {
  authenticatedHeaders,
  signInToControllerApp,
  createTestAuthPrincipal,
} from "./auth-session.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { createTestSecretDriver } from "./secret-driver.mjs";

export const runtimeLogPodUid = "0f3b6c1e-7d52-4f4b-9a2e-5c6d7e8f9a01";

/**
 * A Compute Driver that implements the runtime log contract over in-memory Pod state.
 * It stands in for the cluster only; OCC authorization, cursor, gap and sanitizer
 * behavior under test is the production code path.
 */
export function createRuntimeLogComputeDriver(options = {}) {
  const calls = [];
  const state = {
    restartCount: 0,
    podUid: runtimeLogPodUid,
    lines: [],
    previousLines: [],
    truncated: false,
    events: [],
    describeError: undefined,
    readError: undefined,
    /** Pods named by the Driver; tests may add a Pod that does not belong to the revision. */
    extraPods: [],
    ...options.state,
  };
  const podName = (revision) => `gateway-${revision.id.slice(4, 12)}-0`;
  return {
    id: options.id ?? "runtime-log-compute",
    capability: "compute",
    implementation: "in-memory-runtime-log-test",
    ...(options.runtimeLogging === undefined ? {} : { runtimeLogging: options.runtimeLogging }),
    calls,
    state,
    podName,
    validateHarnessAuth() {},
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async retireRevision() {},
    ...(options.withoutDescribe
      ? {}
      : {
          async describeAgentRuntime(binding, signal) {
            assert.ok(signal instanceof AbortSignal);
            calls.push({ operation: "describe", revisionId: binding.revision.id });
            if (state.describeError !== undefined) {
              throw state.describeError;
            }
            const name = podName(binding.revision);
            const pods = [
              { name, uid: state.podUid },
              ...state.extraPods.map((pod) => ({ name: pod.name, uid: pod.uid })),
            ];
            return {
              revisionId: binding.revision.id,
              observedAt: "2026-09-30T12:00:00.000Z",
              pods: pods.map((pod) => ({
                role: "gateway",
                cluster: "control",
                name: pod.name,
                uid: pod.uid,
                phase: "Running",
                ready: true,
                createdAt: "2026-09-30T11:00:00Z",
                containers: [
                  {
                    name: "gateway",
                    state: "running",
                    reason: null,
                    ready: true,
                    restartCount: state.restartCount,
                    startedAt: "2026-09-30T11:00:05Z",
                    lastTermination:
                      state.restartCount === 0
                        ? null
                        : {
                            reason: state.terminationReason ?? "OOMKilled",
                            exitCode: 137,
                            finishedAt: "2026-09-30T11:30:00Z",
                          },
                  },
                ],
                events: pod.name === name ? state.events : [],
              })),
              sources: [
                {
                  id: "gateway",
                  kind: "container",
                  pods: pods.map((pod) => ({
                    name: pod.name,
                    uid: pod.uid,
                    container: "gateway",
                    restartCount: state.restartCount,
                  })),
                  available: true,
                  retention: "Kubernetes keeps the current and the previous instance.",
                },
              ],
            };
          },
        }),
    ...(options.withoutRead
      ? {}
      : {
          async readAgentRuntimeLogs(binding, request) {
            calls.push({
              operation: "read",
              revisionId: binding.revision.id,
              pod: request.pod,
              container: request.container,
              previous: request.previous,
              tailLines: request.tailLines,
              ...(request.sinceSeconds === undefined ? {} : { sinceSeconds: request.sinceSeconds }),
              limitBytes: request.limitBytes,
            });
            if (state.readError !== undefined) {
              throw state.readError;
            }
            const source = request.previous ? state.previousLines : state.lines;
            return {
              stream: {
                source: "gateway",
                pod: request.pod,
                podUid: state.readPodUid ?? state.podUid,
                container: request.container,
                restartCount: state.readRestartCount ?? state.restartCount,
              },
              observedAt: "2026-09-30T12:00:01.000Z",
              lines: source.slice(-request.tailLines),
              truncated: state.truncated,
            };
          },
        }),
  };
}

/**
 * The production controller app over in-memory state with native IAM, one deployed
 * embedded Agent, and helpers to add principals with exact Agent grants.
 */
export async function createRuntimeLogFixture(options = {}) {
  const installationId = `ins_${randomUUID()}`;
  const admin = await createTestAuthPrincipal({ installationId, name: "Runtime Log Admin" });
  const policy = {
    identities: [admin.seed.principal],
    groups: [],
    memberships: [],
    roles: admin.seed.roles.map((role) => ({
      ...role,
      permissions: role.permissions.map((permission) => ({ ...permission })),
    })),
    bindings: admin.seed.bindings.map((binding) => ({ ...binding })),
    restrictions: [],
  };
  const auditSink = options.auditSink ?? new InMemoryAuditSink();
  const iamDriver = new NativeIAMDriver(
    { loadNativeIAMState: async () => policy },
    { id: "runtime-log-iam" },
  );
  const computeDriver = options.computeDriver ?? createRuntimeLogComputeDriver();
  let controller;
  const app = createControllerApp({
    auth: admin.auth,
    iamDriver,
    auditSink,
    development: { enabled: true, installationId },
    computeDriver,
    configurationDriver: createTestConfigurationDriver({ id: "runtime-log-configuration" }),
    secretDriver: createTestSecretDriver({ id: "runtime-log-secret" }),
    resolveHarness: resolveApprovedHarness,
    agentRuntimeLogs: options.agentRuntimeLogs ?? {
      enabled: true,
      cursorSecret: `runtime-log-cursor-secret-${randomUUID()}`,
    },
    createController(installation) {
      controller = new OpenClawController(installation, {
        state: new InMemoryPlatformState({ auditSink }),
        recordOperations: false,
      });
      return controller;
    },
  });
  const adminSession = await signInToControllerApp(app, admin);

  async function request(method, path, { session = adminSession, serviceKey, body } = {}) {
    const response = await app.fetch(
      new Request(new URL(path, "http://127.0.0.1"), {
        method,
        headers: {
          ...(serviceKey === undefined
            ? authenticatedHeaders(session)
            : { "x-api-key": serviceKey }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      body: text.length === 0 ? undefined : JSON.parse(text),
      get data() {
        return this.body?.data;
      },
    };
  }

  const bootstrap = await request("POST", "/installation/bootstrap", {
    body: { name: "Runtime log test" },
  });
  assert.equal(bootstrap.status, 201, bootstrap.text);

  async function deployAgent(label = "runtime-logs") {
    const namespace = await request("POST", "/namespaces", {
      body: { name: `${label}-${randomUUID().slice(0, 8)}` },
    });
    assert.equal(namespace.status, 201, namespace.text);
    await controller.handleNamespaceLifecycle(admin.seed.principal.id, namespace.data.id, "ready");
    const secret = await request("POST", `/namespaces/${namespace.data.id}/secrets`, {
      body: { name: "Model API key", value: `model-key-${randomUUID()}` },
    });
    assert.equal(secret.status, 201, secret.text);
    const configuration = await request("POST", `/namespaces/${namespace.data.id}/configurations`, {
      body: { kind: "agent", values: createHarnessConfiguration("openclaw", "gpt-4.1") },
    });
    assert.equal(configuration.status, 201, configuration.text);
    const agent = await request("POST", `/namespaces/${namespace.data.id}/agents`, {
      body: {
        name: "Runtime log Agent",
        configurationId: configuration.data.id,
        executionMode: "embedded",
        harnessAuth: { method: "api_key", source: secret.data.ref },
      },
    });
    assert.equal(agent.status, 201, agent.text);
    policy.identities.push({
      id: `service-agent-${agent.data.id}`,
      kind: "service_principal",
      namespaceId: namespace.data.id,
      agentId: agent.data.id,
    });
    policy.roles.push({
      id: `auth-${agent.data.id}`,
      namespaceId: namespace.data.id,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    policy.bindings.push({
      id: `auth-${agent.data.id}`,
      namespaceId: namespace.data.id,
      subjectKind: "identity",
      subjectId: `service-agent-${agent.data.id}`,
      roleId: `auth-${agent.data.id}`,
      resourceKind: "secret",
      resourceId: secret.data.id,
    });
    const deployed = await request(
      "POST",
      `/namespaces/${namespace.data.id}/agents/${agent.data.id}/deploy`,
    );
    assert.equal(deployed.status, 202, deployed.text);
    const base = `/namespaces/${namespace.data.id}/agents/${agent.data.id}/deployments/${deployed.data.id}`;
    return {
      namespace: namespace.data,
      agent: agent.data,
      revisionId: deployed.data.id,
      runtimePath: `${base}/runtime`,
      logsPath: (query = "source=gateway") => `${base}/runtime/logs?${query}`,
    };
  }

  /** A signed-in human principal holding exactly the listed Agent-scoped actions. */
  async function createPrincipal(label, { namespace, agent, revisionId }, grants) {
    const credentials = {
      email: `${label}-${randomUUID()}@example.com`,
      password: `runtime-password-${randomUUID()}`,
      name: label,
    };
    const account = await admin.auth.createAccount(credentials);
    const principal = admin.auth.principalSeed(account, { grant: "none" }).principal;
    policy.identities.push(principal);
    const bindingIds = [];
    for (const grant of grants) {
      const id = `${label}-${grant.resourceKind}-${grant.action}-${randomUUID().slice(0, 8)}`;
      policy.roles.push({
        id,
        namespaceId: namespace.id,
        permissions: [{ action: grant.action, resourceKind: grant.resourceKind }],
      });
      policy.bindings.push({
        id,
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: id,
        resourceKind: grant.resourceKind,
        resourceId: grant.resourceKind === "agent_revision" ? revisionId : agent.id,
      });
      bindingIds.push(id);
    }
    return {
      principal,
      session: await signInToControllerApp(app, credentials),
      bindingIds,
      revoke(action, resourceKind) {
        const index = policy.bindings.findIndex(
          (binding) =>
            binding.subjectId === principal.id &&
            policy.roles.find((role) => role.id === binding.roleId)?.permissions[0]?.action ===
              action &&
            binding.resourceKind === resourceKind,
        );
        assert.notEqual(index, -1);
        policy.bindings.splice(index, 1);
      },
    };
  }

  /** A Namespace ServicePrincipal with exact Agent grants and one service API key. */
  async function createServicePrincipal(label, { namespace, agent, revisionId }, grants) {
    const principal = {
      id: `service-${label}-${randomUUID().slice(0, 8)}`,
      kind: "service_principal",
      namespaceId: namespace.id,
    };
    policy.identities.push(principal);
    for (const grant of grants) {
      const id = `${principal.id}-${grant.resourceKind}-${grant.action}`;
      policy.roles.push({
        id,
        namespaceId: namespace.id,
        permissions: [{ action: grant.action, resourceKind: grant.resourceKind }],
      });
      policy.bindings.push({
        id,
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: id,
        resourceKind: grant.resourceKind,
        resourceId: grant.resourceKind === "agent_revision" ? revisionId : agent.id,
      });
    }
    const key = await admin.auth.createServiceKey({ principal, name: label });
    return { principal, serviceKey: key.key };
  }

  return {
    app,
    admin,
    adminSession,
    auditSink,
    computeDriver,
    createPrincipal,
    createServicePrincipal,
    deployAgent,
    policy,
    request,
    get controller() {
      return controller;
    },
  };
}

export const operateGrants = [
  { action: "operate", resourceKind: "agent" },
  { action: "read", resourceKind: "agent" },
  { action: "read", resourceKind: "agent_revision" },
];

export const administerGrants = [
  { action: "administer", resourceKind: "agent" },
  { action: "read", resourceKind: "agent" },
  { action: "read", resourceKind: "agent_revision" },
];
