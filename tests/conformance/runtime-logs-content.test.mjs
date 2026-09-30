import assert from "node:assert/strict";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  maskRuntimeEventText,
  redactRuntimeLogText,
  sanitizeRuntimeLogChunk,
} from "../../packages/occ/src/index.ts";
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
  // The download is the same sanitized page in a second serializer.
  const download = await fixture.request("GET", target.logsPath("source=gateway&download=true"));
  assert.equal(download.status, 200, download.text);
  assert.equal(download.headers.get("cache-control"), "no-store");
  for (const [name, value] of Object.entries({ ...values, SPLIT: splitFragment })) {
    if (name === "CONTROL") {
      continue;
    }
    assert.equal(download.text.includes(value), false, `canary ${name} leaked into the download`);
  }
  assert.match(download.text, /\[redacted:/);
  assert.match(download.text, / WITHHELD 2 unrecognised_structured$/m);
  assert.match(download.text, / GAP truncated: /);
  assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f]/.test(download.text), false);
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

// The redactor runs synchronously on workload-controlled lines of up to 32 KiB, before
// the 8 KiB output cut. A pattern that backtracks quadratically on such a line would stall
// the API replica's event loop for every caller, so each hostile shape has a budget.
test("redaction stays linear on hostile 32 KiB lines", () => {
  const budgetMs = 100;
  const line = (unit, suffix = "") =>
    unit.repeat(Math.ceil((32 * 1024) / unit.length)).slice(0, 32 * 1024 - suffix.length) + suffix;
  redactRuntimeLogText(line("warm-up "));
  maskRuntimeEventText(line("warm-up "));
  const units = [
    "a-",
    "a.",
    "-",
    "--a-",
    "=/",
    "(/",
    '"a-',
    "a0a",
    "tokena-",
    "bearer ",
    "-eyJa",
    "-eyJ_",
    "_eyJa",
    "-eyJa-",
    "-eyJaaaa",
  ];
  for (const unit of units) {
    for (const suffix of ["", "?", "token", "=x"]) {
      const input = line(unit, suffix);
      const started = performance.now();
      redactRuntimeLogText(input);
      maskRuntimeEventText(input);
      const elapsed = performance.now() - started;
      assert.ok(
        elapsed < budgetMs,
        `${JSON.stringify(unit)} + ${JSON.stringify(suffix)} took ${elapsed.toFixed(0)} ms`,
      );
    }
  }
  // A whole page of such messages stays well inside one request's budget.
  const started = performance.now();
  sanitizeRuntimeLogChunk({
    stream: { source: "gateway", pod: "gateway-0", container: "gateway" },
    truncated: false,
    lines: Array.from({ length: 50 }, (_, index) => ({
      time: lineTime(index),
      raw: JSON.stringify({ level: "info", message: "a-".repeat(15 * 1024) }),
    })),
  });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 50 * budgetMs, `50 hostile lines took ${elapsed.toFixed(0)} ms`);
});

test("redaction stays linear on a generated sweep of short repeated units", () => {
  // Guards shapes nobody enumerated: every unit of 2 characters over an alphabet of
  // pattern delimiters and prefix letters, every 3-character unit over a smaller one, and
  // each delimiter ahead of the JWT, token and bearer prefixes.
  const budgetMs = 100;
  const alphabet = [
    "a",
    "-",
    ".",
    "=",
    "/",
    "?",
    '"',
    ":",
    "_",
    "+",
    "@",
    "e",
    "y",
    "J",
    "t",
    "o",
    "k",
    "n",
    " ",
  ];
  const units = [];
  for (const x of alphabet) {
    for (const y of alphabet) {
      units.push(x + y);
    }
  }
  const short = ["a", "-", ".", "=", "/", '"', "_", "e", "J", " "];
  for (const x of short) {
    for (const y of short) {
      for (const z of short) {
        units.push(x + y + z);
      }
    }
  }
  for (const x of alphabet) {
    units.push(`${x}eyJ`, `${x}eyJa`, `${x}eyJa.`, `${x}token`, `${x}bearer`);
  }
  const length = 32 * 1024;
  redactRuntimeLogText("warm-up ".repeat(length / 8));
  let worst = { unit: "", elapsed: 0 };
  const started = performance.now();
  for (const unit of units) {
    const input = unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
    const unitStarted = performance.now();
    redactRuntimeLogText(input);
    maskRuntimeEventText(input);
    const elapsed = performance.now() - unitStarted;
    if (elapsed > worst.elapsed) {
      worst = { unit, elapsed };
    }
  }
  const total = performance.now() - started;
  assert.ok(
    worst.elapsed < budgetMs,
    `${JSON.stringify(worst.unit)} took ${worst.elapsed.toFixed(0)} ms (sweep total ${total.toFixed(0)} ms)`,
  );
});

