import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const selector = fileURLToPath(new URL("../../scripts/ci/impact.mjs", import.meta.url));
const gate = fileURLToPath(new URL("../../scripts/ci/impact-gate.mjs", import.meta.url));
const runner = fileURLToPath(new URL("../../scripts/ci/run-tests.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function command(cwd, program, args, options = {}) {
  const result = spawnSync(program, args, { cwd, encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${program} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture(t, change, initial = {}, initialModes = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-impact-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args) => command(repo, "git", args);
  const put = (path, content = "text\n") => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  git("init", "-q");
  git("config", "user.name", "CI test");
  git("config", "user.email", "ci@example.test");
  put("base.txt");
  for (const [path, content] of Object.entries(initial)) {
    put(path, content);
  }
  for (const [path, mode] of Object.entries(initialModes)) {
    chmodSync(join(repo, path), mode);
  }
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "feature");
  change({ repo, put, git });
  git("add", "-A");
  git("commit", "-qm", "change", "--allow-empty");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", base);
  git("merge", "--no-ff", "-qm", "merge", head);
  const tested = git("rev-parse", "HEAD");
  const eventPath = join(dir, "event.json");
  const event = { pull_request: { base: { sha: base }, head: { sha: head } } };
  writeFileSync(eventPath, JSON.stringify(event));
  const env = {
    ...process.env,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_SHA: tested,
  };
  const run = (args, overrides = {}) =>
    spawnSync(process.execPath, [selector, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...env, ...overrides },
    });
  const expect = (mode, overrides = {}) => {
    const output = join(dir, "output");
    writeFileSync(output, "prior=value\n");
    const selected = run(["--github-output", output], overrides);
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(readFileSync(output, "utf8"), `prior=value\nmode=${mode}\n`, selected.stdout);
    assert.equal(run(["--verify-mode", mode], overrides).status, 0);
    assert.notEqual(run(["--verify-mode", mode === "docs" ? "full" : "docs"], overrides).status, 0);
  };
  return { dir, repo, git, event, eventPath, base, head, tested, run, expect };
}

test("verified merge selects documentation and handles unusual names and deletions", (t) => {
  const f = fixture(
    t,
    ({ put, repo }) => {
      put("docs/space and\nnewline.md");
      put("specs/new.md");
      put("README.md", "changed\n");
      put("CONTRIBUTING.md");
      put("SECURITY.md");
      rmSync(join(repo, "docs/deleted.md"));
    },
    { "README.md": "old\n", "docs/deleted.md": "old\n" },
  );
  f.expect("docs");
});

test("mixed code, Helm, workflow and tooling changes select full", (t) => {
  for (const path of [
    "src/app.ts",
    "charts/app/templates/deployment.yaml",
    ".github/workflows/ci.yml",
    "scripts/check.mjs",
    "docs/data.json",
    "AGENTS.md",
  ]) {
    const f = fixture(t, ({ put }) => {
      put("docs/change.md");
      put(path);
    });
    f.expect("full");
  }
});

test("instruction files under docs and specs select full when added or modified", (t) => {
  for (const root of ["docs", "specs"]) {
    for (const path of [`${root}/AGENTS.md`, `${root}/nested/AGENTS.md`]) {
      for (const initial of [{}, { [path]: "old instructions\n" }]) {
        const f = fixture(
          t,
          ({ put }) => {
            put(`${root}/guide.md`);
            put(path, "new instructions\n");
          },
          initial,
        );
        f.expect("full");
      }
    }
  }
});

test("renames across the allowlist boundary in either direction select full", (t) => {
  for (const [from, to] of [
    ["docs/old.md", "src/old.md"],
    ["src/old.md", "docs/old.md"],
  ]) {
    const f = fixture(
      t,
      ({ git, repo }) => {
        mkdirSync(dirname(join(repo, to)), { recursive: true });
        git("mv", from, to);
      },
      { [from]: "same\n" },
    );
    f.expect("full");
  }
});

test("all changes are inspected beyond API file-list limits", (t) => {
  const docs = fixture(t, ({ put }) => {
    for (let i = 0; i < 305; i += 1) {
      put(`docs/${i}.md`);
    }
  });
  docs.expect("docs");
  const f = fixture(t, ({ put }) => {
    for (let i = 0; i < 305; i += 1) {
      put(`docs/${i}.md`);
    }
    put("z-code.ts");
  });
  f.expect("full");
});

test("symlinks and executable documentation select full", (t) => {
  const symlink = fixture(t, ({ repo }) => {
    mkdirSync(join(repo, "docs"));
    symlinkSync("../base.txt", join(repo, "docs/link.md"));
  });
  symlink.expect("full");
  const executable = fixture(t, ({ put, repo }) => {
    put("docs/run.md");
    chmodSync(join(repo, "docs/run.md"), 0o755);
  });
  executable.expect("full");
});

test("submodule changes remain visible even when Git configuration ignores them", (t) => {
  const f = fixture(t, ({ put, git, repo }) => {
    put("docs/change.md");
    const vendor = join(repo, "vendor");
    mkdirSync(vendor);
    command(vendor, "git", ["init", "-q"]);
    command(vendor, "git", ["config", "user.name", "CI test"]);
    command(vendor, "git", ["config", "user.email", "ci@example.test"]);
    writeFileSync(join(vendor, "file"), "content");
    command(vendor, "git", ["add", "file"]);
    command(vendor, "git", ["commit", "-qm", "nested"]);
    git("config", "diff.ignoreSubmodules", "all");
  });
  f.expect("full");
});

test("missing, mismatched or incomplete merge evidence selects full", (t) => {
  const f = fixture(t, ({ put }) => {
    put("docs/valid.md");
  });
  f.expect("full", { GITHUB_SHA: f.head });
  f.expect("full", { GITHUB_EVENT_PATH: join(f.dir, "missing") });
  f.expect("full", { GITHUB_EVENT_NAME: "push" });
  f.expect("full", { GITHUB_EVENT_NAME: "merge_group" });
  f.expect("full", { GITHUB_EVENT_NAME: "workflow_dispatch" });
  const emptyObjects = join(f.dir, "empty-objects");
  mkdirSync(emptyObjects);
  f.expect("full", { GIT_OBJECT_DIRECTORY: emptyObjects, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" });
  for (const event of [
    {},
    { pull_request: { base: { sha: f.head }, head: { sha: f.base } } },
    { pull_request: { base: { sha: "0".repeat(40) }, head: { sha: f.head } } },
    { pull_request: { base: { sha: f.base }, head: {} } },
  ]) {
    writeFileSync(f.eventPath, JSON.stringify(event));
    f.expect("full");
  }
  writeFileSync(f.eventPath, "{");
  f.expect("full");
  const empty = fixture(t, () => {});
  empty.expect("full");
  writeFileSync(f.eventPath, JSON.stringify(f.event));
  f.git("checkout", "-q", "--detach", f.head);
  f.expect("full");
  f.git("checkout", "-q", "--detach", f.tested);
  rmSync(join(f.repo, ".git", "objects", f.head.slice(0, 2), f.head.slice(2)));
  f.expect("full");
});

test("output must be an existing regular file and mode must verify", (t) => {
  const f = fixture(t, ({ put }) => {
    put("docs/valid.md");
  });
  assert.notEqual(f.run(["--github-output", join(f.dir, "missing")]).status, 0);
  assert.notEqual(f.run(["--github-output", f.dir]).status, 0);
  symlinkSync(join(f.dir, "event.json"), join(f.dir, "link"));
  assert.notEqual(f.run(["--github-output", join(f.dir, "link")]).status, 0);
  assert.notEqual(f.run(["--verify-mode", "invalid"]).status, 0);
});

function workflowBootstrap(step) {
  const workflow = readFileSync(
    fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)),
    "utf8",
  );
  const start = workflow.indexOf(step);
  assert.notEqual(start, -1, "workflow step exists");
  const block = workflow.slice(start).split("        run: |\n")[1];
  assert.ok(block, "workflow step has an inline bootstrap");
  const lines = [];
  for (const line of block.split("\n")) {
    if (line && !line.startsWith("          ")) {
      break;
    }
    lines.push(line.slice(10));
  }
  return lines.join("\n");
}

function shallowBootstrap(t, f) {
  // Model the merge checkout Actions obtains with fetch-depth 2, including both parents.
  f.git("branch", "checkout-target", f.tested);
  const checkout = join(f.dir, "shallow");
  command(f.dir, "git", [
    "clone",
    "-q",
    "--depth",
    "2",
    "--branch",
    "checkout-target",
    `file://${f.repo}`,
    checkout,
  ]);
  assert.equal(command(checkout, "git", ["rev-parse", "--is-shallow-repository"]), "true");
  const output = join(f.dir, "github-output");
  const run = (action, expected = "", overrides = {}) => {
    writeFileSync(output, "");
    const script = workflowBootstrap(
      action === "select" ? "      - id: select\n" : "      - name: Verify selected mode\n",
    );
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      cwd: checkout,
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: f.dir,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: f.eventPath,
        GITHUB_SHA: f.tested,
        GITHUB_OUTPUT: output,
        IMPACT_ACTION: action,
        EXPECTED_MODE: expected,
        ...overrides,
      },
    });
    return { ...result, output: readFileSync(output, "utf8") };
  };
  const expect = (mode, overrides = {}) => {
    const selected = run("select", "", overrides);
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(selected.output, `mode=${mode}\n`, selected.stdout);
    assert.equal(run("verify", mode, overrides).status, 0);
    assert.notEqual(run("verify", mode === "docs" ? "full" : "docs", overrides).status, 0);
  };
  return { checkout, run, expect };
}

