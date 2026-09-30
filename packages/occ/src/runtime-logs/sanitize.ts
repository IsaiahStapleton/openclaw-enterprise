import type {
  AgentRuntimeLogChunk,
  SandboxLogLine,
  RuntimeLogGapReason,
  RuntimeLogKind,
  RuntimeLogLevel,
  RuntimeLogRecord,
  RuntimeLogStream,
  RuntimeLogWithheldReason,
} from "@openclaw-enterprise/contracts";
import {
  maskPemBlockLines,
  redactArgvCredentials,
  redactRuntimeLogText,
  stripRuntimeLogControls,
} from "./redact.ts";

declare const sanitizedRuntimeLogRecord: unique symbol;

/**
 * A record that passed classification and redaction. Only this module creates the
 * brand; route serializers accept nothing else, so a new source cannot bypass it.
 */
export type SanitizedRuntimeLogRecord = RuntimeLogRecord & {
  readonly [sanitizedRuntimeLogRecord]: true;
};

export const RUNTIME_LOG_MAX_INPUT_BYTES = 32 * 1024;
export const RUNTIME_LOG_MAX_OUTPUT_BYTES = 8 * 1024;
export const RUNTIME_LOG_MAX_TEXT_BYTES = 4 * 1024;
const MAX_FIELD_CHARS = 512;
const MAX_JSON_DEPTH = 8;
const TRUNCATION_MARK = "…[truncated]";

const WRAPPER_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "runtime.startup_phase": ["container", "phase", "outcome", "ms", "sinceStartMs"],
  "openclaw.model_probe": ["elapsedMs", "capMs", "cpuWaitMs", "code"],
  "codex.model_probe": ["attempt", "elapsedMs", "exitCode", "signal", "code"],
  "runtime.workspace_node": ["container", "outcome", "code"],
});

// Operational keys only. Anything else, and every free-text or payload key
// (`args`, `payload`, `body`, `prompt`, `messages`, `content`, `text`, `transcript`,
// `headers`, `env`), never leaves OCC.
const STRUCTURED_FIELDS: ReadonlySet<string> = new Set([
  "agent_id",
  "session_id",
  "channel",
  "run_id",
  "traceId",
  "spanId",
  "code",
  "status",
  "durationMs",
  "elapsedMs",
  "url",
  "method",
]);

const LEVELS: Readonly<Record<string, RuntimeLogLevel>> = Object.freeze({
  fatal: "error",
  error: "error",
  warn: "warn",
  warning: "warn",
  info: "info",
  debug: "debug",
  trace: "debug",
});

const GAP_REMEDIES: Readonly<Record<RuntimeLogGapReason, string>> = Object.freeze({
  stream_replaced: "Container restarted; showing the new instance.",
  window_exceeded:
    "Lines between the previous page and this one were not retrieved. Refresh to read the current tail.",
  cursor_expired: "The previous view expired; resumed from the current tail.",
  truncated:
    "The page reached its byte limit; later lines were not retrieved. Request fewer lines to read them.",
  buffer_lost:
    "The source no longer holds the lines after the previous page: its in-memory buffer rolled over or restarted. Showing what it still holds.",
});

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type LineRecord = Extract<RuntimeLogRecord, { type: "line" }>;

function brand(record: RuntimeLogRecord): SanitizedRuntimeLogRecord {
  return Object.freeze(record) as SanitizedRuntimeLogRecord;
}

