import { spawnSync } from "node:child_process";
import type { ClientFiles } from "./config.ts";

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

export function prepareGhCommand(
  gh: ParsedGhInvocation,
  configuration: ClientFiles,
  env: NodeJS.ProcessEnv,
): ClientCommand {
  if (
    configuration.client.canonicalApiHost !== "github.com" ||
    new URL(configuration.client.gatewayOrigin).port
  ) {
    throw new Error("gh-requires-canonical-host-and-port-443");
  }
  if (
    gh.target &&
    gh.target.value.replace(/^github\.com\//, "").toLowerCase() !==
      configuration.client.repository.toLowerCase()
  ) {
    throw new Error("conflicting-repository-selection");
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
