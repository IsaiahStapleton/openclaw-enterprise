import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

export const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const credentialSourceRoot = join(repositoryRoot, "apps/controller/src");
export const credentialEmittedRoot = process.env.REPOSITORY_CREDENTIALS_EMITTED_ROOT;
const moduleRoot = credentialEmittedRoot ?? credentialSourceRoot;
const moduleExtension = credentialEmittedRoot === undefined ? "ts" : "js";

function modulePath(owner, name) {
  return resolve(moduleRoot, owner, `${name}.${moduleExtension}`);
}

export function credentialDriverModule(name) {
  return import(pathToFileURL(modulePath("drivers/repository-credentials", name)).href);
}

export function githubProviderModule(name) {
  return import(pathToFileURL(modulePath("providers/repository-credentials/github", name)).href);
}

export function credentialCompositionModule(name) {
  return import(pathToFileURL(modulePath("composition/repository-credentials", name)).href);
}

export function credentialClientPath(name) {
  return modulePath("drivers/repository-credentials/client", name);
}