function cleanStream(stream: RuntimeLogStream): RuntimeLogStream {
  return Object.freeze({
    source: stream.source,
    ...(stream.pod === undefined ? {} : { pod: stream.pod }),
    ...(stream.podUid === undefined ? {} : { podUid: stream.podUid }),
    ...(stream.container === undefined ? {} : { container: stream.container }),
    ...(stream.restartCount === undefined ? {} : { restartCount: stream.restartCount }),
    ...(stream.sandbox === undefined ? {} : { sandbox: stream.sandbox }),
  });
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateBytes(value: string, limit: number): { text: string; truncated: boolean } {
  if (byteLength(value) <= limit) {
    return { text: value, truncated: false };
  }
  const budget = limit - byteLength(TRUNCATION_MARK);
  let text = Buffer.from(value, "utf8").subarray(0, budget).toString("utf8");
  // A cut inside a multibyte character decodes to U+FFFD; drop it.
  text = text.replace(/�$/, "");
  return { text: `${text}${TRUNCATION_MARK}`, truncated: true };
}

/** Redacts, then bounds, one retained string. */
export function sanitizeRuntimeLogText(value: string, limit = RUNTIME_LOG_MAX_OUTPUT_BYTES) {
  return truncateBytes(redactRuntimeLogText(stripRuntimeLogControls(value)), limit);
}

function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") {
    return sanitizeRuntimeLogText(value, MAX_FIELD_CHARS).text;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function pickFields(
  source: Readonly<Record<string, unknown>>,
  allowed: Iterable<string>,
): Readonly<Record<string, string | number | boolean>> | undefined {
  const fields: Record<string, string | number | boolean> = {};
  for (const key of allowed) {
    if (!Object.hasOwn(source, key)) {
      continue;
    }
    const value = scalar(source[key]);
    if (value !== undefined) {
      fields[key] = value;
    }
  }
  return Object.keys(fields).length === 0 ? undefined : Object.freeze(fields);
}

function withinDepth(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) {
    return false;
  }
  if (value === null || typeof value !== "object") {
    return true;
  }
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.every((child) => withinDepth(child, depth + 1));
}

function level(value: unknown): RuntimeLogLevel {
  return typeof value === "string" ? (LEVELS[value.toLowerCase()] ?? "unknown") : "unknown";
}

type Classified =
  | {
      readonly type: "line";
      readonly kind: RuntimeLogKind;
      readonly level: RuntimeLogLevel;
      readonly message: string;
      readonly subsystem?: string;
      readonly fields?: Readonly<Record<string, string | number | boolean>>;
    }
  | { readonly type: "withheld"; readonly reason: RuntimeLogWithheldReason };

function classifyStructured(value: Readonly<Record<string, unknown>>): Classified {
  const event = value.event;
  if (typeof event === "string" && Object.hasOwn(WRAPPER_FIELDS, event)) {
    const fields = pickFields(value, WRAPPER_FIELDS[event]!);
    const failed =
      value.outcome === "failed" ||
      (typeof value.code === "string" && value.code !== "READY" && event.endsWith("model_probe"));
    return {
      type: "line",
      kind: "wrapper",
      level: failed ? "error" : "info",
      message: event,
      ...(fields === undefined ? {} : { fields }),
    };
  }
  if (typeof value.level === "string" && typeof value.message === "string") {
    if (typeof value.target === "string") {
      return codexRecord(value, value.message);
    }
    // OpenClaw JSON console style: `{ ...meta, time, level, subsystem?, message }`.
    const fields = pickFields(value, STRUCTURED_FIELDS);
    return {
      type: "line",
      kind: "openclaw",
      level: level(value.level),
      message: value.message,
      ...(typeof value.subsystem === "string" ? { subsystem: value.subsystem } : {}),
      ...(fields === undefined ? {} : { fields }),
    };
  }
  // Codex tracing JSON: `{ timestamp, level, target, fields: { message, ... } }`.
  if (
    typeof value.level === "string" &&
    typeof value.target === "string" &&
    value.fields !== null &&
    typeof value.fields === "object" &&
    !Array.isArray(value.fields)
  ) {
    const nested = value.fields as Readonly<Record<string, unknown>>;
    if (typeof nested.message === "string") {
      return codexRecord({ ...nested, level: value.level, target: value.target }, nested.message);
    }
  }
  // Everything else, including Codex JSON-RPC protocol output, is withheld.
  return { type: "withheld", reason: "unrecognised_structured" };
}

function codexRecord(value: Readonly<Record<string, unknown>>, message: string): Classified {
  const fields = pickFields(value, STRUCTURED_FIELDS);
  return {
    type: "line",
    kind: "codex",
    level: level(value.level),
    message,
    subsystem: value.target as string,
    ...(fields === undefined ? {} : { fields }),
  };
}

function classify(line: string): Classified {
  if (byteLength(line) > RUNTIME_LOG_MAX_INPUT_BYTES) {
    return { type: "withheld", reason: "oversized" };
  }
  const text = stripRuntimeLogControls(line);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // JSON-shaped but unparseable output may be a structured payload; never show it.
      return { type: "withheld", reason: "malformed" };
    }
    if (!withinDepth(parsed)) {
      return { type: "withheld", reason: "malformed" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { type: "withheld", reason: "unrecognised_structured" };
    }
    return classifyStructured(parsed as Readonly<Record<string, unknown>>);
  }
  if (byteLength(text) > RUNTIME_LOG_MAX_TEXT_BYTES) {
    return { type: "withheld", reason: "oversized" };
  }
  return { type: "line", kind: "text", level: "unknown", message: text };
}