test("the checked-in policy can select a documentation-only pull request", (t) => {
  // Use the actual Git mode so a policy the bootstrap rejects cannot pass by
  // being recreated with a different mode in the fixture.
  const entry = command(repositoryRoot, "git", [
    "ls-files",
    "--stage",
    "--",
    "scripts/ci/impact.mjs",
  ]);
  const match = /^(100[0-7]{3}) [0-9a-f]{40,64} 0\tscripts\/ci\/impact\.mjs$/.exec(entry);
  assert.ok(match, "selector has one tracked regular-file entry");
  const f = fixture(
    t,
    ({ put }) => put("docs/change.md"),
    { "scripts/ci/impact.mjs": readFileSync(selector, "utf8") },
    { "scripts/ci/impact.mjs": Number.parseInt(match[1], 8) & 0o777 },
  );
  shallowBootstrap(t, f).expect("docs");
});

test("workflow executes only the base policy on a shallow merge checkout", (t) => {
  const policy = readFileSync(selector, "utf8");
  const initial = { "scripts/ci/impact.mjs": policy };
  const docs = fixture(t, ({ put }) => put("docs/change.md"), initial);
  shallowBootstrap(t, docs).expect("docs");

  // The PR selector would select docs and leave a marker if the bootstrap ran it.
  const marker = join(docs.dir, "untrusted-marker");
  const malicious = fixture(
    t,
    ({ put }) => {
      put(
        "scripts/ci/impact.mjs",
        `import { writeFileSync, appendFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nappendFileSync(process.argv[3], 'mode=docs\\n');\n`,
      );
      put("docs/change.md");
    },
    initial,
  );
  const mixed = shallowBootstrap(t, malicious);
  mixed.expect("full");
  assert.equal(existsSync(marker), false);

  const code = fixture(t, ({ put }) => put("src/app.ts"), initial);
  shallowBootstrap(t, code).expect("full");
});

