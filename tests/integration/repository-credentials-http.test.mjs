import test from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer, request } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { inspectRequestHead } from "../../apps/controller/src/drivers/repository-credentials/transport/request.ts";
import { createUpstreamSender } from "../../apps/controller/src/drivers/repository-credentials/transport/upstream.ts";
import { sendError } from "../../apps/controller/src/drivers/repository-credentials/transport/errors.ts";

const clock = {
  wallNow: Date.now,
  monotonicNow: () => performance.now(),
  schedule(ms, callback) {
    const id = setTimeout(callback, ms);
    return () => clearTimeout(id);
  },
};
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
const exchange = (port, path, body = Buffer.alloc(0), headers = {}) =>
  new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: body.length ? "POST" : "GET",
        headers: { host: "gateway.example", "content-length": body.length, ...headers },
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });

// These cases exercise actual HTTP parsers, TLS sockets and the production sender.
// Session lease ownership and provider route decisions are covered by composed tests.
test(
  "repository transport framing, bounded streams and dispatch outcomes",
  { timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "repository-transport-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    const key = await readFile(join(directory, "key.pem"));
    const cert = await readFile(join(directory, "cert.pem"));
    const received = [];
    const outcomes = [];
    let gateOpen = true;
    let observeStreamingChunk;
    const upstream = httpsServer({ key, cert }, async (req, res) => {
      const chunks = [];
      try {
        for await (const chunk of req) {
          if (req.url === "/stream") observeStreamingChunk?.();
          chunks.push(chunk);
        }
      } catch {
        return;
      }
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url === "/disconnect") {
        req.socket.destroy();
        return;
      }
      if (req.url === "/empty") {
        res.writeHead(204, { "set-cookie": "no=forward", "www-authenticate": "no-forward" });
        res.end();
        return;
      }
      if (req.url === "/rewrite") {
        const body = JSON.stringify({ url: "machine", body: "human content" });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          etag: "old",
        });
        res.end(body);
        return;
      }
      if (req.url === "/encoded-response") {
        res.writeHead(200, { "content-encoding": "gzip" });
        res.end(gzipSync("not identity"));
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.concat(chunks));
    });
    await listen(upstream);
    const origin = `https://127.0.0.1:${upstream.address().port}`;
    const gateway = httpServer(async (req, res) => {
      const parsed = inspectRequestHead(req, {
        authority: "gateway.example",
        receivedMonoMs: clock.monotonicNow(),
        headerBytes: 32768,
        headerPairs: 64,
        targetBytes: 8192,
      });
      if (parsed.kind === "denied") {
        sendError(res, parsed.status, parsed.code);
        return;
      }
      assert.equal(parsed.head.headers.authorization, undefined);
      assert.equal(parsed.head.headers.cookie, undefined);
      const plan = {
        origin: req.url === "/untrusted" ? "https://unexpected.example" : origin,
        target: req.url,
        method: req.method,
        category: "transport",
        effect: "write",
        requestHeaders: {},
        limits: {
          inputWireBytes: 65536,
          inputDecodedBytes: 65536,
          responseBytes: 65536,
          totalMs: 2000,
          inputMs: 1000,
          firstHeaderMs: 1000,
          connectMs: 1000,
          stallMs: 1000,
        },
        responsePolicy: {
          body: req.url === "/rewrite" ? "bounded-json" : "stream",
          headers: (_status, headers) => headers,
          rewriteJson:
            req.url === "/rewrite"
              ? (value) => ({ ...value, url: "rewritten-machine-url" })
              : undefined,
        },
      };
      const tracked = [];
      const outcome = await createUpstreamSender({
        request: req,
        response: res,
        head: parsed.head,
        trustedUpstreamOrigins: new Set([origin]),
        upstreamCa: cert,
        clock,
      })(
        {
          plan,
          headers: {
            authorization: "Bearer fixture-provider-only",
            "content-type": "application/octet-stream",
          },
        },
        {
          signal: new AbortController().signal,
          deadlineMonoMs: clock.monotonicNow() + 2000,
          gate: {
            dispatch(_cancel, open) {
              if (!gateOpen) throw new Error("closed");
              return open();
            },
            track(io) {
              tracked.push(io);
            },
          },
        },
      );
      await Promise.all(tracked);
      outcomes.push({ path: req.url, outcome });
      if (outcome.kind !== "completed") sendError(res, 502, "exchange-failed");
    });
    gateway.on("clientError", (_error, socket) => socket.destroy());
    await listen(gateway);
    const port = gateway.address().port;
    t.after(async () => {
      await close(gateway);
      await close(upstream);
      await rm(directory, { recursive: true, force: true });
    });

    await t.test(
      "gzip input is decoded incrementally and upstream authentication is reconstructed",
      async () => {
        const input = Buffer.from("payload".repeat(4000));
        const response = await exchange(port, "/echo", gzipSync(input), {
          "content-encoding": "gzip",
          authorization: "Bearer fixture-gateway-only",
          cookie: "private=inbound",
        });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, input);
        const observed = received.at(-1);
        assert.deepEqual(observed.body, input);
        assert.equal(observed.headers["content-encoding"], undefined);
        assert.equal(observed.headers["content-length"], undefined);
        assert.equal(observed.headers.authorization, "Bearer fixture-provider-only");
        assert.equal(observed.headers.cookie, undefined);
      },
    );
    await t.test("input reaches upstream before the client finishes its body", async () => {
      const observed = new Promise((resolve) => {
        observeStreamingChunk = resolve;
      });
      const payload = Buffer.alloc(32768, 42);
      let outgoing;
      const complete = new Promise((resolve, reject) => {
        outgoing = request(
          {
            host: "127.0.0.1",
            port,
            path: "/stream",
            method: "POST",
            headers: { host: "gateway.example", "content-length": payload.length },
            agent: false,
          },
          (incoming) => {
            const chunks = [];
            incoming.on("data", (chunk) => chunks.push(chunk));
            incoming.once("error", reject);
            incoming.once("end", () => resolve(Buffer.concat(chunks)));
          },
        );
        outgoing.once("error", reject);
      });
      outgoing.write(payload.subarray(0, 16384));
      await Promise.race([observed, complete]);
      outgoing.end(payload.subarray(16384));
      assert.deepEqual(await complete, payload);
      observeStreamingChunk = undefined;
    });
    await t.test(
      "bodyless statuses remain bodyless and private upstream headers are removed",
      async () => {
        const response = await exchange(port, "/empty");
        assert.equal(response.status, 204);
        assert.equal(response.body.length, 0);
        assert.equal(response.headers["set-cookie"], undefined);
        assert.equal(response.headers["www-authenticate"], undefined);
      },
    );
    await t.test(
      "structured response rewriting recomputes framing and discards stale integrity",
      async () => {
        const response = await exchange(port, "/rewrite");
        assert.deepEqual(JSON.parse(response.body), {
          url: "rewritten-machine-url",
          body: "human content",
        });
        assert.equal(Number(response.headers["content-length"]), response.body.length);
        assert.equal(response.headers.etag, undefined);
      },
    );
    await t.test("untrusted origins and a closed final gate never open upstream", async () => {
      const before = received.length;
      assert.equal((await exchange(port, "/untrusted")).status, 502);
      gateOpen = false;
      assert.equal((await exchange(port, "/echo")).status, 502);
      gateOpen = true;
      assert.equal(received.length, before);
    });
    await t.test("possibly accepted writes are not replayed after disconnect", async () => {
      const before = received.length;
      await assert.rejects(exchange(port, "/disconnect", Buffer.from("write")));
      const deadline = Date.now() + 1000;
      while (!outcomes.some((entry) => entry.path === "/disconnect") && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(
        outcomes.find((entry) => entry.path === "/disconnect")?.outcome.kind,
        "possibly-dispatched",
      );
      assert.equal(received.length, before + 1);
    });
    await t.test(
      "decoded overflow and unexpected upstream encoding abort the exchange",
      async () => {
        await assert.rejects(
          exchange(port, "/echo", gzipSync(Buffer.alloc(70000, 65)), {
            "content-encoding": "gzip",
          }),
        );
        await assert.rejects(exchange(port, "/encoded-response"));
      },
    );
    await t.test(
      "duplicate authorization, wrong authority and absolute targets deny before forwarding",
      async () => {
        const before = received.length;
        for (const head of [
          "GET /echo HTTP/1.1\r\nHost: gateway.example\r\nAuthorization: Bearer one\r\nAuthorization: Bearer two",
          "GET /echo HTTP/1.1\r\nHost: wrong.example",
          "GET https://gateway.example/echo HTTP/1.1\r\nHost: gateway.example",
          "POST /echo HTTP/1.1\r\nHost: gateway.example\r\nContent-Length: 0\r\nTransfer-Encoding: chunked",
        ]) {
          const raw = await new Promise((resolve, reject) => {
            const socket = connect(port, "127.0.0.1");
            let output = "";
            socket.on("connect", () => socket.end(`${head}\r\nConnection: close\r\n\r\n`));
            socket.on("data", (chunk) => (output += chunk));
            socket.on("error", reject);
            socket.on("close", () => resolve(output));
          });
          assert.ok(raw === "" || raw.startsWith("HTTP/1.1 400"));
        }
        assert.equal(received.length, before);
      },
    );
  },
);
