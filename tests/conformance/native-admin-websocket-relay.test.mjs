import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { proxyNativeAdminWebSocket } from "../../apps/controller/src/gateway/native-admin-proxy.ts";

// Drives proxyNativeAdminWebSocket in this process against a loopback HTTPS gateway, with a
// browser socket whose writes complete only when the test says so, as writes do behind a full
// TCP send buffer. A real slow browser only reaches that state when the kernel buffers happen
// to be full, so a loopback test would rarely catch a relay that drops queued bytes.

const WAIT_MS = 10_000;
const testOptions = { timeout: 60_000 };
const agentOrigin = "https://agent.native.example";

function bound(promise, what, ms = WAIT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// A gateway that answers the upgrade with 101, sends `reply` and closes its side.
async function startGateway(t, reply) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-native-admin-relay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, "tls.key");
  const certPath = join(directory, "tls.crt");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
  const cert = await readFile(certPath, "utf8");
  const previous = getCACertificates("default");
  setDefaultCACertificates([...previous, cert]);
  t.after(() => setDefaultCACertificates(previous));

  const sockets = new Set();
  const server = createServer({ key: await readFile(keyPath), cert }, (_request, response) => {
    response.writeHead(404).end();
  });
  server.on("upgrade", (_request, socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    socket.end(reply);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
  });
  return server.address().port;
}

function heldBrowserSocket(t) {
  const chunks = [];
  const held = [];
  let finished = false;
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      held.push(callback);
    },
    final(callback) {
      finished = true;
      callback();
    },
  });
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  const closed = new Promise((resolve) => socket.once("close", resolve));
  return { socket, closed, held, bytes: () => Buffer.concat(chunks), finished: () => finished };
}

test(
  "the native admin WebSocket relay flushes bytes still queued for the browser after the gateway closes",
  testOptions,
  async (t) => {
    // Smaller than the browser socket's high-water mark, so the pipe never pauses the gateway:
    // its EOF and close reach the relay while the frames still wait behind the first held write.
    const reply = randomBytes(1_024);
    const port = await startGateway(t, reply);
    const browser = heldBrowserSocket(t);
    let resolveClosed;
    const relayClosed = new Promise((resolve) => {
      resolveClosed = resolve;
    });

    proxyNativeAdminWebSocket({
      request: {
        method: "GET",
        url: "/session/socket",
        headers: {
          origin: agentOrigin,
          "sec-websocket-key": randomBytes(16).toString("base64"),
          "sec-websocket-version": "13",
        },
      },
      socket: browser.socket,
      head: Buffer.alloc(0),
      context: {
        gatewayBase: `https://localhost:${port}/`,
        agentOrigin,
        apiKey: "relay-test-key",
      },
      connectionId: "relay-test",
      lease: async () => undefined,
      onConnect: async () => {},
      onClose: resolveClosed,
    });

    const cause = await bound(relayClosed, "relay close");
    assert.equal(cause.reason, "upstream_disconnect");
    assert.ok(browser.socket.writableEnded, "the relay ended the browser after the gateway EOF");
    assert.ok(browser.socket.writableLength > 0, "the frames are still queued for the browser");
    assert.equal(
      browser.socket.destroyed,
      false,
      "the relay keeps a browser that is still reading",
    );

    // The browser reads everything, then closes its side.
    while (browser.held.length > 0) {
      browser.held.shift()();
      await nextTurn();
    }
    assert.ok(browser.finished(), "the browser saw a clean EOF");
    const received = browser.bytes();
    assert.match(received.toString("latin1"), /^HTTP\/1\.1 101 /);
    const body = received.subarray(received.indexOf("\r\n\r\n") + 4);
    assert.ok(body.equals(reply), "the browser received every frame byte");
    browser.socket.push(null);
    await bound(browser.closed, "browser close");
  },
);
