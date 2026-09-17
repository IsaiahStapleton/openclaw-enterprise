import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientFiles } from "./config.ts";

export interface ClientCommand {
  readonly executable: "git" | "gh";
  readonly arguments: readonly string[];
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

function validateGhArguments(args: string[], repository: string): void {
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
    let endpoint: string | undefined;
    for (let index = 1; index < args.length; index++) {
      const argument = args[index]!;
      if (values.has(argument)) {
        if (!args[++index]) throw new Error("unsupported-client-command");
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
        endpoint = argument;
      }
    }
    if (!endpoint) throw new Error("unsupported-client-command");
    return;
  }
  if (args[0] !== "pr" || args[1] !== "create") throw new Error("unsupported-client-command");
  let explicitHead = false;
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
    if (argument === "--draft" || argument === "-d") continue;
    if (!values.has(argument) || !args[index + 1]) throw new Error("unsupported-client-command");
    const value = args[++index]!;
    if ((argument === "--repo" || argument === "-R") && value !== `github.com/${repository}`)
      throw new Error("unsupported-client-command");
    if (argument === "--head" || argument === "-H") explicitHead = true;
  }
  if (!explicitHead) throw new Error("explicit-head-required");
}

function rejectGitUrlCredentials(url: string): void {
  // Explicit remote helpers can reinterpret the URL and bypass ordinary URL checks.
  if (/^[a-z][a-z0-9+.-]*::/i.test(url)) throw new Error("unsafe-git-configuration");
  // Userinfo wins over the selected helper, even when its contents are percent-encoded.
  if (/^https?:\/\/[^/?#]*@/i.test(url)) throw new Error("unsafe-git-configuration");
}

function validateCloneArguments(args: string[]): void {
  const values = new Set([
    "-b",
    "--branch",
    "-o",
    "--origin",
    "--depth",
    "--shallow-since",
    "--shallow-exclude",
    "--filter",
  ]);
  const switches = new Set([
    "--quiet",
    "--verbose",
    "--progress",
    "--no-checkout",
    "--bare",
    "--mirror",
    "--single-branch",
    "--no-single-branch",
    "--no-tags",
    "--sparse",
  ]);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--") return;
    if (!argument.startsWith("-") || switches.has(argument) || /^-[qvn]+$/.test(argument)) continue;
    if (values.has(argument)) {
      if (args[++index] === undefined) throw new Error("unsupported-client-command");
    } else if (!values.has(argument.split("=", 1)[0]!) && !/^-[bo].+/.test(argument)) {
      // Clone config and templates are applied after the preflight inspection.
      throw new Error("unsupported-client-command");
    }
  }
}

function prepareGitArguments(args: string[], env: NodeJS.ProcessEnv, policy: string[]): string[] {
  // Use the same repository selection and command configuration for inspection and execution.
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-")) {
    const option = args[index++]!;
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(option)) {
      if (args[index++] === undefined) throw new Error("unsupported-client-command");
    } else if (
      !/^(?:-C.+|-c.+|--(?:git-dir|work-tree|namespace|config-env)=.+|--(?:bare|no-pager|paginate|no-replace-objects|no-optional-locks|literal-pathspecs|no-literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs))$/.test(
        option,
      )
    ) {
      throw new Error("unsupported-client-command");
    }
  }
  const context = args.slice(0, index);
  const cloning = args[index] === "clone";
  if (cloning) validateCloneArguments(args.slice(index + 1));
  if (["clone", "fetch", "pull", "push", "ls-remote"].includes(args[index] ?? "")) {
    for (const argument of args.slice(index + 1)) {
      rejectGitUrlCredentials(argument.startsWith("--repo=") ? argument.slice(7) : argument);
    }
  }
  const inspected = spawnSync("git", [...context, "config", "--null", "--list", "--includes"], {
    env,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (inspected.status !== 0) throw new Error("unsafe-git-configuration");
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
    if (/^remote\..*\.(?:url|pushurl)$/.test(key)) rejectGitUrlCredentials(value);
    const rewrite = /^url\.(.*)\.(?:insteadof|pushinsteadof)$/.exec(key);
    if (rewrite) rejectGitUrlCredentials(rewrite[1]!);
    const http = /^http\.(?:.*\.)?([^.]+)$/.exec(key);
    if (http) {
      const setting = http[1]!;
      // Git forwards userAgent verbatim, including injected HTTP header lines.
      if (setting === "useragent" && /[\r\n]/.test(value)) {
        throw new Error("unsafe-git-configuration");
      }
      const safe = safeHttp.get(setting);
      if (safe !== undefined) overrides.set(key, safe);
      // Repository trust roots, client certificates, cookies and DNS overrides can
      // also redirect or authenticate a request outside the selected session.
      else if (/^(?:ssl|cookie|savecookies|curloptresolve|emptyauth|proactiveauth)/.test(setting)) {
        throw new Error("unsafe-git-configuration");
      }
    }
    if (/^remote\..*\.proxy$/.test(key)) overrides.set(key, "");
    if (/^credential\..*\.(?:helper|username|usehttppath)$/.test(key)) {
      throw new Error("unsafe-git-configuration");
    }
  }
  // Equal-specificity command entries win URL matching; empty entries reset
  // multi-valued headers/helpers. Generic entries alone cannot enforce this.
  return [
    ...context,
    ...[...overrides].flatMap(([key, value]) => ["-c", `${key}=${value}`]),
    ...policy,
    ...args.slice(index),
  ];
}

export function prepareClientCommand(
  command: ClientCommand["executable"],
  args: string[],
  configuration: ClientFiles,
  sessionDirectory: string,
  env: NodeJS.ProcessEnv,
): ClientCommand {
  let arguments_ = args;
  if (command === "gh") {
    if (
      configuration.client.canonicalApiHost !== "github.com" ||
      new URL(configuration.client.gatewayOrigin).port
    ) {
      throw new Error("gh-requires-canonical-host-and-port-443");
    }
    validateGhArguments(args, configuration.client.repository);
    const version = spawnSync("gh", ["--version"], {
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4096,
    });
    if (version.status !== 0 || !/^gh version 2\.100\.0(?:\s|$)/.test(version.stdout))
      throw new Error("unsupported-gh-version");
  } else {
    const helper = join(
      dirname(fileURLToPath(import.meta.url)),
      `git-helper${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
    );
    // Reset inherited helpers and HTTP defaults, including URL-specific configuration.
    arguments_ = prepareGitArguments(args, env, [
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=!${shellQuote(process.execPath)} ${shellQuote(helper)} ${shellQuote(sessionDirectory)}`,
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
    ]);
  }
  return { executable: command, arguments: arguments_ };
}
