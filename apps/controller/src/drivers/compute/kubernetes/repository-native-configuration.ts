import type {
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
} from "@openclaw-enterprise/contracts";

export const REPOSITORY_CLIENT_BIN = "/opt/oce/repository-credentials/bin";

function object(
  value: OpenClawConfigurationValue | undefined,
  path: string,
): OpenClawConfigurationDocument {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Repository credentials require ${path} to be an object.`);
  }
  return value as OpenClawConfigurationDocument;
}

function projectExec(
  value: OpenClawConfigurationValue | undefined,
  inheritedPaths: OpenClawConfigurationValue | undefined,
  path: string,
): OpenClawConfigurationDocument {
  const exec = object(value, path);
  const paths = exec.pathPrepend === undefined ? inheritedPaths : exec.pathPrepend;
  if (
    paths !== undefined &&
    (!Array.isArray(paths) || paths.some((entry) => typeof entry !== "string"))
  ) {
    throw new Error(
      `Repository credentials require ${path}.pathPrepend to be an array of strings.`,
    );
  }
  return {
    ...exec,
    pathPrepend: [
      REPOSITORY_CLIENT_BIN,
      ...(paths ?? []).filter((entry) => entry !== REPOSITORY_CLIENT_BIN),
    ],
  };
}

function projectAgent(
  value: OpenClawConfigurationValue,
  inheritedPaths: OpenClawConfigurationValue | undefined,
  path: string,
): OpenClawConfigurationDocument {
  const agent = object(value, path);
  const tools = object(agent.tools, `${path}.tools`);
  if (tools.exec === undefined) {
    return agent;
  }
  // Agent pathPrepend replaces the global list, so preserve its effective inheritance.
  return {
    ...agent,
    tools: {
      ...tools,
      exec: projectExec(tools.exec, inheritedPaths, `${path}.tools.exec`),
    },
  };
}

export function repositoryNativeConfiguration(
  configuration: OpenClawConfigurationDocument,
): OpenClawConfigurationDocument {
  const tools = object(configuration.tools, "tools");
  // Native gateway exec prepends the login-shell PATH before applying this setting.
  const exec = projectExec(tools.exec, undefined, "tools.exec");
  const agents = object(configuration.agents, "agents");
  if (agents.list !== undefined && !Array.isArray(agents.list)) {
    throw new Error("Repository credentials require agents.list to be an array.");
  }
  const list = (agents.list as readonly OpenClawConfigurationValue[] | undefined)?.map((value) =>
    projectAgent(value, exec.pathPrepend, "agents.list entry"),
  );
  const entries =
    agents.entries === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(object(agents.entries, "agents.entries")).map(([id, value]) => [
            id,
            projectAgent(value, exec.pathPrepend, "agents.entries entry"),
          ]),
        );
  return {
    ...configuration,
    tools: { ...tools, exec },
    ...(list === undefined && entries === undefined
      ? {}
      : {
          agents: {
            ...agents,
            ...(list === undefined ? {} : { list }),
            ...(entries === undefined ? {} : { entries }),
          },
        }),
  };
}
