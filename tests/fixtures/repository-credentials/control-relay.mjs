import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";

// A transport fault fixture: every request reaches the actual private listener.
// It can hold a complete admission or disposal response without replacing the
// Driver, service, or admission and disposal logic.
export async function startControlResponseRelay(scope, { directory, target }) {
  const socketPath = join(directory, "control-relay.sock");
  const sockets = new Set();
  const requests = new Set();
  let armed;
  let hideCapabilities = false;
  const server = createServer((incoming, outgoing) => {
    const upstream = request(
      {
        socketPath: target,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
        agent: false,
      },
      (response) => {
        const chunks = [];
        let length = 0;
        response.on("data", (chunk) => {
          length += chunk.length;
          if (length > 128 * 1024) {
            response.destroy();
            outgoing.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () => outgoing.destroy());
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          if (
            hideCapabilities &&
            incoming.method === "GET" &&
            incoming.url === "/v1/capabilities"
          ) {
            outgoing.writeHead(404, { "content-type": "application/json" });
            outgoing.end('{"error":"not-found"}');
            return;
          }
          const forward = () => {
            if (outgoing.destroyed) {
              return;
            }
            outgoing.writeHead(response.statusCode, response.headers);
            outgoing.end(body);
          };
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            forward();
            return;
          }
          const matches =
            armed?.kind === "created"
              ? response.statusCode === 201
              : armed?.kind === "disposed" &&
                response.statusCode === 200 &&
                parsed.state === "DISPOSED";
          if (!matches || --armed.remaining !== 0) {
            forward();
            return;
          }
          const gate = armed;
          armed = undefined;
          const sessionId = gate.kind === "created" ? parsed.session?.sessionId : parsed.sessionId;
          if (typeof sessionId !== "string") {
            outgoing.destroy();
            return;
          }
          gate.release = forward;
          gate.disconnect = () => outgoing.destroy();
          gate.resolve({ sessionId });
        });
      },
    );
    requests.add(upstream);
    upstream.once("close", () => requests.delete(upstream));
    upstream.on("error", () => outgoing.destroy());
    outgoing.once("close", () => upstream.destroy());
    incoming.on("error", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  scope.after(async () => {
    for (const upstream of requests) {
      upstream.destroy();
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    if (!server.listening) {
      return;
    }
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    setCapabilitiesHidden(hidden) {
      hideCapabilities = hidden;
    },
    holdCreatedResponse(ordinal = 1) {
      assert.equal(armed, undefined, "only one control response fault may be armed");
      assert.ok(Number.isInteger(ordinal) && ordinal > 0);
      const gate = { kind: "created", remaining: ordinal, release: undefined, resolve: undefined };
      const observed = new Promise((resolve) => {
        gate.resolve = resolve;
      });
      armed = gate;
      return { observed, release: () => gate.release?.() };
    },
    holdDisposedResponse() {
      assert.equal(armed, undefined, "only one control response fault may be armed");
      const gate = { kind: "disposed", remaining: 1, disconnect: undefined, resolve: undefined };
      const observed = new Promise((resolve) => {
        gate.resolve = resolve;
      });
      armed = gate;
      return { observed, disconnect: () => gate.disconnect?.() };
    },
  };
}
