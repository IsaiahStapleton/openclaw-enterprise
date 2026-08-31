import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  GatewayClient,
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
  type DeviceAuthTokenRecord,
  type DeviceIdentity,
  type GatewayClientHostDeps,
  type GatewayClientOptions,
} from "@openclaw/gateway-client";
import type { ErrorShape, HelloOk } from "@openclaw/gateway-protocol";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
  readPairingConnectErrorDetails,
} from "@openclaw/gateway-protocol/connect-error-details";
import { resolveGatewayStartupRetryAfterMs } from "@openclaw/gateway-protocol/startup-unavailable";
import type { GatewayCommandMethod } from "@openclaw-enterprise/contracts";
import { ControllerGatewayUnknownOutcomeError, isAllowedGatewayCommand } from "./contracts.ts";

const ED25519_RAW_KEY_LENGTH = 32;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const NATIVE_GATEWAY_RESPONSE_MAX_BYTES = 1024 * 1024;
const NATIVE_GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
const NATIVE_GATEWAY_ENROLLMENT_TIMEOUT_MS = 60_000;
const NATIVE_GATEWAY_STOP_TIMEOUT_MS = 1_000;
const NATIVE_GATEWAY_OPERATOR_ROLE = "operator";
const NATIVE_GATEWAY_OPERATOR_SCOPES = ["operator.admin"] as const;

export {
  NATIVE_GATEWAY_ENROLLMENT_TIMEOUT_MS,
  NATIVE_GATEWAY_OPERATOR_ROLE,
  NATIVE_GATEWAY_OPERATOR_SCOPES,
  NATIVE_GATEWAY_REQUEST_TIMEOUT_MS,
};

export type OpenClawGatewayNativeMethod = GatewayCommandMethod;
export type OpenClawGatewayNativeDeviceIdentity = DeviceIdentity;
export type OpenClawGatewayNativeTokenRecord = Required<DeviceAuthTokenRecord>;

export type OpenClawGatewayNativeRequest = {
  method: OpenClawGatewayNativeMethod;
  params?: unknown;
};

export type OpenClawGatewayNativeResult =
  { ok: true; payload: unknown } | { ok: false; error: ErrorShape };

type NativeClientCreateOptions = OpenClawGatewayNativeBaseOptions & {
  connectChallengeTimeoutMs: number;
  deviceToken?: string;
  hostDeps: GatewayClientHostDeps;
  onClose?: NonNullable<GatewayClientOptions["onClose"]>;
  onConnectError?: NonNullable<GatewayClientOptions["onConnectError"]>;
  onHelloOk?: NonNullable<GatewayClientOptions["onHelloOk"]>;
  requestTimeoutMs: number;
  scopes?: readonly string[];
  sharedToken?: string;
};

type NativeGatewayDeadline = {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
  readonly remainingMs: () => number;
  readonly throwIfAborted: () => void;
};

export type OpenClawGatewayNativeBaseOptions = {
  url: string;
  identity: OpenClawGatewayNativeDeviceIdentity;
};

export type OpenClawGatewayNativeBootstrapOptions = OpenClawGatewayNativeBaseOptions & {
  sharedToken: string;
  waitForPairingApproval?: () => Promise<void>;
  signal?: AbortSignal;
};

export type OpenClawGatewayNativeDispatchOptions = OpenClawGatewayNativeBaseOptions & {
  deviceToken: string;
  scopes: readonly string[];
  request: OpenClawGatewayNativeRequest;
  signal?: AbortSignal;
};

export class OpenClawGatewayNativeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenClawGatewayNativeConfigurationError";
  }
}

export class OpenClawGatewayNativeUnsupportedMethodError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`native gateway method is not allowed: ${method}`);
    this.name = "OpenClawGatewayNativeUnsupportedMethodError";
    this.method = method;
  }
}

export class OpenClawGatewayNativeEnrollmentError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "OpenClawGatewayNativeEnrollmentError";
    this.cause = cause;
  }
}

function assertAllowedOpenClawGatewayNativeMethod(
  method: string,
): asserts method is OpenClawGatewayNativeMethod {
  if (!isAllowedGatewayCommand(method)) {
    throw new OpenClawGatewayNativeUnsupportedMethodError(method);
  }
}

