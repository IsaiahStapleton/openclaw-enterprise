const fs = require("node:fs");
const { join } = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

class OwnershipFailure extends Error {}
class ConfigurationFailure extends Error {}

const hash = (value) => createHash("sha256").update(value).digest("hex");
const temporary = (path) => `${path}.pending-${process.pid}-${randomBytes(8).toString("hex")}`;
let child;

function inspect(path) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function directory(path, create = false) {
  const info = inspect(path);
  if (info === undefined && create) {
    fs.mkdirSync(path, { recursive: true, mode: 0o755 });
    return;
  }
  if (!info?.isDirectory()) throw new OwnershipFailure("Expected an owned directory.");
}

function regular(path) {
  if (!inspect(path)?.isFile()) throw new OwnershipFailure("Expected an owned regular file.");
}

function readJson(path) {
  regular(path);
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    throw new OwnershipFailure("Invalid ownership marker.");
  }
}

function verify(marker, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(marker?.[key]) !== JSON.stringify(value)) {
      throw new OwnershipFailure("Host object ownership or immutable snapshot differs.");
    }
  }
  return marker;
}

function atomicWrite(path, contents, mode = 0o600, owner) {
  if (inspect(path) !== undefined) regular(path);
  const pending = temporary(path);
  try {
    fs.writeFileSync(pending, contents, { mode, flag: "wx" });
    if (owner !== undefined) fs.chownSync(pending, owner.uid, owner.gid);
    fs.renameSync(pending, path);
  } finally {
    fs.rmSync(pending, { force: true });
  }
}

function atomicDirectory(path, initialize) {
  const pending = temporary(path);
  fs.mkdirSync(pending, { mode: 0o755 });
  try {
    initialize(pending);
    fs.renameSync(pending, path);
  } finally {
    fs.rmSync(pending, { recursive: true, force: true });
  }
}

async function command(file, args, allowFailure = false) {
  return new Promise((resolve, reject) => {
    child = execFile(
      file,
      args,
      { encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        child = undefined;
        if (error && !allowFailure) reject(new Error("Host command failed."));
        else resolve({ success: !error, stdout: stdout.trim() });
      },
    );
  });
}

async function systemctl(...args) {
  return command("systemctl", args);
}

async function runtimeOwner(runtime) {
  const uid = Number((await command("id", ["-u", runtime.user])).stdout);
  const gid = Number((await command("id", ["-g", runtime.user])).stdout);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) {
    throw new ConfigurationFailure("Runtime user is unavailable.");
  }
  return { uid, gid };
}

async function probe(runtime) {
  await systemctl("--version");
  await command("sh", ["-c", "command -v flock"]);
  fs.accessSync(runtime.nodePath, fs.constants.X_OK);
  fs.accessSync(runtime.openclawPath, fs.constants.R_OK);
  await runtimeOwner(runtime);
}

const LOCK_NAME = ".compute-lock";
let lockHolder;

