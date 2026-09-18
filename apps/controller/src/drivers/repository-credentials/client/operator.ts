import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ControlRequest, ControlResponse } from "../control-contracts.ts";
import { writeClientConfiguration } from "./config.ts";

export async function callControl(
  socket: string,
  request: ControlRequest,
  admissionId = `${Date.now()}-${randomUUID()}`,
): Promise<ControlResponse> {
  if (
    !socket.startsWith("/") ||
    socket.length > 103 ||
    !/^\/v1\/sessions(?:\/[A-Za-z0-9_-]{1,128}(?:\/close)?)?$/.test(request.path)
  )
    throw new Error("invalid-control-request");
  if (!/^[0-9]{13}-[0-9a-f-]{36}$/.test(admissionId)) throw new Error("invalid-admission-id");
  const body = "body" in request ? JSON.stringify(request.body) : "";
  if (Buffer.byteLength(body) > 16 * 1024) throw new Error("invalid-control-request");
  return new Promise((resolveResponse, reject) => {
    const fail = (): void => reject(new Error(`control-request-failed admission=${admissionId}`));
    const outgoing = httpRequest(
      {
        socketPath: socket,
        path: request.path,
        method: request.method,
        agent: false,
        headers: {
          Host: "localhost",
          ...(request.path === "/v1/sessions" ? { "X-Admission-Id": admissionId } : {}),
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Connection: "close",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024) {
            response.destroy();
            outgoing.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", fail);
        response.once("end", () => {
          try {
            if (!response.complete || response.statusCode === undefined)
              throw new Error("control-request-failed");
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ControlResponse;
            if (value === null || typeof value !== "object")
              throw new Error("control-request-failed");
            if ("error" in value) {
              if (
                !["invalid-request", "not-found", "unavailable", "overloaded"].includes(value.error)
              )
                throw new Error("control-request-failed");
              resolveResponse({ error: value.error });
            } else {
              if (response.statusCode < 200 || response.statusCode >= 300)
                throw new Error("control-request-failed");
              resolveResponse(value);
            }
          } catch {
            fail();
          }
        });
      },
    );
    const timer = setTimeout(() => outgoing.destroy(new Error("control-request-timeout")), 5000);
    outgoing.once("error", fail);
    outgoing.once("close", () => clearTimeout(timer));
    outgoing.end(body);
  });
}

async function main(): Promise<void> {
  const [operation, ...args] = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1];
    if (!name.startsWith("--") || !value || options.has(name)) throw new Error("invalid-arguments");
    options.set(name, value);
  }
  const allowed =
    operation === "open"
      ? ["--socket", "--duration-seconds", "--profile", "--output", "--ca", "--admission-id"]
      : ["--socket", "--session"];
  if ([...options.keys()].some((key) => !allowed.includes(key)))
    throw new Error("invalid-arguments");
  const socket = options.get("--socket");
  if (!socket) throw new Error("invalid-arguments");
  if (operation === "open") {
    const durationSeconds = Number(options.get("--duration-seconds"));
    const directory = options.get("--output");
    if (!directory || !Number.isSafeInteger(durationSeconds) || durationSeconds <= 0)
      throw new Error("invalid-arguments");
    const caPath = options.get("--ca");
    const ca = caPath ? await readFile(caPath) : undefined;
    if (ca && ca.length > 64 * 1024) throw new Error("invalid-ca");
    const admissionId = options.get("--admission-id") ?? `${Date.now()}-${randomUUID()}`;
    if (!/^[0-9]{13}-[0-9a-f-]{36}$/.test(admissionId)) throw new Error("invalid-admission-id");
    process.stderr.write(
      `credential-admission ${admissionId}; recover with open --admission-id and the same inputs\n`,
    );
    const result = await callControl(
      socket,
      {
        method: "POST",
        path: "/v1/sessions",
        body: { durationSeconds, profile: options.get("--profile") },
      },
      admissionId,
    );
    if ("error" in result) {
      process.stderr.write(`credential-operator-${result.error}\n`);
      process.exitCode = 1;
      return;
    }
    if (!("bearer" in result)) {
      if (!("state" in result)) throw new Error("invalid-control-response");
      process.stdout.write(JSON.stringify({ ...result, recovered: true }) + "\n");
      process.stderr.write(
        `credential-admission-recovered session=${result.sessionId}; close this session, then open with a new admission ID\n`,
      );
      return;
    }
    try {
      await writeClientConfiguration(result, directory, ca);
    } catch {
      // Admission succeeded; retain the identifier for recovery, never the bearer.
      await callControl(socket, {
        method: "POST",
        path: `/v1/sessions/${result.session.sessionId}/close`,
      }).catch(() => undefined);
      process.stderr.write(
        `client-configuration-failed session=${result.session.sessionId}; inspect cleanup status\n`,
      );
      throw new Error("client-configuration-failed");
    }
    process.stdout.write(
      JSON.stringify({ ...result.session, clientDirectory: resolve(directory) }) + "\n",
    );
  } else if (operation === "status" || operation === "close") {
    const id = options.get("--session");
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("invalid-arguments");
    const result = await callControl(
      socket,
      operation === "status"
        ? { method: "GET", path: `/v1/sessions/${id}` }
        : { method: "POST", path: `/v1/sessions/${id}/close` },
    );
    if ("error" in result) {
      process.stderr.write(`credential-operator-${result.error}\n`);
      process.exitCode = 1;
      return;
    }
    if (!("state" in result)) throw new Error("invalid-control-response");
    process.stdout.write(JSON.stringify(result) + "\n");
  } else throw new Error("invalid-arguments");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("credential-operator-failed\n");
    process.exitCode = 1;
  });
}