test("workflow falls back to full without trustworthy event, parents or base policy", (t) => {
  const noPolicy = fixture(t, ({ put }) => put("docs/change.md"));
  shallowBootstrap(t, noPolicy).expect("full");
  const f = fixture(t, ({ put }) => put("docs/change.md"), {
    "scripts/ci/impact.mjs": readFileSync(selector, "utf8"),
  });
  const shallow = shallowBootstrap(t, f);
  shallow.expect("full", { GITHUB_EVENT_NAME: "push" });
  shallow.expect("full", { GITHUB_EVENT_PATH: join(f.dir, "missing") });
  const emptyObjects = join(f.dir, "empty-shallow-objects");
  mkdirSync(emptyObjects);
  shallow.expect("full", {
    GIT_OBJECT_DIRECTORY: emptyObjects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
  });
  shallow.expect("full", { GITHUB_SHA: f.head });
  writeFileSync(
    f.eventPath,
    JSON.stringify({ pull_request: { base: { sha: f.head }, head: { sha: f.base } } }),
  );
  shallow.expect("full");
  writeFileSync(f.eventPath, "{");
  shallow.expect("full");
  writeFileSync(
    f.eventPath,
    JSON.stringify({
      pull_request: { base: { sha: `${f.base};touch /tmp/no` }, head: { sha: f.head } },
    }),
  );
  shallow.expect("full");
});

