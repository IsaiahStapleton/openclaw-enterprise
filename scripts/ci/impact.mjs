#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants, closeSync, fstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { TextDecoder } from "node:util";

const decoder = new TextDecoder("utf-8", { fatal: true });
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

class InspectionError extends Error {}

function git(...args) {
  const result = spawnSync("git", args, { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new InspectionError("Git inspection failed");
  }
  return result.stdout;
}

function documentationPath(path) {
  if (
    /^(?:docs|specs)\/(?:[\s\S]*\/)?AGENTS\.md$/.test(path) ||
    ["docs/reference/api.md", "docs/reference/cheatsheets/api.md"].includes(path) ||
    /^docs\/reference\/api\/[\s\S]+\.md$/.test(path)
  ) {
    return false;
  }
  return (
    ["README.md", "CONTRIBUTING.md", "SECURITY.md"].includes(path) ||
    /^(?:docs|specs)\/[\s\S]+\.md$/.test(path)
  );
}

function classify() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    return { mode: "full", reason: "event is not a pull request" };
  }
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const base = event.pull_request.base.sha;
    const head = event.pull_request.head.sha;
    const tested = process.env.GITHUB_SHA;
    if (![base, head, tested].every((value) => typeof value === "string" && oid.test(value))) {
      throw new InspectionError("missing or invalid event commit identifiers");
    }
    const actual = git("rev-parse", "--verify", "HEAD^{commit}").toString("ascii").trim();
    if (actual !== tested) {
      throw new InspectionError("checkout does not match tested commit");
    }
    const parents = git("show", "-s", "--format=%P", tested).toString("ascii").trim().split(" ");
    if (parents.length !== 2 || parents[0] !== base || parents[1] !== head) {
      throw new InspectionError("event commits do not match the tested merge parents");
    }
    git("cat-file", "-e", `${base}^{commit}`);
    git("cat-file", "-e", `${head}^{commit}`);
    const diff = git(
      "diff",
      "--raw",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      base,
      tested,
      "--",
    );
    if (diff.length === 0 || diff[diff.length - 1] !== 0) {
      throw new InspectionError("diff is empty or incomplete");
    }
    const fields = diff.subarray(0, -1).toString("binary").split("\0");
    if (fields.length % 2 !== 0) {
      throw new InspectionError("diff has an unexpected shape");
    }
    for (let i = 0; i < fields.length; i += 2) {
      const header = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([AMD])$/.exec(fields[i]);
      const path = decoder.decode(Buffer.from(fields[i + 1], "binary"));
      if (!header || !documentationPath(path)) {
        throw new InspectionError(
          "diff contains a path or change outside the documentation allowlist",
        );
      }
      const [, oldMode, newMode, status] = header;
      if (
        (status === "A" && (oldMode !== "000000" || newMode !== "100644")) ||
        (status === "D" && (oldMode !== "100644" || newMode !== "000000")) ||
        (status === "M" && (oldMode !== "100644" || newMode !== "100644"))
      ) {
        throw new InspectionError("diff contains a non-regular or executable file");
      }
    }
    return { mode: "docs", reason: `verified ${fields.length / 2} documentation changes` };
  } catch (error) {
    return {
      mode: "full",
      reason: error instanceof InspectionError ? error.message : "inspection failed",
    };
  }
}

function main() {
  const [option, value, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !value ||
    !["--github-output", "--verify-mode"].includes(option) ||
    (option === "--verify-mode" && !["docs", "full"].includes(value))
  ) {
    throw new Error("usage: impact.mjs --github-output PATH | --verify-mode docs|full");
  }
  const result = classify();
  console.log(`CI impact: ${result.mode} (${result.reason})`);
  if (option === "--verify-mode") {
    if (result.mode !== value) {
      throw new Error("requested mode does not match current evidence");
    }
    return;
  }
  const fd = openSync(value, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error("output is not a regular file");
    }
    const output = Buffer.from(`mode=${result.mode}\n`);
    if (writeSync(fd, output) !== output.length) {
      throw new Error("output write was incomplete");
    }
  } finally {
    closeSync(fd);
  }
}

try {
  main();
} catch {
  console.error("CI impact: unable to select or verify mode");
  process.exitCode = 1;
}
