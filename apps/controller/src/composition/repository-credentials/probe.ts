import { request } from "node:http";

// Readiness is private to the co-located worker and credential service.
const probe = request(
  {
    socketPath: "/run/openclaw/repository-control/private/control.sock",
    method: "GET",
    path: "/healthz",
    agent: false,
    maxHeaderSize: 1024,
  },
  (response) => {
    const chunks: Buffer[] = [];
    let length = 0;
    response.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 1024) probe.destroy(new Error("invalid-health"));
      else chunks.push(chunk);
    });
    response.once("error", () => {
      process.exitCode = 1;
    });
    response.once("end", () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          response.statusCode !== 200 ||
          !value ||
          typeof value !== "object" ||
          !("ready" in value) ||
          value.ready !== true ||
          !("protocolVersion" in value) ||
          value.protocolVersion !== 1
        )
          throw new Error("invalid-health");
      } catch {
        process.exitCode = 1;
      }
    });
  },
);
const deadline = setTimeout(() => probe.destroy(new Error("health-timeout")), 2000);
probe.once("close", () => clearTimeout(deadline));
probe.once("error", () => {
  process.exitCode = 1;
});
probe.end();
