import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createNativeClientMaterial } from "../fixtures/repository-credentials/clients.mjs";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";
import { parseGhInvocation } from "../../apps/controller/src/drivers/repo/github/credentials/client/commands.ts";
import { createClientEnvironment } from "../../apps/controller/src/drivers/repo/github/credentials/client/environment.ts";
import {
  inheritedRepositoryBinding,
  readRuntimeRepositoryManifest,
} from "../../apps/controller/src/drivers/repo/github/credentials/client/manifest.ts";
import { selectGhRepository } from "../../apps/controller/src/drivers/repo/github/credentials/client/targets.ts";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const opened = (
  sessionId,
  repository = "example/project",
  deadlineWallMs = Date.now() + 86400000,
) => ({
  session: { sessionId, deadlineWallMs },
  bearer: `controlled_gateway_${sessionId}_${"0".repeat(32)}`,
  client: {
    gatewayOrigin: "https://credentials.example.test",
    gitRemote: `https://credentials.example.test/${repository}.git`,
    gitUsername: "gateway-session",
    canonicalApiHost: "github.com",
    apiHost: "credentials.example.test",
    repository,
  },
});
const protocol = (path = "example/project.git") =>
  `protocol=https\nhost=credentials.example.test\npath=${path}\n\n`;
const environment = (material, extra = {}) => {
  const env = cleanEnvironment({
    HOME: material.root,
    GIT_CONFIG_SYSTEM: join(material.root, "gitconfig"),
    ...extra,
  });
  delete env.GIT_CONFIG_NOSYSTEM;
  return env;
};
const fill = (material, extra = {}, path) =>
  run("/usr/bin/git", ["credential", "fill"], {
    env: environment(material, extra),
    input: protocol(path),
    allowFailure: true,
  });
const pin = (material, binding) =>
  JSON.stringify([material.manifest.generation, binding.repositoryRef, binding.sessionId]);

test("duplicate bindings select only explicit authority and never an alternate unexpired grant", async (t) => {
  const read = opened("read");
  const write = opened("write");
  const material = await createNativeClientMaterial(t, [
    { opened: read, repositoryRef: "read" },
    { opened: write, repositoryRef: "write" },
  ]);
  const denied = await fill(material);
  assert.notEqual(denied.code, 0);
  assert.equal(denied.stdout, "");
  for (const [entry, bearer] of material.manifest.bindings.map((binding, index) => [
    binding,
    [read, write][index].bearer,
  ])) {
    for (const selection of [
      { OCE_REPOSITORY_REF: entry.repositoryRef },
      { OCE_REPOSITORY_SELECTION: pin(material, entry) },
    ]) {
      const result = await fill(material, selection);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.includes(`password=${bearer}\n`), true);
    }
  }
  // A username is an endpoint constraint, not permission to select among duplicate grants.
  const differentUsername = await createNativeClientMaterial(t, [
    { opened: read, repositoryRef: "read" },
    {
      opened: { ...write, client: { ...write.client, gitUsername: "alternate-session" } },
      repositoryRef: "write",
    },
  ]);
  const usernameSelection = await run("/usr/bin/git", ["credential", "fill"], {
    env: environment(differentUsername),
    input: protocol().replace("\n\n", "\nusername=alternate-session\n\n"),
    allowFailure: true,
  });
  assert.notEqual(usernameSelection.code, 0);
  assert.equal(usernameSelection.stdout, "");
  const readBinding = material.manifest.bindings[0];
  for (const extra of [
    { OCE_REPOSITORY_REF: "missing" },
    { OCE_REPOSITORY_REF: "write", OCE_REPOSITORY_SELECTION: pin(material, readBinding) },
    { OCE_REPOSITORY_SELECTION: JSON.stringify(["0".repeat(64), "read", "read"]) },
    { OCE_REPOSITORY_SELECTION: "invalid-json" },
  ]) {
    const result = await fill(material, extra);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
  }
  // Metadata validation covers the whole generation without reading unrelated bearer bytes.
  await writeFile(
    join(material.manifest.bindings[1].directory, "bearer"),
    "invalid unrelated bearer",
    { mode: 0o600 },
  );
  assert.equal((await fill(material, { OCE_REPOSITORY_REF: "read" })).code, 0);
  const metadataPath = join(readBinding.directory, "client.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.deadlineWallMs = 1;
  readBinding.deadlineWallMs = 1;
  await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
  await writeFile(join(material.root, "manifest.json"), JSON.stringify(material.manifest), {
    mode: 0o600,
  });
  const expired = await fill(material, { OCE_REPOSITORY_REF: "read" });
  assert.notEqual(expired.code, 0);
  assert.equal(expired.stdout, "");
});

