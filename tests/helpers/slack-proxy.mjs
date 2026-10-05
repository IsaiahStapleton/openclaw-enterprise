import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Starts the bundled Slack proxy (apps/controller/src/slack-proxy.mjs) as a child process with
 * OCC_SLACK_PROXY_PORT `port` and resolves once it is listening: for a fixed port, once the
 * port accepts connections; for port 0, once the proxy logs the port it bound. The test's
 * cleanup sends it SIGTERM. With `upstreamPort`, the child resolves slack.com to 127.0.0.1 and
 * its connections to slack.com:443 reach that loopback port instead. Returns the child, the
 * listening port and `stderr()`, what the proxy has written so far.
 */
export async function startSlackProxy(t, { port, upstreamPort } = {}) {
  const preload =
    upstreamPort === undefined ? [] : ["--import", await writeDnsFixture(t, upstreamPort)];
  const child = spawn(process.execPath, [...preload, "apps/controller/src/slack-proxy.mjs"], {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, OCC_SLACK_PROXY_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  const listening = new Promise((resolve, reject) => {
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = /Slack proxy listening on (\d+)/.exec(stderr);
      if (match !== null) {
        resolve(Number(match[1]));
      }
    });
    child.once("exit", () => reject(new Error(`Slack proxy exited before listening: ${stderr}`)));
  });
  t.after(() => child.kill());
  if (port === 0) {
    port = await listening;
  } else {
    listening.catch(() => {});
    await waitForProxy(port);
  }
  return { child, port, stderr: () => stderr };
}

async function writeDnsFixture(t, upstreamPort) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-slack-proxy-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "dns-fixture.mjs");
  await writeFile(
    path,
    `import dns from "node:dns";
const originalLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (hostname !== "slack.com") {
    return originalLookup(hostname, options, callback);
  }
  if (typeof options === "function") {
    options(null, "127.0.0.1", 4);
    return;
  }
  if (options?.all) {
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
    return;
  }
  callback(null, "127.0.0.1", 4);
};
import net from "node:net";
const originalConnect = net.connect;
net.connect = (...args) => {
  if (args[0]?.host === "slack.com" && args[0]?.port === 443) {
    return originalConnect({ ...args[0], host: "127.0.0.1", port: ${upstreamPort} }, ...args.slice(1));
  }
  return originalConnect(...args);
};
`,
  );
  return path;
}

async function waitForProxy(port) {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    try {
      const socket = net.connect({ host: "127.0.0.1", port });
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.end();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Slack proxy did not start.");
}

/** Sends `CONNECT target` to the proxy on `port` and returns its response head. */
export async function connectThroughProxy(port, target) {
  return requestThroughProxy(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
}

/** Writes raw `request` bytes to the proxy on `port` and returns its response head. */
export async function requestThroughProxy(port, request) {
  const socket = net.connect({ host: "127.0.0.1", port });
  let response = "";
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("proxy response timeout")), 10_000);
      const finish = () => {
        clearTimeout(timeout);
        resolve();
      };
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(request);
      });
      socket.on("data", (chunk) => {
        response += chunk;
        if (response.includes("\r\n\r\n")) {
          finish();
        }
      });
      socket.once("end", finish);
    });
    return response;
  } finally {
    socket.destroy();
  }
}
