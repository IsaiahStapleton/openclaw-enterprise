import { asRecord, isNonEmptyString, sha256Hex } from "@openclaw-enterprise/utils";
import {
  NATIVE_GATEWAY_ENROLLMENT_TIMEOUT_MS,
  NATIVE_GATEWAY_OPERATOR_ROLE,
  NATIVE_GATEWAY_OPERATOR_SCOPES,
  normalizeOpenClawGatewayNativeOperatorScopes,
  openClawGatewayNativeDeviceIdentityFromPrivateKey,
  type OpenClawGatewayNativeDeviceIdentity,
  type OpenClawGatewayNativeTokenRecord,
} from "../../../gateway/native-client.ts";

const PRIVATE_KEY_KEY = "private-key-pem";
const DEVICE_TOKEN_KEY = "device-token";
const DEVICE_TOKEN_SCOPES_KEY = "device-token-scopes";
const DEFAULT_SECRET_PREFIX = "occ-gateway-admin";

export interface KubernetesGatewayAdministrationOptions {
  readonly controllerNamespace: string;
}

export type GatewayAdministrationCredential =
  | {
      readonly state: "established";
      readonly identity: OpenClawGatewayNativeDeviceIdentity;
      readonly deviceToken: OpenClawGatewayNativeTokenRecord;
    }
  | {
      readonly state: "keyOnly";
      readonly identity: OpenClawGatewayNativeDeviceIdentity;
    };

export function validateGatewayAdministrationOptions(
  value: unknown,
): KubernetesGatewayAdministrationOptions {
  const options = asRecord(value);
  if (options === undefined) {
    throw new Error("Gateway administration requires explicit configuration.");
  }
  for (const key of Object.keys(options)) {
    if (key !== "controllerNamespace") {
      throw new Error(`Gateway administration contains unsupported option ${key}.`);
    }
  }
  const controllerNamespace = requiredString(
    options.controllerNamespace,
    "Gateway administration controller namespace",
  );
  return { controllerNamespace };
}

export function gatewayAdministrationSecretName(input: {
  readonly namespaceId: string;
  readonly agentId: string;
}): string {
  return `${DEFAULT_SECRET_PREFIX}-${sha256Hex(`${input.namespaceId}\0${input.agentId}`, 32)}`;
}

export function gatewayAdministrationSecretStringData(
  credential: GatewayAdministrationCredential,
): Record<string, string> {
  return {
    [PRIVATE_KEY_KEY]: credential.identity.privateKeyPem,
    ...(credential.state === "established"
      ? {
          [DEVICE_TOKEN_KEY]: credential.deviceToken.token,
          [DEVICE_TOKEN_SCOPES_KEY]: JSON.stringify([...credential.deviceToken.scopes]),
        }
      : {}),
  };
}

export function parseGatewayAdministrationCredential(secret: {
  readonly data?: Record<string, string>;
}): GatewayAdministrationCredential {
  const identity = openClawGatewayNativeDeviceIdentityFromPrivateKey(
    requiredSecretString(secret, PRIVATE_KEY_KEY),
  );
  const token = optionalSecretString(secret, DEVICE_TOKEN_KEY);
  const scopesJson = optionalSecretString(secret, DEVICE_TOKEN_SCOPES_KEY);
  if (token === undefined && scopesJson === undefined) return { state: "keyOnly", identity };
  if (token === undefined || scopesJson === undefined) {
    throw new Error("Gateway administration credential Secret is incomplete.");
  }
  const scopes = normalizeOpenClawGatewayNativeOperatorScopes(
    parseScopes(scopesJson),
    "Gateway administration device token scopes",
  );
  return { state: "established", identity, deviceToken: { token, scopes: [...scopes] } };
}

