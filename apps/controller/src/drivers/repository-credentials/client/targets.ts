import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeRepositoryBinding, RuntimeRepositoryManifest } from "./manifest.ts";

export interface GitDestination {
  readonly raw: string;
  readonly effective: string;
  readonly remote?: string;
}

function gitOutput(
  context: readonly string[],
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  missingAllowed = false,
): string[] {
  const result = spawnSync("/usr/bin/git", [...context, ...args], {
    env,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (missingAllowed && result.status === 1 && !result.error) {
    return [];
  }
  if (result.status !== 0 || result.error || /[\r\0]/.test(result.stdout)) {
    throw new Error("repository-target-inspection-failed");
  }
  const values = result.stdout.split("\n");
  if (values.at(-1) === "") {
    values.pop();
  }
  if (values.some((value) => value.length === 0)) {
    throw new Error("repository-target-inspection-failed");
  }
  return values;
}

function single(values: readonly string[]): string {
  if (values.length !== 1) {
    throw new Error("name-one-repository-target");
  }
  return values[0]!;
}

function gitConfigurationValues(
  context: readonly string[],
  pattern: string,
  env: NodeJS.ProcessEnv,
): readonly { key: string; value: string }[] {
  const result = spawnSync(
    "/usr/bin/git",
    [...context, "config", "--null", "--get-regexp", pattern],
    {
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status === 1 && !result.error) {
    return [];
  }
  if (result.status !== 0 || result.error) {
    throw new Error("repository-target-inspection-failed");
  }
  const entries = result.stdout.split("\0");
  if (entries.pop() !== "" || entries.length > 256) {
    throw new Error("repository-target-inspection-failed");
  }
  return entries.map((entry) => {
    const separator = entry.indexOf("\n");
    if (separator <= 0) {
      throw new Error("repository-target-inspection-failed");
    }
    return { key: entry.slice(0, separator), value: entry.slice(separator + 1) };
  });
}

function validateRemoteName(value: string): void {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,255}$/.test(value) || value.includes("..")) {
    throw new Error("unsupported-repository-target");
  }
}

export function inspectDirectGitDestination(
  value: string,
  push: boolean,
  context: readonly string[],
  env: NodeJS.ProcessEnv,
  explicitPushUrl = false,
): GitDestination {
  if (!push) {
    return {
      raw: value,
      effective: single(gitOutput(context, ["ls-remote", "--get-url", "--", value], env)),
    };
  }
  // Git ignores command-only remote definitions in remote get-url. Inspect a
  // private bare repository containing only this URL and the effective rewrite
  // entries. Git still owns rewrite semantics; no workspace config is modified.
  const rewrites = gitConfigurationValues(context, "^url\\..*\\.(insteadof|pushinsteadof)$", env);
  if (!env.HOME) {
    throw new Error("repository-target-inspection-failed");
  }
  const temporary = mkdtempSync(join(env.HOME, "push-inspection-"));
  try {
    gitOutput([], ["init", "--bare", "--template=", "--quiet", temporary], env);
    const isolated = [`--git-dir=${temporary}`];
    gitOutput(isolated, ["config", "remote.target.url", value], env);
    if (explicitPushUrl) {
      gitOutput(isolated, ["config", "remote.target.pushurl", value], env);
    }
    for (const { key, value: rewrite } of rewrites) {
      gitOutput(isolated, ["config", "--add", key, rewrite], env);
    }
    return {
      raw: value,
      effective: single(
        gitOutput(isolated, ["remote", "get-url", "--push", "--all", "target"], env),
      ),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function inspectNamedGitDestination(
  remote: string,
  push: boolean,
  context: readonly string[],
  env: NodeJS.ProcessEnv,
): GitDestination {
  validateRemoteName(remote);
  let raw = push
    ? gitOutput(context, ["config", "--get-all", `remote.${remote}.pushurl`], env, true)
    : [];
  const explicitPushUrl = raw.length > 0;
  if (raw.length === 0) {
    raw = gitOutput(context, ["config", "--get-all", `remote.${remote}.url`], env);
  }
  const source = single(raw);
  const effective = push
    ? inspectDirectGitDestination(source, true, context, env, explicitPushUrl).effective
    : single(gitOutput(context, ["ls-remote", "--get-url", "--", remote], env));
  return { raw: source, effective, remote };
}

export function inspectGitDestination(
  target: string,
  push: boolean,
  context: readonly string[],
  env: NodeJS.ProcessEnv,
): GitDestination {
  return target.startsWith("https://")
    ? inspectDirectGitDestination(target, push, context, env)
    : inspectNamedGitDestination(target, push, context, env);
}

export function inspectImplicitGitDestinations(
  push: boolean,
  context: readonly string[],
  env: NodeJS.ProcessEnv,
): readonly GitDestination[] {
  const remotes = gitOutput(context, ["remote"], env);
  if (remotes.length === 0 || remotes.length > 64) {
    throw new Error("name-one-repository-target");
  }
  const defaults = gitConfigurationValues(
    context,
    "^(branch\\..*\\.(remote|pushremote)|remote\\.pushdefault)$",
    env,
  );
  if (defaults.some(({ value }) => !remotes.includes(value))) {
    throw new Error("name-one-repository-target");
  }
  return remotes.map((remote) => inspectNamedGitDestination(remote, push, context, env));
}

function matchesGitUrl(value: string, binding: RuntimeRepositoryBinding): boolean {
  // URL parsing alone normalizes escaped paths, backslashes and dot segments.
  // Refuse those spellings before matching the exact emitted repository identity.
  if (
    !value.startsWith("https://") ||
    /[\s\x00-\x1f\x7f\\%?#@]/.test(value) ||
    value.includes("..")
  ) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) {
    return false;
  }
  const gateway = new URL(binding.client.gitRemote);
  const gatewayMatch =
    value.slice(0, value.indexOf("/", 8)) === gateway.origin &&
    url.pathname.toLowerCase() === gateway.pathname.toLowerCase();
  const canonicalPrefix = `https://${binding.client.canonicalApiHost}/`;
  const canonicalPath = value.startsWith(canonicalPrefix)
    ? value.slice(canonicalPrefix.length).toLowerCase()
    : undefined;
  const repository = binding.client.repository.toLowerCase();
  return gatewayMatch || canonicalPath === repository || canonicalPath === `${repository}.git`;
}

export function selectGitUrl(
  manifest: RuntimeRepositoryManifest,
  value: string,
  pinned?: RuntimeRepositoryBinding,
): RuntimeRepositoryBinding {
  const matches = manifest.bindings.filter((binding) => matchesGitUrl(value, binding));
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

export function selectGitDestinations(
  manifest: RuntimeRepositoryManifest,
  destinations: readonly GitDestination[],
  pinned?: RuntimeRepositoryBinding,
): RuntimeRepositoryBinding {
  let selected = pinned;
  for (const destination of destinations) {
    const raw = selectGitUrl(manifest, destination.raw, selected);
    const effective = selectGitUrl(manifest, destination.effective, raw);
    if (selected && effective !== selected) {
      throw new Error("conflicting-repository-selection");
    }
    selected = effective;
  }
  if (!selected || destinations.length === 0) {
    throw new Error("name-one-repository-target");
  }
  return selected;
}

export function selectGhRepository(
  manifest: RuntimeRepositoryManifest,
  value: string,
  pinned?: RuntimeRepositoryBinding,
): RuntimeRepositoryBinding {
  const repository = value.startsWith("github.com/") ? value.slice("github.com/".length) : value;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.includes("..")) {
    throw new Error("unsupported-repository-target");
  }
  return selectGitUrl(manifest, `https://github.com/${repository}.git`, pinned);
}

export function routeGitDestinations(
  destinations: readonly GitDestination[],
  binding: RuntimeRepositoryBinding,
  push: boolean,
  context: readonly string[],
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const gateway = binding.client.gitRemote;
  const originals = new Set(destinations.flatMap(({ raw, effective }) => [raw, effective]));
  const routing = [...originals].flatMap((original) => [
    "-c",
    `url.${gateway}.insteadOf=${original}`,
    ...(push ? ["-c", `url.${gateway}.pushInsteadOf=${original}`] : []),
  ]);
  const routedContext = [...context, ...routing];
  // Full-URL rules are safe only after exact matching and actual Git expansion.
  // A concurrent config change can still fail later; it cannot change the helper.
  for (const destination of destinations) {
    const routed = destination.remote
      ? inspectNamedGitDestination(destination.remote, push, routedContext, env)
      : inspectDirectGitDestination(destination.raw, push, routedContext, env);
    if (routed.effective !== gateway) {
      throw new Error("conflicting-git-url-rewrite");
    }
  }
  if (inspectDirectGitDestination(gateway, push, routedContext, env).effective !== gateway) {
    throw new Error("conflicting-git-url-rewrite");
  }
  return routing;
}
