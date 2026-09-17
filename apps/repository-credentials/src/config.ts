import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { createPrivateKey } from "node:crypto";
import { createSecureContext } from "node:tls";
import type { Clock, LoadedConfiguration, ServiceConfig, ServiceLimits } from "./contracts.ts";
import { createGitHubDriverFactory, createGitHubKeyOwner } from "./backends/github/index.ts";
import { validateGitHubConfiguration } from "./backends/github/config.ts";

const defaults: ServiceLimits = Object.freeze({
  sessions: 16,
  credentialSlotsPerSession: 2,
  providerActions: 1,
  providerQueue: 64,
  sockets: 64,
  exchanges: 32,
  exchangesPerSession: 4,
  headerBytes: 32768,
  headerPairs: 64,
  targetBytes: 8192,
  gitFetchInputBytes: 1048576,
  gitPushInputBytes: 268435456,
  gitResponseBytes: 268435456,
  apiInputBytes: 1048576,
  apiResponseBytes: 8388608,
  controlBodyBytes: 16384,
  headerMs: 5000,
  connectMs: 5000,
  stallMs: 5000,
  inputMs: 30000,
  firstHeaderMs: 30000,
  exchangeMs: 300000,
  providerActionMs: 30000,
  shutdownGraceMs: 60000,
  credentialMarginMs: 60000,
  accessTokenBytes: 16384,
  renewalBytesPerSession: 16384,
  privateKeyBytes: 65536,
});
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-configuration");
  return value as Record<string, unknown>;
}
function string(value: unknown, maximum = 4096): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error("invalid-configuration");
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error("invalid-configuration");
  return value;
}
export function validateServiceConfig(input: unknown): ServiceConfig {
  const root = record(input),
    gateway = record(root.gateway),
    policy = record(root.sessionPolicy);
  if (
    Object.keys(root).some(
      (key) => !["gateway", "sessionPolicy", "limits", "backend"].includes(key),
    ) ||
    Object.keys(gateway).some(
      (key) =>
        !["publicOrigin", "listen", "controlSocket", "tlsCertFile", "tlsKeyFile"].includes(key),
    ) ||
    Object.keys(policy).some(
      (key) => !["maximumDurationSeconds", "defaultProfile", "allowedProfiles"].includes(key),
    )
  )
    throw new Error("invalid-configuration");
  const publicOrigin = string(gateway.publicOrigin, 2048),
    url = new URL(publicOrigin);
  if (
    url.protocol !== "https:" ||
    url.origin !== publicOrigin ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error("invalid-configuration");
  const listen = string(gateway.listen, 256),
    match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/.exec(listen);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535)
    throw new Error("invalid-configuration");
  const controlSocket = string(gateway.controlSocket, 104);
  if (!isAbsolute(controlSocket) || resolve(controlSocket) !== controlSocket)
    throw new Error("invalid-configuration");
  const maximumDurationSeconds = positive(policy.maximumDurationSeconds);
  if (maximumDurationSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000))
    throw new Error("invalid-configuration");
  const defaultProfile = string(policy.defaultProfile, 128);
  if (
    !Array.isArray(policy.allowedProfiles) ||
    policy.allowedProfiles.length < 1 ||
    policy.allowedProfiles.length > 16
  )
    throw new Error("invalid-configuration");
  const allowedProfiles = policy.allowedProfiles.map((value) => string(value, 128));
  if (
    new Set(allowedProfiles).size !== allowedProfiles.length ||
    !allowedProfiles.includes(defaultProfile)
  )
    throw new Error("invalid-configuration");
  const override = root.limits === undefined ? {} : record(root.limits);
  if (Object.keys(override).some((key) => !Object.hasOwn(defaults, key)))
    throw new Error("invalid-configuration");
  const limits = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof ServiceLimits)[])
    limits[key] = override[key] === undefined ? defaults[key] : positive(override[key]);
  if (
    limits.providerActions !== 1 ||
    limits.credentialSlotsPerSession < 2 ||
    limits.accessTokenBytes > 16384 ||
    limits.privateKeyBytes > 65536 ||
    limits.providerActionMs > 30000
  )
    throw new Error("invalid-configuration");
  return Object.freeze({
    gateway: Object.freeze({ publicOrigin, listen, controlSocket }),
    sessionPolicy: Object.freeze({
      maximumDurationSeconds,
      defaultProfile,
      allowedProfiles: Object.freeze(allowedProfiles),
    }),
    limits: Object.freeze(limits),
  });
}

