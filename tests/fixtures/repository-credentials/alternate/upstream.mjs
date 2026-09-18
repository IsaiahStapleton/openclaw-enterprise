import { createHash } from "node:crypto";

export function createAlternateUpstreamHandler({ authorize, observe, beforeWriteChunk, revision }) {
  return (request, response) => {
    const key = request.headers["x-repository-key"];
    if (!authorize(key)) {
      response.writeHead(401).end();
      return;
    }
    const entry = { method: request.method, path: request.url };
    observe(entry);
    void (async () => {
      if (request.method === "POST") {
        const hash = createHash("sha256");
        entry.bodyBytes = 0;
        entry.committed = false;
        for await (const chunk of request) {
          hash.update(chunk);
          entry.bodyBytes += chunk.length;
          await beforeWriteChunk();
        }
        // This backend invalidates predecessors on rotation. Checking again at
        // commit detects rotation while a streamed write still owns that key.
        if (!authorize(key)) {
          response.writeHead(401).end();
          return;
        }
        entry.bodyDigest = hash.digest("hex");
        entry.committed = true;
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ repository: "team/nested/project", revision: revision() }));
    })().catch(() => response.destroy());
  };
}
