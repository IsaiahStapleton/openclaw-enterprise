import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createSecureContext } from "node:tls";
import type {
  GitHubRepositoryCredentialProviderDefinition,
  Provider,
  RepositoryCredentialDriver,
} from "@openclaw-enterprise/contracts";
import { GitHubRepositoryCredentialDriver } from "../../drivers/repository-credentials/github.ts";
import {
  UnixRepositoryCredentialControlClient,
  type RepositoryCredentialControlClient,
} from "../../providers/repository-credentials/control-client.ts";
import { loadGitHubRepositoryRegistry } from "../../providers/repository-credentials/github/registry-loader.ts";
import type { SelectedDriverConfiguration } from "../installation-config.ts";

async function loadPublicCa(path: string): Promise<Uint8Array> {
  // Public projected files may be symlinks. Private service material has a
  // separate protected loader and is never part of platform composition.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > 131072 ||
      (before.mode & 0o022) !== 0
    ) {
      throw new Error("invalid-public-ca");
    }
    const data = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < data.length) {
      const result = await file.read(data, size, data.length - size, size);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    const after = await file.stat();
    const named = await stat(path);
    if (
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    ) {
      throw new Error("invalid-public-ca");
    }
    const pem = data.subarray(0, size).toString("utf8");
    if (
      !/^(?:\s*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*)+$/.test(
        pem,
      )
    ) {
      throw new Error("invalid-public-ca");
    }
    createSecureContext({ ca: pem, minVersion: "TLSv1.2" });
    return Buffer.from(data.subarray(0, size));
  } finally {
    await file.close();
  }
}

export async function composeRepositoryCredentialDriver(input: {
  readonly provider: GitHubRepositoryCredentialProviderDefinition;
  readonly selection: SelectedDriverConfiguration;
}): Promise<
  Readonly<{
    repositoryCredentialDriver: RepositoryCredentialDriver;
  }>
> {
  const { provider: definition, selection } = input;
  if (
    selection.implementation !== "github" ||
    selection.id !== definition.drivers.repository_credentials
  ) {
    throw new Error("The repository credential Driver must match its owning Provider.");
  }
  GitHubRepositoryCredentialDriver.validateConfiguration(selection.configuration);
  const configuration = selection.configuration as Readonly<{
    controlSocket: string;
    sessionDurationSeconds: number;
    publicCaPath: string;
  }>;
  const registry = await loadGitHubRepositoryRegistry(
    definition.configuration.registryPath,
    definition.id,
  );
  let publicCa: Uint8Array;
  try {
    publicCa = await loadPublicCa(configuration.publicCaPath);
  } catch {
    throw new Error("The repository credential public CA file is unavailable or invalid.");
  }
  const provider: Provider<RepositoryCredentialControlClient> = Object.freeze({
    id: definition.id,
    drivers: Object.freeze({ repository_credentials: selection.id }),
    client: new UnixRepositoryCredentialControlClient({
      controlSocket: configuration.controlSocket,
    }),
  });
  return Object.freeze({
    repositoryCredentialDriver: new GitHubRepositoryCredentialDriver(provider, registry, {
      sessionDurationSeconds: configuration.sessionDurationSeconds,
      publicCa,
    }),
  });
}
