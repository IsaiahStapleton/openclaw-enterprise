import { createServer } from "node:http";
import { isIP } from "node:net";
import type { OccMetrics } from "./index.ts";

export interface MetricsConfiguration {
  readonly host: string;
  readonly port: number;
}

export function metricsConfiguration(
  environment: NodeJS.ProcessEnv,
  mode: string,
  apiPort?: number,
): MetricsConfiguration | undefined {
  const enabled = environment.OCC_METRICS_ENABLED ?? "false";
  const host = environment.OCC_METRICS_HOST;
  const rawPort = environment.OCC_METRICS_PORT;
  if (enabled !== "true" && enabled !== "false")
    throw new Error("OCC_METRICS_ENABLED must be true or false.");
  if (enabled === "false") {
    if (host !== undefined || rawPort !== undefined)
      throw new Error("Disabled metrics cannot have host or port settings.");
    return undefined;
  }
  if (mode !== "development" && mode !== "production")
    throw new Error("Metrics require development or production mode.");
  const port = Number(rawPort);
  if (
    rawPort === undefined ||
    !/^\d+$/.test(rawPort) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    port === apiPort
  ) {
    throw new Error("OCC_METRICS_PORT must be a distinct valid TCP port.");
  }
  if (host === undefined || isIP(host) === 0)
    throw new Error("OCC_METRICS_HOST must be an explicit IP address.");
  const canonicalHost =
    isIP(host) === 6 ? new URL(`http://[${host}]/`).hostname.slice(1, -1) : host;
  if (mode === "development" && host !== "127.0.0.1" && host !== "::1")
    throw new Error("Development metrics require loopback.");
  if (
    mode === "production" &&
    (canonicalHost === "0.0.0.0" ||
      canonicalHost === "::" ||
      canonicalHost === "::1" ||
      /^127\./.test(canonicalHost) ||
      /^::ffff:/i.test(canonicalHost))
  ) {
    throw new Error("Production metrics require an explicit Pod interface address.");
  }
  return { host, port };
}

export async function startMetricsListener(
  metrics: OccMetrics,
  configuration: MetricsConfiguration,
) {
  const server = createServer(
    { requestTimeout: 5_000, headersTimeout: 5_000, connectionsCheckingInterval: 1_000 },
    async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      if (request.url !== "/metrics") {
        response.writeHead(404).end();
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" }).end();
        return;
      }
      const deadline = setTimeout(() => {
        response.writeHead(503).end();
      }, 5_000);
      try {
        const body = await metrics.exposition();
        if (!response.writableEnded)
          response.writeHead(200, { "Content-Type": metrics.contentType }).end(body);
      } catch {
        if (!response.writableEnded) response.writeHead(503).end();
      } finally {
        clearTimeout(deadline);
      }
    },
  );
  server.maxConnections = 16;
  server.keepAliveTimeout = 1_000;
  server.setTimeout(5_000, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(configuration.port, configuration.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Metrics listener address unavailable.");
  let closing: Promise<void> | undefined;
  return {
    url: `http://${isIP(configuration.host) === 6 ? `[${configuration.host}]` : configuration.host}:${address.port}`,
    close: () => {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
