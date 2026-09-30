import type {
  AgentRuntimeDescription,
  AgentRuntimeLogChunk,
  AgentRuntimeLogRequest,
  RuntimeLogSourceId,
  RuntimeLogStream,
} from "@openclaw-enterprise/contracts";
import {
  newRuntimeLogViewId,
  runtimeLogLineHash,
  type RuntimeLogCursorBinding,
  type RuntimeLogCursorCodec,
  type RuntimeLogCursorPosition,
} from "./cursor.ts";
import {
  runtimeLogGap,
  sanitizeRuntimeLogChunk,
  type SanitizedRuntimeLogRecord,
} from "./sanitize.ts";

export const RUNTIME_LOG_LIMIT_BYTES = 1024 * 1024;
export const RUNTIME_LOG_DEFAULT_TAIL_LINES = 200;
export const RUNTIME_LOG_MAX_TAIL_LINES = 1000;
const RUNTIME_LOG_MAX_PAGE_BYTES = 512 * 1024;
const RESUME_OVERLAP_SECONDS = 2;

export interface RuntimeLogQuery {
  readonly source: RuntimeLogSourceId;
  readonly pod?: string;
  readonly previous: boolean;
  readonly tailLines: number;
  readonly sinceSeconds?: number;
  readonly cursor?: string;
}

/** Audit details for one view; never message text. */
export interface RuntimeLogViewAdmission {
  readonly viewId: string;
  readonly revisionId: string;
  readonly source: RuntimeLogSourceId;
  readonly pod: string;
  readonly container: string;
  readonly previous: boolean;
  readonly tailLines: number;
}

export interface RuntimeLogPage {
  readonly revisionId: string;
  readonly source: RuntimeLogSourceId;
  readonly stream: RuntimeLogStream | null;
  readonly observedAt: string;
  readonly records: readonly SanitizedRuntimeLogRecord[];
  readonly withheld: number;
  readonly truncated: boolean;
  readonly cursor: string | null;
}

export type RuntimeLogReadFailure =
  "cursor_invalid" | "source_unavailable" | "pod_invalid" | "invalid_chunk";

export class RuntimeLogReadError extends Error {
  readonly reason: RuntimeLogReadFailure;

  constructor(reason: RuntimeLogReadFailure) {
    super(`Runtime log read failed: ${reason}.`);
    this.name = "RuntimeLogReadError";
    this.reason = reason;
  }
}