test("unusable base policy cannot select documentation", (t) => {
  const malformed = fixture(t, ({ put }) => put("docs/change.md"), {
    "scripts/ci/impact.mjs": "this is not javascript {",
  });
  const shallow = shallowBootstrap(t, malformed);
  assert.notEqual(shallow.run("select").status, 0);
  assert.notEqual(shallow.run("verify", "docs").status, 0);

  // A symlink at the policy path is not a trusted regular-file policy.
  const f = fixture(t, ({ put }) => put("docs/change.md"));
  f.git("checkout", "-q", "--detach", f.base);
  mkdirSync(join(f.repo, "scripts/ci"), { recursive: true });
  symlinkSync("../../base.txt", join(f.repo, "scripts/ci/impact.mjs"));
  f.git("add", "scripts/ci/impact.mjs");
  f.git("commit", "-qm", "symlink policy");
  const base = f.git("rev-parse", "HEAD");
  f.git("merge", "--no-ff", "-qm", "merge", f.head);
  f.base = base;
  f.tested = f.git("rev-parse", "HEAD");
  writeFileSync(
    f.eventPath,
    JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: f.head } } }),
  );
  shallowBootstrap(t, f).expect("full");
});

test("documentation workflow selects documentation checks and omits product tests", () => {
  const workflow = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const job = (name) => {
    const match = new RegExp(
      `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|(?![\\s\\S]))`,
      "m",
    ).exec(workflow);
    assert.ok(match, `workflow contains ${name}`);
    return match[1];
  };
  const docs = job("docs-checks");
  assert.match(docs, /needs\.impact\.outputs\.mode == 'docs'/);
  for (const command of ["format:check", "docs:check", "docs:build"]) {
    assert.match(docs, new RegExp(`\\bpnpm ${command}\\b`));
  }
  // Keep the documentation route free of product-test and lane invocations.
  assert.doesNotMatch(
    docs,
    /run-ci-lane|run-tests\.mjs\s+(?:run|aggregate)|\b(?:pnpm|npm)\s+(?:run\s+)?test(?::|\b)|\bnode\s+--test\b|\bgo\s+test\b/,
  );
  for (const name of ["checks-baseline", "pr-safe", "runtime-image-fixture"]) {
    assert.match(job(name), /needs\.impact\.outputs\.mode == 'full'/, name);
  }
  const required = job("ci-required");
  const aggregate = required.split("      - name: Aggregate CI results\n")[1];
  assert.ok(aggregate, "required job contains aggregation");
  assert.match(aggregate, /if:.*needs\.impact\.outputs\.mode == 'full'/);
});

