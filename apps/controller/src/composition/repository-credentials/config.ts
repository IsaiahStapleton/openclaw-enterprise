import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { createPrivateKey } from "node:crypto";
import { createSecureContext } from "node:tls";
import type { Clock } from "../../drivers/repository-credentials/backend-contracts.ts";
import type { LoadedConfiguration } from "./contracts.ts";
import {
  createGitHubDriverFactory,
  createGitHubKeyOwner,
} from "../../providers/repository-credentials/github/index.ts";
import {
  record,
  string,
  validateServiceConfig,
} from "../../drivers/repository-credentials/configuration.ts";
import { validateGitHubConfiguration } from "../../providers/repository-credentials/github/config.ts";
import {
  GITHUB_REPOSITORY_REGISTRY_MAX_BYTES,
  validateGitHubRepositoryRegistry,
} from "../../providers/repository-credentials/github/registry.ts";
import type { GitHubRepositoryRegistry } from "../../providers/repository-credentials/github/registry.ts";
import type { GitHubConfiguration } from "../../providers/repository-credentials/github/types.ts";
import { createGitHubRegistryDriverFactory } from "../../providers/repository-credentials/github/registry-factory.ts";

async function readProtected(path: string, maximum: number, privateFile = true): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("invalid-protected-file");
  }
  // Reject symlinked components as well as a symlink at the final basename.
  let parent = dirname(path);
  while (parent !== parse(parent).root) {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("invalid-protected-file");
    }
    parent = dirname(parent);
  }
  const parentStat = await lstat(dirname(path));
  if (
    (parentStat.mode & 0o022) !== 0 ||
    (process.getuid && parentStat.uid !== process.getuid() && parentStat.uid !== 0)
  ) {
    throw new Error("invalid-protected-file");
  }
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
    ) {
      throw new Error("invalid-protected-file");
    }
    data = Buffer.alloc(before.size + 1);
    let position = 0;
    while (position < data.length) {
      const result = await handle.read(data, position, data.length - position, position);
      if (!result.bytesRead) {
        break;
      }
      position += result.bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(path);
    if (
      position !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    ) {
      throw new Error("invalid-protected-file");
    }
    return Buffer.from(data.subarray(0, position));
  } finally {
    data?.fill(0);
    await handle.close();
  }
}
export async function loadConfiguration(path: string, clock: Clock): Promise<LoadedConfiguration> {
  let raw: Buffer | undefined;
  let pem: Buffer | undefined;
  let registryBytes: Buffer | undefined;
  let cert: Buffer | undefined;
  let tlsKey: Buffer | undefined;
  let owner: ReturnType<typeof createGitHubKeyOwner> | undefined;
  try {
    raw = await readProtected(path, 262144);
    const input: unknown = JSON.parse(raw.toString("utf8"));
    const root = record(input);
    const config = validateServiceConfig(root);
    const backendInput = record(root.backend);
    let backend: GitHubConfiguration | undefined;
    let registry: GitHubRepositoryRegistry | undefined;
    let privateKeyFile: string;
    let appId: string;
    if (backendInput.kind === "github-app-registry") {
      if (
        Object.keys(backendInput).some(
          (key) => !["kind", "providerId", "registryFile", "privateKeyFile"].includes(key),
        )
      ) {
        throw new Error("invalid-configuration");
      }
      registryBytes = await readProtected(
        string(backendInput.registryFile),
        GITHUB_REPOSITORY_REGISTRY_MAX_BYTES,
        false,
      );
      registry = validateGitHubRepositoryRegistry(
        JSON.parse(registryBytes.toString("utf8")),
        string(backendInput.providerId),
      );
      if (config.sessionPolicy.maximumDurationSeconds > registry.maximumDurationSeconds) {
        throw new Error("invalid-configuration");
      }
      privateKeyFile = string(backendInput.privateKeyFile);
      appId = registry.appId;
    } else {
      backend = validateGitHubConfiguration(backendInput);
      privateKeyFile = backend.privateKeyFile;
      appId = backend.appId;
    }
    const gateway = record(root.gateway);
    for (const profile of config.sessionPolicy.allowedProfiles) {
      if (profile !== "git-read" && profile !== "git-write" && profile !== "git-full") {
        throw new Error("invalid-configuration");
      }
    }
    pem = await readProtected(privateKeyFile, config.limits.privateKeyBytes);
    owner = createGitHubKeyOwner({
      privateKey: createPrivateKey(pem),
      appId,
      clock,
    });
    cert = await readProtected(string(gateway.tlsCertFile), 131072, false);
    tlsKey = await readProtected(string(gateway.tlsKeyFile), 65536);
    createSecureContext({ cert, key: tlsKey, minVersion: "TLSv1.2" });
    const factoryOptions = {
      key: owner,
      gatewayOrigin: config.gateway.publicOrigin,
      limits: config.limits,
      clock,
    };
    const factory = registry
      ? createGitHubRegistryDriverFactory({ ...factoryOptions, registry, privateKeyFile })
      : createGitHubDriverFactory({ ...factoryOptions, configuration: backend! });
    const ownedCert = cert;
    const ownedTlsKey = tlsKey;
    const ownedKey = owner;
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
    registryBytes?.fill(0);
    pem?.fill(0);
  }
}
