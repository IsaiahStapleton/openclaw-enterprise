import assert from "node:assert/strict";
import test from "node:test";
import { isTransientKubectlFailure, retryKubectlRead } from "../helpers/kubernetes-real.mjs";

// execFile rejects a non-zero kubectl exit with a numeric code and the
// captured stderr; a spawn failure has a string code and no stderr.
function kubectlFailure(stderr, code = 1) {
  return Object.assign(new Error(`Command failed: kubectl\n${stderr}`), { code, stderr });
}

// Verbatim stderr from run 37139165776 (finding 308): an exec into a Ready
// gateway Pod lost its stream.
const execStreamDropped =
  'Defaulted container "gateway" out of: gateway, prepare-private-state (init)\nerror: EOF\n';

function recordingOptions() {
  const sleeps = [];
  const logs = [];
  return {
    sleeps,
    logs,
    options: {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: (message) => logs.push(message),
    },
  };
}

test("a kubectl read retries a dropped exec stream and returns the next attempt's output", async () => {
  const { sleeps, logs, options } = recordingOptions();
  let calls = 0;
  const output = await retryKubectlRead(async () => {
    calls += 1;
    if (calls === 1) {
      throw kubectlFailure(execStreamDropped);
    }
    return '{"gateway":{}}';
  }, options);
  assert.equal(output, '{"gateway":{}}');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [500]);
  assert.deepEqual(logs, [
    "Transient kubectl failure (error: EOF); retrying in 500 ms (attempt 2/4)",
  ]);
});

test("kubectl transport failures are transient", () => {
  for (const stderr of [
    execStreamDropped,
    "error: unexpected EOF\n",
    "Unable to connect to the server: EOF\n",
    "Error from server: error dialing backend: EOF\n",
    "error: websocket: close 1006 (abnormal closure): unexpected EOF\n",
    "error: read tcp 127.0.0.1:50122->127.0.0.1:6443: read: connection reset by peer\n",
    "The connection to the server 0.0.0.0:6443 was refused - did you specify the right host or port?\nconnection refused\n",
    "Unable to connect to the server: net/http: TLS handshake timeout\n",
    "error: http2: client connection lost\n",
    "Error from server (ServiceUnavailable): the server is currently unable to handle the request\n",
    "Error from server: etcdserver: request timed out\n",
  ]) {
    assert.equal(isTransientKubectlFailure(kubectlFailure(stderr)), true, stderr);
  }
});

test("kubectl results and local failures are not transient", () => {
  for (const error of [
    kubectlFailure('Error from server (NotFound): pods "gateway-0" not found\n'),
    kubectlFailure(
      'Error from server (Forbidden): pods is forbidden: User "fixture" cannot list resource "pods"\n',
    ),
    // The remote command ran and failed: its output is the result, even when it
    // mentions a transport error of its own.
    kubectlFailure(
      "Error: connect ECONNREFUSED\nerror: EOF\ncommand terminated with exit code 1\n",
    ),
    // A remote command can print "error: EOF" and still succeed; kubectl then
    // exits 0 and nothing is thrown. A wrapper error without stderr is not kubectl's.
    new Error("error: EOF"),
    Object.assign(new Error("spawn kubectl ENOENT"), { code: "ENOENT", stderr: "" }),
  ]) {
    assert.equal(isTransientKubectlFailure(error), false, error.message);
  }
});

test("a kubectl read fails at once on a non-transient error", async () => {
  const { sleeps, options } = recordingOptions();
  const notFound = kubectlFailure('Error from server (NotFound): pods "gateway-0" not found\n');
  let calls = 0;
  await assert.rejects(
    retryKubectlRead(async () => {
      calls += 1;
      throw notFound;
    }, options),
    (error) => error === notFound,
  );
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test("a kubectl read gives up after four attempts with the last error", async () => {
  const { sleeps, logs, options } = recordingOptions();
  const failures = [];
  await assert.rejects(
    retryKubectlRead(async () => {
      const failure = kubectlFailure(execStreamDropped);
      failures.push(failure);
      throw failure;
    }, options),
    (error) => error === failures.at(-1),
  );
  assert.equal(failures.length, 4);
  assert.deepEqual(sleeps, [500, 1000, 2000]);
  assert.equal(logs.length, 3);
});
