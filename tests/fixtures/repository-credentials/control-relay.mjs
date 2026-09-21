import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";

// A transport fault fixture: every request reaches the actual private listener.
// It can hold one complete created response to reproduce lost ownership after
// remote admission without replacing the Driver, service, or admission logic.
export async function startControlResponseRelay(scope, { directory, target }) {
  const socketPath = join(directory, "control-relay.sock");
  const sockets = new Set();
  const requests = new Set();
  let armed;
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
          const forward = () => {
            if (outgoing.destroyed) {
              return;
            }
            outgoing.writeHead(response.statusCode, response.headers);
            outgoing.end(body);
          };
          if (response.statusCode !== 201 || armed === undefined || --armed.remaining !== 0) {
            forward();
            return;
          }
          const gate = armed;
          armed = undefined;
          let sessionId;
          try {
            sessionId = JSON.parse(body).session.sessionId;
          } catch {
            outgoing.destroy();
            return;
          }
          gate.release = forward;
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
    holdCreatedResponse(ordinal = 1) {
      assert.equal(armed, undefined, "only one control response fault may be armed");
      assert.ok(Number.isInteger(ordinal) && ordinal > 0);
      const gate = { remaining: ordinal, release: undefined, resolve: undefined };
      const observed = new Promise((resolve) => {
        gate.resolve = resolve;
      });
      armed = gate;
      return { observed, release: () => gate.release?.() };
    },
  };
}
