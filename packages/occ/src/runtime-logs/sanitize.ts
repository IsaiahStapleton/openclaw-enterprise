import type {
  AgentRuntimeLogChunk,
  RuntimeLogGapReason,
  RuntimeLogKind,
  RuntimeLogLevel,
  RuntimeLogRecord,
  RuntimeLogStream,
  RuntimeLogWithheldReason,
} from "@openclaw-enterprise/contracts";
import { redactRuntimeLogText, stripRuntimeLogControls } from "./redact.ts";

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
  for (const line of lines) {
    const classified = classify(line.raw);
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
    const message = sanitizeRuntimeLogText(classified.message);
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
    remedy: GAP_REMEDIES[reason],
  });
}

function validTime(value: string | null): string | null {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    ? value
    : null;
}
