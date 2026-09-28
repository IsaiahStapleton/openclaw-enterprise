import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  arrangeProductionTopology,
  hash,
  requiresProductionCluster,
} from "./harness-topology-k3d-real.mjs";

const providerModel = (process.env.OCC_TEST_OPENAI_MODEL ?? "gpt-4.1").replace(
  /^(?:openai|codex)\//,
  "",
);
const invalidSlackAppToken = "xapp-invalid-nosend-runtime-diagnostics";
const invalidSlackBotToken = "xoxb-invalid-nosend-runtime-diagnostics";
const defaultAllowedUserId = "U0000000000";
const defaultChannelId = "C0000000000";

const requiresNoSendSlackInvalid = {
  skip:
    process.env.OCC_TEST_SLACK_NOSEND_INVALID === "1"
      ? requiresProductionCluster.skip
      : "Set OCC_TEST_SLACK_NOSEND_INVALID=1 plus production k3d prerequisites to prove invalid Slack auth without sending messages.",
};

const requiresNoSendSlackLive = {
  skip:
    process.env.OCC_TEST_SLACK_NOSEND_LIVE === "1"
      ? requiresProductionCluster.skip
      : "Set OCC_TEST_SLACK_NOSEND_LIVE=1 plus production k3d prerequisites, APP_TOKEN/SLACK_APP_TOKEN and BOT_TOKEN/SLACK_BOT_TOKEN to prove authenticated connected Slack diagnostics without sending messages.",
};

function assertNoSecretMaterial(value, secrets, description) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets.filter(Boolean)) {
    assert.equal(
      serialized.includes(secret),
      false,
      `${description} must not expose secret material`,
    );
  }
}

function secretBinding(source) {
  return { source, delivery: { type: "env" } };
}

