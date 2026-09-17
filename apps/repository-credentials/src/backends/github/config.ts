import { isAbsolute } from "node:path";
import type { GitHubConfiguration } from "./types.ts";
export function validateGitHubConfiguration(value: unknown): GitHubConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-backend");
  const input = value as Record<string, unknown>;
  const fields = [
    "kind",
    "providerInstanceId",
    "configVersion",
    "appId",
    "installationId",
    "repositoryId",
    "repository",
    "privateKeyFile",
  ];
  if (
    Object.keys(input).some((key) => !fields.includes(key)) ||
    fields.some(
      (key) =>
        typeof input[key] !== "string" ||
        (input[key] as string).length < 1 ||
        (input[key] as string).length > 4096 ||
        /[\x00-\x1f\x7f]/.test(input[key] as string),
    )
  )
    throw new Error("invalid-backend");
  if (
    input.kind !== "github-app" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.providerInstanceId as string) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.configVersion as string)
  )
    throw new Error("invalid-backend");
  for (const key of ["appId", "installationId", "repositoryId"])
    if (
      !/^[1-9][0-9]{0,15}$/.test(input[key] as string) ||
      !Number.isSafeInteger(Number(input[key]))
    )
      throw new Error("invalid-backend");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(
      input.repository as string,
    ) ||
    !isAbsolute(input.privateKeyFile as string)
  )
    throw new Error("invalid-backend");
  return Object.freeze(
    Object.fromEntries(fields.map((key) => [key, input[key]])),
  ) as unknown as GitHubConfiguration;
}
