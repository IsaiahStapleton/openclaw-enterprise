import assert from "node:assert/strict";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sanitizeRuntimeLogChunk } from "../../packages/occ/src/index.ts";
import {
  createRuntimeLogComputeDriver,
  createRuntimeLogFixture,
} from "../helpers/runtime-logs.mjs";

const corpusUrl = new URL("../fixtures/runtime-logs/canary-corpus.txt", import.meta.url);
const alphanumeric = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// Canaries are generated per run so no credential-shaped value is committed.
function randomString(length, alphabet = alphanumeric) {
  return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");
}

function canaries() {
  const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    QUERY_TOKEN: `q${randomString(23)}`,
    SIGNATURE: randomString(32),
    FRAGMENT: `frag${randomString(20)}`,
    PROMPT: `prompt-canary-${randomUUID()}`,
    CONTENT: `content-canary-${randomUUID()}`,
    PROTO: `proto-canary-${randomUUID()}`,
    OPENAI_KEY: `sk-proj-${randomString(40)}`,
    API_KEY: `key${randomString(21)}`,
    INSTALLATION_TOKEN: `ghs_${randomString(36)}`,
    BEARER: randomString(32),
    COOKIE: randomString(24),
    PASSWORD: `pw${randomString(14)}`,
    CLI_PASSWORD: `cli${randomString(13)}`,
    AWS_KEY: `AKIA${randomString(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`,
    HEX40: randomBytes(20).toString("hex"),
    JWT: `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({ sub: randomUUID() })}.${randomString(43)}`,
    PEM_BODY: randomBytes(48).toString("base64"),
    GITHUB_PAT: `github_pat_${randomString(40)}`,
    RPC: `rpc-canary-${randomUUID()}`,
    CODEX_PROMPT: `codex-prompt-${randomUUID()}`,
    WRAPPER_EXTRA: `wrapper-extra-${randomUUID()}`,
    MALFORMED: `malformed-canary-${randomUUID()}`,
  };
}

function lineTime(index) {
  return `2026-09-30T12:00:${String(index % 60).padStart(2, "0")}.${String(index).padStart(9, "0")}Z`;
}

async function corpusLines(values) {
  const template = await readFile(corpusUrl, "utf8");
  const lines = template
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\{\{([A-Z_0-9]+)\}\}/g, (_match, name) => values[name]));
  // Hostile shapes that a text fixture cannot carry literally.
  const deep = { level: "info", message: "deep" };
  let cursor = deep;
  for (let depth = 0; depth < 12; depth += 1) {
    cursor.nested = {};
    cursor = cursor.nested;
  }
  cursor.secret = values.DEEP;
  lines.push(JSON.stringify(deep));
  lines.push(`\u001b[31mcolored\u001b[0m output\u0007 with ${values.CONTROL} and \u0000nul`);
  return lines.map((raw, index) => ({ time: lineTime(index), raw }));
}

