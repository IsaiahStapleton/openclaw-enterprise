import assert from "node:assert/strict";
import test from "node:test";

import { assertActualModelTurn } from "../helpers/harness-topology-k3d-real.mjs";

import {
  arrangeNoSendSlackTopology,
  assertConnectedSlackChecks,
  assertCurrentRuntimeDiagnosticsNoSend,
  assertInvalidAuthRejected,
  assertMissingCredentialAdmissionDenied,
  assertNoSendSlackPrerequisites,
  assertNoSecretMaterial,
  assertUnreachableSlackNotConnected,
  noSendSlackFixture,
  requiredNoSendSlackProxy,
  requiresNoSendSlackInvalid,
  requiresNoSendSlackLive,
  requiresProductionCluster,
} from "../helpers/harness-topology-k3d-slack-nosend.mjs";

test(
  "production Slack no-send diagnostics report unreachable channel as not connected",
  { ...requiresProductionCluster, timeout: 780_000 },
  async (context) => {
    const slack = noSendSlackFixture({ proxyUrl: "http://127.0.0.1:9" });
    const { topology, protectedValues } = await arrangeNoSendSlackTopology(context, slack);
    const diagnostics = await assertCurrentRuntimeDiagnosticsNoSend(
      context,
      topology,
      topology.revision,
    );
    assertUnreachableSlackNotConnected(diagnostics);
    assertNoSecretMaterial(diagnostics, protectedValues, "unreachable Slack diagnostics");
    context.diagnostic("slack no-send unreachable proxy: connectivity did not succeed");
  },
);

test(
  "production Slack no-send API rejects missing channel credentials",
  { ...requiresProductionCluster, timeout: 780_000 },
  async (context) => {
    const { response, protectedValues } = await assertMissingCredentialAdmissionDenied(context);
    assertNoSecretMaterial(response, protectedValues, "missing Slack credential rejection");
  },
);

test(
  "production Slack no-send diagnostics map invalid Slack auth to failed code",
  { ...requiresNoSendSlackInvalid, timeout: 780_000 },
  async (context) => {
    const slack = noSendSlackFixture({ proxyUrl: requiredNoSendSlackProxy() });
    const { topology, protectedValues } = await arrangeNoSendSlackTopology(context, slack);
    const diagnostics = await assertCurrentRuntimeDiagnosticsNoSend(
      context,
      topology,
      topology.revision,
    );
    assertInvalidAuthRejected(diagnostics);
    assertNoSecretMaterial(diagnostics, protectedValues, "invalid Slack auth diagnostics");
    context.diagnostic("slack no-send invalid auth: authentication failed with structured code");
  },
);

test(
  "production Slack no-send diagnostics prove configured authenticated connected without posting",
  { ...requiresNoSendSlackLive, timeout: 780_000 },
  async (context) => {
    const appToken = process.env.SLACK_APP_TOKEN ?? process.env.APP_TOKEN;
    const botToken = process.env.SLACK_BOT_TOKEN ?? process.env.BOT_TOKEN;
    assert.ok(
      appToken,
      "SLACK_APP_TOKEN or APP_TOKEN is required for live no-send Slack diagnostics.",
    );
    assert.ok(
      botToken,
      "SLACK_BOT_TOKEN or BOT_TOKEN is required for live no-send Slack diagnostics.",
    );
    const slack = noSendSlackFixture({
      proxyUrl: requiredNoSendSlackProxy(),
      appToken,
      botToken,
      disableEventResponses: true,
    });
    const { topology, protectedValues } = await arrangeNoSendSlackTopology(context, slack);
    assertNoSendSlackPrerequisites(topology.revision);
    await assertActualModelTurn(topology);
    const diagnostics = await assertCurrentRuntimeDiagnosticsNoSend(
      context,
      topology,
      topology.revision,
    );
    assertConnectedSlackChecks(diagnostics);
    assertNoSecretMaterial(diagnostics, protectedValues, "live Slack no-send diagnostics");
    context.diagnostic("slack no-send live: configured/authenticated/connected all succeeded");
  },
);