export function createOpenClawGatewayNativeDeviceIdentity(): OpenClawGatewayNativeDeviceIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);
  return {
    deviceId: deriveDeviceIdFromPublicKeyRaw(publicKeyRaw),
    privateKeyPem,
    publicKeyPem,
  };
}

export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  const publicKey = createPublicKey(publicKeyPem);
  assertEd25519Key(publicKey, "public key");
  const spki = publicKey.export({ type: "spki", format: "der" });
  if (
    spki.length !== ED25519_SPKI_PREFIX.length + ED25519_RAW_KEY_LENGTH ||
    !spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    throw new OpenClawGatewayNativeConfigurationError(
      "native gateway public key must use canonical Ed25519 SPKI encoding",
    );
  }
  return spki.subarray(ED25519_SPKI_PREFIX.length).toString("base64url");
}

export function deriveDeviceIdFromPublicKeyRaw(publicKeyRawBase64Url: string): string {
  const raw = Buffer.from(publicKeyRawBase64Url, "base64url");
  if (raw.length !== ED25519_RAW_KEY_LENGTH) {
    throw new OpenClawGatewayNativeConfigurationError(
      "native gateway public key must contain exactly 32 raw Ed25519 bytes",
    );
  }
  return createHash("sha256").update(raw).digest("hex");
}

export function validateOpenClawGatewayNativeDeviceIdentity(
  identity: OpenClawGatewayNativeDeviceIdentity,
): void {
  const privateKey = createPrivateKey(identity.privateKeyPem);
  assertEd25519Key(privateKey, "private key");
  const publicKey = createPublicKey(identity.publicKeyPem);
  assertEd25519Key(publicKey, "public key");
  const publicKeyRaw = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  const derivedDeviceId = deriveDeviceIdFromPublicKeyRaw(publicKeyRaw);
  if (identity.deviceId !== derivedDeviceId) {
    throw new OpenClawGatewayNativeConfigurationError(
      "native gateway device id does not match the public key",
    );
  }
  const pairValidationPayload = "openclaw-enterprise-native-device-identity-validation";
  const signature = sign(null, Buffer.from(pairValidationPayload, "utf8"), privateKey);
  if (!verify(null, Buffer.from(pairValidationPayload, "utf8"), publicKey, signature)) {
    throw new OpenClawGatewayNativeConfigurationError(
      "native gateway private key does not match the public key",
    );
  }
}

export function signOpenClawGatewayNativePayload(privateKeyPem: string, payload: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  assertEd25519Key(privateKey, "private key");
  return sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
}

export function normalizeOpenClawGatewayNativeOperatorScopes(
  scopes: readonly string[],
  label = "native gateway operator scopes",
): readonly string[] {
  const normalized = scopes.map((scope) => scope.trim());
  const expected = [...NATIVE_GATEWAY_OPERATOR_SCOPES].sort();
  const observed = [...new Set(normalized)].sort();
  const exact =
    observed.length === normalized.length &&
    observed.length === expected.length &&
    observed.every((scope, index) => scope === expected[index]);
  if (!exact) {
    throw new OpenClawGatewayNativeConfigurationError(`${label} must be exactly operator.admin`);
  }
  return [...NATIVE_GATEWAY_OPERATOR_SCOPES];
}