// Host-wide serialization uses a kernel flock(2) on <root>/.compute-lock held by
// a child whose stdin is this process. Whatever kills this helper (SSH drop,
// SIGKILL, deadline, host crash) closes that pipe, the child exits, and the
// kernel releases the lock; there is no stale-lock state to reclaim.
async function acquireLock(root) {
  directory(root, true);
  const path = join(root, LOCK_NAME);
  const holder = spawn("flock", ["-w", "30", path, "sh", "-c", "printf ok && read -r _"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  await new Promise((resolve, reject) => {
    let acquired = false;
    holder.stdout.setEncoding("utf8").on("data", (chunk) => {
      if (chunk.includes("ok")) {
        acquired = true;
        resolve();
      }
    });
    holder.once("error", () => reject(new ConfigurationFailure("Host flock is unavailable.")));
    holder.once("exit", () => {
      if (!acquired) reject(new Error("Host operation lock timed out."));
    });
  });
  lockHolder = holder;
}

function releaseLock() {
  if (lockHolder !== undefined) {
    lockHolder.stdin.end();
    lockHolder.kill("SIGTERM");
    lockHolder = undefined;
  }
}

function ownership(input) {
  return {
    driverId: input.driverId,
    implementation: input.implementation,
    namespaceId: input.namespace.id,
    namespaceName: input.namespace.name,
  };
}

function agentOwnership(input) {
  return {
    ...ownership(input),
    agentId: input.revision.agentId,
    servicePrincipalId: input.revision.servicePrincipalId,
  };
}

function namespaceDirectory(input) {
  return join(input.runtime.root, "namespaces", hash(input.namespace.id).slice(0, 12));
}

function unitName(agentId) {
  return `openclaw-enterprise-gateway-${hash(agentId).slice(0, 12)}.service`;
}

function unitHeader(namespaceId, agentId) {
  return `# openclaw-enterprise namespace=${namespaceId} agent=${agentId}`;
}

function verifyUnit(input, agent) {
  const path = join(input.runtime.systemdUnitDirectory, unitName(agent.agentId));
  if (inspect(path) === undefined) return undefined;
  regular(path);
  const contents = fs.readFileSync(path, "utf8");
  if (!contents.split("\n").includes(unitHeader(agent.namespaceId, agent.agentId))) {
    throw new OwnershipFailure("Refusing an unowned systemd unit.");
  }
  return contents;
}

function verifyNamespace(input) {
  const path = namespaceDirectory(input);
  directory(join(input.runtime.root, "namespaces"));
  directory(path);
  verify(readJson(join(path, "namespace.json")), ownership(input));
}

function verifyAgent(input, path) {
  directory(path);
  const marker = verify(readJson(join(path, "agent.json")), agentOwnership(input));
  if (!Number.isSafeInteger(marker.port) || marker.port < 1024 || marker.port > 65535) {
    throw new OwnershipFailure("Invalid Agent port marker.");
  }
  for (const name of ["home", "state", "revisions"]) directory(join(path, name));
  verifyUnit(input, marker);
  servedRevision(path);
  return marker;
}

// Written only after a restart reached readiness; a pointer flip alone never counts.
function servedRevision(agentDir) {
  const path = join(agentDir, "served.json");
  if (inspect(path) === undefined) return undefined;
  const marker = readJson(path);
  if (typeof marker.revisionId !== "string") throw new OwnershipFailure("Invalid served marker.");
  return marker.revisionId;
}

function snapshot(input, agentDir, revisionId, expected) {
  const path = join(agentDir, "revisions", hash(revisionId).slice(0, 12));
  directory(path);
  const marker = verify(readJson(join(path, "revision.json")), {
    ...agentOwnership(input),
    revisionId,
    ...expected,
  });
  regular(join(path, "openclaw.json"));
  if (
    marker.configurationHash !== hash(fs.readFileSync(join(path, "openclaw.json"), "utf8")) ||
    !Number.isSafeInteger(marker.revision) ||
    marker.revision < 1 ||
    marker.harness?.id !== "openclaw" ||
    marker.harness?.mode !== "embedded"
  ) {
    throw new OwnershipFailure("Immutable revision snapshot differs.");
  }
  return marker;
}

function currentSnapshot(input, agentDir) {
  const path = join(agentDir, "current");
  const info = inspect(path);
  if (info === undefined) return undefined;
  if (!info.isSymbolicLink()) throw new OwnershipFailure("Current pointer is not a symlink.");
  const target = fs.readlinkSync(path);
  if (!/^revisions\/[a-f0-9]{12}$/.test(target))
    throw new OwnershipFailure("Current pointer escapes Agent revisions.");
  const marker = readJson(join(agentDir, target, "revision.json"));
  if (
    typeof marker.revisionId !== "string" ||
    target !== `revisions/${hash(marker.revisionId).slice(0, 12)}`
  ) {
    throw new OwnershipFailure("Current revision identity differs.");
  }
  return snapshot(input, agentDir, marker.revisionId);
}

function revisionMetadata(input) {
  return {
    ...agentOwnership(input),
    revisionId: input.revision.id,
    revision: input.revision.revision,
    configurationHash: input.configurationHash,
    harness: input.revision.harness,
  };
}

function allocatedPorts(input) {
  const ports = new Set();
  const namespaces = join(input.runtime.root, "namespaces");
  directory(namespaces);
  for (const entry of fs.readdirSync(namespaces)) {
    const nsDir = join(namespaces, entry);
    directory(nsDir);
    const ns = readJson(join(nsDir, "namespace.json"));
    if (typeof ns.namespaceId !== "string" || entry !== hash(ns.namespaceId).slice(0, 12)) {
      throw new OwnershipFailure("Invalid host Namespace marker.");
    }
    const agents = join(nsDir, "agents");
    directory(agents);
    for (const name of fs.readdirSync(agents)) {
      const agentDir = join(agents, name);
      directory(agentDir);
      const agent = readJson(join(agentDir, "agent.json"));
      verify(agent, {
        driverId: ns.driverId,
        implementation: ns.implementation,
        namespaceId: ns.namespaceId,
        namespaceName: ns.namespaceName,
      });
      if (
        typeof agent.agentId !== "string" ||
        name !== hash(agent.agentId).slice(0, 12) ||
        !Number.isSafeInteger(agent.port) ||
        agent.port < 1024 ||
        agent.port > 65535 ||
        ports.has(agent.port)
      ) {
        throw new OwnershipFailure("Invalid or duplicate host Agent port.");
      }
      ports.add(agent.port);
    }
  }
  return ports;
}

function renderUnit(input, agentDir, port) {
  const { runtime, revision } = input;
  const token = revision.configuration.gateway?.auth?.mode !== "trusted-proxy";
  return `[Unit]
Description=OpenClaw Enterprise gateway ${revision.agentId}
${unitHeader(revision.namespaceId, revision.agentId)}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${runtime.user}
WorkingDirectory=${agentDir}/state
Environment=HOME=${agentDir}/home
Environment=OPENCLAW_STATE_DIR=${agentDir}/state
Environment=OPENCLAW_CONFIG_PATH=${agentDir}/current/openclaw.json
Environment=OPENCLAW_GATEWAY_PORT=${port}
${token ? `EnvironmentFile=${agentDir}/gateway.env\n` : ""}EnvironmentFile=-${agentDir}/env
ExecStart=${runtime.nodePath} ${runtime.openclawPath} gateway --port ${port}
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
}

async function active(unit) {
  return (await command("systemctl", ["is-active", "--quiet", unit], true)).success;
}

async function ready(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(1_000),
      redirect: "error",
    });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

async function waitReady(unit, port) {
  const deadline = Date.now() + 120_000;
  do {
    if (!(await active(unit))) throw new Error("Gateway unit is inactive.");
    if (await ready(port)) return;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error("Gateway readiness timed out.");
}

async function prepare(input, nsDir) {
  const revision = input.revision;
  if (revision.harness.id !== "openclaw" || revision.harness.mode !== "embedded")
    throw new ConfigurationFailure("Only embedded OpenClaw is supported.");
  if (input.configurationHash !== hash(JSON.stringify(revision.configuration)))
    throw new OwnershipFailure("Admitted configuration hash differs.");
  const agents = join(nsDir, "agents");
  directory(agents);
  const agentDir = join(agents, hash(revision.agentId).slice(0, 12));
  const expected = agentOwnership(input);
  const existingUnit = verifyUnit(input, expected);
  const owner = await runtimeOwner(input.runtime);
  if (inspect(agentDir) === undefined) {
    const used = allocatedPorts(input);
    const range = input.network.gatewayPortRange;
    let port = range.start;
    while (used.has(port) && port <= range.end) port++;
    if (port > range.end) throw new ConfigurationFailure("Host gateway port range is exhausted.");
    atomicDirectory(agentDir, (pending) => {
      fs.writeFileSync(join(pending, "agent.json"), JSON.stringify({ ...expected, port }), {
        mode: 0o600,
      });
      for (const name of ["home", "state"]) {
        const path = join(pending, name);
        fs.mkdirSync(path, { mode: 0o700 });
        fs.chownSync(path, owner.uid, owner.gid);
      }
      fs.mkdirSync(join(pending, "revisions"), { mode: 0o755 });
    });
  }
  const agent = verifyAgent(input, agentDir);
  const current = currentSnapshot(input, agentDir);
  const revisionDir = join(agentDir, "revisions", hash(revision.id).slice(0, 12));
  const snapshotExists = inspect(revisionDir) !== undefined;
  if (snapshotExists) snapshot(input, agentDir, revision.id, revisionMetadata(input));
  // A late worker must not write snapshots, tokens, units, or pointers over a newer revision.
  if (current !== undefined && current.revision > revision.revision) return { ready: false };
  if (
    current !== undefined &&
    current.revision === revision.revision &&
    current.revisionId !== revision.id
  ) {
    throw new OwnershipFailure("Revision number belongs to another immutable revision.");
  }
  if (!snapshotExists) {
    atomicDirectory(revisionDir, (pending) => {
      // Controller-owned and group-readable: the runtime account can read but never
      // rewrite the admitted document, so a live gateway cannot bypass admission.
      atomicWrite(join(pending, "openclaw.json"), JSON.stringify(revision.configuration), 0o640, {
        uid: process.getuid(),
        gid: owner.gid,
      });
      atomicWrite(join(pending, "revision.json"), JSON.stringify(revisionMetadata(input)));
    });
  }
  if (revision.configuration.gateway?.auth?.mode !== "trusted-proxy") {
    const tokenFile = join(agentDir, "gateway.env");
    if (inspect(tokenFile) === undefined)
      atomicWrite(tokenFile, `OPENCLAW_GATEWAY_TOKEN=${randomBytes(32).toString("hex")}\n`);
    else regular(tokenFile);
  }
  directory(input.runtime.systemdUnitDirectory);
  const unit = unitName(revision.agentId);
  const unitPath = join(input.runtime.systemdUnitDirectory, unit);
  const content = renderUnit(input, agentDir, agent.port);
  const changed = existingUnit !== content;
  if (changed) atomicWrite(unitPath, content, 0o644);
  await systemctl("daemon-reload");
  await systemctl("enable", unit);
  if (
    !changed &&
    current?.revisionId === revision.id &&
    servedRevision(agentDir) === revision.id &&
    (await active(unit)) &&
    (await ready(agent.port))
  )
    return { ready: true };
  const pending = temporary(join(agentDir, "current"));
  try {
    fs.symlinkSync(`revisions/${hash(revision.id).slice(0, 12)}`, pending);
    fs.renameSync(pending, join(agentDir, "current"));
  } finally {
    fs.rmSync(pending, { force: true });
  }
  await systemctl("restart", unit);
  await waitReady(unit, agent.port);
  atomicWrite(join(agentDir, "served.json"), JSON.stringify({ revisionId: revision.id }));
  return { ready: true };
}

async function removeNamespace(input, nsDir) {
  const agentsDir = join(nsDir, "agents");
  directory(agentsDir);
  const agents = [];
  // Validate the complete deletion set before stopping any gateway.
  for (const name of fs.readdirSync(agentsDir)) {
    const agentDir = join(agentsDir, name);
    directory(agentDir);
    const agent = readJson(join(agentDir, "agent.json"));
    if (
      typeof agent.agentId !== "string" ||
      typeof agent.servicePrincipalId !== "string" ||
      name !== hash(agent.agentId).slice(0, 12)
    ) {
      throw new OwnershipFailure("Invalid Agent ownership marker.");
    }
    const scoped = { ...input, revision: agent };
    verifyAgent(scoped, agentDir);
    currentSnapshot(scoped, agentDir);
    for (const revision of fs.readdirSync(join(agentDir, "revisions"))) {
      const marker = readJson(join(agentDir, "revisions", revision, "revision.json"));
      if (
        typeof marker.revisionId !== "string" ||
        revision !== hash(marker.revisionId).slice(0, 12)
      )
        throw new OwnershipFailure("Invalid revision ownership marker.");
      snapshot(scoped, agentDir, marker.revisionId);
    }
    agents.push(agent);
  }
  for (const agent of agents) {
    if (verifyUnit(input, agent) !== undefined) {
      const unit = unitName(agent.agentId);
      await systemctl("stop", unit);
      await systemctl("disable", unit);
      fs.unlinkSync(join(input.runtime.systemdUnitDirectory, unit));
    }
  }
  await systemctl("daemon-reload");
  fs.rmSync(nsDir, { recursive: true });
  return {};
}

async function run(input) {
  if (input.operation === "probe") {
    await probe(input.runtime);
    return {};
  }
  const nsDir = namespaceDirectory(input);
  if (input.operation === "delete-namespace" && inspect(nsDir) === undefined) return {};
  await acquireLock(input.runtime.root);
  try {
    if (input.operation === "ensure-namespace") {
      directory(join(input.runtime.root, "namespaces"), true);
      if (inspect(nsDir) === undefined) {
        atomicDirectory(nsDir, (pending) => {
          atomicWrite(join(pending, "namespace.json"), JSON.stringify(ownership(input)));
          fs.mkdirSync(join(pending, "agents"), { mode: 0o755 });
        });
      }
      verifyNamespace(input);
      return {};
    }
    verifyNamespace(input);
    if (input.operation === "delete-namespace") return await removeNamespace(input, nsDir);
    if (input.operation === "prepare-revision") return await prepare(input, nsDir);
    const revision = input.revision;
    const agentDir = join(nsDir, "agents", hash(revision.agentId).slice(0, 12));
    if (input.operation === "retire-revision" && inspect(agentDir) === undefined) return {};
    const agent = verifyAgent(input, agentDir);
    const current = currentSnapshot(input, agentDir);
    const revisionDir = join(agentDir, "revisions", hash(revision.id).slice(0, 12));
    if (input.operation === "retire-revision" && inspect(revisionDir) === undefined) return {};
    snapshot(input, agentDir, revision.id, revisionMetadata(input));
    if (input.operation === "verify-revision") return {};
    if (input.operation === "activate-revision") {
      if (current?.revisionId !== revision.id || servedRevision(agentDir) !== revision.id)
        throw new OwnershipFailure("Current or served revision differs from the activated one.");
      if (!(await active(unitName(revision.agentId))) || !(await ready(agent.port)))
        throw new Error("Activated gateway is not ready.");
      return {};
    }
    if (input.operation === "retire-revision") {
      if (current?.revisionId === revision.id) {
        const unit = unitName(revision.agentId);
        if (verifyUnit(input, agent) !== undefined) {
          await systemctl("stop", unit);
          await systemctl("disable", unit);
        }
        fs.unlinkSync(join(agentDir, "current"));
        fs.rmSync(join(agentDir, "served.json"), { force: true });
      }
      fs.rmSync(revisionDir, { recursive: true });
      return {};
    }
    throw new ConfigurationFailure("Unknown SSH helper operation.");
  } finally {
    releaseLock();
  }
}

function abandon() {
  child?.kill("SIGTERM");
  releaseLock();
  process.exit(1);
}

for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, abandon);

// A cancelled SSH client does not signal this process (no PTY, stdin already
// consumed). The reliable loss signal is a failed write to the closed session
// pipe, so heartbeat every second and stop mutating as soon as one fails.
process.stdout.on("error", abandon);
const heartbeat = setInterval(() => {
  try {
    process.stdout.write("\n");
  } catch {
    abandon();
  }
}, 1_000);

function parseInput() {
  try {
    const input = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"));
    if (Number.isSafeInteger(input.deadlineMs) && input.deadlineMs > 0) return input;
  } catch {
    /* Reported below as invalid input. */
  }
  return undefined;
}

const input = parseInput();
// Enforce a deadline below the transport timeout so a hung host step cannot
// outlive the controller operation that owns it.
const deadline = setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, failure: "retryable" })}\n`);
  process.stderr.write("Host operation deadline exceeded.\n");
  abandon();
}, input?.deadlineMs ?? 0);

Promise.resolve()
  .then(() => {
    if (input === undefined) throw new ConfigurationFailure("Invalid helper operation input.");
    return run(input);
  })
  .then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  })
  .catch((error) => {
    let failure = "retryable";
    let message = "SSH host operation failed or timed out.";
    if (error instanceof OwnershipFailure) {
      failure = "ownership";
      message = error.message;
    } else if (error instanceof ConfigurationFailure) {
      failure = "configuration";
      message = error.message;
    }
    process.stdout.write(`${JSON.stringify({ ok: false, failure })}\n`);
    process.stderr.write(`${message.replace(/[\r\n\x00-\x1f\x7f]/g, " ")}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    clearInterval(heartbeat);
    clearTimeout(deadline);
  });