export function buildGatewayAdministrationHelperScript(): string {
  return String.raw`
const { execFileSync } = require("node:child_process");

const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const deadline = Date.now() + Number(input.timeoutMs);
const pollIntervalMs = Math.max(1, Number(input.pollIntervalMs || 100));
function remainingTimeout() {
  return Math.max(1, deadline - Date.now());
}
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}
function callOpenClaw(args) {
  return execFileSync("openclaw", args, {
    encoding: "utf8",
    timeout: remainingTimeout(),
    env: {
      ...process.env,
      OPENCLAW_GATEWAY_TOKEN: input.gatewayToken,
      OPENCLAW_GATEWAY_URL: input.url,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function array(value) {
  return Array.isArray(value) ? value : [];
}
function sameSet(left, right) {
  const l = array(left).map(String).sort();
  const r = array(right).map(String).sort();
  return l.length === r.length && l.every((value, index) => value === r[index]);
}
function matchesPinnedDevice(device) {
  return (
    String(device.deviceId || "").trim() === input.deviceId &&
    String(device.publicKey || "").trim() === input.publicKey
  );
}
function hasRequestedGrant(device) {
  if (
    String(device.role || "").trim() === input.role &&
    sameSet(device.scopes, input.scopes)
  ) {
    return true;
  }
  if (
    array(device.roles).map(String).includes(input.role) &&
    sameSet(device.scopes, input.scopes)
  ) {
    return true;
  }
  return array(device.tokens).some(
    (token) =>
      String(token.role || "").trim() === input.role &&
      sameSet(token.scopes, input.scopes)
  );
}
function findPinnedPending(list) {
  return array(list.pending).filter((request) =>
    String(request.requestId || "").trim() &&
    matchesPinnedDevice(request) &&
    String(request.role || "").trim() === input.role &&
    sameSet(request.scopes, input.scopes)
  );
}
function findGrantedPaired(list) {
  return array(list.paired).filter((device) => matchesPinnedDevice(device) && hasRequestedGrant(device));
}
let requestId;
while (Date.now() < deadline) {
  const list = JSON.parse(callOpenClaw([
    "devices",
    "list",
    "--json",
    "--timeout",
    String(remainingTimeout()),
  ]));
  const pairedMatches = findGrantedPaired(list);
  if (pairedMatches.length > 1) {
    throw new Error("Expected at most one pinned OCC gateway paired device.");
  }
  if (pairedMatches.length === 1) {
    process.exit(0);
  }
  const pendingMatches = findPinnedPending(list);
  if (pendingMatches.length > 1) {
    throw new Error("Expected exactly one pinned OCC gateway device approval request.");
  }
  if (pendingMatches.length === 1) {
    requestId = String(pendingMatches[0].requestId).trim();
    break;
  }
  sleep(Math.min(pollIntervalMs, remainingTimeout()));
}
if (!requestId) {
  throw new Error("Timed out waiting for pinned OCC gateway device approval request.");
}
const approval = JSON.parse(callOpenClaw([
  "devices",
  "approve",
  requestId,
  "--json",
  "--timeout",
  String(remainingTimeout()),
]));
if (String(approval.requestId || "").trim() !== requestId) {
  throw new Error("Gateway device approval returned an unexpected request.");
}
const device = approval.device || {};
if (!matchesPinnedDevice(device)) {
  throw new Error("Gateway device approval returned an unexpected device.");
}
`;
}
export function gatewayAdministrationHelperInput(input: {
  readonly url: string;
  readonly gatewayToken: string;
  readonly identity: OpenClawGatewayNativeDeviceIdentity;
  readonly publicKey: string;
  readonly timeoutMs?: number;
}): string {
  return JSON.stringify({
    url: input.url,
    gatewayToken: input.gatewayToken,
    deviceId: input.identity.deviceId,
    publicKey: input.publicKey,
    role: NATIVE_GATEWAY_OPERATOR_ROLE,
    scopes: [...NATIVE_GATEWAY_OPERATOR_SCOPES],
    timeoutMs: input.timeoutMs ?? NATIVE_GATEWAY_ENROLLMENT_TIMEOUT_MS,
  });
}

function parseScopes(value: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Gateway administration token scopes are invalid.");
  }
  if (!Array.isArray(parsed) || parsed.some((scope) => !isNonEmptyString(scope))) {
    throw new Error("Gateway administration token scopes are invalid.");
  }
  return parsed;
}

function requiredString(value: unknown, description: string): string {
  if (!isNonEmptyString(value)) throw new Error(`${description} must be explicitly configured.`);
  return value;
}

function requiredSecretString(
  secret: { readonly data?: Record<string, string> },
  key: string,
): string {
  const value = optionalSecretString(secret, key);
  if (value === undefined) {
    throw new Error("Gateway administration credential Secret is incomplete.");
  }
  return value;
}

function optionalSecretString(
  secret: { readonly data?: Record<string, string> },
  key: string,
): string | undefined {
  const encoded = secret.data?.[key];
  if (encoded === undefined) return undefined;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  if (!isNonEmptyString(decoded)) {
    throw new Error("Gateway administration credential Secret is incomplete.");
  }
  return decoded;
}
