#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const lane = "repository-credentials-platform";
const sha256 = /^sha256:[a-f0-9]{64}$/;
const receipt = {
  kind: "repository-platform-headroom",
  sourceSha: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "")
    ? process.env.GITHUB_SHA
    : undefined,
  status: "failed",
  stage: "hosted-guard",
  pruneAttempted: false,
};

// Bound both the CLI and plugin descendants, and never forward command output.
function execute(command, args, timeout = 30_000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let bytes = 0;
    let failed = false;
    let settled = false;
    let joinTimer;
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    };
    const finish = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(joinTimer);
      kill();
      if (failed || code !== 0) {
        reject(new Error("Headroom command failed."));
      } else {
        resolveResult(stdout);
      }
    };
    const stop = () => {
      failed = true;
      kill();
      joinTimer ??= setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null);
      }, 1_000);
    };
    const collect = (chunk, output) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        stop();
      } else if (output && !failed) {
        stdout += chunk;
      }
    };
    const timer = setTimeout(stop, timeout);
    child.stdout.on("data", (chunk) => collect(chunk, true));
    child.stderr.on("data", (chunk) => collect(chunk, false));
    child.once("error", stop);
    child.once("close", finish);
  });
}

async function privateJson(path) {
  const info = await lstat(path);
  assert(info.isFile() && info.uid === process.getuid() && (info.mode & 0o777) === 0o600);
  assert(info.size > 0 && info.size <= 1024 * 1024);
  return JSON.parse(await readFile(path, "utf8"));
}

const docker = (...args) => execute("docker", ["--context", "default", ...args]);
const counters = (value) => {
  const result = {};
  for (const field of ["availableBytes", "capacityBytes", "inodesFree", "inodes"]) {
    assert(Number.isSafeInteger(value?.[field]) && value[field] >= 0);
    result[field] = value[field];
  }
  assert(result.capacityBytes > 0 && result.availableBytes <= result.capacityBytes);
  assert(result.inodesFree <= result.inodes);
  return result;
};

