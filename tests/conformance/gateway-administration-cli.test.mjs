import assert from "node:assert/strict";
import test from "node:test";
import {
  GATEWAY_ADMINISTRATION_RESPONSE_MAX_BYTES,
  parseGatewayAdministrationCliOutput,
} from "../../apps/controller/src/drivers/compute/kubernetes/gateway-administration.ts";
import { ControllerGatewayUnknownOutcomeError } from "../../apps/controller/src/gateway/contracts.ts";

test("gateway administration CLI parser maps success and typed native request errors", () => {
  assert.deepEqual(
    parseGatewayAdministrationCliOutput(
      JSON.stringify({
        kind: "openclaw-gateway-cli-result",
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputExceeded: false,
        stdoutBytes: 29,
        stderrBytes: 0,
        response: { file: { name: "USER.md", content: "ok\n" } },
      }),
    ),
    { ok: true, payload: { file: { name: "USER.md", content: "ok\n" } } },
  );

  assert.deepEqual(
    parseGatewayAdministrationCliOutput(
      JSON.stringify({
        kind: "openclaw-gateway-cli-result",
        exitCode: 1,
        signal: null,
        timedOut: false,
        outputExceeded: false,
        stdoutBytes: 91,
        stderrBytes: 0,
        response: {
          ok: false,
          error: {
            type: "gateway_request_error",
            code: "BAD_REQUEST",
            message: "missing file name",
            details: { field: "name" },
            retryable: false,
          },
        },
      }),
    ),
    {
      ok: false,
      error: {
        code: "BAD_REQUEST",
        message: "missing file name",
        details: { field: "name" },
        retryable: false,
      },
    },
  );
});

test("gateway administration CLI parser treats incomplete outcomes as unknown after exec", () => {
  for (const envelope of [
    {
      kind: "openclaw-gateway-cli-result",
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      outputExceeded: false,
      stdoutBytes: 0,
      stderrBytes: 0,
    },
    {
      kind: "openclaw-gateway-cli-result",
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputExceeded: true,
      stdoutBytes: GATEWAY_ADMINISTRATION_RESPONSE_MAX_BYTES + 1,
      stderrBytes: 0,
    },
    {
      kind: "openclaw-gateway-cli-result",
      exitCode: 2,
      signal: null,
      timedOut: false,
      outputExceeded: false,
      stdoutBytes: 20,
      stderrBytes: 12,
    },
  ]) {
    assert.throws(
      () => parseGatewayAdministrationCliOutput(JSON.stringify(envelope)),
      ControllerGatewayUnknownOutcomeError,
    );
  }

  assert.throws(
    () => parseGatewayAdministrationCliOutput("not json"),
    ControllerGatewayUnknownOutcomeError,
  );
});
