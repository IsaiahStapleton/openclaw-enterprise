import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "./backend-contracts.ts";
import type { SessionInput } from "./sessions.ts";
import { snapshotSessionInput, sameSessionInput, isBoundInput } from "./sessions.ts";
import type { SessionControl, ServiceConfig } from "./service-contracts.ts";
import { inspectRequestHead } from "./transport/request.ts";

// A new correlation must be fresh; completed-session tombstones share this window.
const admissionWindowMs = 60_000;

export function createControlAdmission(
  service: SessionControl,
  config: ServiceConfig,
  clock: Clock,
) {
  const records = new Map<
    string,
    {
      input: SessionInput;
      sessionId: string | undefined;
      forgetAt: number;
      cancel: () => void;
    }
  >();
  let disposed = false;
  const startedWall = clock.wallNow();
  const startedMono = clock.monotonicNow();
  let latestWall = startedWall;
  const now = () => {
    latestWall = Math.max(
      latestWall,
      clock.wallNow(),
      startedWall + clock.monotonicNow() - startedMono,
    );
    return latestWall;
  };
  const sweep = () => {
    for (const [id, record] of records) {
      const status = record.sessionId === undefined ? undefined : service.status(record.sessionId);
      if (
        (status === undefined || status.state === "DISPOSED") &&
        clock.monotonicNow() >= record.forgetAt
      ) {
        record.cancel();
        records.delete(id);
      }
    }
  };
  return {
    open(id: string, input: SessionInput) {
      if (disposed) throw new Error("CONTROL_CLOSED");
      const recoverOnly = "recoverOnly" in input && input.recoverOnly === true;
      const snapshot = snapshotSessionInput(input);
      const admittedInput = isBoundInput(snapshot)
        ? snapshot
        : Object.freeze({
            durationSeconds: snapshot.durationSeconds,
            profile: snapshot.profile ?? config.sessionPolicy.defaultProfile,
          });
      sweep();
      const previous = records.get(id);
      if (previous) {
        if (!sameSessionInput(previous.input, admittedInput)) throw new Error("ADMISSION_CONFLICT");
        const status =
          previous.sessionId === undefined ? undefined : service.status(previous.sessionId);
        if (!status) throw new Error("ADMISSION_MISSING");
        return { result: status, sessionId: previous.sessionId!, created: false };
      }
      const timestamp =
        /^([0-9]{13})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.exec(
          id,
        );
      const age = timestamp ? now() - Number(timestamp[1]) : -1;
      if (age < 0) throw new Error("INVALID_ADMISSION");
      if (age >= admissionWindowMs) throw new Error("ADMISSION_MISSING");
      if (records.size >= 2 * config.limits.sessions) throw new Error("SESSION_CAPACITY");
      const forgetAt = clock.monotonicNow() + admissionWindowMs - age;
      if (recoverOnly) {
        // A missing result fences a delayed first-open for this still-fresh ID.
        // Without the fence, cleanup could finish before that request creates authority.
        const record = { input: admittedInput, sessionId: undefined, forgetAt, cancel: () => {} };
        records.set(id, record);
        record.cancel = clock.schedule(admissionWindowMs - age, () => records.delete(id));
        throw new Error("ADMISSION_MISSING");
      }
      const opened = service.open(admittedInput);
      const record = {
        input: admittedInput,
        sessionId: opened.session.sessionId,
        forgetAt,
        cancel: () => {},
      };
      records.set(id, record);
      // Recovery retains only immutable input and ID, never the once-returned bearer.
      // Deadline expiry cannot discard correlation while CLOSED still owns cleanup.
      record.cancel = clock.schedule(
        Math.max(opened.session.deadlineWallMs - clock.wallNow(), admissionWindowMs - age),
        sweep,
      );
      return { result: opened, sessionId: opened.session.sessionId, created: true };
    },
    close(sessionId: string) {
      const result = service.close(sessionId);
      sweep();
      return result;
    },
    dispose() {
      disposed = true;
      for (const record of records.values()) record.cancel();
      records.clear();
    },
  };
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
    "cache-control": "no-store",
    connection: "close",
  });
  response.end(body);
}

