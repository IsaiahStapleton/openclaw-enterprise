import type {
  GatewayCommandMethod,
  OpenClawConfigurationValue,
} from "@openclaw-enterprise/contracts";
import {
  ControllerGatewayUnknownOutcomeError,
  type ControllerGatewayDispatchResult,
  type ControllerGatewayRpcError,
} from "../../../gateway/contracts.ts";

export const GATEWAY_ADMINISTRATION_REQUEST_TIMEOUT_MS = 30_000;
export const GATEWAY_ADMINISTRATION_RESPONSE_MAX_BYTES = 1024 * 1024;
export const GATEWAY_ADMINISTRATION_STDERR_MAX_BYTES = 64 * 1024;

const HELPER_RESULT_KIND = "openclaw-gateway-cli-result";

export interface GatewayAdministrationCliRequest {
  readonly method: GatewayCommandMethod;
  readonly params?: unknown;
  readonly port: number;
  readonly timeoutMs: number;
}

interface GatewayAdministrationCliEnvelope {
  readonly kind: typeof HELPER_RESULT_KIND;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputExceeded: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly response?: unknown;
}

export function gatewayAdministrationCliInput(input: GatewayAdministrationCliRequest): string {
  return JSON.stringify({
    method: input.method,
    ...(input.params === undefined ? {} : { params: input.params }),
    port: input.port,
    timeoutMs: input.timeoutMs,
    responseMaxBytes: GATEWAY_ADMINISTRATION_RESPONSE_MAX_BYTES,
    stderrMaxBytes: GATEWAY_ADMINISTRATION_STDERR_MAX_BYTES,
  });
}

export function parseGatewayAdministrationCliOutput(
  stdout: string,
): ControllerGatewayDispatchResult {
  const envelope = parseHelperEnvelope(stdout);
  if (envelope.timedOut || envelope.outputExceeded || envelope.signal !== null) {
    throw new ControllerGatewayUnknownOutcomeError(
      "The native gateway command may have started, but the controller could not observe its final outcome.",
    );
  }
  if (envelope.exitCode === 0) {
    const payload = asConfigurationValue(envelope.response);
    return { ok: true, ...(payload === undefined ? {} : { payload }) };
  }
  if (envelope.exitCode === 1) {
    const requestError = readGatewayRequestError(envelope.response);
    if (requestError !== undefined) {
      return { ok: false, error: requestError };
    }
  }
  throw new ControllerGatewayUnknownOutcomeError(
    "The native gateway command exited without a supported controller response.",
  );
}

export function buildGatewayAdministrationCliScript(): string {
  return String.raw`
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");

const HELPER_RESULT_KIND = "openclaw-gateway-cli-result";
const input = JSON.parse(readFileSync(0, "utf8"));
const method = requiredString(input.method, "method");
const port = requiredPort(input.port);
const timeoutMs = requiredTimeout(input.timeoutMs);
const responseMaxBytes = requiredLimit(input.responseMaxBytes);
const stderrMaxBytes = requiredLimit(input.stderrMaxBytes);
const paramsJson = JSON.stringify(input.params === undefined ? {} : input.params);

let timedOut = false;
let outputExceeded = false;
const child = spawn("openclaw", [
  "gateway",
  "call",
  method,
  "--params",
  paramsJson,
  "--json",
  "--timeout",
  String(timeoutMs),
  "--port",
  String(port),
], {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

const stdout = collect(child.stdout, responseMaxBytes);
const stderr = collect(child.stderr, stderrMaxBytes);
const killTimer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 1000).unref();
}, timeoutMs);
killTimer.unref();

child.on("error", () => {
  outputExceeded = true;
});

child.on("close", (exitCode, signal) => {
  clearTimeout(killTimer);
  const parsed = exitCode === 0 || exitCode === 1 ? parseJson(stdout.text()) : undefined;
  writeResult({
    kind: HELPER_RESULT_KIND,
    exitCode,
    signal,
    timedOut,
    outputExceeded: outputExceeded || stdout.exceeded() || stderr.exceeded() || parsed === undefined,
    stdoutBytes: stdout.bytes(),
    stderrBytes: stderr.bytes(),
    ...(parsed === undefined ? {} : { response: stripSensitiveConfig(method, parsed) }),
  });
});

function collect(stream, maxBytes) {
  let size = 0;
  let exceeded = false;
  const chunks = [];
  stream.on("data", (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      exceeded = true;
      outputExceeded = true;
      child.kill("SIGTERM");
      return;
    }
    chunks.push(buffer);
  });
  return {
    bytes: () => size,
    exceeded: () => exceeded,
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stripSensitiveConfig(methodName, value) {
  if (methodName !== "config.get" || value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const { sourceConfigBeforeMigrations, ...safe } = value;
  return safe;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(name + " must be a nonempty string.");
  }
  return value;
}

function requiredPort(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("port must be a valid TCP port.");
  }
  return value;
}

function requiredTimeout(value) {
  if (!Number.isInteger(value) || value < 1 || value > 30000) {
    throw new Error("timeoutMs must be between 1 and 30000.");
  }
  return value;
}

function requiredLimit(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("output limit must be a positive integer.");
  }
  return value;
}

function writeResult(value) {
  process.stdout.write(JSON.stringify(value));
}
`;
}

function parseHelperEnvelope(stdout: string): GatewayAdministrationCliEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ControllerGatewayUnknownOutcomeError(
      "The native gateway command produced an invalid controller response.",
    );
  }
  const envelope = asRecord(parsed);
  if (
    envelope?.kind !== HELPER_RESULT_KIND ||
    !isExitCode(envelope.exitCode) ||
    !isSignal(envelope.signal) ||
    typeof envelope.timedOut !== "boolean" ||
    typeof envelope.outputExceeded !== "boolean" ||
    !isSafeByteCount(envelope.stdoutBytes) ||
    !isSafeByteCount(envelope.stderrBytes)
  ) {
    throw new ControllerGatewayUnknownOutcomeError(
      "The native gateway command produced an invalid controller response.",
    );
  }
  return envelope as unknown as GatewayAdministrationCliEnvelope;
}

function readGatewayRequestError(value: unknown): ControllerGatewayRpcError | undefined {
  const response = asRecord(value);
  const error = asRecord(response?.error);
  if (response?.ok !== false || error?.type !== "gateway_request_error") return undefined;
  if (typeof error.code !== "string" || typeof error.message !== "string") return undefined;
  return {
    code: error.code,
    message: error.message,
    ...(isConfigurationValue(error.details) ? { details: error.details } : {}),
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
    ...(typeof error.retryAfterMs === "number" && Number.isSafeInteger(error.retryAfterMs)
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
}

function asConfigurationValue(value: unknown): OpenClawConfigurationValue | undefined {
  if (value === undefined) return undefined;
  if (!isConfigurationValue(value)) {
    throw new ControllerGatewayUnknownOutcomeError(
      "The native gateway command returned a non-JSON response.",
    );
  }
  return value;
}

function isConfigurationValue(value: unknown): value is OpenClawConfigurationValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isConfigurationValue);
  const record = asRecord(value);
  if (record === undefined) return false;
  return Object.values(record).every(isConfigurationValue);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isExitCode(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isSignal(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isSafeByteCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
