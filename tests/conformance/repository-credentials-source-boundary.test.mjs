import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyRepositoryCredentialBoundary } from "../../scripts/verify-repository-credentials-boundary.mjs";

const sourceRoot = fileURLToPath(new URL("../../apps/controller/src/", import.meta.url));

async function appendSource(root, file, source, check) {
  const path = join(root, file);
  const previous = await readFile(path, "utf8").catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${previous ?? ""}\n${source}\n`);
  try {
    await check();
  } finally {
    if (previous === undefined) {
      await rm(path);
    } else {
      await writeFile(path, previous);
    }
  }
}

test("credential source boundary rejects new raw capabilities in the real source tree", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "repository-credentials-boundary-"));
  const root = join(temporary, "src");
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directories = [
    "drivers/repo/credentials",
    "drivers/repo/github/credentials",
    "composition/repository-credentials",
  ];
  for (const directory of directories) {
    await cp(join(sourceRoot, directory), join(root, directory), { recursive: true });
  }
  assert.ok((await verifyRepositoryCredentialBoundary(root)) > 0);

  await t.test("type-only imports and ordinary object methods remain valid", () =>
    appendSource(
      root,
      "drivers/repo/credentials/boundary-types.ts",
      `import type * as Http from "node:http";
       import type { RequestOptions } from "node:https";
       export type { Socket } from "node:net";
       export type { IncomingMessage } from "node:http";
       type Fetch = typeof fetch;
       const client = { fetch() { return 1; }, WebSocket: 2 };
       client.fetch(); void client.WebSocket;`,
      () => verifyRepositoryCredentialBoundary(root),
    ),
  );
  for (const directory of directories) {
    await t.test(`missing source root ${directory} fails closed`, async () => {
      const path = join(root, directory);
      const parked = join(temporary, "parked");
      await rename(path, parked);
      try {
        await assert.rejects(
          verifyRepositoryCredentialBoundary(root),
          /Missing or invalid credential source root/,
        );
        await symlink(parked, path);
        await assert.rejects(
          verifyRepositoryCredentialBoundary(root),
          /Missing or invalid credential source root/,
        );
      } finally {
        await rm(path, { force: true });
        await rename(parked, path);
      }
    });
  }
  await t.test("missing check-config entrypoint fails closed", async () => {
    const path = join(root, "composition/repository-credentials/check-config.ts");
    const parked = join(temporary, "check-config.ts");
    await rename(path, parked);
    try {
      await assert.rejects(
        verifyRepositoryCredentialBoundary(root),
        /Missing credential entrypoint/,
      );
    } finally {
      await rename(parked, path);
    }
  });
  await t.test("service cannot import a client command owner", () =>
    appendSource(
      root,
      "drivers/repo/github/credentials/client/boundary-command.ts",
      "export const command = 1;",
      () =>
        appendSource(
          root,
          "drivers/repo/credentials/boundary-client.ts",
          'import { command } from "../github/credentials/client/boundary-command.ts";',
          () =>
            assert.rejects(
              verifyRepositoryCredentialBoundary(root),
              /service code cannot load client command owner/,
            ),
        ),
    ),
  );
  const cases = [
    [
      "unscanned controller source",
      'import { initialize } from "../../../index.ts";',
      /runtime import has no scanned credential source/,
    ],
    [
      "composition output permission stays with check-config",
      'process.stdout.write("credential");',
      /raw process capability stdout/,
      "composition/repository-credentials/config.ts",
    ],
    [
      "direct HTTPS request",
      'import { request } from "node:https";',
      /unreviewed runtime import from node:https/,
    ],
    ["bare builtin alias", 'import https from "https";', /unreviewed runtime import from https/],
    [
      "raw re-export",
      'export { request } from "node:http";',
      /unreviewed runtime export from node:http/,
    ],
    ["new network dependency", 'export * from "undici";', /unreviewed runtime export from undici/],
    [
      "mixed type and value import",
      'import { type RequestOptions, request } from "node:https";',
      /unreviewed runtime import from node:https \(request\)/,
    ],
    [
      "inline type import retains its module side effect",
      'import { type Dispatcher } from "undici";',
      /unreviewed runtime import from undici \(<side-effect>\)/,
    ],
    [
      "inline type export retains its module side effect",
      'export { type Dispatcher } from "undici";',
      /unreviewed runtime export from undici \(<side-effect>\)/,
    ],
    ["side-effect import", 'import "node:tls";', /unreviewed runtime import from node:tls/],
    [
      "empty runtime import",
      'import {} from "node:net";',
      /unreviewed runtime import from node:net/,
    ],
    [
      "dynamic raw import",
      'await import("node:http2");',
      /unreviewed runtime import from node:http2/,
    ],
    [
      "nonliteral loader",
      "export const load = (specifier: string) => import(specifier);",
      /nonliteral module loading/,
    ],
    [
      "CommonJS import",
      'import http = require("node:http");',
      /unreviewed runtime import from node:http/,
    ],
    ["fetch alias", "const send = fetch; void send;", /raw global fetch/],
    ["optional fetch", 'fetch?.("https://example.test");', /raw global fetch/],
    ["global property", 'const send = globalThis["fetch"];', /raw global globalThis/],
    ["global destructuring", "const { fetch: send } = globalThis;", /raw global globalThis/],
    ["WebSocket alias", "const Socket = WebSocket;", /raw global WebSocket/],
    ["builtin loader", 'process.getBuiltinModule("https");', /raw process capability/],
    [
      "process alias",
      'const runtime = process; runtime.getBuiltinModule("https");',
      /raw process capability/,
    ],
    ["CommonJS loader", 'require("node:dns");', /raw global require/],
    ["dynamic code", 'Function("return fetch")();', /raw global Function/],
    [
      "filesystem sink",
      'import { writeFile } from "node:fs/promises";',
      /unreviewed runtime import from node:fs\/promises/,
    ],
    [
      "configuration assembly cannot read outside the protected owner",
      'import { open } from "node:fs/promises";',
      /unreviewed runtime import from node:fs\/promises \(open\)/,
      "composition/repository-credentials/config.ts",
    ],
    [
      "protected input owner cannot become a filesystem sink",
      'import { writeFile } from "node:fs/promises";',
      /unreviewed runtime import from node:fs\/promises \(writeFile\)/,
      "composition/repository-credentials/protected-file.ts",
    ],
    ["console sink", 'console.log("credential");', /raw global console/],
    ["process output sink", 'process.stdout.write("credential");', /raw process capability stdout/],
    [
      "process warning sink",
      'process.emitWarning("credential");',
      /raw process capability emitWarning/,
    ],
    [
      "process report sink",
      'process.report.writeReport("/tmp/credential.json");',
      /raw process capability report/,
    ],
    [
      "process execution sink",
      'process.execve("/usr/bin/git", ["git", "status"]);',
      /raw process capability execve/,
    ],
    [
      "raw provider helper through emitted extension",
      'import { sendProviderRequest } from "../github/credentials/provider-transport/request.js";',
      /raw sender drivers\/repo\/github\/credentials\/provider-transport\/request.ts/,
    ],
    [
      "unscanned source",
      'import { send } from "../../../../dist/unchecked.js";',
      /runtime import escapes credential source/,
    ],
    [
      "approved sender cannot re-export raw HTTPS",
      "export { httpsRequest as rawRequest };",
      /raw I\/O binding cannot be re-exported/,
      "drivers/repo/github/credentials/provider-transport/request.ts",
    ],
    [
      "a type assertion cannot hide an exported raw sender",
      "export const rawRequest = httpsRequest as typeof httpsRequest;",
      /raw I\/O binding cannot be re-exported/,
      "drivers/repo/github/credentials/provider-transport/request.ts",
    ],
    [
      "a default export cannot hide an asserted raw sender",
      "export default httpsRequest satisfies typeof httpsRequest;",
      /raw I\/O binding cannot be re-exported/,
      "drivers/repo/github/credentials/provider-transport/request.ts",
    ],
  ];
  for (const [
    label,
    source,
    expected,
    file = "drivers/repo/credentials/boundary-regression.ts",
  ] of cases) {
    await t.test(label, () =>
      appendSource(root, file, source, () =>
        assert.rejects(verifyRepositoryCredentialBoundary(root), (error) => {
          assert.match(error.message, /Repository credential boundary requires security review/);
          assert.ok(error.message.includes(`${file}:`), error.message);
          assert.match(error.message, expected);
          return true;
        }),
      ),
    );
  }
});