/** Kubelet RFC 3339 times trim trailing zeros; pad the fraction before comparing. */
export function compareRuntimeLogTime(left: string, right: string): number {
  const normal = (value: string) => {
    const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
    return match === null ? value : `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z`;
  };
  const a = normal(left);
  const b = normal(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function validChunk(value: unknown, source: RuntimeLogSourceId): AgentRuntimeLogChunk {
  const chunk = value as AgentRuntimeLogChunk;
  if (
    chunk === null ||
    typeof chunk !== "object" ||
    chunk.stream === null ||
    typeof chunk.stream !== "object" ||
    chunk.stream.source !== source ||
    !Array.isArray(chunk.lines) ||
    chunk.lines.length > RUNTIME_LOG_MAX_TAIL_LINES + 1 ||
    typeof chunk.truncated !== "boolean" ||
    !chunk.lines.every(
      (line) =>
        line !== null &&
        typeof line === "object" &&
        typeof line.raw === "string" &&
        (line.time === null || typeof line.time === "string"),
    )
  ) {
    throw new RuntimeLogReadError("invalid_chunk");
  }
  return chunk;
}

export interface ReadRuntimeLogPageInput {
  readonly description: Readonly<AgentRuntimeDescription>;
  readonly query: RuntimeLogQuery;
  readonly codec: RuntimeLogCursorCodec;
  readonly binding: RuntimeLogCursorBinding;
  readonly signal: AbortSignal;
  readonly now?: () => number;
  /** Writes the view audit event; runs before any Driver read of log text. */
  readonly admitView: (admission: RuntimeLogViewAdmission) => Promise<void>;
  readonly readLogs: (request: AgentRuntimeLogRequest) => Promise<AgentRuntimeLogChunk>;
}

/**
 * One bounded page of one container stream: cursor validation, resume window,
 * de-duplication, gap records and sanitization. The Driver sees only Pods that
 * `describeAgentRuntime` listed for this revision.
 */
export async function readRuntimeLogPage(input: ReadRuntimeLogPageInput): Promise<RuntimeLogPage> {
  const now = input.now ?? Date.now;
  const { description, query, codec, binding } = input;
  const decoded =
    query.cursor === undefined ? undefined : codec.decode(query.cursor, binding, now());
  if (decoded?.status === "invalid") {
    throw new RuntimeLogReadError("cursor_invalid");
  }
  const source = description.sources.find(({ id }) => id === query.source);
  if (source === undefined) {
    throw new RuntimeLogReadError("source_unavailable");
  }
  if (query.pod !== undefined && !source.pods.some(({ name }) => name === query.pod)) {
    throw new RuntimeLogReadError("pod_invalid");
  }
  const cursorPosition = decoded?.status === "valid" ? decoded.position : undefined;
  // A cursor continues only its own view: the same instance selection and Pod choice.
  // Anything else is a new view and is audited like a request without a cursor.
  const prior =
    cursorPosition !== undefined &&
    cursorPosition.previous === query.previous &&
    (query.pod === undefined || query.pod === cursorPosition.pod)
      ? cursorPosition
      : undefined;
  const podName = query.pod ?? prior?.pod ?? source.pods[0]?.name;
  const pod =
    source.pods.find(({ name }) => name === podName) ??
    (query.pod === undefined ? source.pods[0] : undefined);
  const observedAt = new Date(now()).toISOString();
  if (pod === undefined) {
    return Object.freeze({
      revisionId: description.revisionId,
      source: query.source,
      stream: null,
      observedAt,
      records: Object.freeze([]),
      withheld: 0,
      truncated: false,
      cursor: null,
    });
  }
  const stream: RuntimeLogStream = {
    source: query.source,
    pod: pod.name,
    podUid: pod.uid,
    container: pod.container,
    restartCount: pod.restartCount,
  };
  const leading: SanitizedRuntimeLogRecord[] = [];
  if (decoded?.status === "expired") {
    leading.push(runtimeLogGap("cursor_expired", stream));
  }
  const sameStream =
    prior !== undefined &&
    prior.pod === pod.name &&
    prior.podUid === pod.uid &&
    prior.restartCount === pod.restartCount;
  if (prior !== undefined && !sameStream) {
    leading.push(runtimeLogGap("stream_replaced", stream));
  }
  const resume = sameStream && prior.lastTime !== null ? prior : undefined;
  // A view is audited once, before its first Driver read. Cursor polls inside a
  // view are not re-audited; an expired cursor starts a new view, and so does a
  // cursor whose Pod is gone (the audit row names the Pod that is read).
  const continuesView = prior !== undefined && prior.pod === pod.name;
  const viewId = continuesView ? prior.viewId : newRuntimeLogViewId();
  if (!continuesView) {
    await input.admitView({
      viewId,
      revisionId: description.revisionId,
      source: query.source,
      pod: pod.name,
      container: pod.container,
      previous: query.previous,
      tailLines: query.tailLines,
    });
  }
  const sinceSeconds =
    resume !== undefined
      ? Math.min(
          86_400,
          Math.max(
            1,
            Math.ceil((now() - Date.parse(resume.lastTime!)) / 1000) + RESUME_OVERLAP_SECONDS,
          ),
        )
      : query.sinceSeconds;
  const chunk = validChunk(
    await input.readLogs({
      source: query.source,
      pod: pod.name,
      podUid: pod.uid,
      container: pod.container,
      previous: query.previous,
      tailLines: query.tailLines,
      ...(sinceSeconds === undefined ? {} : { sinceSeconds }),
      limitBytes: RUNTIME_LOG_LIMIT_BYTES,
      signal: input.signal,
    }),
    query.source,
  );
  const observedStream: RuntimeLogStream = {
    source: query.source,
    pod: pod.name,
    podUid:
      typeof chunk.stream.podUid === "string" && /^[A-Za-z0-9-]{1,64}$/.test(chunk.stream.podUid)
        ? chunk.stream.podUid
        : pod.uid,
    container: pod.container,
    restartCount:
      Number.isSafeInteger(chunk.stream.restartCount) && chunk.stream.restartCount! >= 0
        ? chunk.stream.restartCount!
        : pod.restartCount,
  };
  // The Driver re-reads the Pod after the log read; a changed instance means the
  // lines may span two containers.
  const replacedDuringRead =
    observedStream.podUid !== pod.uid || observedStream.restartCount !== pod.restartCount;
  if (
    replacedDuringRead &&
    !leading.some((record) => record.type === "gap" && record.reason === "stream_replaced")
  ) {
    leading.push(runtimeLogGap("stream_replaced", observedStream));
  }
  // The byte limit cuts the final line; a partial line may end inside a token.
  let lines = chunk.truncated ? chunk.lines.slice(0, -1) : chunk.lines;
  if (resume !== undefined && !replacedDuringRead) {
    const lastTime = resume.lastTime!;
    const seen = new Set(resume.lastHashes);
    const earliest = lines.find((line) => line.time !== null)?.time ?? null;
    if (
      chunk.lines.length >= query.tailLines &&
      earliest !== null &&
      compareRuntimeLogTime(earliest, lastTime) > 0
    ) {
      leading.push(runtimeLogGap("window_exceeded", observedStream, earliest));
    }
    lines = lines.filter((line) => {
      if (line.time === null) {
        return true;
      }
      const order = compareRuntimeLogTime(line.time, lastTime);
      return order > 0 || (order === 0 && !seen.has(runtimeLogLineHash(line.raw)));
    });
  }
  // Bound the page. Later lines are dropped so the cursor resumes after the last
  // delivered line; the Driver's byte cut already dropped the final partial line.
  let pageBytes = 0;
  let pageCut = false;
  const delivered: (typeof lines)[number][] = [];
  for (const line of lines) {
    pageBytes += Math.min(Buffer.byteLength(line.raw, "utf8"), 8 * 1024) + 256;
    if (pageBytes > RUNTIME_LOG_MAX_PAGE_BYTES) {
      pageCut = true;
      break;
    }
    delivered.push(line);
  }
  const sanitized = sanitizeRuntimeLogChunk({
    stream: observedStream,
    lines: delivered,
    truncated: false,
  });
  const truncated = chunk.truncated || pageCut;
  const records = [
    ...leading,
    ...sanitized.records,
    ...(truncated
      ? [runtimeLogGap("truncated", observedStream, delivered.at(-1)?.time ?? null)]
      : []),
  ];
  const last = [...delivered].reverse().find((line) => line.time !== null);
  let lastTime = resume !== undefined && !replacedDuringRead ? resume.lastTime : null;
  let lastHashes = resume !== undefined && !replacedDuringRead ? [...resume.lastHashes] : [];
  if (last !== undefined) {
    if (lastTime === null || compareRuntimeLogTime(last.time!, lastTime) !== 0) {
      lastHashes = [];
    }
    lastTime = last.time;
    for (const line of delivered) {
      if (line.time !== null && compareRuntimeLogTime(line.time, lastTime!) === 0) {
        lastHashes.push(runtimeLogLineHash(line.raw));
      }
    }
  }
  const position: RuntimeLogCursorPosition = {
    viewId,
    pod: pod.name,
    podUid: observedStream.podUid!,
    restartCount: observedStream.restartCount!,
    previous: query.previous,
    lastTime,
    lastHashes: lastHashes.slice(-16),
    issuedAt: now(),
  };
  return Object.freeze({
    revisionId: description.revisionId,
    source: query.source,
    stream: Object.freeze(observedStream),
    observedAt,
    records: Object.freeze(records),
    withheld: sanitized.withheld,
    truncated,
    cursor: codec.encode(binding, position),
  });
}
