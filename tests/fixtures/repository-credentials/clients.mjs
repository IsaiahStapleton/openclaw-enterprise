import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appRoot, appExtension } from "./runtime.mjs";
import { cleanEnvironment, run, temporaryDirectory } from "./process.mjs";

/**
 * Invoke the delivered launcher with a private work directory and clean environment.
 * @param {import("node:test").TestContext} t
 * @param {{clientDirectory: string}} fixture Public client files only.
 */
export async function runPinnedClients(t, fixture, { signal = t.signal } = {}) {
  const directory = await temporaryDirectory(t, "repository-credentials-client-work-");
  const launcher = join(appRoot, `drivers/repo/github/credentials/client/launch.${appExtension}`);
  const env = cleanEnvironment({ HOME: directory });
  const invoke = (client, args, options = {}) =>
    run(process.execPath, [launcher, fixture.clientDirectory, client, ...args], {
      env,
      cwd: directory,
      signal,
      ...options,
    });
  // Version inspection is a fixture prerequisite, not a supported gateway
  // command. The production launcher validates its own pin on actual gh use.
  const version = await run("gh", ["--version"], { env, signal });
  assert.match(version.stdout, /^gh version 2\.100\.0\b/);
  return {
    directory,
    git: (args, options) => invoke("git", args, options),
    gh: (args, options) => invoke("gh", args, options),
    async json(name, value) {
      const path = join(directory, name);
      await writeFile(path, JSON.stringify(value));
      return path;
    },
  };
}
