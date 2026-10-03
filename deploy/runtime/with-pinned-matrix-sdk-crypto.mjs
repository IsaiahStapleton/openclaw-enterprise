// Usage: node with-pinned-matrix-sdk-crypto.mjs <directory> <command> [arguments...]
//
// @matrix-org/matrix-sdk-crypto-nodejs downloads its native library from GitHub in
// postinstall, with no retry and no checksum. The Dockerfile fetches the pinned library
// with scripts/ci/download-pinned.sh instead, and this wrapper serves that directory on
// loopback while the command (pnpm install) runs, through the package's
// MATRIX_SDK_CRYPTO_DOWNLOADS_BASE_URL setting. Any other request fails, so a package
// version change fails the build until the pin is updated.
import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, normalize } from "node:path";

const [directory, command, ...commandArguments] = process.argv.slice(2);
if (!directory || !command) {
  console.error("Usage: with-pinned-matrix-sdk-crypto.mjs <directory> <command> [arguments...]");
  process.exit(64);
}

const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, "http://localhost").pathname));
  const file = join(directory, path);
  let found = false;
  try {
    found = request.method === "GET" && !path.includes("..") && statSync(file).isFile();
  } catch {}
  if (!found) {
    console.error(
      `with-pinned-matrix-sdk-crypto: no pinned file for ${request.method} ${request.url}; update the matrix-sdk-crypto pin in deploy/runtime/Dockerfile`,
    );
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-length": statSync(file).size,
    "content-type": "application/octet-stream",
  });
  createReadStream(file).pipe(response);
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const child = spawn(command, commandArguments, {
    stdio: "inherit",
    env: { ...process.env, MATRIX_SDK_CRYPTO_DOWNLOADS_BASE_URL: `http://127.0.0.1:${port}` },
  });
  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
  child.on("exit", (code) => {
    server.close();
    process.exit(code ?? 1);
  });
});