export interface SanitizedRuntimeLogChunk {
  readonly records: readonly SanitizedRuntimeLogRecord[];
  readonly withheld: number;
}

/**
 * The only producer of `SanitizedRuntimeLogRecord` lines. Classifies each raw line
 * against the operational allowlist, redacts every retained string, bounds sizes and
 * coalesces consecutive withheld lines into one counted record.
 */
export function sanitizeRuntimeLogChunk(
  chunk: Pick<AgentRuntimeLogChunk, "stream" | "lines" | "truncated">,
): SanitizedRuntimeLogChunk {
  const stream = cleanStream(chunk.stream);
  let lines = chunk.lines;
  // The byte limit cuts the final line; a partial line may end inside a token.
  if (chunk.truncated && lines.length > 0) {
    lines = lines.slice(0, -1);
  }
  const records: SanitizedRuntimeLogRecord[] = [];
  let withheld = 0;
  let run: Mutable<Extract<RuntimeLogRecord, { type: "withheld" }>> | undefined;
  const classifiedLines = lines.map((line) => classify(line.raw));
  // A key printed over several lines is split across records; mask the whole block.
  const pem = maskPemBlockLines(
    classifiedLines.map((classified) =>
      classified.type === "line" && classified.kind === "text" ? classified.message : undefined,
    ),
  );
  for (const [index, line] of lines.entries()) {
    const classified = classifiedLines[index]!;
    const time = validTime(line.time);
    if (classified.type === "withheld") {
      withheld += 1;
      if (run !== undefined && run.reason === classified.reason) {
        run.count += 1;
        continue;
      }
      if (run !== undefined) {
        records.push(brand(run));
      }
      run = { type: "withheld", time, stream, count: 1, reason: classified.reason };
      continue;
    }
    if (run !== undefined) {
      records.push(brand(run));
      run = undefined;
    }
    const message = sanitizeRuntimeLogText(pem.get(index) ?? classified.message);
    const subsystem =
      classified.subsystem === undefined
        ? undefined
        : sanitizeRuntimeLogText(classified.subsystem, MAX_FIELD_CHARS).text;
    const record: LineRecord = {
      type: "line",
      time,
      stream,
      // Slice 1 recognises operational output only; nothing is ever classed `content`.
      contentClass: "operational",
      kind: classified.kind,
      level: classified.level,
      message: message.text,
      ...(subsystem === undefined ? {} : { subsystem }),
      ...(classified.fields === undefined ? {} : { fields: classified.fields }),
      ...(message.truncated ? { truncated: true as const } : {}),
    };
    records.push(brand(record));
  }
  if (run !== undefined) {
    records.push(brand(run));
  }
  return Object.freeze({ records: Object.freeze(records), withheld });
}

// Sandbox policy and supervisor records (OpenShell OCSF shorthand and tracing fields).
// Operational and activity keys only; `cmd_line` and `url` carry credentials in argv and
// query strings, so they are kept only after redaction and cut to 1 KiB.
const SANDBOX_FIELDS: ReadonlySet<string> = new Set([
  "activity",
  "action",
  "disposition",
  "dst_host",
  "dst_port",
  "method",
  "path",
  "binary",
  "pid",
  "rule_name",
  "rule_type",
  "policy_generation",
  "reason",
]);
const SANDBOX_REDACTED_FIELDS: ReadonlySet<string> = new Set(["cmd_line", "url"]);
const SANDBOX_REDACTED_FIELD_BYTES = 1024;
const SANDBOX_ORIGINS: ReadonlySet<string> = new Set(["gateway", "sandbox"]);
const OCSF_SEVERITIES: Readonly<Record<string, RuntimeLogLevel>> = Object.freeze({
  INFO: "info",
  LOW: "info",
  MED: "warn",
  HIGH: "error",
  CRIT: "error",
  FATAL: "error",
});

