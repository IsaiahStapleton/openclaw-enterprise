import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "./driver-contracts.ts";
import type { SessionControl, ServiceConfig } from "./contracts.ts";
import { inspectRequestHead } from "./transport/request.ts";

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
  const status = /^\/v1\/sessions\/([A-Za-z0-9_-]{1,128})$/.exec(head.rawTarget);
  const close = /^\/v1\/sessions\/([A-Za-z0-9_-]{1,128})\/close$/.exec(head.rawTarget);
  if (!open && !(head.method === "GET" && status) && !(head.method === "POST" && close)) {
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
      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "durationSeconds" && key !== "profile")
      ) {
        reply(response, 400, { error: "invalid-request" });
        return;
      }
      const input = body as Record<string, unknown>;
      if (
        typeof input.durationSeconds !== "number" ||
        !Number.isSafeInteger(input.durationSeconds) ||
        input.durationSeconds <= 0 ||
        input.durationSeconds > config.sessionPolicy.maximumDurationSeconds ||
        (input.profile !== undefined &&
          (typeof input.profile !== "string" ||
            !config.sessionPolicy.allowedProfiles.includes(input.profile)))
      ) {
        reply(response, 400, { error: "invalid-request" });
        return;
      }
      reply(
        response,
        201,
        service.open({
          durationSeconds: input.durationSeconds,
          profile: input.profile,
        }),
      );
    } else {
      if (size !== 0) {
        reply(response, 400, { error: "invalid-request" });
        return;
      }
      const id = (status ?? close)![1]!;
      const found = service.status(id);
      if (!found) {
        reply(response, 404, { error: "not-found" });
        return;
      }
      reply(response, 200, close ? service.close(id) : found);
    }
  } catch (error) {
    if (!response.destroyed && !response.headersSent)
      reply(response, 503, {
        error:
          error instanceof Error && error.message === "SESSION_CAPACITY"
            ? "overloaded"
            : "unavailable",
      });
  } finally {
    timer();
  }
}
