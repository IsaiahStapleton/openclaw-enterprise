import assert from "node:assert/strict";

import {
  arrangeProductionTopology,
  requiresProductionCluster,
} from "./harness-topology-k3d-real.mjs";

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

async function arrangeNoSendSlackTopology(context, slack) {
  const topology = await arrangeProductionTopology(context, "dedicated", slack);
  return {
    topology,
    protectedValues: [slack.appToken, slack.botToken, process.env.OPENAI_API_KEY],
  };
}

export {
  arrangeNoSendSlackTopology,
  assertConnectedSlackChecks,
  assertInvalidAuthRejected,
  assertNoSendSlackPrerequisites,
  assertNoSecretMaterial,
  assertUnreachableSlackNotConnected,
  noSendSlackFixture,
  requiredNoSendSlackProxy,
  requiresNoSendSlackInvalid,
  requiresNoSendSlackLive,
  requiresProductionCluster,
};