async function readProtected(path: string, maximum: number, privateFile = true): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("invalid-protected-file");
  // Reject symlinked components as well as a symlink at the final basename.
  let parent = dirname(path);
  while (parent !== parse(parent).root) {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid-protected-file");
    parent = dirname(parent);
  }
  const parentStat = await lstat(dirname(path));
  if (
    (parentStat.mode & 0o022) !== 0 ||
    (process.getuid && parentStat.uid !== process.getuid() && parentStat.uid !== 0)
  )
    throw new Error("invalid-protected-file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let data: Buffer | undefined;
  try {
    const before = await handle.stat();
    const uid = process.getuid?.();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > maximum ||
      (uid !== undefined && before.uid !== uid && before.uid !== 0) ||
      (before.mode & (privateFile ? 0o077 : 0o022)) !== 0
    )
      throw new Error("invalid-protected-file");
    data = Buffer.alloc(before.size + 1);
    let position = 0;
    while (position < data.length) {
      const result = await handle.read(data, position, data.length - position, position);
      if (!result.bytesRead) break;
      position += result.bytesRead;
    }
    const after = await handle.stat(),
      named = await lstat(path);
    if (
      position !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    )
      throw new Error("invalid-protected-file");
    return Buffer.from(data.subarray(0, position));
  } finally {
    data?.fill(0);
    await handle.close();
  }
}
export async function loadConfiguration(path: string, clock: Clock): Promise<LoadedConfiguration> {
  let raw: Buffer | undefined,
    pem: Buffer | undefined,
    cert: Buffer | undefined,
    tlsKey: Buffer | undefined;
  let owner: ReturnType<typeof createGitHubKeyOwner> | undefined;
  try {
    raw = await readProtected(path, 262144);
    const input: unknown = JSON.parse(raw.toString("utf8")),
      root = record(input);
    const config = validateServiceConfig(root),
      backend = validateGitHubConfiguration(root.backend),
      gateway = record(root.gateway);
    for (const profile of config.sessionPolicy.allowedProfiles)
      if (profile !== "git-write" && profile !== "read-write")
        throw new Error("invalid-configuration");
    pem = await readProtected(backend.privateKeyFile, config.limits.privateKeyBytes);
    owner = createGitHubKeyOwner({
      privateKey: createPrivateKey(pem),
      appId: backend.appId,
      clock,
    });
    cert = await readProtected(string(gateway.tlsCertFile), 131072, false);
    tlsKey = await readProtected(string(gateway.tlsKeyFile), 65536);
    createSecureContext({ cert, key: tlsKey, minVersion: "TLSv1.2" });
    const factory = createGitHubDriverFactory({
      configuration: backend,
      key: owner,
      gatewayOrigin: config.gateway.publicOrigin,
      limits: config.limits,
      clock,
    });
    const ownedCert = cert,
      ownedTlsKey = tlsKey,
      ownedKey = owner;
    return Object.freeze({
      config,
      tls: Object.freeze({ cert: ownedCert, key: ownedTlsKey }),
      factory,
      trustedUpstreamOrigins: factory.trustedUpstreamOrigins,
      close() {
        ownedKey.close();
        ownedCert.fill(0);
        ownedTlsKey.fill(0);
      },
    });
  } catch {
    owner?.close();
    cert?.fill(0);
    tlsKey?.fill(0);
    throw new Error("invalid-configuration");
  } finally {
    raw?.fill(0);
    pem?.fill(0);
  }
}
