import { join } from "node:path";
import type { ClientFiles } from "./config.ts";

export const repositoryClientPath =
  "/opt/oce/repository-credentials/bin:/usr/local/bin:/usr/bin:/bin";

export function createBootstrapClientEnvironment(home: string): NodeJS.ProcessEnv {
  // Only Git/gh children receive this environment; the Harness keeps its model setup.
  return {
    PATH: repositoryClientPath,
    HOME: home,
    XDG_CONFIG_HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    GCM_INTERACTIVE: "Never",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    PAGER: "cat",
  };
}

export function createClientEnvironment(
  configuration: ClientFiles,
  sessionDirectory: string,
  home: string,
): NodeJS.ProcessEnv {
  // An allowlist prevents ambient tokens, proxy/debug settings, loaders and Git auth from leaking in.
  const env: NodeJS.ProcessEnv = {
    ...createBootstrapClientEnvironment(home),
    GIT_CONFIG_GLOBAL: join(sessionDirectory, "gitconfig"),
    GIT_ALLOW_PROTOCOL: "https",
    GH_CONFIG_DIR: join(sessionDirectory, "gh"),
    GH_HOST: "github.com",
    GH_REPO: `github.com/${configuration.client.repository}`,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_BROWSER: "/bin/false",
    BROWSER: "/bin/false",
    GH_PAGER: "cat",
    PAGER: "cat",
  };
  delete env.GIT_NO_LAZY_FETCH;
  if (configuration.hasPublicCa) {
    env.GIT_SSL_CAINFO = join(sessionDirectory, "ca.pem");
    env.SSL_CERT_FILE = join(sessionDirectory, "ca.pem");
    env.NODE_EXTRA_CA_CERTS = join(sessionDirectory, "ca.pem");
  }
  return env;
}
