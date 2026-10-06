import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// One lock per lane state directory: concurrent test files in a lane are separate
// processes on one runner. A lock left by a dead process is taken over.
async function withAttachmentLock(lockPath, step) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const holder = Number((await readFile(lockPath, "utf8").catch(() => "")).trim());
      if (Number.isInteger(holder) && holder > 0 && !processAlive(holder)) {
        await rm(lockPath, { force: true });
        continue;
      }
      assert.ok(Date.now() < deadline, `timed out waiting for ${lockPath}`);
      await delay(100);
    }
  }
  try {
    return await step();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function readHolders(registryPath) {
  try {
    return JSON.parse(await readFile(registryPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { connectedByHarness: false, holders: {} };
    }
    throw error;
  }
}

async function writeHolders(registryPath, registry) {
  const temporary = `${registryPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(registry), { mode: 0o600 });
  await rename(temporary, registryPath);
}

function liveHolders(registry) {
  return Object.fromEntries(
    Object.entries(registry.holders).filter(([, pid]) => processAlive(pid)),
  );
}

// Connects the lane's PostgreSQL container to its k3d network for in-cluster OCC.
// Files that run concurrently in one lane share the attachment: the first connects,
// and only the last holder disconnects, so no file loses PostgreSQL under a sibling.
// An attachment that existed before any harness connected it is never removed.
export async function attachPostgresToK3d(registerCleanup) {
  const statePath = process.env.OPENCLAW_ENTERPRISE_CI_STATE;
  const containerBin = process.env.OCC_DOCKER_BIN ?? "docker";
  assert.ok(statePath, "OPENCLAW_ENTERPRISE_CI_STATE is required for in-cluster OCC");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const cluster = state.resources?.find(
    ({ kind, status }) => kind === "k3d-cluster" && status === "ready",
  );
  const postgres = state.resources?.find(
    ({ kind, status }) => kind === "compose-postgres" && status === "ready",
  );
  assert.ok(cluster?.name, "prepared state must identify the owned k3d cluster");
  assert.ok(postgres?.name, "prepared state must identify the owned PostgreSQL service");
  const { stdout: containerOutput } = await executeFile(containerBin, [
    "ps",
    "--filter",
    `label=com.docker.compose.project=${postgres.name}`,
    "--filter",
    "label=com.docker.compose.service=postgres",
    "--format",
    "{{.Names}}",
  ]);
  const containers = containerOutput.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(containers.length, 1, "prepared PostgreSQL must have exactly one container");
  const postgresContainer = containers[0];
  const serverContainer = `k3d-${cluster.name}-server-0`;
  const { stdout: serverNetworksOutput } = await executeFile(containerBin, [
    "inspect",
    "--format",
    "{{json .NetworkSettings.Networks}}",
    serverContainer,
  ]);
  const serverNetworks = JSON.parse(serverNetworksOutput);
  const network = Object.keys(serverNetworks).find((name) =>
    name.startsWith(`k3d-${cluster.name}`),
  );
  assert.ok(network, "owned k3d server network must be inspectable");
  const attached = async () => {
    const { stdout } = await executeFile(containerBin, [
      "inspect",
      "--format",
      "{{json .NetworkSettings.Networks}}",
      postgresContainer,
    ]);
    return Object.hasOwn(JSON.parse(stdout), network);
  };

  const base = join(dirname(statePath), `postgres-k3d-${cluster.name}`);
  const lockPath = `${base}.lock`;
  const registryPath = `${base}.json`;
  const holder = randomUUID();
  await withAttachmentLock(lockPath, async () => {
    const registry = await readHolders(registryPath);
    const holders = liveHolders(registry);
    // An attachment no harness file made (connectedByHarness false) stays with its owner.
    let connectedByHarness = registry.connectedByHarness;
    if (!(await attached())) {
      await executeFile(containerBin, ["network", "connect", network, postgresContainer]);
      connectedByHarness = true;
    }
    await writeHolders(registryPath, {
      connectedByHarness,
      holders: { ...holders, [holder]: process.pid },
    });
  });
  registerCleanup(async () => {
    await withAttachmentLock(lockPath, async () => {
      const registry = await readHolders(registryPath);
      const remaining = liveHolders(registry);
      delete remaining[holder];
      if (Object.keys(remaining).length > 0) {
        await writeHolders(registryPath, { ...registry, holders: remaining });
        return;
      }
      if (registry.connectedByHarness) {
        await executeFile(containerBin, [
          "network",
          "disconnect",
          "--force",
          network,
          postgresContainer,
        ]).catch(() => undefined);
      }
      await rm(registryPath, { force: true });
    });
  });
  const { stdout: attachedOutput } = await executeFile(containerBin, [
    "inspect",
    "--format",
    `{{(index .NetworkSettings.Networks ${JSON.stringify(network)}).IPAddress}}`,
    postgresContainer,
  ]);
  const address = attachedOutput.trim();
  assert.equal(isIP(address), 4, "PostgreSQL must have an IPv4 address on the k3d network");
  return address;
}