/**
 * Fields recovered from one OpenShell OCSF shorthand line, for example
 * `HTTP:GET [INFO] ALLOWED curl(42) -> GET https://host/p?q=1 [policy:web engine:opa]` or
 * `PROC:LAUNCH [INFO] git(7) [cmd:git clone https://...]`. OpenShell pushes OCSF events
 * with an empty field map, so the shorthand is the only structure. Every pattern is
 * anchored on a fixed keyword and scans bounded tokens.
 */
function ocsfFields(message: string): {
  readonly fields: Record<string, string>;
  readonly message: string;
  readonly level: RuntimeLogLevel;
} {
  const fields: Record<string, string> = {};
  let rest = message;
  // The command line closes the PROC shorthand and may itself contain brackets. A string
  // search, not a regex, keeps hostile lines full of ` [cmd:` linear.
  const command = rest.startsWith("PROC:") && rest.endsWith("]") ? rest.indexOf(" [cmd:") : -1;
  if (command !== -1) {
    fields.cmd_line = rest.slice(command + " [cmd:".length, -1);
    rest = rest.slice(0, command);
  }
  const head = /^([A-Z]{2,16}:[A-Z_]{1,32}) \[([A-Z]{3,5})\]/.exec(rest);
  if (head !== null) {
    fields.activity = head[1]!;
  }
  const action = /^[A-Z]{2,16}:[A-Z_]{1,32} \[[A-Z]{3,5}\] ([A-Z]{3,16})\b/.exec(rest);
  if (action !== null && action[1] !== "UNKNOWN") {
    fields.action = action[1]!;
  }
  const actor = /(?:^|\s)([^\s()[\]]{1,256})\((\d{1,10})\)/.exec(rest);
  if (actor !== null) {
    fields.binary = actor[1]!;
    fields.pid = actor[2]!;
  }
  if (rest.startsWith("HTTP:")) {
    // `... curl(42) -> GET <url>`, or `... ALLOWED GET <url>` when no process is known.
    const request =
      /-> ([A-Z]{3,10}) (\S{1,32768})/.exec(rest) ??
      /^HTTP:[A-Z_]{1,32} \[[A-Z]{3,5}\] (?:[A-Z]{3,16} )?([A-Z]{3,10}) (\S{1,32768})/.exec(rest);
    if (request !== null) {
      fields.method = request[1]!;
      fields.url = request[2]!;
    }
  } else if (rest.startsWith("NET:")) {
    const target = /-> ([^\s:/]{1,253})(?::(\d{1,5}))?/.exec(rest);
    if (target !== null) {
      fields.dst_host = target[1]!;
      if (target[2] !== undefined) {
        fields.dst_port = target[2];
      }
    }
  }
  const policy = /\[policy:([^\s\]]{1,256}) engine:([^\s\]]{1,64})\]/.exec(rest);
  if (policy !== null) {
    fields.rule_name = policy[1]!;
    fields.rule_type = policy[2]!;
  }
  const reason = /[[ ]reason:([^\]]{1,512})\]/.exec(rest);
  if (reason !== null) {
    fields.reason = reason[1]!;
  }
  let severity: RuntimeLogLevel =
    head === null ? "unknown" : (OCSF_SEVERITIES[head[2]!] ?? "unknown");
  if (fields.action === "DENIED" && (severity === "info" || severity === "unknown")) {
    severity = "warn";
  }
  return { fields, message: rest, level: severity };
}

function sandboxFields(
  line: Readonly<SandboxLogLine>,
  parsed: Readonly<Record<string, string>>,
): Readonly<Record<string, string | number | boolean>> | undefined {
  const fields: Record<string, string | number | boolean> = {};
  const candidates: Record<string, unknown> = { ...parsed };
  for (const [key, value] of Object.entries(line.fields)) {
    if (!Object.hasOwn(candidates, key)) {
      candidates[key] = value;
    }
  }
  for (const [key, value] of Object.entries(candidates)) {
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    if (key === "cmd_line") {
      // argv credentials (`-u user:pass`, `-p pass`) have no key the text rules can see.
      const command = redactArgvCredentials(stripRuntimeLogControls(value));
      fields[key] = sanitizeRuntimeLogText(command, SANDBOX_REDACTED_FIELD_BYTES).text;
    } else if (SANDBOX_REDACTED_FIELDS.has(key)) {
      fields[key] = sanitizeRuntimeLogText(value, SANDBOX_REDACTED_FIELD_BYTES).text;
    } else if (SANDBOX_FIELDS.has(key)) {
      fields[key] = sanitizeRuntimeLogText(value, MAX_FIELD_CHARS).text;
    }
  }
  if (SANDBOX_ORIGINS.has(line.source)) {
    fields.source = line.source;
  }
  return Object.keys(fields).length === 0 ? undefined : Object.freeze(fields);
}

