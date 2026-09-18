export interface ParsedGitInvocation {
  readonly context: readonly string[];
  readonly command: string;
  readonly commandIndex: number;
  readonly args: readonly string[];
  readonly kind: "local" | "network";
  readonly target?: { readonly value: string; readonly index: number };
  readonly push: boolean;
}

interface Options {
  readonly flags: readonly string[];
  readonly values?: readonly string[];
  readonly assigned?: readonly string[];
}

const verbosity = ["--quiet", "-q", "--verbose", "-v", "--progress", "--no-progress"];
const fetchFlags = [
  ...verbosity,
  "--append",
  "-a",
  "--atomic",
  "--force",
  "-f",
  "--keep",
  "-k",
  "--prune",
  "-p",
  "--no-prune",
  "--prune-tags",
  "--no-prune-tags",
  "--tags",
  "-t",
  "--no-tags",
  "--unshallow",
  "--update-shallow",
  "--dry-run",
  "--no-write-fetch-head",
  "--write-fetch-head",
  "--no-recurse-submodules",
  "--recurse-submodules=no",
];
const fetchValues = [
  "--depth",
  "--deepen",
  "--shallow-since",
  "--shallow-exclude",
  "--refmap",
  "--filter",
  "--negotiation-tip",
  "--server-option",
  "--jobs",
  "-j",
];

const networkOptions: Readonly<Record<string, Options>> = {
  clone: {
    flags: [
      ...verbosity,
      "--no-checkout",
      "-n",
      "--bare",
      "--mirror",
      "--single-branch",
      "--no-single-branch",
      "--no-tags",
      "--sparse",
    ],
    values: [
      "-b",
      "--branch",
      "-o",
      "--origin",
      "--depth",
      "--shallow-since",
      "--shallow-exclude",
      "--filter",
    ],
  },
  fetch: { flags: fetchFlags, values: fetchValues },
  pull: {
    flags: [
      ...fetchFlags,
      "--ff",
      "--no-ff",
      "--ff-only",
      "--rebase",
      "-r",
      "--no-rebase",
      "--autostash",
      "--no-autostash",
      "--commit",
      "--no-commit",
      "--edit",
      "-e",
      "--no-edit",
      "--squash",
      "--no-squash",
      "--log",
      "--no-log",
      "--stat",
      "--no-stat",
      "--verify",
      "--no-verify",
      "--allow-unrelated-histories",
      "--rebase=false",
      "--rebase=true",
      "--rebase=merges",
      "--rebase=interactive",
    ],
    values: [...fetchValues, "--strategy", "-s", "--strategy-option", "-X"],
  },
  push: {
    flags: [
      ...verbosity,
      "--all",
      "--branches",
      "--mirror",
      "--tags",
      "--follow-tags",
      "--atomic",
      "--dry-run",
      "-n",
      "--force",
      "-f",
      "--force-with-lease",
      "--force-if-includes",
      "--no-force-if-includes",
      "--delete",
      "-d",
      "--prune",
      "--porcelain",
      "--set-upstream",
      "-u",
      "--no-verify",
      "--verify",
      "--thin",
      "--no-thin",
      "--recurse-submodules=no",
      "--no-recurse-submodules",
    ],
    values: ["--push-option", "-o"],
    assigned: ["--force-with-lease"],
  },
  "ls-remote": {
    flags: [
      ...verbosity,
      "--heads",
      "-h",
      "--branches",
      "--tags",
      "-t",
      "--refs",
      "--symref",
      "--exit-code",
      "--get-url",
    ],
    values: ["--sort", "--server-option"],
  },
};

// These builtins operate on local state. Recursive transport is disabled during
// preparation; discovery without a binding also prohibits lazy fetch entirely.
const localCommands = new Set([
  "init",
  "status",
  "add",
  "diff",
  "commit",
  "switch",
  "checkout",
  "branch",
  "rev-parse",
  "symbolic-ref",
  "show-ref",
  "for-each-ref",
  "rev-list",
  "log",
  "show",
  "ls-files",
  "ls-tree",
  "cat-file",
  "check-ref-format",
  "merge-base",
  "diff-files",
  "diff-index",
  "diff-tree",
  "reset",
  "restore",
  "stash",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "tag",
  "clean",
  "version",
  "--version",
]);

function unsupported(): never {
  throw new Error("unsupported-client-command");
}

/** Find operands without treating an option value or refspec as another target. */
function operands(args: readonly string[], start: number, options: Options): number[] {
  const found: number[] = [];
  let ended = false;
  for (let index = start; index < args.length; index++) {
    const argument = args[index]!;
    if (ended || !argument.startsWith("-") || argument === "-") {
      found.push(index);
    } else if (argument === "--") {
      ended = true;
    } else if (options.flags.includes(argument)) {
      continue;
    } else if (options.values?.includes(argument)) {
      if (!args[++index]) {
        unsupported();
      }
    } else if (argument.startsWith("--")) {
      const separator = argument.indexOf("=");
      if (
        separator < 0 ||
        !(
          options.values?.includes(argument.slice(0, separator)) ||
          options.assigned?.includes(argument.slice(0, separator))
        ) ||
        !argument.slice(separator + 1)
      ) {
        unsupported();
      }
    } else {
      // Git accepts attached short values and clusters of short switches. A
      // value-taking option consumes the rest of its token, or the next token.
      for (let offset = 1; offset < argument.length; offset++) {
        const option = `-${argument[offset]}`;
        if (options.values?.includes(option)) {
          if (offset === argument.length - 1 && !args[++index]) {
            unsupported();
          }
          break;
        }
        if (!options.flags.includes(option)) {
          unsupported();
        }
      }
    }
  }
  return found;
}