export async function connectOpenClawGatewayNativeWithBootstrap(
  options: OpenClawGatewayNativeBootstrapOptions,
): Promise<OpenClawGatewayNativeTokenRecord> {
  validateOpenClawGatewayNativeDeviceIdentity(options.identity);
  assertNonEmpty(options.sharedToken, "native gateway shared token");

  const deadline = createNativeGatewayDeadline({
    timeoutMs: NATIVE_GATEWAY_ENROLLMENT_TIMEOUT_MS,
    timeoutMessage: `native gateway enrollment timed out after ${NATIVE_GATEWAY_ENROLLMENT_TIMEOUT_MS}ms`,
    abortMessage: "native gateway enrollment wait aborted",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  let pairingApprovalUsed = false;
  try {
    for (;;) {
      try {
        return await connectOpenClawGatewayNativeBootstrapAttempt(options, deadline);
      } catch (error) {
        if (
          pairingApprovalUsed ||
          options.waitForPairingApproval === undefined ||
          !isManualPairingRequired(error)
        ) {
          throw error;
        }
        pairingApprovalUsed = true;
        deadline.throwIfAborted();
        await waitForGatewayNativePairingApproval(options.waitForPairingApproval, deadline.signal);
        deadline.throwIfAborted();
      }
    }
  } catch (error) {
    throw new OpenClawGatewayNativeEnrollmentError(
      "native gateway bootstrap enrollment did not return a durable device token",
      error,
    );
  } finally {
    deadline.dispose();
  }
}

async function connectOpenClawGatewayNativeBootstrapAttempt(
  options: OpenClawGatewayNativeBootstrapOptions,
  deadline: NativeGatewayDeadline,
): Promise<OpenClawGatewayNativeTokenRecord> {
  const tokenWaiter = createGatewayNativeWaiter<OpenClawGatewayNativeTokenRecord>(deadline.signal);
  let capturedToken: OpenClawGatewayNativeTokenRecord | undefined;
  const client = createGatewayNativeClient({
    ...options,
    sharedToken: options.sharedToken,
    requestTimeoutMs: NATIVE_GATEWAY_ENROLLMENT_TIMEOUT_MS,
    connectChallengeTimeoutMs: NATIVE_GATEWAY_ENROLLMENT_TIMEOUT_MS,
    hostDeps: nativeHostDeps(options, (record) => {
      capturedToken = record;
    }),
    onConnectError: (error) => {
      if (!shouldContinueEnrollmentAfterConnectFailure(error)) tokenWaiter.reject(error);
    },
    onClose: (code, reason, info) => {
      if (info?.phase !== "post-hello") {
        const closeError = info?.connectError ?? errorFromGatewayClose(code, reason);
        if (!shouldContinueEnrollmentAfterConnectFailure(closeError))
          tokenWaiter.reject(closeError);
      }
    },
    onHelloOk: (hello) => {
      try {
        assertGatewayNativeOperatorHello(hello);
      } catch (error) {
        tokenWaiter.reject(error);
        return;
      }
      const record = capturedToken ?? tokenRecordFromHello(hello);
      if (record === undefined) {
        tokenWaiter.reject(
          new OpenClawGatewayNativeEnrollmentError(
            "native gateway bootstrap enrollment did not return a durable device token",
          ),
        );
        return;
      }
      tokenWaiter.resolve(record);
    },
  });

  try {
    deadline.throwIfAborted();
    client.start();
    return await tokenWaiter.promise;
  } finally {
    await stopGatewayNativeClient(client);
  }
}

export async function requestOpenClawGatewayNative(
  options: OpenClawGatewayNativeDispatchOptions,
): Promise<OpenClawGatewayNativeResult> {
  validateOpenClawGatewayNativeDeviceIdentity(options.identity);
  assertAllowedOpenClawGatewayNativeMethod(options.request.method);
  assertNonEmpty(options.deviceToken, "native gateway device token");
  if (options.scopes.length === 0) {
    throw new OpenClawGatewayNativeConfigurationError(
      "native gateway device token scopes must not be empty",
    );
  }
  const scopes = normalizeOpenClawGatewayNativeOperatorScopes(
    options.scopes,
    "native gateway device token scopes",
  );

  const deadline = createNativeGatewayDeadline({
    timeoutMs: NATIVE_GATEWAY_REQUEST_TIMEOUT_MS,
    timeoutMessage: `native gateway request timed out before ${options.request.method} completed`,
    abortMessage: `native gateway request wait aborted for ${options.request.method}`,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const helloWaiter = createGatewayNativeWaiter<HelloOk>(deadline.signal);
  const client = createGatewayNativeClient({
    ...options,
    deviceToken: options.deviceToken,
    scopes,
    requestTimeoutMs: NATIVE_GATEWAY_REQUEST_TIMEOUT_MS,
    connectChallengeTimeoutMs: NATIVE_GATEWAY_REQUEST_TIMEOUT_MS,
    hostDeps: nativeHostDeps(options),
    onConnectError: helloWaiter.reject,
    onClose: (code, reason, info) => {
      if (info?.phase !== "post-hello") {
        helloWaiter.reject(errorFromGatewayClose(code, reason));
      }
    },
    onHelloOk: (hello) => {
      try {
        assertGatewayNativeOperatorHello(hello);
      } catch (error) {
        helloWaiter.reject(error);
        return;
      }
      helloWaiter.resolve(hello);
    },
  });
  let requestSent = false;

  try {
    deadline.throwIfAborted();
    client.start();
    await helloWaiter.promise;
    deadline.throwIfAborted();
    const requestTimeoutMs = deadline.remainingMs();
    const payload = await client.request(options.request.method, options.request.params, {
      expectFinal: false,
      timeoutMs: requestTimeoutMs,
      signal: deadline.signal,
      onSent: () => {
        requestSent = true;
      },
    });
    const publicPayload = projectNativeGatewaySuccessPayload(options.request.method, payload);
    assertResponseFitsNativeGatewayLimit(options.request.method, {
      ok: true,
      payload: publicPayload,
    });
    return { ok: true, payload: publicPayload };
  } catch (error) {
    if (error instanceof GatewayClientRequestError && requestSent) {
      const nativeError: ErrorShape = {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      };
      assertResponseFitsNativeGatewayLimit(options.request.method, {
        ok: false,
        error: nativeError,
      });
      return { ok: false, error: nativeError };
    }
    if (error instanceof ControllerGatewayUnknownOutcomeError) {
      throw error;
    }
    if (requestSent || (error instanceof GatewayClientRequestTimeoutError && error.requestSent)) {
      throw new ControllerGatewayUnknownOutcomeError(
        `The native gateway command outcome is unknown for ${options.request.method}.`,
        {
          cause: error,
        },
      );
    }
    throw error;
  } finally {
    deadline.dispose();
    await stopGatewayNativeClient(client);
  }
}

function createGatewayNativeClient(options: NativeClientCreateOptions): GatewayClient {
  const gatewayOptions: GatewayClientOptions = {
    url: options.url,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "OpenClaw Enterprise OCC",
    clientVersion: "0.1.0",
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    role: NATIVE_GATEWAY_OPERATOR_ROLE,
    scopes: [...(options.scopes ?? NATIVE_GATEWAY_OPERATOR_SCOPES)],
    deviceIdentity: options.identity,
    ...(options.sharedToken === undefined ? {} : { token: options.sharedToken }),
    ...(options.deviceToken === undefined ? {} : { deviceToken: options.deviceToken }),
    requestTimeoutMs: options.requestTimeoutMs,
    connectChallengeTimeoutMs: options.connectChallengeTimeoutMs,
    hostDeps: options.hostDeps,
    ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
    ...(options.onConnectError === undefined ? {} : { onConnectError: options.onConnectError }),
    ...(options.onHelloOk === undefined ? {} : { onHelloOk: options.onHelloOk }),
  };
  return new GatewayClient(gatewayOptions);
}

function nativeHostDeps(
  options: OpenClawGatewayNativeBaseOptions,
  captureToken?: (record: OpenClawGatewayNativeTokenRecord) => void,
): GatewayClientHostDeps {
  const hostDeps: GatewayClientHostDeps = {
    loadOrCreateDeviceIdentity: () => options.identity,
    signDevicePayload: signOpenClawGatewayNativePayload,
    publicKeyRawBase64UrlFromPem,
    loadDeviceAuthToken: () => null,
    storeDeviceAuthToken: (record) => {
      const normalized = tokenRecordFromDeviceAuth(record);
      if (normalized !== undefined) captureToken?.(normalized);
    },
    clearDeviceAuthToken: () => {},
  };
  return hostDeps;
}

function tokenRecordFromHello(hello: HelloOk): OpenClawGatewayNativeTokenRecord | undefined {
  return tokenRecordFromDeviceAuth({
    scopes: hello.auth.scopes,
    ...(hello.auth.deviceToken === undefined ? {} : { token: hello.auth.deviceToken }),
  });
}

function tokenRecordFromDeviceAuth(
  record: DeviceAuthTokenRecord,
): OpenClawGatewayNativeTokenRecord | undefined {
  const token = record.token?.trim();
  if (token === undefined || token.length === 0) return undefined;
  if (record.scopes === undefined) return undefined;
  let scopes: readonly string[];
  try {
    scopes = normalizeOpenClawGatewayNativeOperatorScopes(record.scopes);
  } catch {
    return undefined;
  }
  return { token, scopes: [...scopes] };
}

function shouldContinueEnrollmentAfterConnectFailure(error: unknown): boolean {
  if (resolveGatewayStartupRetryAfterMs(error) !== null) return true;
  if (!(error instanceof GatewayClientRequestError)) return false;
  if (readConnectErrorDetailCode(error.details) !== ConnectErrorDetailCodes.PAIRING_REQUIRED) {
    return false;
  }
  const pairing = readPairingConnectErrorDetails(error.details);
  return pairing?.pauseReconnect === false || pairing?.recommendedNextStep === "wait_then_retry";
}

function isManualPairingRequired(error: unknown): boolean {
  return (
    error instanceof GatewayClientRequestError &&
    readConnectErrorDetailCode(error.details) === ConnectErrorDetailCodes.PAIRING_REQUIRED &&
    !shouldContinueEnrollmentAfterConnectFailure(error)
  );
}

async function waitForGatewayNativePairingApproval(
  waitForPairingApproval: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("native gateway enrollment wait aborted");
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new Error("native gateway enrollment wait aborted"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([waitForPairingApproval(), aborted]);
  } finally {
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}

function assertGatewayNativeOperatorHello(hello: HelloOk): void {
  if (hello.auth.role !== NATIVE_GATEWAY_OPERATOR_ROLE) {
    throw new OpenClawGatewayNativeConfigurationError(
      "native gateway hello-ok must grant operator role with operator.admin scope",
    );
  }
  normalizeOpenClawGatewayNativeOperatorScopes(hello.auth.scopes, "native gateway hello-ok scopes");
}

function createGatewayNativeWaiter<T>(signal: AbortSignal): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const cleanup = () => signal.removeEventListener("abort", abort);
  const settle = (callback: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    callback();
  };
  const abort = () => {
    settle(() => rejectPromise(signal.reason ?? new Error("native gateway wait aborted")));
  };
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return {
    promise,
    resolve: (value) => settle(() => resolvePromise(value)),
    reject: (reason) => settle(() => rejectPromise(reason)),
  };
}

function createNativeGatewayDeadline(options: {
  timeoutMs: number;
  signal?: AbortSignal;
  timeoutMessage: string;
  abortMessage: string;
}): NativeGatewayDeadline {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => {
    controller.abort(new Error(options.timeoutMessage));
  }, options.timeoutMs);
  timeout.unref?.();
  const abort = () => {
    controller.abort(options.signal?.reason ?? new Error(options.abortMessage));
  };
  if (options.signal?.aborted === true) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    },
    remainingMs: () => {
      const remaining = options.timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) controller.abort(new Error(options.timeoutMessage));
      return Math.max(1, remaining);
    },
    throwIfAborted: () => {
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new Error(options.abortMessage);
      }
    },
  };
}

