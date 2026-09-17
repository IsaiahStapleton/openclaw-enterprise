import type { ServerResponse } from "node:http";

const SAFE_CODES = new Set([
  "limit-exceeded",
  "unsupported-request",
  "authentication-required",
  "unavailable",
  "exchange-uncertain",
  "exchange-failed",
  "session-unavailable",
  "exchange-capacity",
  "invalid-request",
  "request-expired",
  "invalid-credential",
  "invalid-binding",
  "route-denied",
]);

/** All error text is service-owned; no upstream exception is serialized. */
export function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from(
    JSON.stringify({ error: { code: SAFE_CODES.has(code) ? code : "unavailable" } }),
  );
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json",
    "content-length": String(body.length),
    "cache-control": "no-store",
    connection: "close",
  });
  response.end(body);
}