function validateRemote(args: readonly string[], start: number): void {
  if (args[start] === "-v" || args[start] === "--verbose") {
    start++;
  }
  if (start === args.length) {
    return;
  }
  const command = args[start++]!;
  const forms: Readonly<Record<string, Options & { minimum: number; maximum: number }>> = {
    add: { flags: ["--tags", "--no-tags"], values: ["-t", "-m"], minimum: 2, maximum: 2 },
    "get-url": { flags: ["--push", "--all"], minimum: 1, maximum: 1 },
    "set-url": { flags: ["--push", "--add", "--delete"], minimum: 2, maximum: 3 },
    rename: { flags: [], minimum: 2, maximum: 2 },
    remove: { flags: [], minimum: 1, maximum: 1 },
    rm: { flags: [], minimum: 1, maximum: 1 },
    "set-head": { flags: ["-d", "--delete"], minimum: 1, maximum: 2 },
    "set-branches": { flags: ["--add"], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    show: { flags: ["-n", "--no-query"], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  };
  const form = Object.hasOwn(forms, command) ? forms[command] : undefined;
  if (!form) {
    unsupported();
  }
  const positions = operands(args, start, form);
  if (positions.length < form.minimum || positions.length > form.maximum) {
    unsupported();
  }
  const endOptions = args.indexOf("--", start);
  if (
    command === "show" &&
    !args
      .slice(start, endOptions < 0 ? undefined : endOptions)
      .some((arg) => arg === "-n" || arg === "--no-query")
  ) {
    unsupported();
  }
}

function validateLocal(command: string, args: readonly string[], start: number): void {
  if (command === "remote") {
    validateRemote(args, start);
    return;
  }
  if (command === "credential") {
    // The standalone helper qualification uses this exact builtin. The ordinary
    // Agent router refuses it and never supplies credentials on its local path.
    if (args.length !== start + 1 || args[start] !== "fill") {
      unsupported();
    }
    return;
  }
  if (command === "worktree") {
    if (
      !["add", "list", "lock", "unlock", "move", "prune", "remove", "repair"].includes(
        args[start] ?? "",
      )
    ) {
      unsupported();
    }
  } else if (command === "config") {
    const positions = operands(args, start, {
      flags: [
        "--global",
        "--system",
        "--local",
        "--worktree",
        "--includes",
        "--no-includes",
        "--null",
        "-z",
        "--list",
        "-l",
        "--get",
        "--get-all",
        "--get-regexp",
        "--get-urlmatch",
        "--add",
        "--replace-all",
        "--unset",
        "--unset-all",
        "--rename-section",
        "--remove-section",
        "--name-only",
        "--show-origin",
        "--show-scope",
        "--bool",
        "--int",
        "--bool-or-int",
        "--bool-or-str",
        "--path",
        "--expiry-date",
        "--no-type",
        "--fixed-value",
        "--all",
        "--regexp",
        "--show-names",
        "--no-show-names",
      ],
      values: ["--file", "-f", "--blob", "--type", "--default", "--value", "--comment"],
    });
    const first = positions[0] === undefined ? undefined : args[positions[0]];
    if (first === "edit") {
      unsupported();
    }
  } else if (!localCommands.has(command)) {
    unsupported();
  }
  if (["checkout", "switch", "restore"].includes(command)) {
    for (const argument of args.slice(start)) {
      if (argument === "--") {
        break;
      }
      if (/^--recurse-submodules(?:=|$)/.test(argument) && argument !== "--recurse-submodules=no") {
        unsupported();
      }
    }
  }
}

/** Normalize once; inspection and execution reuse the same ordered global context. */
export function parseGitInvocation(input: readonly string[]): ParsedGitInvocation {
  const args = Object.freeze([...input]);
  const globalArguments: string[] = [];
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-") && args[index] !== "--version") {
    const option = args[index++]!;
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(option)) {
      const value = args[index++];
      if (value === undefined) {
        unsupported();
      }
      if (option === "-C" || option === "-c") {
        globalArguments.push(option, value);
      } else {
        globalArguments.push(`${option}=${value}`);
      }
    } else if (option.startsWith("-C") || option.startsWith("-c")) {
      globalArguments.push(option.slice(0, 2), option.slice(2));
    } else if (
      /^(?:--(?:git-dir|work-tree|namespace|config-env)=.+|--(?:bare|no-pager|paginate|no-replace-objects|no-optional-locks|literal-pathspecs|no-literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs))$/.test(
        option,
      )
    ) {
      globalArguments.push(option);
    } else {
      unsupported();
    }
  }
  const context = Object.freeze(globalArguments);
  const commandIndex = index;
  const command = args[index++];
  if (!command) {
    unsupported();
  }
  const options = Object.hasOwn(networkOptions, command) ? networkOptions[command] : undefined;
  if (!options) {
    validateLocal(command, args, index);
    return Object.freeze({ context, command, commandIndex, args, kind: "local", push: false });
  }
  const positions = operands(args, index, options);
  if (command === "clone" && (positions.length < 1 || positions.length > 2)) {
    unsupported();
  }
  const targetIndex = positions[0];
  if (targetIndex !== undefined && !args[targetIndex]) {
    unsupported();
  }
  return Object.freeze({
    context,
    command,
    commandIndex,
    args,
    kind: "network",
    push: command === "push",
    ...(targetIndex === undefined
      ? {}
      : { target: Object.freeze({ value: args[targetIndex]!, index: targetIndex }) }),
  });
}
