import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SessionControl } from "./contracts.ts";
import type { RunningListeners, TlsMaterial } from "./internal-contracts.ts";
import { createControlAdmission, handleControl } from "./control.ts";
import { createAgentHandler } from "./transport/agent.ts";
import type { AgentHandlerOptions } from "./transport/agent.ts";
import { sendError } from "./transport/errors.ts";

export interface StartListenersOptions extends AgentHandlerOptions {
  readonly service: AgentHandlerOptions["service"] & SessionControl;
  readonly tls: TlsMaterial;
}

export type BoundListeners = RunningListeners & Readonly<{ address: AddressInfo }>;

export async function startListeners(options: StartListenersOptions): Promise<BoundListeners> {
  const { config, service, clock } = options;
  const socketPath = resolve(config.gateway.controlSocket);
  const parent = dirname(socketPath);
  const parentInfo = await lstat(parent);
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    (parentInfo.mode & 0o077) !== 0 ||
    parentInfo.uid !== process.getuid?.() ||
    (await realpath(parent)) !== parent
  )
    throw new Error("unsafe-control-directory");
  try {
    await lstat(socketPath);
    throw new Error("control-socket-exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const sockets = new Set<Socket>();
  const active = new WeakSet<Socket>();
  let admitting = true;
  let socketIdentity: Readonly<{ dev: number; ino: number }> | undefined;
  const limits = config.limits;
  const serverOptions = {
    maxHeaderSize: limits.headerBytes,
    headersTimeout: limits.headerMs,
    requestTimeout: limits.exchangeMs,
    connectionsCheckingInterval: Math.min(1000, limits.headerMs),
    keepAliveTimeout: limits.stallMs,
  };
  const agent = createHttpsServer({
    ...serverOptions,
    cert: Buffer.from(options.tls.cert),
    key: Buffer.from(options.tls.key),
    minVersion: "TLSv1.2",
    ALPNProtocols: ["http/1.1"],
    handshakeTimeout: limits.headerMs,
  });
  const control = createHttpServer(serverOptions);
  const onAgent = createAgentHandler(options);
  const admissions = createControlAdmission(service, config, clock);
  const route =
    (kind: "agent" | "control") =>
    (request: IncomingMessage, response: ServerResponse): void => {
      if (!admitting || active.has(request.socket)) {
        request.socket.destroy();
        return;
      }
      active.add(request.socket);
      response.shouldKeepAlive = false;
      // Connections are deliberately single-use; pipelining never creates two owners.
      void (
        kind === "agent"
          ? onAgent(request, response)
          : handleControl(request, response, service, config, clock, admissions)
      ).catch(() => sendError(response, 503, "unavailable"));
    };
  for (const [server, handler] of [
    [agent, route("agent")],
    [control, route("control")],
  ] as const) {
    // Retain one excess pair so the inspector can reject instead of silently truncating.
    server.maxHeadersCount = limits.headerPairs + 1;
    server.maxRequestsPerSocket = 1;
    server.setTimeout(limits.stallMs, (socket) => socket.destroy());
    server.on("connection", (socket: Socket) => {
      if (!admitting || sockets.size >= limits.sockets) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.setTimeout(limits.headerMs, () => socket.destroy());
    });
    server.on("request", handler);
    server.on("checkContinue", handler);
    server.on("checkExpectation", (_request, response) =>
      sendError(response, 417, "unsupported-request"),
    );
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("connect", (_request, socket) => socket.destroy());
    server.on("upgrade", (_request, socket) => socket.destroy());
  }
  let agentClose: Promise<void> | undefined;
  let controlClose: Promise<void> | undefined;
  const stopAdmission = () => {
    if (!admitting) return;
    admitting = false;
    agentClose = new Promise((done) => agent.close(() => done()));
    controlClose = new Promise((done) => control.close(() => done()));
  };
  const close = async () => {
    stopAdmission();
    admissions.dispose();
    for (const socket of sockets) socket.destroy();
    agent.closeAllConnections();
    control.closeAllConnections();
    await Promise.all([agentClose, controlClose]);
    // Session shutdown joins credential ownership; listener shutdown only joins I/O.
    if (socketIdentity) {
      try {
        const current = await lstat(socketPath);
        if (current.dev === socketIdentity.dev && current.ino === socketIdentity.ino)
          await unlink(socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };
  try {
    const listen = new URL(`tcp://${config.gateway.listen}`);
    if (!listen.port || !/^\d+$/.test(listen.port)) throw new Error("invalid-listen");
    await new Promise<void>((done, reject) => {
      agent.once("error", reject);
      agent.listen(Number(listen.port), listen.hostname.replace(/^\[|\]$/g, ""), () => {
        agent.off("error", reject);
        done();
      });
    });
    await new Promise<void>((done, reject) => {
      control.once("error", reject);
      control.listen(socketPath, () => {
        control.off("error", reject);
        done();
      });
    });
    await chmod(socketPath, 0o600);
    const info = await lstat(socketPath);
    socketIdentity = { dev: info.dev, ino: info.ino };
    return { stopAdmission, close, address: agent.address() as AddressInfo };
  } catch {
    await close();
    throw new Error("listener-startup-failed");
  }
}