function sandboxLineSize(line: Readonly<SandboxLogLine>): number {
  let size = byteLength(line.message) + byteLength(line.target);
  for (const [key, value] of Object.entries(line.fields)) {
    size += byteLength(key) + byteLength(value);
  }
  return size;
}

/**
 * The sandbox counterpart of `sanitizeRuntimeLogChunk`: OpenShell policy decisions and
 * supervisor tracing become `activity` records. Messages, command lines and URLs are
 * redacted; any structured payload in a message is withheld.
 */
export function sanitizeSandboxLogLines(
  streamValue: RuntimeLogStream,
  lines: readonly Readonly<SandboxLogLine>[],
): SanitizedRuntimeLogChunk {
  const stream = cleanStream(streamValue);
  const records: SanitizedRuntimeLogRecord[] = [];
  let withheld = 0;
  let run: Mutable<Extract<RuntimeLogRecord, { type: "withheld" }>> | undefined;
  for (const line of lines) {
    const time = validTime(line.time);
    let reason: RuntimeLogWithheldReason | undefined;
    let text = "";
    if (sandboxLineSize(line) > RUNTIME_LOG_MAX_INPUT_BYTES) {
      reason = "oversized";
    } else {
      text = stripRuntimeLogControls(line.message);
      const trimmed = text.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        // A structured payload in a tracing message is never shown.
        reason = "unrecognised_structured";
      }
    }
    if (reason !== undefined) {
      withheld += 1;
      if (run !== undefined && run.reason === reason) {
        run.count += 1;
        continue;
      }
      if (run !== undefined) {
        records.push(brand(run));
      }
      run = { type: "withheld", time, stream, count: 1, reason };
      continue;
    }
    if (run !== undefined) {
      records.push(brand(run));
      run = undefined;
    }
    const ocsf = line.level.toUpperCase() === "OCSF";
    const parsed = ocsf ? ocsfFields(text) : undefined;
    let shown = parsed?.message ?? text;
    if (parsed?.fields.url !== undefined) {
      // The URL in the message is cut like the field so a long query cannot fill a page.
      // A replacer function: a URL may contain `$&`-style replacement patterns.
      const url = sanitizeRuntimeLogText(parsed.fields.url, SANDBOX_REDACTED_FIELD_BYTES).text;
      shown = shown.replace(parsed.fields.url, () => url);
    }
    // A PROC line whose `[cmd:` was not recovered, or a tracing message quoting a
    // command, still carries argv; mask credential flags in the message too.
    const message = sanitizeRuntimeLogText(redactArgvCredentials(shown));
    const subsystem =
      line.target.length === 0
        ? undefined
        : sanitizeRuntimeLogText(line.target, MAX_FIELD_CHARS).text;
    const fields = sandboxFields(line, parsed?.fields ?? {});
    const record: LineRecord = {
      type: "line",
      time,
      stream,
      // Policy decisions name hosts, methods and binaries: activity, never content.
      contentClass: "activity",
      kind: "sandbox",
      level: parsed?.level ?? level(line.level),
      message: message.text,
      ...(subsystem === undefined ? {} : { subsystem }),
      ...(fields === undefined ? {} : { fields }),
      ...(message.truncated ? { truncated: true as const } : {}),
    };
    records.push(brand(record));
  }
  if (run !== undefined) {
    records.push(brand(run));
  }
  return Object.freeze({ records: Object.freeze(records), withheld });
}

/** A labelled gap for loss the API observed. Remedy text is fixed. */
export function runtimeLogGap(
  reason: RuntimeLogGapReason,
  stream: RuntimeLogStream,
  time: string | null = null,
): SanitizedRuntimeLogRecord {
  return brand({
    type: "gap",
    time: validTime(time),
    stream: cleanStream(stream),
    reason,
    remedy:
      reason === "stream_replaced" && stream.source === "sandbox"
        ? "The Sandbox was recreated; showing the new one."
        : GAP_REMEDIES[reason],
  });
}

function validTime(value: string | null): string | null {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    ? value
    : null;
}
