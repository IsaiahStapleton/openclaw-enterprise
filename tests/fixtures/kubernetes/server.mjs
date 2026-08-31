import { createServer } from "node:http";

const server = createServer((request, response) => {
  if (request.url !== "/readyz") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ready: true }));
});

server.listen(8080, "0.0.0.0");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close());
}