test("workflow selection flows through the gate and full-mode source-bound aggregate", (t) => {
  const lanes = [
    "checks-baseline",
    "postgres",
    "postgres-application",
    "images-packaging",
    "runtime-image-fixture",
    "k3d-fixture-configuration",
    "k3d-fixture-state",
    "k3d-fixture-plugins",
    "k3d-observability",
    "logging-collector",
    "repository-credentials-container",
    "repository-credentials-platform",
  ];
  for (const expected of ["docs", "full"]) {
    const f = fixture(
      t,
      ({ put }) => {
        put("docs/change.md");
        if (expected === "full") {
          put("src/change.ts");
        }
      },
      { "scripts/ci/impact.mjs": readFileSync(selector, "utf8") },
    );
    const bootstrap = shallowBootstrap(t, f);
    const selected = bootstrap.run("select");
    assert.equal(selected.status, 0, selected.stderr);
    assert.match(selected.output, /^mode=(docs|full)\n$/);
    const mode = selected.output.trim().split("=")[1];
    assert.equal(mode, expected);
    assert.equal(bootstrap.run("verify", mode).status, 0);

    const root = bootstrap.checkout;
    const needs = {
      impact: { result: "success", outputs: { mode } },
      audit: { result: "success", outputs: {} },
      "docs-checks": { result: mode === "docs" ? "success" : "skipped", outputs: {} },
      "checks-baseline": { result: mode === "docs" ? "skipped" : "success", outputs: {} },
      "pr-safe": { result: mode === "docs" ? "skipped" : "success", outputs: {} },
      "runtime-image-fixture": { result: mode === "docs" ? "skipped" : "success", outputs: {} },
    };
    const raw = join(root, "raw-needs.json");
    const expanded = join(root, "needs.json");
    const runGate = () => {
      writeFileSync(raw, JSON.stringify(needs));
      return spawnSync(
        process.execPath,
        [gate, "--needs", raw, "--mode", mode, "--output", expanded],
        { encoding: "utf8" },
      );
    };
    const gateResult = runGate();
    assert.equal(gateResult.status, 0, gateResult.stderr);
    if (mode === "docs") {
      // An omitted product lane must not be represented by a successful receipt.
      const output = JSON.parse(readFileSync(expanded, "utf8"));
      for (const lane of lanes) {
        assert.notEqual(output[lane]?.result, "success", lane);
      }
      needs["docs-checks"].result = "failure";
      assert.notEqual(runGate().status, 0);
      needs["docs-checks"].result = "success";
      needs["checks-baseline"].result = "success";
      assert.notEqual(runGate().status, 0);
      continue;
    }

    // Full mode produces genuine runner artifacts for every selected lane.
    mkdirSync(join(root, "tests/integration"), { recursive: true });
    mkdirSync(join(root, "results"));
    const manifest = { version: 1, lanes: {}, groups: { ci: lanes } };
    for (const lane of lanes) {
      const path = `tests/integration/${lane}.test.mjs`;
      writeFileSync(
        join(root, path),
        `import test from "node:test"; test("case ${lane}", () => {});\n`,
      );
      manifest.lanes[lane] = { files: [{ path, expectedTests: [`case ${lane}`] }] };
    }
    writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
    const invoke = (args, sha = f.tested) =>
      spawnSync(process.execPath, [runner, ...args], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_SHA: sha },
      });
    const common = ["--manifest", "manifest.json", "--root", root];
    const runLane = (lane) =>
      invoke([
        "run",
        lane,
        ...common,
        "--state",
        join(root, `${lane}.state`),
        "--results",
        join(root, `results/${lane}.json`),
      ]);
    for (const lane of lanes) {
      const result = runLane(lane);
      assert.equal(result.status, 0, `${lane}: ${result.stderr} ${result.stdout}`);
    }
    const aggregate = (sha = f.tested) =>
      invoke(
        ["aggregate", "ci", ...common, "--results-dir", "results", "--needs", "needs.json"],
        sha,
      );
    const passed = aggregate();
    assert.equal(passed.status, 0, `${passed.stderr} ${passed.stdout}`);
    assert.equal(JSON.parse(passed.stdout).status, "passed");
    command(root, "git", ["checkout", "-q", "--detach", f.head]);
    const wrongRevision = aggregate(f.head);
    assert.notEqual(wrongRevision.status, 0);
    assert.ok(
      JSON.parse(wrongRevision.stdout).issues.some(
        (issue) => issue.code === "source-sha-mismatch" && issue.lane === "checks-baseline",
      ),
    );
    command(root, "git", ["checkout", "-q", "--detach", f.tested]);

    {
      const lane = "postgres";
      const artifact = join(root, `results/${lane}.json`);
      const original = readFileSync(artifact);
      rmSync(artifact);
      const missing = aggregate();
      assert.notEqual(missing.status, 0);
      assert.ok(
        JSON.parse(missing.stdout).issues.some(
          (issue) => issue.code === "missing-lane-output" && issue.lane === lane,
        ),
      );
      writeFileSync(
        join(root, `tests/integration/${lane}.test.mjs`),
        `import test from "node:test"; test("case ${lane}", () => { throw new Error("failure"); });\n`,
      );
      const failedRun = runLane(lane);
      assert.notEqual(failedRun.status, 0);
      const failed = aggregate();
      assert.notEqual(failed.status, 0);
      assert.ok(
        JSON.parse(failed.stdout).issues.some(
          (issue) => issue.code === "lane-failed" && issue.lane === lane,
        ),
      );
      writeFileSync(artifact, original);
      needs["pr-safe"].result = "failure";
      assert.notEqual(runGate().status, 0);
      const failedJob = aggregate();
      assert.notEqual(failedJob.status, 0);
      assert.ok(
        JSON.parse(failedJob.stdout).issues.some((issue) => issue.code === "need-not-success"),
      );
    }
  }
});
