import { once } from "node:events";
import { createServer, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import { request, type RequestOptions } from "node:https";
import type { Duplex } from "node:stream";
import { createKubernetesClientConfiguration } from "../../kubernetes/client.ts";

type KubernetesAuthentication =
  | { readonly mode: "inCluster" }
  | { readonly mode: "kubeconfig"; readonly kubeconfigPath: string; readonly context: string };

/** Bridge the native SDK to one already verified owned Pod through authenticated Kubernetes. */
export async function openKubernetesGatewayPodProxy(
  authentication: KubernetesAuthentication,
  validationFailure: (message: string) => Error,
  input: {
    readonly namespace: string;
    readonly podName: string;
    readonly targetPort: number;
    readonly signal: AbortSignal;
  },
): Promise<{ readonly url: string; close(): Promise<void> }> {
  input.signal.throwIfAborted();
  const { kubeConfig } = await createKubernetesClientConfiguration(
    authentication,
    validationFailure,
  );
  input.signal.throwIfAborted();
  const cluster = kubeConfig.getCurrentCluster();
  if (cluster === null) throw validationFailure("The selected Kubernetes cluster is missing.");
  const upstreamUrl = new URL(
    `/api/v1/namespaces/${encodeURIComponent(input.namespace)}/pods/${encodeURIComponent(input.podName)}:${input.targetPort}/proxy/`,
    cluster.server,
  );
  const sockets = new Set<Duplex>();
  const requests = new Set<ClientRequest>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const server = createServer({ maxHeaderSize: 8192 }, (_request, response) => {
    response.writeHead(404, { connection: "close" });
    response.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closed = true;
    input.signal.removeEventListener("abort", abort);
    for (const pending of requests) pending.destroy();
    for (const socket of sockets) socket.destroy();
    closing = new Promise<void>((resolve) => {
      // Also handle cancellation between listen() and the listening event.
      const stop = () => server.close(() => resolve());
      if (server.listening) stop();
      else {
        server.once("listening", stop);
        server.once("error", () => {
          server.removeListener("listening", stop);
          resolve();
        });
      }
    });
    return closing;
  };
  const abort = () => {
    void close();
  };

  server.on("upgrade", (incoming, downstream, head) => {
    if (closed || incoming.method !== "GET" || incoming.url !== "/" || head.length !== 0) {
      downstream.destroy();
      return;
    }
    void (async () => {
      // Only WebSocket negotiation headers cross this boundary. Kubernetes auth
      // comes from kubeConfig; the native gateway token stays in its connect frame.
      const headers: IncomingHttpHeaders = { connection: "Upgrade", upgrade: "websocket" };
      for (const name of [
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
        "sec-websocket-extensions",
      ]) {
        const value = incoming.headers[name];
        if (value !== undefined) headers[name] = value;
      }
      const options: RequestOptions = {
        method: "GET",
        headers,
        signal: input.signal,
        maxHeaderSize: 8192,
      };
      await kubeConfig.applyToHTTPSOptions(options);
      if (closed || downstream.destroyed) return;
      input.signal.throwIfAborted();
      const upstream = request(upstreamUrl, options);
      requests.add(upstream);
      upstream.once("close", () => requests.delete(upstream));
      downstream.once("close", () => upstream.destroy());
      upstream.once("error", () => downstream.destroy());
      upstream.once("response", (response) => {
        response.resume();
        downstream.destroy();
      });
      upstream.once("upgrade", (response, peer, upstreamHead) => {
        requests.delete(upstream);
        if (closed || downstream.destroyed || response.statusCode !== 101) {
          peer.destroy();
          downstream.destroy();
          return;
        }
        sockets.add(peer);
        peer.once("close", () => {
          sockets.delete(peer);
          downstream.destroy();
        });
        peer.on("error", () => {
          peer.destroy();
          downstream.destroy();
        });
        downstream.once("close", () => peer.destroy());
        const responseHeaders = [
          "HTTP/1.1 101 Switching Protocols",
          "Connection: Upgrade",
          "Upgrade: websocket",
        ];
        for (const name of [
          "sec-websocket-accept",
          "sec-websocket-protocol",
          "sec-websocket-extensions",
        ]) {
          const value = response.headers[name];
          if (typeof value === "string") responseHeaders.push(`${name}: ${value}`);
        }
        downstream.write(`${responseHeaders.join("\r\n")}\r\n\r\n`);
        if (upstreamHead.length > 0) downstream.write(upstreamHead);
        downstream.pipe(peer);
        peer.pipe(downstream);
      });
      upstream.end();
    })().catch(() => downstream.destroy());
  });

  try {
    server.listen(0, "127.0.0.1");
    input.signal.addEventListener("abort", abort, { once: true });
    await once(server, "listening");
    input.signal.throwIfAborted();
    const address = server.address();
    if (closed || address === null || typeof address === "string") {
      throw validationFailure("Kubernetes Pod proxy did not bind a loopback HTTP port.");
    }
    return { url: `ws://127.0.0.1:${address.port}`, close };
  } catch (error) {
    // A failed listen has no active listener to close.
    if (!server.listening && !closed) {
      closed = true;
      input.signal.removeEventListener("abort", abort);
    } else {
      await close();
    }
    throw error;
  }
}
