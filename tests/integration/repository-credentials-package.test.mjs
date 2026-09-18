import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  await import(
    pathToFileURL(join(runtime, "dist/composition/repository-credentials/projected-inputs.js")).href
  );
  await access(join(runtime, "dist/composition/repository-credentials/probe.js"));
  const manifest = JSON.parse(await readFile(join(runtime, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {});

  for (const platformModule of [
    "drivers/repository-credentials/github.js",
    "providers/repository-credentials/control-client.js",
    "composition/repository-credentials/platform.js",
  ]) {
    await assert.rejects(access(join(runtime, "dist", platformModule)), { code: "ENOENT" });
  }

  const client = join(temporary, "client");
  await cp(join(root, ".build/repository-credentials/client"), client, { recursive: true });
  for (const excluded of ["node_modules", "src", "dist/providers", "dist/composition"]) {
    await assert.rejects(access(join(client, excluded)), { code: "ENOENT" });
  }
  await assert.rejects(access(join(client, "dist/drivers/repository-credentials/service.js")), {
    code: "ENOENT",
  });
  const clientModules = join(client, "dist/drivers/repository-credentials/client");
  const { writeClientConfiguration } = await import(
    pathToFileURL(join(clientModules, "config.js")).href
  );
  const session = join(temporary, "session");
  const bearer = "controlled_packaging_bearer_000000000000000000000000";
  await writeClientConfiguration(
    {
      session: { sessionId: "packaging-session", deadlineWallMs: Date.now() + 60000 },
      bearer,
      client: {
        gatewayOrigin: "https://credentials.example.test",
        gitRemote: "https://credentials.example.test/example/project.git",
        gitUsername: "gateway-session",
        canonicalApiHost: "github.com",
        apiHost: "credentials.example.test",
        repository: "example/project",
      },
    },
    session,
    undefined,
  );
  // Native Git launches the packaged helper by its constructed filename. An
  // import-only closure would omit that file even though launch.js itself loads.
  const credential = spawnSync(
    process.execPath,
    [join(clientModules, "launch.js"), session, "git", "credential", "fill"],
    {
      cwd: client,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      input: "protocol=https\nhost=credentials.example.test\npath=example/project.git\n\n",
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(credential.status, 0, credential.stderr);
  assert.equal(credential.stdout.includes(`password=${bearer}\n`), true);
  assert.equal(credential.stderr.includes(bearer), false);
  // These are independently invoked image entrypoints, not transitive imports
  // of launch.js. Loading their detached modules verifies their runtime closure.
  for (const entrypoint of ["router", "operator"]) {
    const imported = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(join(clientModules, `${entrypoint}.js`)).href)})`,
      ],
      { cwd: client, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(imported.status, 0, imported.stderr);
  }
});

test("credential packaging follows emitted imports and rejects incomplete isolated closures", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "credential-closure-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const fixture = join(temporary, "repository");
  const emitted = join(fixture, "apps/controller/dist");
  async function file(path, contents) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  const script = join(fixture, "scripts/build-repository-credentials.mjs");
  await file(script, await readFile(join(root, "scripts/build-repository-credentials.mjs")));
  await file(
    join(fixture, "deploy/runtime/repository-credentials/.dockerignore"),
    await readFile(join(root, "deploy/runtime/repository-credentials/.dockerignore")),
  );
  await mkdir(join(fixture, "node_modules"));
  await symlink(join(root, "node_modules/prettier"), join(fixture, "node_modules/prettier"));

  // The fixture supplies emitted ESM to the real packager. Unreached platform
  // code deliberately imports a workspace package that isolated images lack.
  const entrypoint = join(emitted, "repository-credentials.js");
  const main = 'import "node:fs"; import "./service.js";\n';
  await file(entrypoint, main);
  await file(join(emitted, "service.js"), 'export const load = () => import("./nested.js");\n');
  await file(join(emitted, "nested.js"), 'export { value } from "./leaf.js";\n');
  await file(join(emitted, "leaf.js"), 'export const value = "import(\\\"missing.js\\\")";\n');
  await file(join(emitted, "composition/repository-credentials/check-config.js"), "export {};\n");
  await file(
    join(emitted, "composition/repository-credentials/projected-inputs.js"),
    "export {};\n",
  );
  await file(join(emitted, "composition/repository-credentials/probe.js"), 'import "node:http";\n');
  await file(
    join(emitted, "drivers/repository-credentials/github.js"),
    'import "@openclaw-enterprise/occ";\n',
  );
  const client = join(emitted, "drivers/repository-credentials/client");
  for (const name of ["launch", "router", "operator", "git-helper"]) {
    await file(join(client, `${name}.js`), 'import "./shared.js";\n');
  }
  await file(join(client, "shared.js"), 'export { readFile } from "node:fs/promises";\n');
  function stage() {
    return spawnSync(process.execPath, [script], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 10000,
    });
  }
  const staged = stage();
  assert.equal(staged.status, 0, staged.stderr);
  const service = join(fixture, ".build/repository-credentials/service/dist");
  assert.equal(
    await readFile(join(service, "leaf.js"), "utf8"),
    await readFile(join(emitted, "leaf.js"), "utf8"),
  );
  await assert.rejects(access(join(service, "drivers/repository-credentials/github.js")), {
    code: "ENOENT",
  });
  await access(
    join(
      fixture,
      ".build/repository-credentials/client/dist/drivers/repository-credentials/client/git-helper.js",
    ),
  );

  for (const [label, source, expected] of [
    [
      "external package",
      'import "@openclaw-enterprise/occ";',
      /Unsupported service runtime dependency/,
    ],
    [
      "computed import",
      "export const load = (name) => import(name);",
      /Unsupported runtime import/,
    ],
    ["CommonJS loader", 'const value = require("hidden-package");', /Unsupported runtime import/],
    [
      "alternate loader",
      'import { createRequire as loader } from "node:module";',
      /Unsupported runtime import/,
    ],
    [
      "dynamic alternate loader",
      'export const load = () => import("node:module");',
      /Unsupported runtime import/,
    ],
    ["reexported loader", 'export * from "node:module";', /Unsupported runtime import/],
    ["escaping module", 'import "../../../../outside.js";', /Invalid service runtime module/],
    [
      "unsupported asset",
      'import "./configuration.json";',
      /Unsupported service runtime dependency/,
    ],
    ["missing module", 'import "./missing.js";', /ENOENT/],
  ]) {
    await t.test(label, async () => {
      await writeFile(entrypoint, `${source}\n`);
      const rejected = stage();
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, expected);
      // Validation failure preserves the last complete staged artifact.
      assert.equal(await readFile(join(service, "repository-credentials.js"), "utf8"), main);
    });
  }

  await t.test("symlinked module", async () => {
    const outside = join(temporary, "outside.js");
    await writeFile(outside, "export {};\n");
    await symlink(outside, join(emitted, "linked.js"));
    await writeFile(entrypoint, 'import "./linked.js";\n');
    const rejected = stage();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Invalid service runtime module/);
  });

  await writeFile(entrypoint, main);
  await t.test("client reaches a service module", async () => {
    await writeFile(join(client, "router.js"), 'import "../github.js";\n');
    const rejected = stage();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Invalid client runtime module/);
    assert.equal(await readFile(join(service, "repository-credentials.js"), "utf8"), main);
  });
  await t.test("missing independently invoked entrypoint", async () => {
    await rm(join(client, "router.js"));
    const rejected = stage();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /ENOENT/);
    assert.equal(await readFile(join(service, "repository-credentials.js"), "utf8"), main);
  });
});