async function stopGatewayNativeClient(client: GatewayClient): Promise<void> {
  try {
    await client.stopAndWait({ timeoutMs: NATIVE_GATEWAY_STOP_TIMEOUT_MS });
  } catch {
    client.stop();
  }
}

function errorFromGatewayClose(code: number, reason: string): Error {
  const closeReason =
    reason.trim().length === 0 ? "without a close reason" : `with reason: ${reason}`;
  return new Error(`native gateway socket closed before hello-ok (${code}) ${closeReason}`);
}

function assertEd25519Key(key: KeyObject, label: string): void {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new OpenClawGatewayNativeConfigurationError(
      `native gateway ${label} must be an Ed25519 key`,
    );
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new OpenClawGatewayNativeConfigurationError(`${label} must not be empty`);
  }
}

function projectNativeGatewaySuccessPayload(
  method: OpenClawGatewayNativeMethod,
  payload: unknown,
): unknown {
  if (method !== "config.get" || !isNativeGatewayPayloadRecord(payload)) {
    return payload;
  }
  const publicPayload = { ...payload };
  delete publicPayload.sourceConfigBeforeMigrations;
  return publicPayload;
}

function isNativeGatewayPayloadRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertResponseFitsNativeGatewayLimit(
  method: string,
  value: OpenClawGatewayNativeResult,
): void {
  const serialized = JSON.stringify(value);
  const observedBytes = Buffer.byteLength(serialized, "utf8");
  if (observedBytes > NATIVE_GATEWAY_RESPONSE_MAX_BYTES) {
    throw new ControllerGatewayUnknownOutcomeError(
      `The native gateway response exceeded ${NATIVE_GATEWAY_RESPONSE_MAX_BYTES} bytes after dispatch for ${method}.`,
      {
        cause: new Error(`native gateway response was ${observedBytes} bytes`),
      },
    );
  }
}