async function main() {
  assert(
    process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted",
  );
  assert(process.platform === "linux" && receipt.sourceSha);
  assert(process.env.OPENCLAW_CI_HEADROOM_LANE === lane);
  assert(
    /^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") &&
      /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ""),
  );
  assert(process.env.RUNNER_TEMP && process.argv.length === 4 && process.argv[2] === "--state");
  assert(
    !process.env.DOCKER_HOST &&
      (!process.env.DOCKER_CONTEXT || process.env.DOCKER_CONTEXT === "default"),
  );
  const statePath = join(resolve(process.env.RUNNER_TEMP), "state", `${lane}.json`);
  assert(resolve(process.argv[3]) === statePath);
  receipt.stage = "state-guard";
  const state = await privateJson(statePath);
  assert(state.version === 1 && state.repositoryRoot === repositoryRoot && state.lane === lane);
  assert(state.statePath === statePath && typeof state.prefix === "string");
  assert(
    process.env.OPENCLAW_ENTERPRISE_CI_STATE === statePath &&
      process.env.OPENCLAW_ENTERPRISE_CI_PREFIX === state.prefix,
  );
  assert(
    state.prefix.startsWith(
      `openclaw-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-`,
    ),
  );
  assert(Array.isArray(state.resources));
  const owned = (kind) => state.resources.filter((resource) => resource.kind === kind);
  const clusters = owned("k3d-cluster");
  const images = owned("image-tag");
  const imports = owned("k3d-image");
  assert(clusters.length === 1 && images.length === 2 && imports.length === 1);
  for (const resource of [...clusters, ...images, ...imports]) {
    assert(resource.owner === state.prefix && resource.status === "ready");
  }
  const cluster = clusters[0];
  const imported = imports[0];
  assert(/^openclaw-k8s-[a-z0-9-]+$/.test(cluster.name));
  assert(dirname(cluster.directory) === resolve(process.env.RUNNER_TEMP));
  assert(basename(cluster.directory).startsWith(`${cluster.name}-`));
  assert(
    cluster.kubeconfig === join(cluster.directory, "kubeconfig") &&
      cluster.context === `k3d-${cluster.name}`,
  );
  const fixtureTag = `localhost/${cluster.name}/repository-platform:local`;
  assert(images.some(({ name }) => name === fixtureTag));
  assert(
    images.some(({ name }) =>
      /^localhost\/openclaw-ci-image-[a-z0-9-]+\/runtime:local$/.test(name),
    ),
  );
  assert(
    imported.cluster === cluster.name &&
      imported.sourceImage === fixtureTag &&
      imported.name === fixtureTag,
  );
  assert(sha256.test(imported.hostImageId));
  const digest = imported.reference?.slice(imported.reference.lastIndexOf("@") + 1);
  assert(sha256.test(digest) && imported.reference === `${fixtureTag.slice(0, -6)}@${digest}`);
  assert(state.env?.OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM_IMAGE === imported.reference);
  const kubeInfo = await lstat(cluster.kubeconfig);
  assert(
    kubeInfo.isFile() && kubeInfo.uid === process.getuid() && (kubeInfo.mode & 0o777) === 0o600,
  );
  const kubectl = (args, timeout = 10_000) =>
    execute(
      "kubectl",
      ["--kubeconfig", cluster.kubeconfig, "--context", cluster.context, ...args],
      timeout,
    );
  const config = JSON.parse(await kubectl(["config", "view", "--minify", "-o", "json"]));
  const endpoint = new URL(config.clusters?.[0]?.cluster?.server);
  assert(
    endpoint.protocol === "https:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) &&
      Number(endpoint.port) > 0,
  );
  assert(!config.users?.some(({ user }) => user?.exec || user?.["auth-provider"]));
  receipt.stage = "docker-guard";
  const contexts = JSON.parse(await docker("context", "inspect", "default"));
  assert(
    contexts.length === 1 &&
      contexts[0].Name === "default" &&
      contexts[0].Endpoints?.docker?.Host === "unix:///var/run/docker.sock",
  );
  const builders = await docker(
    "buildx",
    "ls",
    "--format",
    '{{if eq .Builder.Name "default"}}{{.Builder.Driver}} {{range .Builder.Nodes}}{{.Endpoint}} {{end}}{{end}}',
  );
  const defaultBuilders = builders
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert(defaultBuilders.length > 0 && defaultBuilders.every((line) => line === "docker default"));

  async function imageIdentities() {
    const checked = await Promise.allSettled([
      ...images.map(async (image) => {
        const id = (await docker("image", "inspect", "--format", "{{.Id}}", image.name)).trim();
        assert(sha256.test(id));
        if (image.name === fixtureTag) {
          assert(id === imported.hostImageId);
        }
        return id;
      }),
      (async () => {
        const listed = await docker(
          "exec",
          `k3d-${cluster.name}-server-0`,
          "ctr",
          "-n",
          "k8s.io",
          "images",
          "list",
        );
        const line = listed
          .split(/\r?\n/)
          .find((entry) => entry.split(/\s+/)[0] === imported.reference);
        assert(line?.trim().split(/\s+/)[2] === digest);
        await docker(
          "exec",
          `k3d-${cluster.name}-server-0`,
          "crictl",
          "inspecti",
          imported.reference,
        );
      })(),
    ]);
    assert(checked.every(({ status }) => status === "fulfilled"));
    return checked.slice(0, images.length).map(({ value }) => value);
  }
  let nodeUid;
  async function observe(deadline = Date.now() + 25_000) {
    const raw = async (path) => {
      const remaining = deadline - Date.now();
      assert(remaining > 0);
      return JSON.parse(
        await kubectl(["get", `--raw=${path}`, "--request-timeout=3s"], Math.min(4_000, remaining)),
      );
    };
    const list = await raw("/api/v1/nodes?limit=2");
    assert(
      Array.isArray(list.items) &&
        list.items.length === 1 &&
        (list.metadata?.continue === undefined || list.metadata.continue === ""),
    );
    const node = list.items[0];
    assert(
      node.metadata?.name === `k3d-${cluster.name}-server-0` &&
        typeof node.metadata.uid === "string",
    );
    nodeUid ??= node.metadata.uid;
    assert(node.metadata.uid === nodeUid);
    const condition = (type) =>
      node.status?.conditions?.find((entry) => entry.type === type)?.status;
    const summary = await raw(
      `/api/v1/nodes/${encodeURIComponent(node.metadata.name)}/proxy/stats/summary`,
    );
    return {
      ready: condition("Ready") === "True",
      diskPressureClear: condition("DiskPressure") === "False",
      diskTaintPresent:
        node.spec?.taints?.some(({ key }) => key === "node.kubernetes.io/disk-pressure") ?? false,
      nodeFs: counters(summary.node?.fs),
      imageFs: counters(summary.node?.runtime?.imageFs),
    };
  }
  async function cacheInventory() {
    const output = await docker(
      "buildx",
      "du",
      "--builder",
      "default",
      "--filter",
      "inuse=false",
      "--filter",
      "shared=false",
      "--format=json",
    );
    let eligibleRecordBytes = 0;
    let eligibleRecords = 0;
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const entry = JSON.parse(line);
      assert(
        entry.Reclaimable === true &&
          entry.Shared === false &&
          typeof entry.Size === "string" &&
          /^\d+$/.test(entry.Size),
      );
      const size = Number(entry.Size);
      assert(Number.isSafeInteger(size) && Number.isSafeInteger(eligibleRecordBytes + size));
      eligibleRecordBytes += size;
      eligibleRecords += 1;
    }
    return { eligibleRecords, eligibleRecordBytes };
  }
  receipt.stage = "before";
  const beforeImages = await imageIdentities();
  receipt.imageIdsBefore = beforeImages;
  try {
    receipt.before = await observe();
    assert(receipt.before.ready);
    receipt.cacheBefore = await cacheInventory();
    receipt.stage = "cache-prune";
    receipt.pruneAttempted = true;
    await execute(
      "docker",
      [
        "--context",
        "default",
        "buildx",
        "prune",
        "--builder",
        "default",
        "--filter",
        "inuse=false",
        "--filter",
        "shared=false",
        "--force",
      ],
      120_000,
    );
    receipt.stage = "recovery";
    receipt.cacheAfter = await cacheInventory();
    const deadline = Date.now() + 360_000;
    do {
      receipt.after = await observe(deadline);
      assert(receipt.after.ready);
      if (receipt.after.diskPressureClear && !receipt.after.diskTaintPresent) {
        break;
      }
      await delay(Math.min(5_000, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    assert(receipt.after.diskPressureClear && !receipt.after.diskTaintPresent);
  } finally {
    if (receipt.pruneAttempted && !receipt.after) {
      try {
        receipt.after = await observe();
      } catch {
        /* Preserve the failed stage. */
      }
    }
    try {
      receipt.imageIdsAfter = await imageIdentities();
      receipt.imagesPreserved = beforeImages.every(
        (id, index) => id === receipt.imageIdsAfter[index],
      );
      assert(receipt.imagesPreserved);
    } catch {
      receipt.imagesPreserved = false;
    }
  }
  assert(receipt.imagesPreserved);
  receipt.stage = "complete";
  receipt.status = "passed";
}

try {
  await main();
} catch {
  process.exitCode = 1;
} finally {
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
