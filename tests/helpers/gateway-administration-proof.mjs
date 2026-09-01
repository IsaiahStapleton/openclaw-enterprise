import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  buildGatewayAdministrationCliScript,
  gatewayAdministrationCliInput,
  parseGatewayAdministrationCliOutput,
} from "../../apps/controller/src/drivers/compute/kubernetes/gateway-administration.ts";
import { KubernetesClientNodePodExecutor } from "../../apps/controller/src/drivers/compute/kubernetes/pod-exec.ts";

/** Real native/Kubernetes boundaries with faults injected only after genuine effects. */
export async function runGatewayAdministrationFailureProofs(topology, callbacks) {
  await proveLostCliOutcomeAfterRealEffect(topology, callbacks);
  await proveExecBoundaries(topology, callbacks);
}

async function proveLostCliOutcomeAfterRealEffect(topology, callbacks) {
  const driver = topology.apiComputeDriver;
  const originalExecutor = driver.podExecutor;
  assert.equal(typeof originalExecutor?.exec, "function");
  const content = "OCC lost native CLI response " + randomUUID() + "\n";
  const stats = { requests: 0, dropped: 0 };

  driver.podExecutor = {
    async exec(input) {
      const request = JSON.parse(input.stdin);
      const result = await originalExecutor.exec(input);
      if (
        request.method === "agents.files.set" &&
        request.params?.name === "USER.md" &&
        request.params?.content === content
      ) {
        stats.requests += 1;
        stats.dropped += 1;
        return {
          stdout: JSON.stringify({
            kind: "openclaw-gateway-cli-result",
            exitCode: null,
            signal: "SIGTERM",
            timedOut: true,
            outputExceeded: false,
            stdoutBytes: result.stdout.length,
            stderrBytes: result.stderr.length,
          }),
          stderr: "",
        };
      }
      return result;
    },
  };
  try {
    const result = await callbacks.dispatchOccGatewayCommand(topology, "agents.files.set", {
      agentId: "main",
      name: "USER.md",
      content,
    });
    assert.equal(result.status, 503);
    assert.equal(result.error?.code, "UNKNOWN_OUTCOME");
  } finally {
    driver.podExecutor = originalExecutor;
  }

  assert.equal(stats.requests, 1, "a sent native CLI mutation must not be replayed");
  assert.equal(stats.dropped, 1, "the injected failure must replace one genuine CLI success");
  const read = callbacks.assertOccGatewaySuccess(
    await callbacks.dispatchOccGatewayCommand(topology, "agents.files.get", {
      agentId: "main",
      name: "USER.md",
    }),
    "agents.files.get",
  );
  assert.equal(read.file.content, content, "native CLI execution survives its lost response");
  callbacks.diagnostic(
    "PASS real native CLI lost response: UNKNOWN_OUTCOME, one exec, persisted file",
  );
}

async function proveExecBoundaries(topology, callbacks) {
  const input = cliInput(topology, "status");
  const execute = (authentication, stdin) =>
    new KubernetesClientNodePodExecutor(authentication, (message) => new Error(message)).exec({
      namespace: topology.placement,
      podName: topology.gatewayPod.metadata.name,
      containerName: "gateway",
      command: ["node", "-e", buildGatewayAdministrationCliScript()],
      stdin,
      timeoutMs: 8_000,
    });

  // Gateway administration belongs to the API identity. The worker identity
  // can reconcile workloads, but it must not receive the Pod exec permission.
  await assert.rejects(execute(topology.workerAuthentication, input), {
    message: "Kubernetes Pod exec failed to start.",
  });
  const status = await execute(topology.apiAuthentication, input);
  const parsed = parseGatewayAdministrationCliOutput(status.stdout);
  assert.equal(parsed.ok, true);

  const started = Date.now();
  const rejected = await execute(
    topology.apiAuthentication,
    cliInput(topology, "agents.files.set", { agentId: "main", name: "USER.md" }, 5_000),
  );
  const parsedRejection = parseGatewayAdministrationCliOutput(rejected.stdout);
  assert.equal(parsedRejection.ok, false);
  assert.equal(typeof parsedRejection.error.code, "string");
  assert.equal(typeof parsedRejection.error.message, "string");
  assert.ok(Date.now() - started < 8_000, "the helper must finish before the outer exec deadline");
  callbacks.diagnostic("PASS real denied exec and CLI error-envelope parsing");
}

function cliInput(topology, method, params, timeoutMs = 5_000) {
  const port = topology.gatewayPod.spec.containers
    .find((item) => item.name === "gateway")
    .ports.find((item) => item.name === "http").containerPort;
  return gatewayAdministrationCliInput({ method, params, port, timeoutMs });
}
