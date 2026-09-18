import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runInFixtureContainer } from "../fixtures/repository-credentials/container.mjs";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.mjs";
import { credentialClientPath } from "../fixtures/repository-credentials/runtime.mjs";

const materialRoot = "/run/oce/repository-credentials";
const shimDirectory = "/opt/oce/repository-credentials/bin";
const childGitTrace = "/tmp/repository-router-child-git";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function installMaterial(t, repositories) {
  // The fixed production paths live only in this disposable, network-none
  // container. These files stand in for Compute's separately tested delivery.
  assert.equal(process.env.REPOSITORY_CREDENTIALS_CONTAINER_CHILD, "1");
  await mkdir(materialRoot, { recursive: true, mode: 0o700 });
  await chmod(materialRoot, 0o700);
  await mkdir(join(materialRoot, "sessions"), { mode: 0o700 });
  await mkdir(shimDirectory, { recursive: true });
  t.after(() => rm(materialRoot, { recursive: true, force: true }));
  for (const command of ["git", "gh"]) {
    await writeFile(
      join(shimDirectory, command),
      `#!/bin/sh\n${command === "git" ? `printf 'git\\n' >> '${childGitTrace}'\n` : ""}exec /usr/local/bin/node '${credentialClientPath("router")}' ${command} "$@"\n`,
      { mode: 0o755 },
    );
  }
  const bindings = [];
  for (const repository of repositories) {
    const { opened, repositoryRef, clientDirectory } = repository;
    const directory = join(
      materialRoot,
      "sessions",
      hash([repositoryRef, opened.session.sessionId]),
    );
    await cp(clientDirectory, directory, { recursive: true });
    bindings.push({
      repositoryRef,
      sessionId: opened.session.sessionId,
      deadlineWallMs: opened.session.deadlineWallMs,
      directory,
      client: opened.client,
    });
  }
  bindings.sort((left, right) =>
    left.repositoryRef < right.repositoryRef
      ? -1
      : left.repositoryRef > right.repositoryRef
        ? 1
        : 0,
  );
  const manifest = {
    version: 1,
    generation: hash(bindings.map(({ repositoryRef, sessionId }) => [repositoryRef, sessionId])),
    bindings,
  };
  await writeFile(join(materialRoot, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  return manifest;
}

test(
  "ordinary Git and gh route independent admitted repositories through their actual targets",
  { timeout: 120000 },
  async (t) => {
    if (await runInFixtureContainer(t, "tests/integration/repository-credentials-router.test.mjs"))
      return;
    const fixture = await startRegistryCredentialServiceFixture(t);
    const manifest = await installMaterial(t, fixture.repositories);
    const work = await temporaryDirectory(t, "repository-router-work-");
    const [a, b] = fixture.repositories;
    const canonical = (repository) => `https://github.com/${repository.repository}.git`;
    const launcher = credentialClientPath("router");
    const invoke = async (command, args, options = {}) => {
      const result = await run(process.execPath, [launcher, command, ...args], {
        cwd: work,
        env: cleanEnvironment({
          HOME: work,
          OPENAI_API_KEY: "model-environment-marker",
          GH_TOKEN: "ambient-token",
          GIT_DIR: "/does-not-exist",
          ...options.env,
        }),
        ...options,
        allowFailure: true,
      });
      if (!options.allowFailure) assert.equal(result.code, 0, result.stderr);
      return result;
    };
    const git = (args, options) => invoke("git", args, options);
    const gh = (args, options) => invoke("gh", args, options);
    const configure = (cwd, key, value) => run("/usr/bin/git", ["config", key, value], { cwd });
    const traces = () =>
      fixture.repositories.map(({ git: upstream, github }) => [
        upstream.trace.length,
        github.trace.length,
        github.issuesOfTokens.length,
      ]);
    const denied = async (command, args, options = {}) => {
      const before = traces();
      const result = await invoke(command, args, { ...options, allowFailure: true });
      assert.notEqual(result.code, 0);
      assert.deepEqual(
        traces(),
        before,
        "selection denial must precede upstream traffic or minting",
      );
      assert.equal(result.stderr.includes("ambient-token"), false);
      return result;
    };

    await t.test(
      "local preparation is credential-free and natural clones ignore the cwd binding",
      async () => {
        const local = join(work, "local");
        await git(["init", local]);
        await git(["-C", local, "config", "user.name", "Router fixture"]);
        await git(["-C", local, "config", "user.email", "router@example.test"]);
        const environment = join(work, "git-environment.json");
        await writeFile(
          join(local, ".git/hooks/pre-commit"),
          `#!/usr/local/bin/node\nrequire('node:fs').writeFileSync(${JSON.stringify(environment)}, JSON.stringify({model:process.env.OPENAI_API_KEY, token:process.env.GH_TOKEN, gh:process.env.GH_CONFIG_DIR, protocols:process.env.GIT_ALLOW_PROTOCOL}));\n`,
          { mode: 0o700 },
        );
        await git(["-C", local, "commit", "--allow-empty", "-m", "Local preparation"]);
        assert.deepEqual(JSON.parse(await readFile(environment, "utf8")), { protocols: "" });
        assert.deepEqual(traces(), [
          [0, 0, 0],
          [0, 0, 0],
        ]);
        await git(["clone", canonical(a)]);
        a.checkout = join(work, "repository");
        await git(["clone", canonical(b)], { cwd: a.checkout });
        b.checkout = join(a.checkout, "other");
        assert.equal(
          (await git(["-C", a.checkout, "remote", "get-url", "origin"])).stdout.trim(),
          a.opened.client.gitRemote,
        );
        assert.equal(
          (await git(["-C", b.checkout, "remote", "get-url", "origin"])).stdout.trim(),
          b.opened.client.gitRemote,
        );
        const renamed = join(work, "renamed");
        await rename(b.checkout, renamed);
        b.checkout = renamed;
        await git(["-C", work, "-Crenamed", "-C", "", "fetch", "origin"]);
        // Linked worktrees and explicit/bare Git directory contexts must use
        // Git's own effective configuration, not a guessed .git/config path.
        const linked = join(work, "linked");
        await git(["-C", a.checkout, "worktree", "add", "--detach", linked, "HEAD"]);
        await git(["-C", linked, "fetch", "origin"]);
        await git([
          "--git-dir",
          join(a.checkout, ".git"),
          "--work-tree",
          a.checkout,
          "fetch",
          "origin",
        ]);
        const bare = join(work, "bare-checkout");
        await git(["clone", "--bare", canonical(a), bare]);
        await git(["--bare", `--git-dir=${bare}`, "fetch", "origin"]);
      },
    );

    await t.test(
      "push and gh pin the exact repository independently under concurrency",
      async () => {
        await configure(a.checkout, "user.name", "Router fixture");
        await configure(a.checkout, "user.email", "router@example.test");
        await writeFile(join(a.checkout, "change.txt"), "Ordinary Agent routing\n");
        await git(["-C", a.checkout, "add", "change.txt"]);
        await git(["-C", a.checkout, "commit", "-m", "Routed change"]);
        const head = (await git(["-C", a.checkout, "rev-parse", "HEAD"])).stdout.trim();
        await git(["-C", a.checkout, "push", "origin", "HEAD:refs/heads/router-feature"]);
        assert.equal(await a.git.ref("refs/heads/router-feature"), head);
        await git(["-C", a.checkout, "push", canonical(a), "HEAD:refs/heads/direct-feature"]);
        assert.equal(await a.git.ref("refs/heads/direct-feature"), head);
        const [fetched, metadata] = await Promise.all([
          git(["-C", a.checkout, "fetch", "origin"]),
          gh(["api", `repos/${b.repository}`], { cwd: a.checkout }),
        ]);
        assert.equal(fetched.code, 0);
        assert.equal(JSON.parse(metadata.stdout).full_name, b.repository);
        await gh(
          [
            "pr",
            "create",
            "-R",
            b.repository,
            "--head",
            "existing-branch",
            "--base",
            "main",
            "--title",
            "Independent repository",
            "--body",
            "Native CLI creation",
          ],
          { cwd: a.checkout },
        );
        const nestedGit = await readFile(childGitTrace, "utf8").catch(() => "");
        assert.ok(
          nestedGit.split("\n").filter(Boolean).length > 0,
          "native gh must reach the pinned Git shim without recursion",
        );
        assert.equal([...b.github.pulls.values()].filter((pull) => pull.native).length, 1);
        assert.equal([...a.github.pulls.values()].length, 0);
        for (const repository of fixture.repositories) {
          assert.ok(
            repository.github.issuesOfTokens.every(
              (issued) =>
                JSON.stringify(issued.repositoryIds) ===
                JSON.stringify([Number(repository.repositoryId)]),
            ),
          );
        }
      },
    );

    await t.test(
      "named and effective targets govern selection without default-remote guessing",
      async () => {
        await git(["-C", a.checkout, "remote", "add", "upstream", canonical(b)]);
        await git(["-C", a.checkout, "fetch", "upstream"]);
        await denied("git", ["-C", a.checkout, "fetch"]);
        await denied("git", ["-C", a.checkout, "fetch", "upstream"], {
          env: cleanEnvironment({ OCE_REPOSITORY_REF: a.repositoryRef }),
        });
        await git(["-C", a.checkout, "remote", "remove", "upstream"]);
        await configure(a.checkout, "remote.origin.url", canonical(b));
        await git(["-C", a.checkout, "fetch", "origin"]);
        await configure(a.checkout, "remote.origin.url", canonical(a));
        await configure(a.checkout, "remote.origin.pushurl", canonical(b));
        await git(["-C", a.checkout, "push", "origin", "HEAD:refs/heads/push-url-feature"]);
        assert.equal(
          await b.git.ref("refs/heads/push-url-feature"),
          await a.git.ref("refs/heads/router-feature"),
        );
        await run("/usr/bin/git", ["config", "--add", "remote.origin.pushurl", canonical(a)], {
          cwd: a.checkout,
        });
        await denied("git", ["-C", a.checkout, "push", "origin", "HEAD:refs/heads/ambiguous"]);
        await run("/usr/bin/git", ["config", "--unset-all", "remote.origin.pushurl"], {
          cwd: a.checkout,
        });
        await configure(a.checkout, "branch.main.remote", canonical(b));
        await denied("git", ["-C", a.checkout, "fetch"]);
        await configure(a.checkout, "branch.main.remote", "origin");
        const empty = join(work, "command-context");
        await git(["init", empty]);
        await git([
          "-C",
          empty,
          `-cremote.named.url=${canonical(b)}`,
          "ls-remote",
          "named",
          "refs/heads/main",
        ]);
      },
    );

    await t.test(
      "rewrites, unapproved targets and inherited pin conflicts fail before the network",
      async () => {
        for (const target of [
          "https://github.com/fixture/unapproved.git",
          `${canonical(a)}-extra`,
          canonical(a).replace("https://", "https://user@"),
          "git@github.com:fixture/repository.git",
          canonical(a).replace("fixture", "%66ixture"),
        ]) {
          await denied("git", ["-C", a.checkout, "fetch", target]);
        }
        for (const suffix of ["insteadOf", "pushInsteadOf"]) {
          const setting = `url.${canonical(b)}.${suffix}`;
          await configure(a.checkout, setting, canonical(a));
          await denied("git", [
            "-C",
            a.checkout,
            suffix === "insteadOf" ? "fetch" : "push",
            canonical(a),
            ...(suffix === "pushInsteadOf" ? ["HEAD:refs/heads/denied"] : []),
          ]);
          await run("/usr/bin/git", ["config", "--unset-all", setting], { cwd: a.checkout });
        }
        const pinned = cleanEnvironment({
          OCE_REPOSITORY_SELECTION: JSON.stringify([
            manifest.generation,
            b.repositoryRef,
            b.opened.session.sessionId,
          ]),
        });
        await git(["-C", a.checkout, "status", "--short"], { env: pinned });
        await denied("git", ["-C", a.checkout, "fetch", "origin"], { env: pinned });
        await denied("git", ["fetch", "--all"]);
        await denied("git", ["remote", "add", "-f", "unknown", canonical(a)]);
        await denied("git", ["credential", "fill"]);
        await denied("git", ["unknown-command"]);
        await denied("gh", ["api", `repos/${a.repository}`], { env: pinned });
        await denied("git", ["-C", a.checkout, "status"], {
          env: cleanEnvironment({
            OCE_REPOSITORY_SELECTION: JSON.stringify([
              "0".repeat(64),
              b.repositoryRef,
              b.opened.session.sessionId,
            ]),
          }),
        });
        assert.equal(
          fixture.repositories.every(({ github }) => github.errors.length === 0),
          true,
        );
      },
    );

    await t.test(
      "an in-flight push retains its old session across generation replacement",
      async () => {
        // Rotation installs a read-only replacement after selection, from the real
        // Git pre-push hook. The running push must retain its original write grant.
        const previous = a.opened;
        const replacement = await fixture.open(a.repositoryRef, { profile: "git-read" });
        const directory = join(
          materialRoot,
          "sessions",
          hash([a.repositoryRef, replacement.opened.session.sessionId]),
        );
        await cp(replacement.clientDirectory, directory, { recursive: true });
        const bindings = manifest.bindings.map((binding) =>
          binding.repositoryRef === a.repositoryRef
            ? {
                repositoryRef: a.repositoryRef,
                sessionId: replacement.opened.session.sessionId,
                deadlineWallMs: replacement.opened.session.deadlineWallMs,
                directory,
                client: replacement.opened.client,
              }
            : binding,
        );
        const replacementManifest = {
          version: 1,
          generation: hash(
            bindings.map(({ repositoryRef, sessionId }) => [repositoryRef, sessionId]),
          ),
          bindings,
        };
        const nextManifest = join(work, "next-manifest.json");
        await writeFile(nextManifest, JSON.stringify(replacementManifest), { mode: 0o600 });
        const hook = join(a.checkout, ".git/hooks/pre-push");
        await writeFile(
          hook,
          `#!/usr/local/bin/node\nrequire('node:fs').copyFileSync(${JSON.stringify(nextManifest)}, ${JSON.stringify(join(materialRoot, "manifest.json"))});\nrequire('node:child_process').execFileSync('/usr/bin/git', ['config', 'remote.origin.url', ${JSON.stringify(canonical(b))}]);\n`,
          { mode: 0o700 },
        );
        await git(["-C", a.checkout, "push", "origin", "HEAD:refs/heads/generation-feature"]);
        await rm(hook);
        assert.equal(
          await a.git.ref("refs/heads/generation-feature"),
          await a.git.ref("refs/heads/router-feature"),
        );
        await configure(a.checkout, "remote.origin.url", canonical(a));
        await denied("git", ["-C", a.checkout, "push", "origin", "HEAD:refs/heads/read-denied"]);
        await denied("gh", ["api", `repos/${a.repository}`]);
        await denied("git", ["-C", a.checkout, "fetch", "origin"], {
          env: cleanEnvironment({
            OCE_REPOSITORY_SELECTION: JSON.stringify([
              manifest.generation,
              a.repositoryRef,
              previous.session.sessionId,
            ]),
          }),
        });
        const metadata = await gh(["api", `repos/${b.repository}`]);
        assert.equal(JSON.parse(metadata.stdout).full_name, b.repository);
        const bearer = join(directory, "bearer");
        await rename(bearer, `${bearer}.missing`);
        await denied("git", ["-C", a.checkout, "fetch", "origin"]);
        await rename(`${bearer}.missing`, bearer);
        const publicConfig = JSON.parse(await readFile(join(directory, "client.json"), "utf8"));
        publicConfig.deadlineWallMs = 1;
        bindings.find((binding) => binding.repositoryRef === a.repositoryRef).deadlineWallMs = 1;
        await writeFile(join(directory, "client.json"), JSON.stringify(publicConfig), {
          mode: 0o600,
        });
        await writeFile(join(materialRoot, "manifest.json"), JSON.stringify(replacementManifest), {
          mode: 0o600,
        });
        const expired = await denied("git", ["-C", a.checkout, "fetch", "origin"]);
        assert.match(expired.stderr, /repository-session-expired/);
      },
    );
  },
);
