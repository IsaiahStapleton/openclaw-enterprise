import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConfiguration } from "../../apps/repository-credentials/src/check-config.ts";
import { validateServiceConfig } from "../../apps/repository-credentials/src/config.ts";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.mjs";
test("protected startup accepts RSA/TLS files without provider calls and rejects unsafe material", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "repository-configuration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tls = await createTlsMaterial(t),
    key = join(directory, "app.pem"),
    tlsKey = join(directory, "tls.key"),
    cert = join(directory, "tls.crt"),
    file = join(directory, "config.json");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  await writeFile(key, pem, { mode: 0o600 });
  await writeFile(tlsKey, tls.key, { mode: 0o600 });
  await writeFile(cert, tls.cert, { mode: 0o644 });
  const input = {
    gateway: {
      publicOrigin: "https://credentials.example",
      listen: "127.0.0.1:8443",
      tlsCertFile: cert,
      tlsKeyFile: tlsKey,
      controlSocket: join(directory, "control.sock"),
    },
    sessionPolicy: {
      maximumDurationSeconds: 172800,
      defaultProfile: "git-write",
      allowedProfiles: ["git-write", "read-write"],
    },
    backend: {
      kind: "github-app",
      providerInstanceId: "production",
      configVersion: "1",
      appId: "12345",
      installationId: "41",
      repositoryId: "73",
      repository: "fixture/repository",
      privateKeyFile: key,
    },
  };
  async function save(value = input) {
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  }
  await save();
  const summary = await checkConfiguration(file);
  assert.equal(summary.valid, true);
  assert.equal(summary.maximumDurationSeconds, 172800);
  assert.equal(JSON.stringify(summary).includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(summary).includes(directory), false);
  await chmod(key, 0o644);
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  await chmod(key, 0o600);
  const link = join(directory, "link.pem");
  await symlink(key, link);
  await save({ ...input, backend: { ...input.backend, privateKeyFile: link } });
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  await save({ ...input, backend: { ...input.backend, privateKeyFile: directory } });
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  await save();
  await writeFile(key, "x".repeat(65537));
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await writeFile(key, ec.privateKey.export({ type: "pkcs8", format: "pem" }));
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  await writeFile(key, pem);
  await chmod(file, 0o644);
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  await chmod(file, 0o600);
  await chmod(directory, 0o777);
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  await chmod(directory, 0o700);
});
test("service admission bounds are finite and retain an explicit long-task policy", () => {
  const input = {
    gateway: {
      publicOrigin: "https://credentials.example",
      listen: "127.0.0.1:8443",
      controlSocket: "/run/credentials/control.sock",
    },
    sessionPolicy: {
      maximumDurationSeconds: 172800,
      defaultProfile: "git-write",
      allowedProfiles: ["git-write"],
    },
  };
  assert.equal(validateServiceConfig(input).sessionPolicy.maximumDurationSeconds, 172800);
  for (const value of [0, -1, Infinity, NaN])
    assert.throws(() => validateServiceConfig({ ...input, limits: { exchangeMs: value } }));
  assert.throws(() =>
    validateServiceConfig({
      ...input,
      sessionPolicy: { ...input.sessionPolicy, maximumDurationSeconds: undefined },
    }),
  );
  assert.throws(() =>
    validateServiceConfig({
      ...input,
      gateway: { ...input.gateway, publicOrigin: "https://credentials.example/alias" },
    }),
  );
  assert.throws(() => validateServiceConfig({ ...input, limits: { providerActions: 2 } }));
});