test("literal dot-git names and effective repository endpoints cannot silently switch bindings", async (t) => {
  const a = opened("a");
  const b = opened("b", "example/project.git");
  const c = opened("c", "example/other");
  const material = await createNativeClientMaterial(t, [
    { opened: a, repositoryRef: "a" },
    { opened: b, repositoryRef: "b" },
    { opened: c, repositoryRef: "c" },
  ]);
  assert.notEqual((await fill(material)).code, 0);
  assert.equal((await fill(material, { OCE_REPOSITORY_REF: "a" })).stdout.includes(a.bearer), true);
  assert.equal((await fill(material, { OCE_REPOSITORY_REF: "b" })).stdout.includes(b.bearer), true);
  assert.equal(
    (await fill(material, {}, "EXAMPLE/PROJECT.git.git")).stdout.includes(b.bearer),
    true,
  );
  const conflicting = await fill(material, { OCE_REPOSITORY_REF: "a" }, "example/other.git");
  assert.notEqual(conflicting.code, 0);
  assert.equal(conflicting.stdout, "");
  assert.equal((await fill(material, {}, "example/other")).stdout.includes(c.bearer), true);
});

test("embedded generation fails closed after replacement while local stock Git retains hooks and configuration", async (t) => {
  const original = opened("original");
  const material = await createNativeClientMaterial(t, [
    { opened: original, repositoryRef: "project" },
  ]);
  const work = await temporaryDirectory(t);
  const env = environment(material, {
    OCE_REPOSITORY_SELECTION: JSON.stringify(["0".repeat(64), "project", "stale"]),
    NATIVE_HOOK_MARKER: "normal-environment",
  });
  const git = (args, options = {}) => run("/usr/bin/git", args, { env, cwd: work, ...options });
  await git(["init"]);
  await git(["config", "user.name", "Native fixture"]);
  await git(["config", "user.email", "fixture@example.test"]);
  const marker = join(work, "hook-result");
  await writeFile(
    join(work, ".git/hooks/pre-commit"),
    `#!/bin/sh\nprintf '%s' "$NATIVE_HOOK_MARKER" > '${marker}'\n`,
    { mode: 0o700 },
  );
  await writeFile(join(work, "file.txt"), "native content\n");
  await git(["add", "file.txt"]);
  await git(["commit", "-m", "Native hook"]);
  assert.equal(await readFile(marker, "utf8"), "normal-environment");
  await git(["mv", "file.txt", "moved.txt"]);
  await git(["commit", "-m", "Native move"]);
  await git(["rm", "moved.txt"]);
  await git(["commit", "-m", "Native removal"]);
  await git(["config", "alias.native-status", "status --short"]);
  assert.equal((await git(["native-status"])).stdout.trim(), "?? hook-result");
  const linked = join(work, "linked");
  await git(["worktree", "add", "--detach", linked]);
  assert.equal(
    (await git(["-C", linked, "log", "-1", "--format=%s"])).stdout.trim(),
    "Native removal",
  );
  await git(["remote", "add", "origin", "https://github.com/ExAmPlE/PrOjEcT"]);
  await git(["remote", "set-url", "--push", "origin", "https://github.com/example/other.git"]);
  assert.equal(
    (await git(["remote", "get-url", "origin"])).stdout.trim(),
    "https://credentials.example.test/ExAmPlE/PrOjEcT",
  );
  assert.equal(
    (await git(["remote", "get-url", "--push", "origin"])).stdout.trim(),
    "https://credentials.example.test/example/other.git",
  );
  assert.notEqual(
    (await fill(material, { OCE_REPOSITORY_SELECTION: env.OCE_REPOSITORY_SELECTION })).code,
    0,
  );
  // New material is valid in isolation but cannot be selected by the old emitted helper command.
  const replacement = opened("replacement");
  const next = await createNativeClientMaterial(t, [
    { opened: replacement, repositoryRef: "project" },
  ]);
  const oldConfig = await readFile(join(material.root, "gitconfig"), "utf8");
  const newManifest = {
    ...next.manifest,
    bindings: next.manifest.bindings.map((binding) => ({
      ...binding,
      directory: binding.directory.replace(next.root, material.root),
    })),
  };
  // Install a fully valid next generation; only the old helper generation pin must reject it.
  await cp(join(next.root, "sessions"), join(material.root, "sessions"), { recursive: true });
  newManifest.generation = hash(
    newManifest.bindings.map(({ repositoryRef, sessionId }) => [repositoryRef, sessionId]),
  );
  await writeFile(join(material.root, "manifest.json"), JSON.stringify(newManifest), {
    mode: 0o600,
  });
  assert.equal(await readFile(join(material.root, "gitconfig"), "utf8"), oldConfig);
  const current = await readRuntimeRepositoryManifest(material.root);
  assert.equal(current.generation, next.manifest.generation);
  const acceptedNew = await run(
    process.execPath,
    [material.helper, "manifest", material.root, current.generation, "get"],
    { env: cleanEnvironment(), input: protocol() },
  );
  assert.equal(acceptedNew.stdout.includes(replacement.bearer), true);
  const rejected = await fill(material);
  assert.notEqual(rejected.code, 0);
  assert.equal(rejected.stdout, "");
  assert.equal((await git(["log", "-1", "--format=%s"])).stdout.trim(), "Native removal");
});

