import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { ServiceKey } from "../auth/index.ts";

export interface BootstrapOutputFile {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

export interface BootstrapServiceKeyOutput {
  readonly data: ServiceKey & { readonly key: string };
  readonly meta: {
    readonly installationId: string;
  };
}

export interface BootstrapCleanupFailure {
  readonly path: string;
  readonly error: string;
}

export function bootstrapOutputPath(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must identify an absolute output path.`);
  }
  if (!isAbsolute(value)) {
    throw new Error(`${name} must identify an absolute output path.`);
  }
  return value;
}

export async function writeProtectedBootstrapFile(
  path: string,
  contents: string,
): Promise<BootstrapOutputFile> {
  const parent = dirname(path);
  const parentStatus = await lstat(parent);
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) {
    throw new Error("Bootstrap output parent must be a real directory.");
  }
  if ((parentStatus.mode & 0o007) !== 0 || !processOwnsParent(parentStatus.uid, parentStatus.gid)) {
    throw new Error("Bootstrap output parent must be private to the runtime identity.");
  }

  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let output: BootstrapOutputFile | undefined;
  try {
    await handle.chmod(0o600);
    const status = await handle.stat();
    output = { path, dev: status.dev, ino: status.ino };
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
  } catch (error) {
    await handle.close();
    await removeAttemptBootstrapFile(output);
    await syncDirectory(parent);
    throw error;
  }
  try {
    await handle.close();
    await syncDirectory(parent);
  } catch (error) {
    await removeAttemptBootstrapFile(output);
    throw error;
  }
  return output;
}

export async function writeProtectedBootstrapJson(
  path: string,
  payload: BootstrapServiceKeyOutput,
): Promise<BootstrapOutputFile> {
  return writeProtectedBootstrapFile(path, `${JSON.stringify(payload)}\n`);
}

export async function removeAttemptBootstrapFile(
  file: BootstrapOutputFile | undefined,
): Promise<BootstrapCleanupFailure | undefined> {
  if (file === undefined) return undefined;
  try {
    const status = await lstat(file.path);
    if (!status.isFile() || status.dev !== file.dev || status.ino !== file.ino) {
      return undefined;
    }
    await unlink(file.path);
    await syncDirectory(dirname(file.path));
    return undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return {
      path: file.path,
      error: error instanceof Error ? error.message : "Bootstrap output cleanup failed.",
    };
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function processOwnsParent(uid: number, gid: number): boolean {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUid !== undefined && (uid === currentUid || uid === 0)) return true;
  if (typeof process.getgroups !== "function") return false;
  return process.getgroups().includes(gid);
}
