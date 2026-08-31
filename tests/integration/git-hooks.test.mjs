import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function createRepositoryFixture(t, { initializeGit = true } = {}) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "openclaw-enterprise-git-hooks-"));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  await mkdir(join(fixtureRoot, "scripts"));
  await mkdir(join(fixtureRoot, ".githooks"));
  await copyFile(
    join(repositoryRoot, "scripts/install-git-hooks.mjs"),
    join(fixtureRoot, "scripts/install-git-hooks.mjs"),
  );
  await copyFile(
    join(repositoryRoot, ".githooks/pre-push"),
    join(fixtureRoot, ".githooks/pre-push"),
  );

  if (initializeGit) {
    const initialize = spawnSync("git", ["init", "--quiet"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    assert.equal(initialize.status, 0, initialize.stderr);
  }

  return fixtureRoot;
}

function installHooks(fixtureRoot) {
  return spawnSync(process.execPath, ["scripts/install-git-hooks.mjs"], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
}

test("automatic installation skips packaged environments without a Git checkout", async (t) => {
  const fixtureRoot = await createRepositoryFixture(t, { initializeGit: false });

  const automaticInstallation = spawnSync(
    process.execPath,
    ["scripts/install-git-hooks.mjs", "--if-git-present"],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
    },
  );
  assert.equal(automaticInstallation.status, 0, automaticInstallation.stderr);
  assert.match(automaticInstallation.stdout, /Skipping Git hook installation/);

  const explicitInstallation = installHooks(fixtureRoot);
  assert.notEqual(explicitInstallation.status, 0);
  assert.match(explicitInstallation.stderr, /outside a Git checkout/);
});

test("hook installation preserves core.hooksPath and is safely repeatable", async (t) => {
  const fixtureRoot = await createRepositoryFixture(t);
  const protectedHooksPath = join(fixtureRoot, "protected-organization-hooks");
  const configureProtectedHooks = spawnSync(
    "git",
    ["config", "core.hooksPath", protectedHooksPath],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
    },
  );
  assert.equal(configureProtectedHooks.status, 0, configureProtectedHooks.stderr);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = installHooks(fixtureRoot);
    assert.equal(result.status, 0, result.stderr);
  }

  const nativeHookPath = join(fixtureRoot, ".git/hooks/pre-push");
  assert.equal(
    await readFile(nativeHookPath, "utf8"),
    await readFile(join(fixtureRoot, ".githooks/pre-push"), "utf8"),
  );
  assert.notEqual((await stat(nativeHookPath)).mode & 0o111, 0);

  const currentHooksPath = spawnSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
  assert.equal(currentHooksPath.status, 0, currentHooksPath.stderr);
  assert.equal(currentHooksPath.stdout.trim(), protectedHooksPath);
});

test("hook installation refuses to replace an existing unmanaged native hook", async (t) => {
  const fixtureRoot = await createRepositoryFixture(t);
  const nativeHookPath = join(fixtureRoot, ".git/hooks/pre-push");
  const unmanagedHook = "#!/bin/sh\n# Existing user-managed pre-push hook\nexit 0\n";
  await writeFile(nativeHookPath, unmanagedHook);
  await chmod(nativeHookPath, 0o755);

  const result = installHooks(fixtureRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unmanaged.*pre-push/i);
  assert.equal(await readFile(nativeHookPath, "utf8"), unmanagedHook);
  assert.notEqual((await stat(nativeHookPath)).mode & 0o111, 0);
});

test("the native pre-push hook runs installed Prettier directly and blocks formatting failures", async (t) => {
  const fixtureRoot = await createRepositoryFixture(t);
  const install = installHooks(fixtureRoot);
  assert.equal(install.status, 0, install.stderr);

  const binariesPath = join(fixtureRoot, "bin");
  await mkdir(binariesPath);
  const prettierPath = join(fixtureRoot, "node_modules/prettier/bin/prettier.cjs");
  await mkdir(join(fixtureRoot, "node_modules/prettier/bin"), { recursive: true });
  await writeFile(prettierPath, "");
  const nodePath = join(binariesPath, "node");
  await writeFile(
    nodePath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOOK_INVOCATION_LOG"\nexit "${HOOK_EXIT_CODE:-0}"\n',
  );
  await chmod(nodePath, 0o755);
  const packageManagerPath = join(binariesPath, "pnpm");
  await writeFile(
    packageManagerPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$PACKAGE_MANAGER_INVOCATION_LOG"\nexit 97\n',
  );
  await chmod(packageManagerPath, 0o755);

  const invocationLog = join(fixtureRoot, "node-invocation.log");
  const packageManagerInvocationLog = join(fixtureRoot, "pnpm-invocation.log");
  const nativeHookPath = join(fixtureRoot, ".git/hooks/pre-push");
  const environment = {
    ...process.env,
    PATH: `${binariesPath}${delimiter}${process.env.PATH ?? ""}`,
    HOOK_INVOCATION_LOG: invocationLog,
    PACKAGE_MANAGER_INVOCATION_LOG: packageManagerInvocationLog,
  };
  const expectedInvocation = [
    await realpath(prettierPath),
    "--check",
    "{apps,packages,scripts,tests}/**/*.{ts,mjs,json}",
    "*.{json,yaml,yml,md}",
    "",
  ].join("\n");

  for (const expectedExitCode of [0, 23]) {
    const result = spawnSync(nativeHookPath, ["origin", "https://example.test/repository"], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        ...environment,
        HOOK_EXIT_CODE: String(expectedExitCode),
      },
    });

    assert.equal(result.status, expectedExitCode, result.stderr);
    assert.equal(await readFile(invocationLog, "utf8"), expectedInvocation);
  }

  await rm(prettierPath);
  const missingPrettier = spawnSync(nativeHookPath, [], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: environment,
  });
  assert.equal(missingPrettier.status, 1);
  assert.match(missingPrettier.stderr, /installed Prettier executable is unavailable/);
  assert.equal(await readFile(invocationLog, "utf8"), expectedInvocation);
  await assert.rejects(stat(packageManagerInvocationLog), { code: "ENOENT" });
});
