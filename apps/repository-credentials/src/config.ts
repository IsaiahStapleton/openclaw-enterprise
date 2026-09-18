import { createPrivateKey } from "node:crypto";
import { createSecureContext } from "node:tls";
import type { Clock } from "./driver-contracts.ts";
import type { LoadedConfiguration } from "./internal-contracts.ts";
import { createGitHubDriverFactory, createGitHubKeyOwner } from "./backends/github/index.ts";
import { record, string, validateServiceConfig } from "./configuration/service.ts";
import { readProtectedFile } from "./configuration/protected-file.ts";

export { validateServiceConfig } from "./configuration/service.ts";
import { validateGitHubConfiguration } from "./backends/github/config.ts";

async function readProtected(path: string, maximum: number, privateFile = true): Promise<Buffer> {
  const result = await readProtectedFile(path, maximum, privateFile);
  if (!result.ok) {
    throw new Error("invalid-configuration");
  }
  return result.bytes;
}

export async function loadConfiguration(path: string, clock: Clock): Promise<LoadedConfiguration> {
  let raw: Buffer | undefined;
  let pem: Buffer | undefined;
  let cert: Buffer | undefined;
  let tlsKey: Buffer | undefined;
  let owner: ReturnType<typeof createGitHubKeyOwner> | undefined;
  try {
    raw = await readProtected(path, 262144);
    const input: unknown = JSON.parse(raw.toString("utf8"));
    const root = record(input);
    const config = validateServiceConfig(root);
    const backend = validateGitHubConfiguration(root.backend);
    const gateway = record(root.gateway);
    for (const profile of config.sessionPolicy.allowedProfiles) {
      if (profile !== "git-read" && profile !== "git-write" && profile !== "git-full") {
        throw new Error("invalid-configuration");
      }
    }
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
    pem?.fill(0);
  }
}
