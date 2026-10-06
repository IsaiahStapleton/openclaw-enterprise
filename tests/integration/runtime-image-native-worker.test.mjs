// Runtime image native worker smoke tests split from
// runtime-image-startup-probe.test.mjs so CI can run them beside
// runtime-image-startup.test.mjs: workspace node enrollment and reconnect, and
// ephemeral native worker reconnect from an expired replayed setup code.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  imageTestOptions,
  runDocker,
  temporaryGatewayConfiguration,
  runGatewaySmoke,
} from "../helpers/runtime-image-startup.mjs";

test(
  "runtime image enrolls the restricted workspace node and reconnects with saved credentials",
  imageTestOptions,
  async (t) => {
    // The Kubernetes entrypoint admits the workspace command grant before pairing.
    const configurationPath = await temporaryGatewayConfiguration(t, "codex");
    const { containerName } = await runGatewaySmoke(t, "codex", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
    });
    const source = await readFile(
      new URL("../fixtures/runtime-workspace-node.mjs", import.meta.url),
      "utf8",
    );
    const { stdout } = await runDocker(
      ["exec", containerName, "node", "--input-type=module", "-e", source],
      { timeout: 240_000 * imageSmokeTimeoutMultiplier },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.sameIdentityAfterRestart, true);
    assert.equal(result.singleBootstrapCompletion, true);
    assert.equal(result.commands.length, 7);
  },
);

test(
  "runtime image reconnects an ephemeral native worker from an expired replayed setup code",
  imageTestOptions,
  async (t) => {
    // Pod restarts replay the enrollment Secret's setup code after its expiry.
    const configurationPath = await temporaryGatewayConfiguration(t, "codex");
    const { containerName } = await runGatewaySmoke(t, "codex", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
    });
    const source = await readFile(
      new URL("../fixtures/runtime-native-worker-restart.mjs", import.meta.url),
      "utf8",
    );
    const { stdout } = await runDocker(
      ["exec", containerName, "node", "--input-type=module", "-e", source],
      { timeout: 300_000 * imageSmokeTimeoutMultiplier },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.sameIdentityAfterExpiredReplay, true);
    assert.equal(result.singleBootstrapCompletion, true);
    assert.equal(result.unpairedExpiredRejected, true);
  },
);
