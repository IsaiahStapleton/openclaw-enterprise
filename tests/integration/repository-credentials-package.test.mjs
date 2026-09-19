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
import test from "node:test";

const root = resolve(".");

test("emitted credential configuration check runs without workspace packages or node_modules", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "credential-package-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const build = join(temporary, "build");
  await mkdir(join(build, "scripts"), { recursive: true });
  await mkdir(join(build, "apps/controller/dist"), { recursive: true });
  await cp(
    join(root, "scripts/build-repository-credentials.mjs"),
    join(build, "scripts/build-repository-credentials.mjs"),
  );
  // Exercise the real artifact builder on the current controller output. A root
  // TypeScript build is a prerequisite; no detached source package exists.
  await cp(join(root, "apps/controller/dist"), join(build, "apps/controller/dist"), {
    recursive: true,
  });
  await symlink(join(root, "node_modules"), join(build, "node_modules"));
  const built = spawnSync(
    process.execPath,
    [join(build, "scripts/build-repository-credentials.mjs")],
    {
      encoding: "utf8",
      timeout: 30000,
      env: { PATH: process.env.PATH },
    },
  );
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const artifact = join(build, ".build/repository-credentials/service");
  const runtime = join(temporary, "runtime");
  await cp(artifact, runtime, { recursive: true });
  const emitted = await readdir(join(runtime, "dist"), { recursive: true });
  assert.ok(emitted.includes("composition/repository-credentials/check-config.js"));
  assert.ok(emitted.every((path) => !path.endsWith(".ts") && !path.endsWith(".map")));
  assert.ok(!emitted.includes("index.js"));
  assert.ok(!emitted.includes("worker.js"));
  assert.deepEqual((await readdir(join(build, ".build/repository-credentials"))).sort(), [
    "service",
  ]);
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

test("credential artifact builder rejects dependencies outside its emitted closure", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "credential-closure-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(join(temporary, "scripts"));
  const emitted = join(temporary, "apps/controller/dist");
  const entrypoint = join(emitted, "composition/repository-credentials/check-config.js");
  await mkdir(join(emitted, "composition/repository-credentials"), { recursive: true });
  await cp(
    join(root, "scripts/build-repository-credentials.mjs"),
    join(temporary, "scripts/build-repository-credentials.mjs"),
  );
  await symlink(join(root, "node_modules"), join(temporary, "node_modules"));
  const cases = [
    ["missing emitted dependency", 'import "./missing.js";'],
    ["workspace dependency", 'import "@openclaw-enterprise/occ";'],
    ["escaping dependency", 'import "../../../outside.js";'],
    ["nonliteral dynamic import", 'const target = "./other.js"; await import(target);'],
    ["alternate loader", 'import { createRequire } from "node:module";'],
  ];
  for (const [label, source] of cases) {
    await t.test(label, async () => {
      await writeFile(entrypoint, source);
      const built = spawnSync(
        process.execPath,
        [join(temporary, "scripts/build-repository-credentials.mjs")],
        {
          encoding: "utf8",
          timeout: 10000,
          env: { PATH: process.env.PATH },
        },
      );
      assert.notEqual(built.status, 0);
      assert.match(built.stderr, /Unsupported|Invalid|ENOENT/);
    });
  }
});
