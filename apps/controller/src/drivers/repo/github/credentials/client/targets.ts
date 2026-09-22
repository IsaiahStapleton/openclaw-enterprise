import { spawnSync } from "node:child_process";
import type { RuntimeRepositoryBinding, RuntimeRepositoryManifest } from "./manifest.ts";

function selectBinding(
  matches: readonly RuntimeRepositoryBinding[],
  pinned?: RuntimeRepositoryBinding,
): RuntimeRepositoryBinding {
  if (pinned) {
    if (!matches.includes(pinned)) {
      throw new Error("conflicting-repository-selection");
    }
    return pinned;
  }
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? "repository-not-admitted" : "name-one-repository-ref");
  }
  return matches[0]!;
}

/** Match the effective credential endpoint, never a guessed command operand. */
export function selectGitCredential(
  manifest: RuntimeRepositoryManifest,
  fields: ReadonlyMap<string, string>,
  pinned?: RuntimeRepositoryBinding,
): RuntimeRepositoryBinding {
  const path = fields.get("path") ?? "";
  if (
    fields.get("protocol") !== "https" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) ||
    path.includes("..")
  ) {
    throw new Error("repository-not-admitted");
  }
  const matches = manifest.bindings.filter(({ client }) => {
    const repository = client.repository.toLowerCase();
    return (
      fields.get("host") === new URL(client.gatewayOrigin).host &&
      [repository, `${repository}.git`].includes(path.toLowerCase())
    );
  });
  const selected = selectBinding(matches, pinned);
  if (fields.has("username") && fields.get("username") !== selected.client.gitUsername) {
    throw new Error("repository-not-admitted");
  }
  return selected;
}

export function selectGhRepository(
  manifest: RuntimeRepositoryManifest,
  value: string,
  pinned?: RuntimeRepositoryBinding,
): RuntimeRepositoryBinding {
  const repository = value.replace(/^github\.com\//, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.includes("..")) {
    throw new Error("unsupported-repository-target");
  }
  return selectBinding(
    manifest.bindings.filter(
      ({ client }) =>
        client.canonicalApiHost === "github.com" &&
        client.repository.toLowerCase() === repository.toLowerCase(),
    ),
    pinned,
  );
}

/** Ask native Git for effective remotes only when gh has no explicit target. */
export function selectImplicitGhRepository(
  manifest: RuntimeRepositoryManifest,
  env: NodeJS.ProcessEnv,
): RuntimeRepositoryBinding {
  const output = (args: string[]): string[] => {
    const result = spawnSync("/usr/bin/git", args, {
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || result.error || /[\r\0]/.test(result.stdout)) {
      throw new Error("repository-target-inspection-failed");
    }
    return result.stdout.trimEnd().split("\n").filter(Boolean);
  };
  const remotes = output(["remote"]);
  if (remotes.length === 0 || remotes.length > 64) {
    throw new Error("name-one-repository-target");
  }
  let selected: RuntimeRepositoryBinding | undefined;
  for (const remote of remotes) {
    const urls = output(["remote", "get-url", "--all", "--", remote]);
    if (
      urls.length !== 1 ||
      !urls[0]!.startsWith("https://") ||
      /[\s\\%?#@]/.test(urls[0]!) ||
      urls[0]!.includes("..")
    ) {
      throw new Error("name-one-repository-target");
    }
    const url = new URL(urls[0]!);
    const matches = manifest.bindings.filter(({ client }) => {
      const repository = client.repository.toLowerCase();
      return (
        [client.gatewayOrigin, `https://${client.canonicalApiHost}`].includes(url.origin) &&
        [repository, `${repository}.git`].includes(url.pathname.slice(1).toLowerCase())
      );
    });
    const binding = selectBinding(matches);
    if (selected && selected !== binding) {
      throw new Error("name-one-repository-target");
    }
    selected = binding;
  }
  if (!selected) {
    throw new Error("name-one-repository-target");
  }
  return selected;
}