/** This handler is mounted only on the protected local Unix socket. */
export async function handleControl(
  request: IncomingMessage,
  response: ServerResponse,
  service: SessionControl,
  config: ServiceConfig,
  clock: Clock,
  admissions: ReturnType<typeof createControlAdmission>,
): Promise<void> {
  const inspected = inspectRequestHead(request, {
    authority: "localhost",
    receivedMonoMs: clock.monotonicNow(),
    headerBytes: config.limits.headerBytes,
    headerPairs: config.limits.headerPairs,
    targetBytes: config.limits.targetBytes,
  });
  if (
    inspected.kind === "denied" ||
    inspected.authorization !== undefined ||
    inspected.head.contentEncoding !== "identity" ||
    inspected.expectContinue
  ) {
    reply(response, 400, { error: "invalid-request" });
    return;
  }
  const { head } = inspected;
  if ((head.framing.bytes ?? 0) > Math.min(16384, config.limits.controlBodyBytes)) {
    reply(response, 413, { error: "invalid-request" });
    return;
  }
  const open = head.method === "POST" && head.rawTarget === "/v1/sessions";
  const health = head.method === "GET" && head.rawTarget === "/healthz";
  const status = /^\/v1\/sessions\/([A-Za-z0-9_-]{1,128})$/.exec(head.rawTarget);
  const close = /^\/v1\/sessions\/([A-Za-z0-9_-]{1,128})\/close$/.exec(head.rawTarget);
  if (
    !open &&
    !health &&
    !(head.method === "GET" && status) &&
    !(head.method === "POST" && close)
  ) {
    reply(response, 404, { error: "not-found" });
    return;
  }
  const timer = clock.schedule(config.limits.inputMs, () => request.destroy());
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > Math.min(16384, config.limits.controlBodyBytes)) {
        request.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    if (open) {
      if (head.headers["content-type"] !== "application/json") {
        reply(response, 400, { error: "invalid-request" });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        reply(response, 400, { error: "invalid-request" });
        return;
      }
      const input = snapshotSessionInput(body);
      const recoverOnly = (body as Record<string, unknown>).recoverOnly === true;
      const admission = admissions.open(head.headers["x-admission-id"] ?? "", {
        ...input,
        ...(recoverOnly ? { recoverOnly: true as const } : {}),
      });
      // Before handing bytes to the socket, nondelivery is certain. Once writes
      // begin, a lost response is ambiguous and must remain recoverable.
      if (response.destroyed || request.socket.destroyed) {
        if (admission.created) {
          admissions.close(admission.sessionId);
        }
        return;
      }
      try {
        reply(response, admission.created ? 201 : 200, admission.result);
      } catch (error) {
        if (admission.created && !response.headersSent) {
          admissions.close(admission.sessionId);
        }
        throw error;
      }
    } else {
      if (size !== 0) {
        reply(response, 400, { error: "invalid-request" });
        return;
      }
      if (health) {
        reply(response, 200, { ready: true, protocolVersion: 1 });
        return;
      }
      const id = (status ?? close)![1]!;
      const found = service.status(id);
      if (!found) {
        reply(response, 404, { error: "not-found" });
        return;
      }
      reply(response, 200, close ? admissions.close(id) : found);
    }
  } catch (error) {
    if (!response.destroyed && !response.headersSent) {
      const invalid =
        error instanceof Error &&
        [
          "INVALID_ADMISSION",
          "ADMISSION_CONFLICT",
          "INVALID_BINDING",
          "INVALID_DEADLINE",
          "INVALID_PROFILE",
          "INVALID_DURATION",
          "BOUND_SESSION_REQUIRED",
        ].includes(error.message);
      let code = "unavailable";
      let status = 503;
      if (invalid) {
        code = "invalid-request";
        status = 400;
      } else if (error instanceof Error && error.message === "SESSION_CAPACITY") {
        code = "overloaded";
      } else if (error instanceof Error && error.message === "ADMISSION_MISSING") {
        code = "admission-missing";
        status = 404;
      }
      reply(response, status, { error: code });
    }
  } finally {
    timer();
  }
}
