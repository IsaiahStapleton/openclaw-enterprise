import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientFiles } from "./config.ts";
import { parseGitInvocation } from "./git-context.ts";
import type { ParsedGitInvocation } from "./git-context.ts";

export interface ClientCommand {
  readonly executable: "/usr/bin/git" | "/usr/local/bin/gh";
  readonly arguments: readonly string[];
}

export interface ParsedGhInvocation {
  readonly args: readonly string[];
  readonly target?: {
    readonly kind: "repository" | "endpoint";
    readonly value: string;
    readonly index: number;
  };
}

interface CommandOptions {
  readonly git?: ParsedGitInvocation;
  readonly gh?: ParsedGhInvocation;
  readonly overrides?: ReadonlyMap<string, string>;
  readonly routing?: readonly string[];
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function parseGhInvocation(input: readonly string[]): ParsedGhInvocation {
  const args = Object.freeze([...input]);
  if (args[0] === "api") {
    const values = new Set([
      "--method",
      "-X",
      "--input",
      "--field",
      "-F",
      "--raw-field",
      "-f",
      "--jq",
      "-q",
      "--template",
      "-t",
    ]);
    const switches = new Set(["--paginate", "--slurp", "--include", "-i", "--silent"]);
    let endpoint: { value: string; index: number } | undefined;
    for (let index = 1; index < args.length; index++) {
      const argument = args[index]!;
      if (values.has(argument)) {
        if (!args[++index]) {
          throw new Error("unsupported-client-command");
        }
      } else if (!switches.has(argument)) {
        if (
          argument.startsWith("-") ||
          endpoint ||
          !/^[A-Za-z0-9_/?=&.%+-]+$/.test(argument) ||
          argument.startsWith("/") ||
          argument.includes(":") ||
          argument.includes("..")
        ) {
          throw new Error("unsupported-client-command");
        }
        endpoint = { value: argument, index };
      }
    }
    if (!endpoint) {
      throw new Error("unsupported-client-command");
    }
    const repository = /^repos\/([^/?]+)\/([^/?]+)(?:[/?]|$)/.exec(endpoint.value);
    if (
      repository &&
      (!/^[A-Za-z0-9_.-]+$/.test(repository[1]!) || !/^[A-Za-z0-9_.-]+$/.test(repository[2]!))
    ) {
      throw new Error("unsupported-client-command");
    }
    return Object.freeze({
      args,
      ...(repository
        ? {
            target: Object.freeze({
              kind: "endpoint" as const,
              value: `${repository[1]}/${repository[2]}`,
              index: endpoint.index,
            }),
          }
        : {}),
    });
  }
  if (args[0] !== "pr" || args[1] !== "create") {
    throw new Error("unsupported-client-command");
  }
  let explicitHead = false;
  let target: ParsedGhInvocation["target"];
  const values = new Set([
    "--base",
    "-B",
    "--head",
    "-H",
    "--title",
    "-t",
    "--body",
    "-b",
    "--body-file",
    "-F",
    "--repo",
    "-R",
  ]);
  for (let index = 2; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--draft" || argument === "-d") {
      continue;
    }
    if (!values.has(argument) || !args[index + 1]) {
      throw new Error("unsupported-client-command");
    }
    const value = args[++index]!;
    if (argument === "--repo" || argument === "-R") {
      if (
        target ||
        !/^(?:github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ||
        value.includes("..")
      ) {
        throw new Error("unsupported-client-command");
      }
      target = Object.freeze({ kind: "repository", value, index });
    }
    if (argument === "--head" || argument === "-H") {
      explicitHead = true;
    }
  }
  if (!explicitHead) {
    throw new Error("explicit-head-required");
  }
  return Object.freeze({ args, ...(target ? { target } : {}) });
}

function rejectGitUrlCredentials(url: string): void {
  // Explicit helpers and URL userinfo can bypass the selected credential helper.
  if (/^[a-z][a-z0-9+.-]*::/i.test(url) || /^https?:\/\/[^/?#]*@/i.test(url)) {
    throw new Error("unsafe-git-configuration");
  }
}

const safeGitPolicy = [
  "-c",
  "credential.helper=",
  "-c",
  "credential.useHttpPath=true",
  "-c",
  "http.followRedirects=false",
  "-c",
  "http.sslVerify=true",
  "-c",
  "http.extraHeader=",
  "-c",
  "http.proxy=",
  "-c",
  "submodule.recurse=false",
  "-c",
  "fetch.recurseSubmodules=false",
  "-c",
  "push.recurseSubmodules=no",
];

function prepareGitArguments(
  git: ParsedGitInvocation,
  overrides: ReadonlyMap<string, string>,
  policy: readonly string[],
  routing: readonly string[] = [],
): string[] {
  if (git.target) {
    rejectGitUrlCredentials(git.target.value);
  }
  // Equal-specificity entries win URL matching; empty headers/helpers reset
  // inherited multi-valued configuration. Preserve the inspected context exactly.
  return [
    ...git.context,
    ...[...overrides].flatMap(([key, value]) => ["-c", `${key}=${value}`]),
    ...routing,
    ...safeGitPolicy,
    ...policy,
    ...git.args.slice(git.commandIndex),
  ];
}

export function inspectGitConfiguration(
  context: readonly string[],
  env: NodeJS.ProcessEnv,
  cloning: boolean,
): ReadonlyMap<string, string> {
  const inspected = spawnSync(
    "/usr/bin/git",
    [...context, "config", "--null", "--list", "--includes"],
    {
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (inspected.status !== 0) {
    throw new Error("unsafe-git-configuration");
  }
  const safeHttp = new Map([
    ["followredirects", "false"],
    ["sslverify", "true"],
    ["extraheader", ""],
    ["proxy", ""],
  ]);
  const overrides = new Map<string, string>();
  for (const entry of inspected.stdout.split("\0")) {
    const separator = entry.indexOf("\n");
    const key = separator === -1 ? entry : entry.slice(0, separator);
    const value = separator === -1 ? "" : entry.slice(separator + 1);
    if (cloning && (key === "init.templatedir" || key.startsWith("includeif."))) {
      throw new Error("unsafe-git-configuration");
    }
    if (/^remote\..*\.(?:url|pushurl)$/.test(key)) {
      rejectGitUrlCredentials(value);
    }
    const rewrite = /^url\.(.*)\.(?:insteadof|pushinsteadof)$/.exec(key);
    if (rewrite) {
      rejectGitUrlCredentials(rewrite[1]!);
    }
    const http = /^http\.(?:.*\.)?([^.]+)$/.exec(key);
    if (http) {
      const setting = http[1]!;
      // Git forwards userAgent verbatim, including injected HTTP header lines.
      if (setting === "useragent" && /[\r\n]/.test(value)) {
        throw new Error("unsafe-git-configuration");
      }
      const safe = safeHttp.get(setting);
      if (safe !== undefined) {
        overrides.set(key, safe);
      }
      // Repository trust roots, client certificates, cookies and DNS overrides can
      // also redirect or authenticate a request outside the selected session.
      else if (/^(?:ssl|cookie|savecookies|curloptresolve|emptyauth|proactiveauth)/.test(setting)) {
        throw new Error("unsafe-git-configuration");
      }
    }
    if (/^remote\..*\.proxy$/.test(key)) {
      overrides.set(key, "");
    }
    if (/^credential\..*\.(?:helper|username|usehttppath)$/.test(key)) {
      throw new Error("unsafe-git-configuration");
    }
  }
  return overrides;
}

export function prepareLocalGitCommand(
  git: ParsedGitInvocation,
  env: NodeJS.ProcessEnv,
  overrides?: ReadonlyMap<string, string>,
): ClientCommand {
  if (git.kind !== "local" || git.command === "credential") {
    throw new Error("unsupported-client-command");
  }
  return {
    executable: "/usr/bin/git",
    arguments: prepareGitArguments(
      git,
      overrides ?? inspectGitConfiguration(git.context, env, false),
      ["-c", "protocol.allow=never"],
    ),
  };
}

export function prepareClientCommand(
  command: "git" | "gh",
  args: readonly string[],
  configuration: ClientFiles,
  sessionDirectory: string,
  env: NodeJS.ProcessEnv,
  options: CommandOptions = {},
): ClientCommand {
  if (command === "gh") {
    if (
      configuration.client.canonicalApiHost !== "github.com" ||
      new URL(configuration.client.gatewayOrigin).port
    ) {
      throw new Error("gh-requires-canonical-host-and-port-443");
    }
    const gh = options.gh ?? parseGhInvocation(args);
    if (gh.target) {
      const selected = configuration.client.repository.toLowerCase();
      const requested = gh.target.value.replace(/^github\.com\//, "").toLowerCase();
      if (requested !== selected) {
        throw new Error("unsupported-client-command");
      }
    }
    const version = spawnSync("/usr/local/bin/gh", ["--version"], {
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4096,
    });
    if (version.status !== 0 || !/^gh version 2\.100\.0(?:\s|$)/.test(version.stdout)) {
      throw new Error("unsupported-gh-version");
    }
    return { executable: "/usr/local/bin/gh", arguments: gh.args };
  }
  const git = options.git ?? parseGitInvocation(args);
  const helper = join(
    dirname(fileURLToPath(import.meta.url)),
    `git-helper${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
  );
  return {
    executable: "/usr/bin/git",
    arguments: prepareGitArguments(
      git,
      options.overrides ?? inspectGitConfiguration(git.context, env, git.command === "clone"),
      [
        "-c",
        `credential.helper=!${shellQuote(process.execPath)} ${shellQuote(helper)} ${shellQuote(sessionDirectory)}`,
      ],
      options.routing,
    ),
  };
}
