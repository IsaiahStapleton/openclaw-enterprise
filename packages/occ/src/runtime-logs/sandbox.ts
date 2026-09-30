import type {
  AgentRuntimeDescription,
  RuntimeLogStream,
  SandboxLogChunk,
  SandboxLogLine,
  SandboxLogRequest,
} from "@openclaw-enterprise/contracts";
import {
  newRuntimeLogViewId,
  runtimeLogLineHash,
  type RuntimeLogCursorBinding,
  type RuntimeLogCursorCodec,
  type RuntimeLogCursorPosition,
} from "./cursor.ts";
import {
  compareRuntimeLogTime,
  RuntimeLogReadError,
  RUNTIME_LOG_MAX_TAIL_LINES,
  type RuntimeLogPage,
  type RuntimeLogQuery,
  type RuntimeLogViewAdmission,
} from "./read.ts";
import {
  runtimeLogGap,
  sanitizeSandboxLogLines,
  type SanitizedRuntimeLogRecord,
} from "./sanitize.ts";

const SANDBOX_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const SANDBOX_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_FIELDS_PER_LINE = 64;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_LINE_BYTES_COUNTED = 8 * 1024;

/** Fixed notice for loss the API cannot observe (AL2). */
export const SANDBOX_LOG_RETENTION =
  "OpenShell keeps the last 2000 lines per sandbox in memory and loses them when its gateway restarts. Lines the sandbox could not send under load are dropped without notice.";

function isStringMap(value: unknown): value is Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_FIELDS_PER_LINE &&
    entries.every(([key, entry]) => key.length <= 64 && typeof entry === "string")
  );
}

function validLine(value: unknown): value is SandboxLogLine {
  const line = value as SandboxLogLine;
  return (
    line !== null &&
    typeof line === "object" &&
    (line.time === null || (typeof line.time === "string" && TIME.test(line.time))) &&
    typeof line.sandboxId === "string" &&
    (line.sandboxId.length === 0 || SANDBOX_ID.test(line.sandboxId)) &&
    typeof line.level === "string" &&
    line.level.length <= 32 &&
    typeof line.target === "string" &&
    typeof line.message === "string" &&
    typeof line.source === "string" &&
    line.source.length <= 32 &&
    isStringMap(line.fields)
  );
}

/**
 * A Driver chunk for the revision's one Sandbox: a DNS name, bounded lines, and every
 * line from the same Sandbox object. Lines naming two Sandboxes are refused whole.
 */
function validChunk(value: unknown, requested: number): SandboxLogChunk {
  const chunk = value as SandboxLogChunk;
  if (
    chunk === null ||
    typeof chunk !== "object" ||
    typeof chunk.sandbox !== "string" ||
    !SANDBOX_NAME.test(chunk.sandbox) ||
    !Array.isArray(chunk.lines) ||
    chunk.lines.length > requested ||
    !Number.isSafeInteger(chunk.bufferTotal) ||
    chunk.bufferTotal < chunk.lines.length ||
    !chunk.lines.every(validLine)
  ) {
    throw new RuntimeLogReadError("invalid_chunk");
  }
  const ids = new Set(chunk.lines.map(({ sandboxId }) => sandboxId).filter((id) => id !== ""));
  if (ids.size > 1) {
    throw new RuntimeLogReadError("invalid_chunk");
  }
  return chunk;
}

/** Stable identity of one raw line for overlap de-duplication. */
export function sandboxLogLineHash(line: Readonly<SandboxLogLine>): string {
  const fields = Object.keys(line.fields)
    .sort()
    .map((key) => [key, line.fields[key]]);
  return runtimeLogLineHash(
    JSON.stringify([line.time, line.level, line.target, line.message, line.source, fields]),
  );
}

function lineBytes(line: Readonly<SandboxLogLine>): number {
  let size = Buffer.byteLength(line.message, "utf8") + Buffer.byteLength(line.target, "utf8");
  for (const [key, value] of Object.entries(line.fields)) {
    size += key.length + Buffer.byteLength(value, "utf8");
  }
  return Math.min(size, MAX_LINE_BYTES_COUNTED) + 256;
}

export interface ReadSandboxLogPageInput {
  readonly description: Readonly<AgentRuntimeDescription>;
  readonly query: RuntimeLogQuery;
  readonly codec: RuntimeLogCursorCodec;
  readonly binding: RuntimeLogCursorBinding;
  readonly now?: () => number;
  /** Writes the view audit event; runs before any Driver read of log text. */
  readonly admitView: (admission: RuntimeLogViewAdmission) => Promise<void>;
  readonly readLogs: (request: SandboxLogRequest) => Promise<SandboxLogChunk>;
}

/**
 * One bounded page of the revision's Sandbox log: cursor validation, resume from the
 * last delivered time, de-duplication, gap records and sanitization.
 *
 * The source is a ring buffer read as "the last N lines at or after `sinceTime`". On a
 * resume the line the previous page ended with (the anchor) is still in the buffer when
 * nothing was lost. When the anchor is gone and nothing older came back either, lines
 * were lost: `window_exceeded` when the requested window was full (more lines exist
 * than were read), otherwise `buffer_lost` (the buffer rolled over or restarted).
 */
