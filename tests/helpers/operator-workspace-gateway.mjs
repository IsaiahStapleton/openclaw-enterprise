import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { GatewayClient } = await import(
  pathToFileURL(controllerRequire.resolve("@openclaw/gateway-client")).href
);

const executeFile = promisify(execFile);
const proxyPort = 8443;

function nonempty(value, name) {
  assert.equal(typeof value, "string", `${name} must be configured.`);
  assert.ok(value.trim().length > 0, `${name} must be nonempty.`);
  return value;
}

function normalizeIp(value) {
  if (typeof value !== "string") return "";
  if (value.startsWith("::ffff:")) return value.slice("::ffff:".length);
  return value;
}

async function command(file, args, { timeoutMs = 120_000 } = {}) {
  try {
    return await executeFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    throw new Error(
      `${file} ${args.join(" ")} failed with exit ${error.code ?? "unknown"}.\n${String(
        error.stdout ?? "",
      )}${String(error.stderr ?? "")}`,
    );
  }
}

async function docker(args, options) {
  return command("docker", args, options);
}

async function dockerJson(args, options) {
  const { stdout } = await docker(args, options);
  return JSON.parse(stdout);
}

async function waitFor(description, operation, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(
    `Timed out waiting for ${description}${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }.`,
  );
}

function proxySource() {
  return String.raw`
import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const target = new URL(process.env.TARGET_URL);
const userHeader = process.env.USER_HEADER;
const identity = process.env.IDENTITY;
const allowedClientIps = new Set(JSON.parse(process.env.ALLOWED_CLIENT_IPS));
const statsPath = "/state/stats.json";
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-real-ip",
]);

const stats = { ready: false, connections: [] };

function normalizeIp(value) {
  if (typeof value !== "string") return "";
  if (value.startsWith("::ffff:")) return value.slice("::ffff:".length);
  return value;
}

function writeStats() {
  writeFileSync(statsPath, JSON.stringify(stats, null, 2));
}

function record(entry) {
  stats.connections.push(Object.assign({ at: new Date().toISOString() }, entry));
  writeStats();
}

function filteredHeaders(headers, remoteAddress) {
  const next = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      hopByHop.has(lower) ||
      lower.startsWith("x-forwarded-") ||
      lower === userHeader.toLowerCase()
    ) {
      continue;
    }
    next[name] = value;
  }
  next.host = target.host;
  next.connection = "Upgrade";
  next.upgrade = "websocket";
  next["x-forwarded-for"] = remoteAddress;
  next[userHeader] = identity;
  return next;
}

function upstreamPath(requestUrl) {
  const incoming = new URL(requestUrl || "/", "ws://client");
  const base = target.pathname === "/" ? "" : target.pathname.replace(/\/$/u, "");
  return base + incoming.pathname + incoming.search;
}

const server = createServer(
  {
    cert: readFileSync("/proxy/cert.pem"),
    key: readFileSync("/proxy/key.pem"),
  },
  (request, response) => {
    if (request.url === "/readyz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ready" }));
      return;
    }
    if (request.url === "/__stats") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(stats));
      return;
    }
    response.writeHead(404);
    response.end();
  },
);

server.on("upgrade", (clientRequest, clientSocket, head) => {
  const remoteAddress = normalizeIp(clientRequest.socket.remoteAddress);
  const accepted = allowedClientIps.has(remoteAddress);
  record({
    remoteAddress,
    forwardedFor: remoteAddress,
    accepted,
    path: clientRequest.url,
  });
  if (!accepted) {
    clientSocket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  const upstream = httpRequest({
    hostname: target.hostname,
    port: target.port || "80",
    method: clientRequest.method,
    path: upstreamPath(clientRequest.url),
    headers: filteredHeaders(clientRequest.headers, remoteAddress),
  });

  upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    const headers = Object.entries(upstreamResponse.headers)
      .flatMap(([name, value]) =>
        Array.isArray(value) ? value.map((entry) => [name, entry]) : [[name, value]],
      )
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => name + ": " + value)
      .join("\r\n");
    clientSocket.write(
      "HTTP/1.1 " +
        upstreamResponse.statusCode +
        " " +
        upstreamResponse.statusMessage +
        "\r\n" +
        headers +
        "\r\n\r\n",
    );
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstream.on("response", (upstreamResponse) => {
    clientSocket.write(
      "HTTP/1.1 " +
        upstreamResponse.statusCode +
        " " +
        upstreamResponse.statusMessage +
        "\r\nConnection: close\r\n\r\n",
    );
    upstreamResponse.resume();
    clientSocket.destroy();
  });

  upstream.on("error", () => {
    if (!clientSocket.destroyed) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      clientSocket.destroy();
    }
  });

  upstream.end();
});

server.listen(${proxyPort}, "0.0.0.0", () => {
  stats.ready = true;
  writeStats();
});
`;
}

