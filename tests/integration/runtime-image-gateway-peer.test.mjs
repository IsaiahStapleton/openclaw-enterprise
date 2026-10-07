import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import {
  GATEWAY_READINESS_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
  PLUGIN_APP_SERVER_TOKEN_HMAC_DOMAIN,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  imageTestOptions,
  runDocker,
  commandOutput,
  createAdmittedRuntimeImageConfiguration,
  jsonLogEntries,
  runGatewaySmoke,
} from "../helpers/runtime-image-startup.mjs";

// The dedicated Gateway's in-place OpenClaw respawn for a changed Harness peer on
// the real runtime image. Split from runtime-image-startup.test.mjs by measured
// case durations; the peer outage and stale replacement exits are in
// runtime-image-startup-probe.test.mjs.

test(
  "runtime image Gateway respawns OpenClaw in place when its Harness peer changes",
  imageTestOptions,
  async (t) => {
    // A dedicated Codex Gateway with a plugin selection follows its Harness
    // peer status and holds a workspace node binding, as after a first deploy.
    const workspaceNodeId = randomBytes(32).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "oce-runtime-image-config-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const configurationPath = join(directory, "openclaw.json");
    await writeFile(
      configurationPath,
      JSON.stringify(createAdmittedRuntimeImageConfiguration("codex")),
    );
    const bindingPath = join(directory, "workspace-node.json");
    await writeFile(
      bindingPath,
      JSON.stringify({ revisionId: "revision-peer-respawn", deviceId: workspaceNodeId }),
    );
    const manifest = {
      kind: "codex",
      selections: {
        "codex-plugin:linear@openai-curated-remote": {
          enabled: true,
          toolDefaults: { approval: "provider_default" },
        },
      },
    };
    const { containerName } = await runGatewaySmoke(t, "codex", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      volumes: [
        `${configurationPath}:/etc/openclaw/openclaw.json:ro`,
        `${bindingPath}:/etc/openclaw-workspace-node/workspace-node.json:ro`,
      ],
      extraEnvironment: [
        "APP_SERVER_URL=ws://[::1]:4500",
        `OPENCLAW_PLUGIN_RUNTIME_JSON=${JSON.stringify({ manifest })}`,
        "OPENCLAW_PLUGIN_STATUS_CONTAINER=gateway",
        "OPENCLAW_PLUGIN_STATUS_PORT=18791",
        "OPENCLAW_RUNTIME_STATUS_PORT=18791",
        "OPENCLAW_RUNTIME_STATUS_CONTAINER=gateway",
        "OPENCLAW_WORKSPACE_NODE_PATH=/etc/openclaw-workspace-node/workspace-node.json",
        "OPENCLAW_AGENT_REVISION_ID=revision-peer-respawn",
        "OPENCLAW_POD_UID=pod-peer-respawn",
        "OPENCLAW_WORKSPACE_DIR=/home/node/workspace",
      ],
      // The wrapper waits for the Harness status, which the fixture serves.
      waitUntilReady: false,
    });
    const fixture = await readFile(
      new URL("../fixtures/runtime-gateway-peer-respawn.mjs", import.meta.url),
      "utf8",
    );
    let stdout;
    try {
      ({ stdout } = await runDocker(
        [
          "exec",
          "-e",
          `OCC_TEST_WORKSPACE_NODE_ID=${workspaceNodeId}`,
          "-e",
          `OCC_TEST_GATEWAY_READINESS=${GATEWAY_READINESS_ENTRYPOINT}`,
          "-e",
          `OCC_TEST_TOKEN_DOMAIN=${PLUGIN_APP_SERVER_TOKEN_HMAC_DOMAIN}`,
          containerName,
          "node",
          "--input-type=module",
          "-e",
          fixture,
        ],
        { timeout: 780_000 * imageSmokeTimeoutMultiplier },
      ));
    } catch (error) {
      const logs = await runDocker(["logs", containerName]).catch((logsError) => logsError);
      throw new Error(`${commandOutput(error)}\n${commandOutput(logs)}`, { cause: error });
    }
    const result = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.ok(result.samePeerOutageResponses >= 2);
    assert.ok(result.samePeerUnreadySamples >= 2);
    assert.ok(result.samePeerRecoveryResponses >= 1);
    assert.notDeepEqual(result.after, result.before);
    // The container, and the wrapper that is its main process, never restarted.
    const inspect = await runDocker([
      "inspect",
      containerName,
      "--format",
      "{{.State.Running}} {{.RestartCount}}",
    ]);
    assert.equal(inspect.stdout.trim(), "true 0");
    const logs = await runDocker(["logs", containerName]);
    const entries = jsonLogEntries(`${logs.stdout}\n${logs.stderr}`);
    const phases = entries
      .filter((entry) => entry.event === "runtime.startup_phase")
      .map((entry) => `${entry.phase}:${entry.outcome}`);
    assert.equal(phases.filter((phase) => phase === "native-spawn:ok").length, 1);
    assert.equal(phases.filter((phase) => phase === "runtime-assets:ok").length, 1);
    assert.ok(phases.includes("peer-status-changed:ok"), phases.join(", "));
    const respawn = entries.find(
      (entry) => entry.event === "runtime.startup_phase" && entry.phase === "gateway-respawn",
    );
    assert.equal(respawn?.outcome, "ok", phases.join(", "));
    const timeline = entries
      .filter((entry) => entry.event === "runtime.startup_phase")
      .map((entry) => `${entry.phase} ${entry.ms}/${entry.sinceStartMs} ms`);
    t.diagnostic(`in-place Gateway respawn took ${respawn.ms} ms: ${JSON.stringify(result)}`);
    t.diagnostic(`wrapper phases (duration/since start): ${timeline.join(", ")}`);
  },
);
