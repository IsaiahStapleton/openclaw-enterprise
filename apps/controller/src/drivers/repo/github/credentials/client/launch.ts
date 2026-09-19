import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readClientConfiguration } from "./config.ts";
import { prepareClientCommand, type ClientCommand } from "./commands.ts";
import { createClientEnvironment } from "./environment.ts";

export async function withClientHome(run: (home: string) => Promise<number>): Promise<number> {
  const home = await mkdtemp(join(tmpdir(), "repository-client-"));
  try {
    return await run(home);
  } finally {
    try {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Cleanup must not replace an already completed mutation's exit status.
      process.stderr.write(`repository-client-cleanup-pending ${JSON.stringify(home)}\n`);
    }
  }
}

export async function executeClientCommand(
  prepared: ClientCommand,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(prepared.executable, prepared.arguments, { env, stdio: "inherit" });
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    const interrupt = (): void => forward("SIGINT");
    const terminate = (): void => forward("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const cleanup = (): void => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.once("error", () => {
      cleanup();
      reject(new Error("client-execution-failed"));
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolveExit(code ?? (signal ? 128 : 1));
    });
  });
}

export async function launchClient(
  directory: string,
  command: string,
  args: string[],
): Promise<number> {
  if (command !== "git" && command !== "gh") {
    throw new Error("unsupported-client-command");
  }
  const sessionDirectory = resolve(directory);
  const configuration = await readClientConfiguration(sessionDirectory);
  if (configuration.deadlineWallMs <= Date.now()) {
    throw new Error("repository-session-expired");
  }
  return withClientHome(async (home) => {
    const env = createClientEnvironment(configuration, sessionDirectory, home);
    const prepared = prepareClientCommand(command, args, configuration, sessionDirectory, env);
    return executeClientCommand(prepared, env);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, command, ...args] = process.argv.slice(2);
  if (!directory || !command) {
    process.stderr.write("Usage: repository-client SESSION_DIRECTORY git|gh ARGS...\n");
    process.exitCode = 1;
  } else {
    launchClient(directory, command, args)
      .then((code) => {
        process.exitCode = code;
      })
      .catch(() => {
        process.stderr.write("repository-client-failed\n");
        process.exitCode = 1;
      });
  }
}
