import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const gate = resolve("scripts/ci/impact-gate.mjs");
const allLanes = [
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

function needsFor(mode) {
  return {
    impact: { result: "success", outputs: { mode } },
    audit: { result: "success", outputs: {} },
    "checks-baseline": { result: "success", outputs: {} },
    "pr-safe": { result: mode === "docs" ? "skipped" : "success", outputs: {} },
    "runtime-image-fixture": { result: mode === "docs" ? "skipped" : "success", outputs: {} },
  };
}

function runGate(t, mode, needs) {
  const dir = mkdtempSync(join(tmpdir(), "ci-impact-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, "needs.json");
  const output = join(dir, "expanded.json");
  writeFileSync(input, typeof needs === "string" ? needs : JSON.stringify(needs));
  const result = spawnSync(
    process.execPath,
    [gate, "--needs", input, "--mode", mode, "--output", output],
    {
      encoding: "utf8",
    },
  );
  let expanded;
  try {
    expanded = JSON.parse(readFileSync(output, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return { ...result, expanded };
}

test("gate expands successful workflow dependencies for each aggregation target", (t) => {
  // Docs aggregation contains only the baseline; full aggregation receives every CI lane.
  for (const mode of ["docs", "full"]) {
    const result = runGate(t, mode, needsFor(mode));
    assert.equal(result.status, 0, result.stderr);
    const keys =
      mode === "docs" ? ["impact", "audit", "checks-baseline"] : ["impact", "audit", ...allLanes];
    assert.deepEqual(Object.keys(result.expanded).sort(), keys.sort());
    for (const state of Object.values(result.expanded)) {
      assert.equal(state.result, "success");
    }
  }
});

test("gate rejects failed, cancelled, missing, and unexpectedly run or skipped jobs", (t) => {
  for (const mode of ["docs", "full"]) {
    for (const job of ["impact", "audit", "checks-baseline", "pr-safe", "runtime-image-fixture"]) {
      for (const bad of [
        "failure",
        "cancelled",
        "missing",
        mode === "docs" && ["pr-safe", "runtime-image-fixture"].includes(job)
          ? "success"
          : "skipped",
      ]) {
        const needs = needsFor(mode);
        if (bad === "missing") {
          delete needs[job];
        } else {
          needs[job].result = bad;
        }
        const result = runGate(t, mode, needs);
        assert.notEqual(result.status, 0, `${mode}: ${job} ${bad}`);
        assert.match(result.stderr, new RegExp(job));
        if (job === "checks-baseline") {
          assert.equal(result.expanded[job].result, bad);
        }
        if (mode === "full" && job === "pr-safe") {
          assert.equal(result.expanded.postgres.result, bad);
        }
      }
    }
  }
});

test("gate fails closed for invalid selection and malformed dependencies", (t) => {
  const mismatch = needsFor("docs");
  mismatch.impact.outputs.mode = "full";
  assert.notEqual(runGate(t, "docs", mismatch).status, 0);
  const unexpected = needsFor("full");
  unexpected.newJob = { result: "failure", outputs: {} };
  assert.notEqual(runGate(t, "full", unexpected).status, 0);
  assert.notEqual(runGate(t, "unknown", needsFor("full")).status, 0);
  assert.notEqual(runGate(t, "docs", "{not json").status, 0);
  assert.notEqual(runGate(t, "docs", "[]").status, 0);
  assert.notEqual(spawnSync(process.execPath, [gate], { encoding: "utf8" }).status, 0);
});

test("docs gate feeds genuine runner evidence into the source-bound aggregate", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ci-impact-aggregate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "tests/integration"), { recursive: true });
  mkdirSync(join(dir, "results"));
  writeFileSync(
    join(dir, "tests/integration/example.test.mjs"),
    'import test from "node:test"; test("selected case", () => {});\n',
  );
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      version: 1,
      lanes: {
        "checks-baseline": {
          files: [{ path: "tests/integration/example.test.mjs", expectedTests: ["selected case"] }],
        },
      },
      groups: { ci: ["checks-baseline"] },
    }),
  );
  const sha = "a".repeat(40);
  const runner = resolve("scripts/ci/run-tests.mjs");
  const invoke = (args, source = sha) =>
    spawnSync(process.execPath, [runner, ...args], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_SHA: source },
    });
  const common = ["--manifest", "manifest.json", "--root", dir];
  const run = invoke([
    "run",
    "checks-baseline",
    ...common,
    "--state",
    join(dir, "state"),
    "--results",
    join(dir, "results/checks-baseline.json"),
  ]);
  assert.equal(run.status, 0, run.stderr);
  const gateResult = runGate(t, "docs", needsFor("docs"));
  assert.equal(gateResult.status, 0, gateResult.stderr);
  writeFileSync(join(dir, "needs.json"), JSON.stringify(gateResult.expanded));
  const aggregate = (source) =>
    invoke(
      [
        "aggregate",
        "checks-baseline",
        ...common,
        "--results-dir",
        "results",
        "--needs",
        "needs.json",
      ],
      source,
    );
  const passed = aggregate(sha);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).status, "passed");
  // A passing artifact from another source must not qualify the current run.
  const mismatched = aggregate("b".repeat(40));
  assert.notEqual(mismatched.status, 0);
  assert.ok(
    JSON.parse(mismatched.stdout).issues.some((issue) => issue.code === "source-sha-mismatch"),
  );
});