export async function startOperatorWorkspaceGatewayProxy({
  name = `oce-workspace-files-proxy-${randomUUID()}`,
  dockerNetwork,
  targetUrl,
  proxyIp,
  userHeader,
  identity,
  allowedClientIps,
  image = process.env.OCC_TEST_OPERATOR_PROXY_IMAGE ??
    process.env.NODE_BASE_IMAGE ??
    "node:24-bookworm",
  timeoutMs = 60_000,
}) {
  nonempty(name, "operator proxy container name");
  nonempty(dockerNetwork, "operator proxy Docker network");
  nonempty(targetUrl, "operator proxy target URL");
  nonempty(userHeader, "operator proxy user header");
  nonempty(identity, "operator proxy identity");
  assert.ok(Array.isArray(allowedClientIps), "operator proxy allowedClientIps must be an array");
  const allowed = allowedClientIps.map((value) =>
    normalizeIp(nonempty(value, "allowed client IP")),
  );
  assert.ok(allowed.length > 0, "operator proxy must have at least one allowed client IP");

  const directory = await mkdtemp(join(tmpdir(), "occ-operator-workspace-gateway-"));
  let containerCreated = false;
  const uid = process.getuid();
  const gid = process.getgid();
  try {
    await chmod(directory, 0o700);
    const keyPath = join(directory, "key.pem");
    const certPath = join(directory, "cert.pem");
    await command(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-subj",
        "/CN=localhost",
        "-days",
        "1",
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ],
      { timeoutMs: 30_000 },
    );
    await chmod(keyPath, 0o600);
    await chmod(certPath, 0o444);
    await writeFile(join(directory, "proxy.mjs"), proxySource(), { mode: 0o444 });
    const cert = new X509Certificate(await readFile(certPath));
    const tlsFingerprint = cert.fingerprint256.replaceAll(":", "");

    await docker([
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      dockerNetwork,
      ...(proxyIp === undefined ? [] : ["--ip", proxyIp]),
      "--publish",
      `127.0.0.1::${proxyPort}`,
      "--mount",
      `type=bind,source=${directory},target=/proxy,readonly`,
      "--tmpfs",
      `/state:uid=${uid},gid=${gid},mode=700`,
      "--user",
      `${uid}:${gid}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--no-healthcheck",
      "-e",
      `TARGET_URL=${targetUrl}`,
      "-e",
      `USER_HEADER=${userHeader}`,
      "-e",
      `IDENTITY=${identity}`,
      "-e",
      `ALLOWED_CLIENT_IPS=${JSON.stringify(allowed)}`,
      image,
      "node",
      "/proxy/proxy.mjs",
    ]);

    containerCreated = true;
    let closed = false;
    const inspect = async () => (await dockerJson(["inspect", name]))[0];
    const container = await waitFor(
      `operator workspace proxy ${name} to publish a loopback TLS port`,
      async () => {
        const current = await inspect();
        if (current?.State?.Running !== true) return undefined;
        const bindings = current.NetworkSettings?.Ports?.[`${proxyPort}/tcp`];
        if (!Array.isArray(bindings) || bindings.length !== 1) return undefined;
        const binding = bindings[0];
        if (binding.HostIp !== "127.0.0.1" || !/^\d+$/u.test(String(binding.HostPort))) {
          return undefined;
        }
        const { stdout } = await docker(["exec", name, "cat", "/state/stats.json"], {
          timeoutMs: 5_000,
        });
        if (JSON.parse(stdout).ready !== true) return undefined;
        return current;
      },
      timeoutMs,
    );
    const hostPort = container.NetworkSettings.Ports[`${proxyPort}/tcp`][0].HostPort;
    return {
      name,
      proxyIp: container.NetworkSettings.Networks[dockerNetwork].IPAddress,
      url: `wss://127.0.0.1:${hostPort}/`,
      tlsFingerprint,
      async stats() {
        const { stdout } = await docker(["exec", name, "cat", "/state/stats.json"], {
          timeoutMs: 10_000,
        });
        return JSON.parse(stdout);
      },
      async close() {
        if (closed) return;
        closed = true;
        await docker(["rm", "-f", name], { timeoutMs: 30_000 }).catch(() => {});
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (containerCreated) await docker(["rm", "-f", name], { timeoutMs: 30_000 }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// This is an independent native administrator used only by the live acceptance tests.
// The expected marker is absent from the message and session key; it must come from
// the workspace file that the test wrote through OCC's public PUT route.
export async function requestNativeGatewayModelTurn({
  url,
  tlsFingerprint,
  identity,
  userHeader,
  nativeAgentId = "main",
  prompt = "What is the configured workspace marker? Reply with only that marker.",
  expectedMarker,
  timeoutMs = 240_000,
}) {
  nonempty(expectedMarker, "expected workspace marker");
  assert.equal(
    prompt.includes(expectedMarker),
    false,
    "the user message must not supply the marker",
  );
  const sessionKey = `agent:${nativeAgentId}:workspace-proof-${randomUUID()}`;
  const signal = AbortSignal.timeout(timeoutMs);
  let resolveHello;
  let rejectHello;
  const connected = new Promise((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const client = new GatewayClient({
    url,
    tlsFingerprint,
    clientName: "gateway-client",
    mode: "backend",
    role: "operator",
    scopes: [],
    deviceIdentity: null,
    edgeAuthHeaders: { [userHeader]: identity },
    onHelloOk: resolveHello,
    onConnectError: rejectHello,
  });
  const connectTimer = setTimeout(
    () => rejectHello(new Error("native model proof connection timed out")),
    15_000,
  );
  try {
    client.start();
    const hello = await connected;
    clearTimeout(connectTimer);
    assert.equal(hello.auth?.role, "operator");
    assert.ok(hello.auth.scopes.includes("operator.admin"));
    assert.equal(hello.auth.deviceToken, undefined, "trusted proxy must not issue a device token");
    await client.request(
      "chat.send",
      {
        sessionKey,
        idempotencyKey: randomUUID(),
        message: prompt,
      },
      { signal, timeoutMs: 30_000 },
    );
    while (!signal.aborted) {
      const history = await client.request(
        "chat.history",
        { sessionKey, limit: 20 },
        { signal, timeoutMs: 10_000 },
      );
      for (const message of history.messages ?? []) {
        if (message.role !== "assistant") continue;
        assert.notEqual(
          message.stopReason,
          "error",
          "the provider-backed native turn must succeed",
        );
        const content =
          typeof message.content === "string"
            ? message.content
            : (message.content ?? [])
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        if (content.includes(expectedMarker))
          return { sessionKey, content, deviceTokenIssued: false };
      }
      await delay(300, undefined, { signal });
    }
    assert.fail("The fresh native session did not consume the workspace instruction.");
  } finally {
    clearTimeout(connectTimer);
    client.stop();
    await client.stopAndWait({ timeoutMs: 1_000 });
  }
}