test("runtime log route bodies never contain planted credentials, prompts or protocol output", async () => {
  const values = {
    ...canaries(),
    DEEP: `deep-canary-${randomUUID()}`,
    CONTROL: "visible-control-text",
  };
  // Hex split at the 1 MiB boundary: the fragment is below every redaction threshold,
  // so only dropping the partial final line keeps it out of the page.
  const splitFragment = randomBytes(10).toString("hex");
  const eventBearer = randomString(30);
  const computeDriver = createRuntimeLogComputeDriver();
  const fixture = await createRuntimeLogFixture({ computeDriver });
  const target = await fixture.deployAgent();
  computeDriver.state.lines = [
    ...(await corpusLines(values)),
    { time: lineTime(90), raw: `export GIT_TOKEN_PART=${splitFragment}` },
  ];
  computeDriver.state.truncated = true;
  computeDriver.state.restartCount = 1;
  computeDriver.state.terminationReason = `Error: token ${values.GITHUB_PAT}`;
  computeDriver.state.events = [
    {
      type: "Warning",
      reason: "Failed",
      message: `Failed to pull image: Authorization: Bearer ${eventBearer}`,
      count: 3,
      lastObservedAt: "2026-09-30T11:59:00Z",
    },
  ];

  const runtime = await fixture.request("GET", target.runtimePath);
  assert.equal(runtime.status, 200, runtime.text);
  assert.equal(runtime.headers.get("cache-control"), "no-store");
  assert.equal(runtime.text.includes(eventBearer), false, "Event messages are redacted");
  assert.equal(runtime.text.includes(values.GITHUB_PAT), false, "termination reasons are redacted");
  assert.match(runtime.data.pods[0].events[0].message, /\[redacted:header\]/);

  const logs = await fixture.request("GET", target.logsPath("source=gateway&tailLines=1000"));
  assert.equal(logs.status, 200, logs.text);
  assert.equal(logs.headers.get("cache-control"), "no-store");
  for (const [name, value] of Object.entries({ ...values, SPLIT: splitFragment })) {
    if (name === "CONTROL") {
      continue;
    }
    assert.equal(logs.text.includes(value), false, `canary ${name} leaked into the response`);
  }
  // `content` is reserved and has no producer.
  assert.ok(logs.data.records.length > 0);
  assert.ok(
    logs.data.records.every(
      (record) => record.type !== "line" || record.contentClass === "operational",
    ),
  );
  assert.equal(logs.text.includes('"contentClass":"content"'), false);

  // Operational context survives; payloads are withheld and counted.
  const lines = logs.data.records.filter((record) => record.type === "line");
  const wrapper = lines.find((record) => record.kind === "wrapper");
  assert.deepEqual(wrapper.fields, {
    container: "gateway",
    phase: "config",
    outcome: "ok",
    ms: 12,
    sinceStartMs: 40,
  });
  const codex = lines.find((record) => record.kind === "codex");
  assert.equal(codex.message, "retrying model request");
  assert.equal(codex.subsystem, "codex_core::client");
  const openclaw = lines.find((record) => record.message === "turn started");
  assert.deepEqual(openclaw.fields, { agent_id: "main" });
  assert.ok(lines.some((record) => record.message.includes("[redacted:userinfo]@github.com")));
  assert.ok(lines.some((record) => record.message.includes("visible-control-text")));
  assert.equal(logs.text.includes("\\u001b"), false, "ANSI escapes are stripped");
  const withheld = logs.data.records.filter((record) => record.type === "withheld");
  assert.deepEqual(
    withheld.map(({ reason, count }) => ({ reason, count })),
    [
      { reason: "unrecognised_structured", count: 2 },
      { reason: "malformed", count: 2 },
    ],
  );
  assert.equal(logs.data.withheld, 4);
  // The byte cut is labelled, never silent.
  assert.equal(logs.data.truncated, true);
  assert.equal(logs.data.records.at(-1).type, "gap");
  assert.equal(logs.data.records.at(-1).reason, "truncated");
});

test("the sanitizer drops a partial final line and bounds oversized input", () => {
  const stream = { source: "gateway", pod: "gateway-0", container: "gateway" };
  const fragment = randomBytes(10).toString("hex");
  const partial = sanitizeRuntimeLogChunk({
    stream,
    truncated: true,
    lines: [
      { time: lineTime(1), raw: "complete line" },
      { time: lineTime(2), raw: `partial ${fragment}` },
    ],
  });
  assert.deepEqual(
    partial.records.map((record) => record.message),
    ["complete line"],
  );
  const oversized = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: [
      { time: lineTime(1), raw: `plain ${"x".repeat(5 * 1024)}` },
      { time: lineTime(2), raw: `{"level":"info","message":"${"y".repeat(33 * 1024)}"}` },
    ],
  });
  assert.deepEqual(
    oversized.records.map(({ type, reason, count }) => ({ type, reason, count })),
    [{ type: "withheld", reason: "oversized", count: 2 }],
  );
  const long = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: [{ time: lineTime(1), raw: `{"level":"info","message":"${"z ".repeat(6000)}"}` }],
  });
  assert.equal(long.records[0].truncated, true);
  assert.ok(Buffer.byteLength(long.records[0].message) <= 8 * 1024);
  assert.match(long.records[0].message, /…\[truncated\]$/);
});