test("gh selection retains private configuration and exact pins without suppressing native system Git", async (t) => {
  const first = opened("first");
  const second = opened("second", "example/other");
  const material = await createNativeClientMaterial(t, [
    { opened: first, repositoryRef: "first" },
    { opened: second, repositoryRef: "second" },
  ]);
  const manifest = await readRuntimeRepositoryManifest(material.root);
  const gh = parseGhInvocation(["api", "repos/ExAmPlE/OTHER"]);
  const selected = selectGhRepository(manifest, gh.target.value);
  assert.equal(selected.sessionId, "second");
  assert.throws(
    () => selectGhRepository(manifest, gh.target.value, manifest.bindings[0]),
    /conflicting-repository-selection/,
  );
  assert.throws(
    () => parseGhInvocation(["api", "https://api.github.com/repos/example/project"]),
    /unsupported-client-command/,
  );
  assert.throws(
    () => parseGhInvocation(["pr", "create", "--title", "missing head"]),
    /explicit-head-required/,
  );
  assert.throws(
    () =>
      inheritedRepositoryBinding(manifest, {
        OCE_REPOSITORY_REF: "first",
        OCE_REPOSITORY_SELECTION: pin(material, material.manifest.bindings[1]),
      }),
    /conflicting-repository-selection/,
  );
  const env = createClientEnvironment(selected.configuration, selected.directory, material.root);
  assert.equal(env.HOME, material.root);
  assert.equal(env.GH_CONFIG_DIR, join(selected.directory, "gh"));
  assert.equal(env.GIT_CONFIG_NOSYSTEM, undefined);
  assert.equal(env.GIT_CONFIG_SYSTEM, undefined);
  assert.equal(env.GIT_CONFIG_GLOBAL, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  const hosts = await readFile(join(env.GH_CONFIG_DIR, "hosts.yml"), "utf8");
  assert.equal(hosts.includes(second.bearer), true);
  const router = resolve("apps/controller/src/drivers/repo/github/credentials/client/router.ts");
  const rejected = await run(process.execPath, [router, "git", "status"], {
    env: cleanEnvironment(),
    allowFailure: true,
  });
  assert.notEqual(rejected.code, 0);
  assert.equal(rejected.stderr, "unsupported-client-command\n");
});
