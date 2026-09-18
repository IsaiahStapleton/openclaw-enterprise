import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

export const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const appRoot =
  process.env.REPOSITORY_CREDENTIALS_APP_ROOT ??
  join(repositoryRoot, "apps/repository-credentials/src");
export const appExtension = appRoot.endsWith("/dist") ? "js" : "ts";
export function appModule(path) {
  return import(pathToFileURL(resolve(appRoot, `${path}.${appExtension}`)).href);
}