function slackNativeConfiguration(slack) {
  const configuration = createHarnessConfiguration("codex", providerModel);
  configuration.models.providers.codex.models[0].input = ["text", "image"];
  configuration.plugins.allow.push("slack");
  configuration.plugins.entries.slack = { enabled: true };
  const eventResponsesDisabled = slack.disableEventResponses === true;
  configuration.channels = {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      allowFrom: eventResponsesDisabled ? [] : [slack.allowedUserId],
      channels: eventResponsesDisabled
        ? {}
        : {
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

function noSendSlackFixture(overrides = {}) {
  return {
    proxyUrl: overrides.proxyUrl ?? process.env.OCC_TEST_SLACK_PROXY_URL ?? "http://127.0.0.1:9",
    allowedUserId: overrides.allowedUserId ?? defaultAllowedUserId,
    channelId: overrides.channelId ?? defaultChannelId,
    appToken: overrides.appToken ?? invalidSlackAppToken,
    botToken: overrides.botToken ?? invalidSlackBotToken,
    disableEventResponses: overrides.disableEventResponses ?? false,
  };
}

function requiredNoSendSlackProxy() {
  assert.ok(
    process.env.OCC_TEST_SLACK_PROXY_URL,
    "OCC_TEST_SLACK_PROXY_URL is required for Slack no-send diagnostics that contact Slack.",
  );
  return process.env.OCC_TEST_SLACK_PROXY_URL;
}

async function createApiSecret(request, namespaceId, name, value, protectedValues = []) {
  const response = await request("POST", `/namespaces/${namespaceId}/secrets`, { name, value });
  assertNoSecretMaterial(response, [value, ...protectedValues], `${name} Secret create response`);
  assert.equal(response.status, 201, JSON.stringify(response.error));
  assert.equal(response.data.namespaceId, namespaceId);
  assert.equal(response.data.name, name);
  assert.deepEqual(response.data.ref, { kind: "secret", namespaceId, id: response.data.id });
  return response.data;
}

function secretOperateRole(role) {
  return (
    Array.isArray(role?.permissions) &&
    role.permissions.length === 1 &&
    role.permissions[0]?.action === "operate" &&
    role.permissions[0]?.resourceKind === "secret"
  );
}

async function ensureSecretOperateRole(request, namespaceId) {
  const listed = await request("GET", `/namespaces/${namespaceId}/iam/roles`);
  assert.equal(listed.status, 200, JSON.stringify(listed.error));
  const existing = listed.data.find(secretOperateRole);
  if (existing !== undefined) {
    return existing;
  }
  const created = await request("POST", `/namespaces/${namespaceId}/iam/roles`, {
    name: "Slack no-send Secret operate",
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.error));
  return created.data;
}

async function grantSecretOperate(request, namespaceId, subjectId, secretId) {
  const role = await ensureSecretOperateRole(request, namespaceId);
  const bindings = await request("GET", `/namespaces/${namespaceId}/iam/access-bindings`);
  assert.equal(bindings.status, 200, JSON.stringify(bindings.error));
  const existing = bindings.data.find(
    (binding) =>
      binding.subjectKind === "identity" &&
      binding.subjectId === subjectId &&
      binding.roleId === role.id &&
      binding.resourceKind === "secret" &&
      binding.resourceId === secretId,
  );
  if (existing !== undefined) {
    return existing;
  }
  const created = await request("POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId,
    roleId: role.id,
    resourceKind: "secret",
    resourceId: secretId,
  });
  assert.equal(created.status, 201, JSON.stringify(created.error));
  return created.data;
}

function gatewayChannelChecks(diagnostics) {
  const byCheck = new Map(
    diagnostics.checks
      .filter((check) => check.component === "gateway")
      .map((check) => [check.check, check]),
  );
  for (const name of ["configuration", "authentication", "connectivity"]) {
    assert.ok(byCheck.has(name), `diagnostics must include gateway ${name} channel status`);
  }
  return byCheck;
}

function assertUnreachableSlackNotConnected(diagnostics) {
  const checks = gatewayChannelChecks(diagnostics);
  const observed = Object.fromEntries(
    ["configuration", "authentication", "connectivity"].map((name) => [
      name,
      { state: checks.get(name).state, code: checks.get(name).code },
    ]),
  );
  assert.notEqual(
    checks.get("connectivity").state,
    "succeeded",
    `unreachable Slack proxy must not report connected: ${JSON.stringify(observed)}`,
  );
  assert.ok(
    ["failed", "unknown"].includes(checks.get("connectivity").state),
    `unreachable Slack proxy must fail closed or report an unavailable probe: ${JSON.stringify(
      observed,
    )}`,
  );
}

function assertInvalidAuthRejected(diagnostics) {
  const checks = gatewayChannelChecks(diagnostics);
  assert.deepEqual(
    { state: checks.get("authentication").state, code: checks.get("authentication").code },
    { state: "failed", code: "AUTHENTICATION_FAILED" },
    `invalid Slack credentials must map to structured AUTHENTICATION_FAILED diagnostics: ${JSON.stringify(
      Object.fromEntries(checks),
    )}`,
  );
}

function assertConnectedSlackChecks(diagnostics) {
  const checks = gatewayChannelChecks(diagnostics);
  assert.deepEqual(
    Object.fromEntries(
      ["configuration", "authentication", "connectivity"].map((name) => [
        name,
        { state: checks.get(name).state, code: checks.get(name).code },
      ]),
    ),
    {
      configuration: { state: "succeeded", code: undefined },
      authentication: { state: "succeeded", code: undefined },
      connectivity: { state: "succeeded", code: undefined },
    },
  );
}

function assertNoSendSlackPrerequisites(revision) {
  const slack = revision.configuration?.channels?.slack;
  assert.equal(slack?.enabled, true, "Slack no-send proof requires Slack to be enabled");
  assert.equal(slack?.mode, "socket", "Slack no-send proof requires Socket Mode");
  assert.equal(slack?.dmPolicy, "allowlist");
  assert.deepEqual(slack?.allowFrom, [], "Slack no-send proof must disable DM replies");
  assert.deepEqual(slack?.channels, {}, "Slack no-send proof must not authorize channel replies");
  assert.ok(
    slack?.groupPolicy === undefined || slack.groupPolicy === "allowlist",
    "Slack no-send proof must not authorize channel groups outside the native allowlist shape",
  );
}

async function assertMissingCredentialAdmissionDenied(context) {
  const topology = await arrangeProductionTopology(context, "dedicated");
  const slack = noSendSlackFixture();
  const namespaceId = topology.agent.namespaceId;
  const protectedValues = [slack.appToken, slack.botToken, process.env.OPENAI_API_KEY];
  const appSecret = await createApiSecret(
    topology.request,
    namespaceId,
    `slack-nosend-app-${hash(randomUUID())}`,
    slack.appToken,
    protectedValues,
  );
  const botSecret = await createApiSecret(
    topology.request,
    namespaceId,
    `slack-nosend-bot-${hash(randomUUID())}`,
    slack.botToken,
    protectedValues,
  );
  const completeSecretBindings = {
    SLACK_APP_TOKEN: secretBinding(appSecret.ref),
    SLACK_BOT_TOKEN: secretBinding(botSecret.ref),
  };
  const completeConfiguration = await topology.request(
    "POST",
    `/namespaces/${namespaceId}/configurations`,
    {
      kind: "agent",
      values: slackNativeConfiguration(slack),
      secretBindings: completeSecretBindings,
    },
  );
  assertNoSecretMaterial(
    completeConfiguration,
    protectedValues,
    "complete Slack credential configuration response",
  );
  assert.equal(completeConfiguration.status, 201, JSON.stringify(completeConfiguration.error));
  assert.deepEqual(
    completeConfiguration.data.secretBindings,
    completeSecretBindings,
    "complete Slack credential control must admit the otherwise identical Configuration",
  );

  const incompleteSecretBindings = { SLACK_APP_TOKEN: secretBinding(appSecret.ref) };
  const configuration = await topology.request(
    "POST",
    `/namespaces/${namespaceId}/configurations`,
    {
      kind: "agent",
      values: slackNativeConfiguration(slack),
      secretBindings: incompleteSecretBindings,
    },
  );
  assertNoSecretMaterial(
    configuration,
    protectedValues,
    "missing Slack credential configuration response",
  );
  assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
  assert.deepEqual(configuration.data.secretBindings, incompleteSecretBindings);
  const created = await topology.request("POST", `/namespaces/${namespaceId}/agents`, {
    name: `slack-nosend-missing-${hash(randomUUID())}`,
    executionMode: "dedicated",
    configurationId: configuration.data.id,
    harnessAuth: topology.agent.harnessAuth,
  });
  assertNoSecretMaterial(created, protectedValues, "missing Slack credential Agent response");
  assert.equal(created.status, 201, JSON.stringify(created.error));
  await Promise.all([
    grantSecretOperate(
      topology.adminRequest,
      namespaceId,
      created.data.servicePrincipalId,
      topology.secretApi.model.id,
    ),
    grantSecretOperate(
      topology.adminRequest,
      namespaceId,
      created.data.servicePrincipalId,
      appSecret.id,
    ),
  ]);
  const deployed = await topology.request(
    "POST",
    `/namespaces/${namespaceId}/agents/${created.data.id}/deploy`,
  );
  assertNoSecretMaterial(deployed, protectedValues, "missing Slack credential deploy response");
  assert.deepEqual(
    {
      status: deployed.status,
      code: deployed.error?.code,
      message: deployed.error?.message,
    },
    {
      status: 409,
      code: "RESOURCE_CONFLICT",
      message: "The requested platform resource already exists.",
    },
    "Slack channel configuration missing a required Bot token binding must be rejected before revision admission",
  );
  const observed = await topology.request(
    "GET",
    `/namespaces/${namespaceId}/agents/${created.data.id}`,
  );
  assertNoSecretMaterial(observed, protectedValues, "missing Slack credential Agent read");
  assert.equal(observed.status, 200, JSON.stringify(observed.error));
  assert.equal(
    observed.data.activeRevisionId,
    undefined,
    "missing Slack credential deployment must not activate a revision",
  );
  const revisions = await topology.request(
    "GET",
    `/namespaces/${namespaceId}/agents/${created.data.id}/revisions`,
  );
  assert.equal(revisions.status, 200, JSON.stringify(revisions.error));
  assert.deepEqual(revisions.data, [], "missing channel bindings must not admit a revision");
  context.diagnostic(`slack no-send missing credential rejected deploy status ${deployed.status}`);
  return { topology, slack, agent: created.data, response: deployed, protectedValues };
}

async function arrangeNoSendSlackTopology(context, slack) {
  const topology = await arrangeProductionTopology(context, "dedicated", slack);
  return {
    topology,
    protectedValues: [slack.appToken, slack.botToken, process.env.OPENAI_API_KEY],
  };
}

function assertIsoTimestampAtOrAfter(value, startedAt, description) {
  assert.equal(typeof value, "string", `${description} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  assert.equal(Number.isNaN(parsed), false, `${description} must parse as an ISO timestamp`);
  assert.ok(parsed >= startedAt, `${description} must be fresh for the explicit diagnostic run`);
}

async function assertCurrentRuntimeDiagnosticsNoSend(context, topology, revision) {
  const startedAt = Date.now() - 1_000;
  const response = await topology.request(
    "POST",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/deployments/${revision.id}/diagnostics`,
  );
  assert.equal(response.status, 200, JSON.stringify(response.error));
  assertNoSecretMaterial(
    response,
    [process.env.OPENAI_API_KEY],
    "current runtime diagnostics response",
  );
  assert.deepEqual(
    Object.keys(response.data).sort(),
    ["checks", "observedAt", "revisionId"],
    "diagnostics response must use the approved opaque shape",
  );
  assert.equal(response.data.revisionId, revision.id);
  assertIsoTimestampAtOrAfter(response.data.observedAt, startedAt, "diagnostics observedAt");
  assert.ok(
    response.data.checks.length > 0,
    "current diagnostics must report at least one native runtime health check",
  );
  for (const check of response.data.checks) {
    assert.deepEqual(
      Object.keys(check).sort(),
      check.code === undefined
        ? ["check", "checkedAt", "component", "state"]
        : ["check", "checkedAt", "code", "component", "state"],
    );
    assert.equal(typeof check.component, "string");
    assert.equal(typeof check.check, "string");
    assert.match(check.component, /^[A-Za-z0-9._~:@-]{1,64}$/);
    assert.match(check.check, /^[A-Za-z0-9._~:@-]{1,64}$/);
    assert.ok(
      ["succeeded", "failed", "unknown"].includes(check.state),
      `unsupported diagnostic state ${check.state}`,
    );
    if (check.checkedAt !== null) {
      assertIsoTimestampAtOrAfter(
        check.checkedAt,
        startedAt,
        `${check.component}/${check.check} checkedAt`,
      );
    }
    if (check.code !== undefined) {
      assert.match(check.code, /^[A-Za-z0-9._~:@-]{1,64}$/);
    }
  }
  context.diagnostic(
    `runtime diagnostics: ${revision.id} reported ${response.data.checks.length} no-send checks`,
  );
  return response.data;
}

export {
  arrangeNoSendSlackTopology,
  assertConnectedSlackChecks,
  assertCurrentRuntimeDiagnosticsNoSend,
  assertInvalidAuthRejected,
  assertMissingCredentialAdmissionDenied,
  assertNoSendSlackPrerequisites,
  assertNoSecretMaterial,
  assertUnreachableSlackNotConnected,
  requiredNoSendSlackProxy,
  noSendSlackFixture,
  requiresNoSendSlackInvalid,
  requiresNoSendSlackLive,
  requiresProductionCluster,
};
