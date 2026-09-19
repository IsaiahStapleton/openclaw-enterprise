import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import test from "node:test";

const root = resolve(".");

test("emitted credential package exposes only protected startup and session controls", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "credential-package-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const build = join(temporary, "build");
  await mkdir(join(build, "apps"), { recursive: true });
  await cp(join(root, "apps/repository-credentials"), join(build, "apps/repository-credentials"), {
    recursive: true,
    filter: (source) => !source.includes("/dist") && !source.includes("/node_modules"),
  });
  await cp(join(root, "tsconfig.base.json"), join(build, "tsconfig.base.json"));
  await symlink(join(root, "node_modules"), join(build, "node_modules"));
  const compiled = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/@typescript/native/bin/tsc"),
      "--build",
      join(build, "apps/repository-credentials/tsconfig.json"),
      "--pretty",
      "false",
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const runtime = join(temporary, "runtime");
  await mkdir(runtime);
  await cp(join(build, "apps/repository-credentials/dist"), join(runtime, "dist"), {
    recursive: true,
  });
  await cp(join(root, "apps/repository-credentials/package.json"), join(runtime, "package.json"));
  const consumer = join(temporary, "consumer");
  await mkdir(join(consumer, "node_modules/@openclaw-enterprise"), { recursive: true });
  await symlink(
    runtime,
    join(consumer, "node_modules/@openclaw-enterprise/repository-credentials"),
  );
  await symlink(join(root, "node_modules/@types"), join(consumer, "node_modules/@types"));
  await writeFile(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(consumer, "consumer.ts"),
    `import { startCredentialService } from "@openclaw-enterprise/repository-credentials";
import type { CredentialService } from "@openclaw-enterprise/repository-credentials";
// @ts-expect-error credential-bearing composition is internal
import { createCredentialService, startListeners } from "@openclaw-enterprise/repository-credentials";
// @ts-expect-error credential-bearing driver methods are internal
import type { RepoDriver } from "@openclaw-enterprise/repository-credentials";
// @ts-expect-error driver injection is internal
import type { BoundDriverFactory } from "@openclaw-enterprise/repository-credentials";
// @ts-expect-error listener injection is internal
import type { StartListenersOptions } from "@openclaw-enterprise/repository-credentials";
// @ts-expect-error the package does not publish internal owner modules
import { createCredentialService as internalOwner } from "@openclaw-enterprise/repository-credentials/dist/service.js";
declare const running: Awaited<ReturnType<typeof startCredentialService>>;
const service: CredentialService = running.service;
service.status("session");
// @ts-expect-error startup accepts a protected configuration path, not driver callbacks
startCredentialService({ factory: { create() {} } });
// @ts-expect-error request admission belongs to the internal HTTP owner
running.service.reserve;
// @ts-expect-error upstream planning belongs to the internal HTTP owner
running.service.plan;
// @ts-expect-error callers cannot receive authenticated upstream requests
running.service.execute;
// @ts-expect-error exchange cancellation belongs to the internal HTTP owner
running.service.cancel;
`,
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      extends: join(root, "tsconfig.base.json"),
      compilerOptions: { composite: false, noEmit: true },
      include: ["consumer.ts"],
    }),
  );
  const checkedConsumer = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/@typescript/native/bin/tsc"),
      "--project",
      join(consumer, "tsconfig.json"),
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(checkedConsumer.status, 0, checkedConsumer.stdout + checkedConsumer.stderr);
  // The detached runtime has no dependency graph or workspace source. Real PEM loading
  // and TLS validation still run before the non-network configuration check succeeds.
  const key = join(temporary, "key.pem");
  const certificate = join(temporary, "certificate.pem");
  const openssl = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=credentials.example.test",
      "-addext",
      "subjectAltName=DNS:credentials.example.test",
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(openssl.status, 0);
  await chmod(key, 0o600);
  await chmod(certificate, 0o644);
  const portReservation = createServer();
  await new Promise((resolve, reject) => {
    portReservation.once("error", reject);
    portReservation.listen(0, "127.0.0.1", resolve);
  });
  const port = portReservation.address().port;
  await new Promise((resolve, reject) =>
    portReservation.close((error) => (error ? reject(error) : resolve())),
  );
  const configuration = join(temporary, "service.json");
  await writeFile(
    configuration,
    JSON.stringify({
      gateway: {
        publicOrigin: "https://credentials.example.test",
        listen: `127.0.0.1:${port}`,
        tlsCertFile: certificate,
        tlsKeyFile: key,
        controlSocket: join(temporary, "control.sock"),
      },
      sessionPolicy: {
        maximumDurationSeconds: 172800,
        defaultProfile: "git-write",
        allowedProfiles: ["git-read", "git-write", "git-full"],
      },
      backend: {
        kind: "github-app",
        providerInstanceId: "fixture",
        configVersion: "1",
        appId: "123",
        installationId: "456",
        repositoryId: "789",
        repository: "example/project",
        privateKeyFile: key,
      },
    }),
    { mode: 0o600 },
  );
  const checked = spawnSync(
    process.execPath,
    [join(runtime, "dist/check-config.js"), "--check-config", configuration],
    { cwd: runtime, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).valid, true);
  assert.equal(checked.stdout.includes("PRIVATE KEY"), false);
  // The ordinary package root starts the real protected configuration path and
  // returns a separate runtime object, so JavaScript callers cannot recover
  // the internal authenticated-request callback through type erasure.
  const started = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from 'node:assert/strict';
const api = await import('@openclaw-enterprise/repository-credentials');
assert.deepEqual(Object.keys(api), ['startCredentialService']);
for (const path of ['dist/service.js', 'dist/server.js', 'dist/main.js', 'dist/backends/github/index.js']) {
  await assert.rejects(import('@openclaw-enterprise/repository-credentials/' + path), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
}
const running = await api.startCredentialService(process.argv[1]);
try {
  assert.equal(Object.isFrozen(running), true);
  assert.equal(Object.isFrozen(running.service), true);
  assert.deepEqual(Reflect.ownKeys(running.service).sort(), ['close', 'open', 'shutdown', 'status']);
  const session = running.service.open({durationSeconds: 60, profile: 'git-read'});
  assert.equal(running.service.status(session.session.sessionId).state, 'OPEN');
  assert.equal(running.service.close(session.session.sessionId).state, 'CLOSED');
  const summary = await running.service.shutdown(1000);
  assert.equal(summary.graceExpired, false);
  assert.equal(summary.disposedSessions, 1);
} finally {
  await running.listeners.close();
}`,
      configuration,
    ],
    { cwd: consumer, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const manifest = JSON.parse(await readFile(join(runtime, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {});
});

test("emitted credential Docker contexts contain only staged runtime inputs", async () => {
  // The service/client package check stages the real emitted closures first.
  // Docker receives only those contexts, never the source workspace or its tools.
  const ignore = await readFile(
    join(root, "deploy/runtime/repository-credentials/.dockerignore"),
    "utf8",
  );
  for (const name of ["service", "client"]) {
    const context = join(root, ".build/repository-credentials", name);
    assert.deepEqual((await readdir(context)).sort(), [".dockerignore", "dist", "package.json"]);
    assert.equal(await readFile(join(context, ".dockerignore"), "utf8"), ignore);
    const files = await readdir(join(context, "dist"), { recursive: true, withFileTypes: true });
    assert.ok(
      files.some((file) => file.isFile()),
      "the context must contain emitted modules",
    );
    assert.ok(
      files.every((file) => file.isDirectory() || (file.isFile() && file.name.endsWith(".js"))),
      "runtime contexts exclude declarations, source maps, compiler state and linked inputs",
    );
  }
});
