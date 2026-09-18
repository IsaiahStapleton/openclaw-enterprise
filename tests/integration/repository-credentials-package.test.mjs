import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(".");

test("emitted credential configuration check runs without workspace packages or node_modules", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "credential-package-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const compiled = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--build",
      join(root, "apps/controller/tsconfig.json"),
      "--pretty",
      "false",
    ],
    { encoding: "utf8", timeout: 120000 },
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const staged = spawnSync(
    process.execPath,
    [join(root, "scripts/build-repository-credentials.mjs")],
    {
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  const runtime = join(temporary, "runtime");
  await cp(join(root, ".build/repository-credentials/service"), runtime, { recursive: true });
  await assert.rejects(access(join(runtime, "node_modules")), { code: "ENOENT" });
  await assert.rejects(access(join(runtime, "src")), { code: "ENOENT" });
  await assert.rejects(access(join(runtime, "dist/drivers/repository-credentials/client")), {
    code: "ENOENT",
  });
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
  const configuration = join(temporary, "service.json");
  await writeFile(
    configuration,
    JSON.stringify({
      gateway: {
        publicOrigin: "https://credentials.example.test",
        listen: "127.0.0.1:8443",
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
    [
      join(runtime, "dist/composition/repository-credentials/check-config.js"),
      "--check-config",
      configuration,
    ],
    { cwd: runtime, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).valid, true);
  assert.equal(checked.stdout.includes("PRIVATE KEY"), false);
  const manifest = JSON.parse(await readFile(join(runtime, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {});
});