export async function readSandboxLogPage(input: ReadSandboxLogPageInput): Promise<RuntimeLogPage> {
  const now = input.now ?? Date.now;
  const { description, query, codec, binding } = input;
  const decoded =
    query.cursor === undefined ? undefined : codec.decode(query.cursor, binding, now());
  if (decoded?.status === "invalid") {
    throw new RuntimeLogReadError("cursor_invalid");
  }
  if (!description.sources.some(({ id, kind }) => id === "sandbox" && kind === "sandbox")) {
    throw new RuntimeLogReadError("source_unavailable");
  }
  // A Sandbox has no Pods to choose from and no previous instance.
  if (query.pod !== undefined || query.previous) {
    throw new RuntimeLogReadError("pod_invalid");
  }
  const prior =
    decoded?.status === "valid" && !decoded.position.previous ? decoded.position : undefined;
  // A view is audited once, before its first read; an expired cursor starts a new view.
  const viewId = prior?.viewId ?? newRuntimeLogViewId();
  if (prior === undefined) {
    await input.admitView({
      viewId,
      revisionId: description.revisionId,
      source: "sandbox",
      previous: false,
      tailLines: query.tailLines,
    });
  }
  const resume = prior?.lastTime === null ? undefined : prior;
  const sinceTime =
    resume !== undefined
      ? resume.lastTime!
      : query.sinceSeconds === undefined
        ? undefined
        : new Date(now() - query.sinceSeconds * 1000).toISOString();
  const tailLines = Math.min(query.tailLines, RUNTIME_LOG_MAX_TAIL_LINES);
  const chunk = validChunk(
    await input.readLogs({ lines: tailLines, ...(sinceTime === undefined ? {} : { sinceTime }) }),
    tailLines,
  );
  const stream: RuntimeLogStream = { source: "sandbox", sandbox: chunk.sandbox };
  const lineId = chunk.lines.find(({ sandboxId }) => sandboxId !== "")?.sandboxId;
  const sandboxId = lineId ?? (prior?.pod === chunk.sandbox ? prior.podUid : "");
  const leading: SanitizedRuntimeLogRecord[] = [];
  if (decoded?.status === "expired") {
    leading.push(runtimeLogGap("cursor_expired", stream));
  }
  // The same revision's Sandbox was deleted and created again: a new stream.
  const replaced =
    prior !== undefined &&
    (prior.pod !== chunk.sandbox ||
      (prior.podUid !== "" && sandboxId !== "" && prior.podUid !== sandboxId));
  if (replaced) {
    leading.push(runtimeLogGap("stream_replaced", stream));
  }
  let lines = chunk.lines;
  if (resume !== undefined && !replaced) {
    const lastTime = resume.lastTime!;
    const seen = new Set(resume.lastHashes);
    const anchored = lines.some(
      (line) =>
        line.time !== null &&
        compareRuntimeLogTime(line.time, lastTime) === 0 &&
        seen.has(sandboxLogLineHash(line)),
    );
    // Lines the source dropped by time were older than the anchor: nothing is missing.
    const olderSeen = lines.length < chunk.bufferTotal;
    if (!anchored && !olderSeen) {
      const earliest = lines.find((line) => line.time !== null)?.time ?? null;
      leading.push(
        runtimeLogGap(
          chunk.bufferTotal >= tailLines ? "window_exceeded" : "buffer_lost",
          stream,
          earliest,
        ),
      );
    }
    lines = lines.filter((line) => {
      if (line.time === null) {
        return true;
      }
      const order = compareRuntimeLogTime(line.time, lastTime);
      return order > 0 || (order === 0 && !seen.has(sandboxLogLineHash(line)));
    });
  }
  let pageBytes = 0;
  let pageCut = false;
  const delivered: SandboxLogLine[] = [];
  for (const line of lines) {
    pageBytes += lineBytes(line);
    if (pageBytes > MAX_PAGE_BYTES) {
      pageCut = true;
      break;
    }
    delivered.push(line);
  }
  const sanitized = sanitizeSandboxLogLines(stream, delivered);
  const records = [
    ...leading,
    ...sanitized.records,
    ...(pageCut ? [runtimeLogGap("truncated", stream, delivered.at(-1)?.time ?? null)] : []),
  ];
  const last = [...delivered].reverse().find((line) => line.time !== null);
  let lastTime = resume !== undefined && !replaced ? resume.lastTime : null;
  let lastHashes = resume !== undefined && !replaced ? [...resume.lastHashes] : [];
  if (last !== undefined) {
    if (lastTime === null || compareRuntimeLogTime(last.time!, lastTime) !== 0) {
      lastHashes = [];
    }
    lastTime = last.time;
    for (const line of delivered) {
      if (line.time !== null && compareRuntimeLogTime(line.time, lastTime!) === 0) {
        lastHashes.push(sandboxLogLineHash(line));
      }
    }
  }
  // The cursor reuses the container position shape: `pod` holds the Sandbox name and
  // `podUid` the Sandbox object ID the source reported.
  const position: RuntimeLogCursorPosition = {
    viewId,
    pod: chunk.sandbox,
    podUid: sandboxId,
    restartCount: 0,
    previous: false,
    lastTime,
    lastHashes: lastHashes.slice(-16),
    issuedAt: now(),
  };
  return Object.freeze({
    revisionId: description.revisionId,
    source: "sandbox",
    stream: Object.freeze(stream),
    observedAt: new Date(now()).toISOString(),
    records: Object.freeze(records),
    withheld: sanitized.withheld,
    truncated: pageCut,
    cursor: codec.encode(binding, position),
  });
}