test("the jwt rule masks tokens in every delimiter context but not inside a longer word", () => {
  const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = `${base64url({ alg: "HS256" })}.${base64url({ sub: randomUUID() })}.${randomString(43)}`;
  for (const [before, after] of [
    ["", ""],
    ["token ", " next"],
    ["auth=", "&x=1"],
    ['{"t":"', '"}'],
    ["(", ")"],
    ["/", "/"],
    [":", ","],
  ]) {
    const output = redactRuntimeLogText(`${before}${jwt}${after}`);
    assert.ok(!output.includes(jwt), `${JSON.stringify(before)} context leaked the token`);
    assert.match(output, /\[redacted:/);
  }
  // `-` and `.` are word boundaries inside a run; a word character ahead of `eyJ` is not.
  assert.equal(redactRuntimeLogText(`x-token-${jwt} next`), "x-token-[redacted:jwt] next");
  assert.equal(redactRuntimeLogText(`a.${jwt}.b`), "a.[redacted:jwt].b");
  assert.equal(redactRuntimeLogText(`${jwt}.${jwt}`), "[redacted:jwt].[redacted:jwt]");
  assert.equal(redactRuntimeLogText("xeyJabcd.efgh.ij"), "xeyJabcd.efgh.ij");
});

test("the linear jwt scan matches the reference regex on random runs", () => {
  const reference = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
  const pieces = ["eyJ", "a", "b", "-", ".", "_", "0", " ", "/", "e", "J"];
  for (let round = 0; round < 3000; round += 1) {
    const input = Array.from(
      { length: randomInt(1, 13) },
      () => pieces[randomInt(pieces.length)],
    ).join("");
    const expected = input.replace(reference, "[redacted:jwt]");
    // Only the jwt rule can fire here: no key names or URLs, and at most 12 pieces of up
    // to 3 characters each (randomInt excludes its upper bound), so 36 characters at most.
    assert.equal(redactRuntimeLogText(input), expected, JSON.stringify(input));
  }
});

test("bounded key and path patterns still mask the shapes they did before", () => {
  // The digit keeps the value inside the digit-gated `bearer` rule on every run.
  const value = `v7${randomString(20)}`;
  for (const [input, expected] of [
    [`github_token=${value} next`, "github_token=[redacted:key-value] next"],
    [`--db-password ${value}`, "--db-password [redacted:key-value]"],
    [`--api-key=${value}`, "--api-key=[redacted:key-value]"],
    [`spring.datasource.password: ${value}`, "spring.datasource.password: [redacted:key-value]"],
    // A key prefix longer than the affix bound still masks: the match starts at the keyword.
    [`${"x".repeat(100)}_password=${value}`, `${"x".repeat(100)}_password=[redacted:key-value]`],
    [`{"client_secret":"${value}"}`, '{"client_secret":"[redacted:key-value]"}'],
    [
      `GET /hooks?token=${value}&a=1 HTTP/1.1`,
      "GET /hooks?token=[redacted:query]&a=[redacted:query] HTTP/1.1",
    ],
    [`url=/cb?code=${value}`, "url=/cb?code=[redacted:query]"],
    [`call(/cb?code=${value}`, "call(/cb?code=[redacted:query]"],
    [`"/cb?${value}"`, '"/cb?[redacted:query]"'],
    ["see /a#b?c", "see /a#b?c"],
    [`bearer token ${value} for upstream`, "bearer token [redacted:bearer] for upstream"],
    ["bearer authentication failed", "bearer authentication failed"],
  ]) {
    assert.equal(redactRuntimeLogText(input), expected, input);
  }
});

test("Event messages hide node names, image references and Secret names", async () => {
  const node = `ip-10-0-${randomInt(255)}-${randomInt(255)}.ec2.internal`;
  const image = `registry.example.com/team-${randomString(8).toLowerCase()}/gateway:1.2.3`;
  const secret = `db-creds-${randomString(8).toLowerCase()}`;
  const messages = [
    `Successfully assigned tenant/gateway-0 to ${node}`,
    `Pulling image "${image}"`,
    `Failed to pull image "${image}": rpc error: code = NotFound desc = failed to resolve reference "${image}": not found`,
    `Error: pull access denied for ${image}, repository does not exist`,
    `MountVolume.SetUp failed for volume "creds" : secret "${secret}" not found`,
    `Error: couldn't find key password in Secret tenant/${secret}`,
    `configmap "${secret}" not found`,
    `Preempted by a higher priority Pod on node ${node}`,
    `nodes "${node}" not found`,
  ];
  for (const message of messages) {
    const masked = maskRuntimeEventText(message);
    for (const name of [node, image, secret]) {
      assert.equal(masked.includes(name), false, `${name} survived in ${masked}`);
    }
  }
  assert.equal(
    maskRuntimeEventText("Back-off restarting failed container gateway in pod gateway-0"),
    "Back-off restarting failed container gateway in pod gateway-0",
  );

  // The Tier 1 route applies the masking to every Event message.
  const computeDriver = createRuntimeLogComputeDriver();
  const fixture = await createRuntimeLogFixture({ computeDriver });
  const target = await fixture.deployAgent();
  computeDriver.state.events = messages.map((message) => ({
    type: "Warning",
    reason: "Failed",
    message,
    count: 1,
    lastObservedAt: "2026-09-30T11:59:00Z",
  }));
  const runtime = await fixture.request("GET", target.runtimePath);
  assert.equal(runtime.status, 200, runtime.text);
  assert.equal(runtime.data.pods[0].events.length, messages.length);
  for (const name of [node, image, secret]) {
    assert.equal(runtime.text.includes(name), false, `${name} reached the runtime route`);
  }
  assert.match(runtime.data.pods[0].events[0].message, /to \[redacted:node\]$/);
});
