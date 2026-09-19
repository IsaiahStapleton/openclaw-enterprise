import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectGitConfiguration,
  parseGhInvocation,
  prepareClientCommand,
  prepareLocalGitCommand,
} from "./commands.ts";
import { createBootstrapClientEnvironment, createClientEnvironment } from "./environment.ts";
import { parseGitInvocation } from "./git-context.ts";
import { executeClientCommand, withClientHome } from "./launch.ts";
import {
  inheritedRepositoryBinding,
  readRuntimeRepositoryManifest,
  repositorySelection,
  repositorySelectionVariable,
  requireCurrentBinding,
} from "./manifest.ts";
import {
  inspectGitDestination,
  inspectImplicitGitDestinations,
  routeGitDestinations,
  selectGhRepository,
  selectGitDestinations,
  selectGitUrl,
} from "./targets.ts";

/** Route an ordinary tool invocation using only its admitted Pod generation. */
export async function routeRepositoryClient(command: string, args: string[]): Promise<number> {
  if (command !== "git" && command !== "gh") {
    throw new Error("unsupported-client-command");
  }
  const manifest = await readRuntimeRepositoryManifest();
  const pinned = inheritedRepositoryBinding(manifest, process.env);
  return withClientHome(async (home) => {
    const bootstrap = createBootstrapClientEnvironment(home);
    if (command === "git") {
      const git = parseGitInvocation(args);
      if (git.command === "credential") {
        throw new Error("unsupported-client-command");
      }
      const overrides = inspectGitConfiguration(git.context, bootstrap, git.command === "clone");
      if (git.kind === "local") {
        // gh may inspect cwd A while explicitly operating on B. Local discovery
        // never changes its pin and receives no helper, hosts file or bearer.
        if (pinned) {
          bootstrap[repositorySelectionVariable] = repositorySelection(manifest, pinned);
        }
        return executeClientCommand(prepareLocalGitCommand(git, bootstrap, overrides), bootstrap);
      }
      if (git.command === "clone" && git.target) {
        // Clone accepts a URL operand, never a remote name from the current cwd.
        selectGitUrl(manifest, git.target.value, pinned);
      }
      const destinations = git.target
        ? [inspectGitDestination(git.target.value, git.push, git.context, bootstrap)]
        : inspectImplicitGitDestinations(git.push, git.context, bootstrap);
      const binding = selectGitDestinations(manifest, destinations, pinned);
      requireCurrentBinding(binding);
      const routing = routeGitDestinations(destinations, binding, git.push, git.context, bootstrap);
      const routedArgs = [...git.args];
      if (git.command === "clone" && git.target) {
        routedArgs[git.target.index] = binding.client.gitRemote;
      }
      const routed = {
        ...git,
        args: routedArgs,
        ...(git.command === "clone" && git.target
          ? { target: { ...git.target, value: binding.client.gitRemote } }
          : {}),
      };
      const env = createClientEnvironment(binding.configuration, binding.directory, home);
      env[repositorySelectionVariable] = repositorySelection(manifest, binding);
      const prepared = prepareClientCommand(
        "git",
        routedArgs,
        binding.configuration,
        binding.directory,
        env,
        {
          git: routed,
          overrides,
          routing,
        },
      );
      return executeClientCommand(prepared, env);
    }

    const gh = parseGhInvocation(args);
    const binding = gh.target
      ? selectGhRepository(manifest, gh.target.value, pinned)
      : (pinned ??
        selectGitDestinations(manifest, inspectImplicitGitDestinations(false, [], bootstrap)));
    requireCurrentBinding(binding);
    const normalizedArgs = [...gh.args];
    if (gh.target?.kind === "repository") {
      normalizedArgs[gh.target.index] = `github.com/${binding.client.repository}`;
    } else if (gh.target?.kind === "endpoint") {
      const endpoint = normalizedArgs[gh.target.index]!;
      normalizedArgs[gh.target.index] =
        `repos/${binding.client.repository}` + endpoint.slice(`repos/${gh.target.value}`.length);
    }
    const env = createClientEnvironment(binding.configuration, binding.directory, home);
    env[repositorySelectionVariable] = repositorySelection(manifest, binding);
    const prepared = prepareClientCommand(
      "gh",
      normalizedArgs,
      binding.configuration,
      binding.directory,
      env,
      {
        gh: {
          ...gh,
          args: normalizedArgs,
          ...(gh.target?.kind === "repository"
            ? { target: { ...gh.target, value: `github.com/${binding.client.repository}` } }
            : {}),
        },
      },
    );
    return executeClientCommand(prepared, env);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  routeRepositoryClient(command ?? "", args)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : "";
      const publicReasons = new Set([
        "name-one-repository-target",
        "name-one-repository-ref",
        "repository-not-admitted",
        "conflicting-repository-selection",
        "conflicting-git-url-rewrite",
        "unsupported-repository-target",
        "unsupported-client-command",
        "explicit-head-required",
        "repository-session-expired",
        "invalid-repository-selection",
      ]);
      if (reason === "name-one-repository-target") {
        process.stderr.write(
          "name-one-repository-target: name one admitted remote or URL explicitly.\n",
        );
      } else if (reason === "name-one-repository-ref") {
        process.stderr.write(
          "name-one-repository-ref: select the admitted binding with OCE_REPOSITORY_REF.\n",
        );
      } else {
        process.stderr.write(
          publicReasons.has(reason) ? `${reason}\n` : "repository-client-failed\n",
        );
      }
      process.exitCode = 1;
    });
}
