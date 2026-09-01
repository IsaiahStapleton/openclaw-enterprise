import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { KubernetesClientNodePodExecutor } from "../../apps/controller/src/drivers/compute/kubernetes/pod-exec.ts";

test("Kubernetes pod exec rejects a pre-aborted signal before creating a client", async () => {
  let createdClient = false;
  const executor = new KubernetesClientNodePodExecutor(
    { mode: "inCluster" },
    (message) => new Error(message),
    {
      async createClientConfiguration() {
        createdClient = true;
        return { sdk: {}, kubeConfig: {} };
      },
    },
  );
  const abort = new AbortController();
  abort.abort(new Error("raw caller reason"));

  await assert.rejects(
    executor.exec(baseExecInput({ signal: abort.signal })),
    /Kubernetes Pod exec aborted\./,
  );
  assert.equal(createdClient, false);
});

test("Kubernetes pod exec bounds output and terminates the websocket", async () => {
  const socket = new FakeSocket();
  const executor = createPodExecutor({
    exec(_namespace, _podName, _containerName, _command, stdout) {
      queueMicrotask(() => stdout.write("x".repeat(65_537)));
      return Promise.resolve(socket);
    },
  });

  await assert.rejects(
    executor.exec(baseExecInput()),
    /Kubernetes Pod exec output exceeded limit\./,
  );
  assert.equal(socket.terminations, 1);
});

test("Kubernetes pod exec streams fixed stdin into an exact argv command", async () => {
  const socket = new FakeSocket();
  let observed;
  const executor = createPodExecutor({
    exec(namespace, podName, containerName, command, stdout, stderr, stdin, tty, status) {
      const chunks = [];
      stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stdin.on("end", () => {
        observed = {
          namespace,
          podName,
          containerName,
          command,
          stdin: Buffer.concat(chunks).toString("utf8"),
          tty,
        };
        stdout.write(JSON.stringify({ ok: true }));
        status({ status: "Success" });
      });
      return Promise.resolve(socket);
    },
  });

  const result = await executor.exec(
    baseExecInput({
      command: ["node", "/opt/openclaw/gateway-admin-helper.mjs"],
      stdin: JSON.stringify({ method: "status", params: {} }),
    }),
  );

  assert.deepEqual(result, {
    stdout: JSON.stringify({ ok: true }),
    stderr: "",
    status: { status: "Success" },
  });
  assert.deepEqual(observed, {
    namespace: "tenant",
    podName: "gateway-0",
    containerName: "gateway",
    command: ["node", "/opt/openclaw/gateway-admin-helper.mjs"],
    stdin: JSON.stringify({ method: "status", params: {} }),
    tty: false,
  });
  assert.equal(socket.terminations, 1);
});

test("Kubernetes pod exec terminates the websocket exactly once across late lifecycle races", async () => {
  const cases = [
    {
      name: "abort before websocket opens",
      async run() {
        const socket = new FakeSocket();
        let resolveExec;
        const executor = createPodExecutor({
          exec() {
            return new Promise((resolve) => {
              resolveExec = () => resolve(socket);
            });
          },
        });
        const abort = new AbortController();
        const result = executor.exec(baseExecInput({ signal: abort.signal }));
        abort.abort(new Error("raw caller reason"));

        await assert.rejects(result, /Kubernetes Pod exec aborted\./);
        resolveExec();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(socket.terminations, 1, "abort before open should terminate exactly once");
      },
    },
    {
      name: "completion before late abort",
      async run() {
        const socket = new FakeSocket();
        const executor = createPodExecutor({
          exec(
            _namespace,
            _podName,
            _containerName,
            _command,
            stdout,
            stderr,
            _stdin,
            _tty,
            status,
          ) {
            stdout.write("ok");
            stderr.write("warn");
            status({ status: "Success" });
            return Promise.resolve(socket);
          },
        });
        const abort = new AbortController();

        const result = await executor.exec(baseExecInput({ signal: abort.signal }));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(result, { stdout: "ok", stderr: "warn", status: { status: "Success" } });
        assert.equal(socket.terminations, 1, "successful completion should terminate exactly once");

        abort.abort(new Error("late abort"));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(socket.terminations, 1, "late abort should not terminate again");
      },
    },
  ];

  for (const lifecycleCase of cases) {
    await lifecycleCase.run();
  }
});

function createPodExecutor({ exec }) {
  return new KubernetesClientNodePodExecutor(
    { mode: "inCluster" },
    (message) => new Error(message),
    {
      async createClientConfiguration() {
        return { sdk: {}, kubeConfig: {} };
      },
      createExec() {
        return { exec };
      },
    },
  );
}

function baseExecInput(overrides = {}) {
  return {
    namespace: "tenant",
    podName: "gateway-0",
    containerName: "gateway",
    command: ["node", "-e", "process.exit(0)"],
    stdin: "fixed-stdin",
    timeoutMs: 1_000,
    ...overrides,
  };
}

class FakeSocket extends EventEmitter {
  terminations = 0;

  close() {
    this.emit("close");
  }

  terminate() {
    this.terminations += 1;
    this.emit("close");
  }
}
