import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, lstat, mkdir, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:https";
import { once } from "node:events";
import {
  credentialDriverModule,
  credentialClientPath,
} from "../fixtures/repository-credentials/runtime.mjs";

const { writeClientConfiguration } = await credentialDriverModule("client/config");

const launcher = credentialClientPath("launch");
const opened = {
  session: { sessionId: "session-test", deadlineWallMs: Date.now() + 86400000 },
  bearer: "controlled_gateway_bearer_0000000000000000000000",
  client: {
    gatewayOrigin: "https://credentials.example.test",
    gitRemote: "https://credentials.example.test/example/project.git",
    gitUsername: "gateway-session",
    canonicalApiHost: "github.com",
    apiHost: "credentials.example.test",
    repository: "example/project",
  },
};
async function run(args, input = "", env = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [launcher, ...args], {
      env: { ...process.env, PATH: "/usr/bin:/bin", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (part) => {
      stdout += part;
    });
    child.stderr.on("data", (part) => {
      stderr += part;
    });
    child.once("error", reject);
    child.once("close", (status) => resolveResult({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("private client configuration drives the actual Git helper with exact host and path isolation", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "credential-client-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const session = join(parent, "session");
  await writeClientConfiguration(opened, session, undefined);
  for (const file of ["bearer", "client.json", "gitconfig", "gh/hosts.yml", "gh/config.yml"]) {
    assert.equal((await lstat(join(session, file))).mode & 0o777, 0o600);
  }
  assert.equal((await lstat(session)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(session, "gh"))).mode & 0o777, 0o700);
  assert.equal(
    (await readFile(join(session, "client.json"), "utf8")).includes(opened.bearer),
    false,
  );
  await assert.rejects(
    writeClientConfiguration(opened, session, undefined),
    /client-directory-exists/,
  );

  // An inherited helper and token must never supply credentials to the supported launcher.
  const ambient = join(parent, "ambient.gitconfig");
  await writeFile(ambient, "[credential]\nhelper = !echo password=ambient-token\n");
  const environment = {
    GIT_CONFIG_GLOBAL: ambient,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "!echo password=ambient-token",
    GH_TOKEN: "ambient-token",
    HTTPS_PROXY: "http://127.0.0.1:9",
    GIT_TRACE: "1",
  };
  const exact = await run(
    [session, "git", "credential", "fill"],
    "protocol=https\nhost=credentials.example.test\npath=example/project.git\n\n",
    environment,
  );
  assert.equal(exact.status, 0);
  assert.equal(exact.stdout.includes(`password=${opened.bearer}\n`), true);
  assert.equal(exact.stderr.includes(opened.bearer), false);
  for (const input of [
    "protocol=http\nhost=credentials.example.test\npath=example/project.git\n\n",
    "protocol=https\nhost=elsewhere.example.test\npath=example/project.git\n\n",
    "protocol=https\nhost=credentials.example.test\npath=example/other.git\n\n",
  ]) {
    const denied = await run([session, "git", "credential", "fill"], input, environment);
    assert.notEqual(denied.status, 0);
    assert.equal(denied.stdout.includes(opened.bearer), false);
    assert.equal(denied.stdout.includes("ambient-token"), false);
  }
  const redirects = await run([session, "git", "config", "--get", "http.followRedirects"]);
  assert.equal(redirects.stdout.trim(), "false");
});

test("client files reject unsafe targets and the launcher refuses absolute API destinations", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "credential-client-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const unsafe = join(parent, "unsafe");
  await mkdir(unsafe, { mode: 0o755 });
  await assert.rejects(
    writeClientConfiguration(opened, join(unsafe, "session"), undefined),
    /unsafe-client-directory/,
  );
  const alias = join(parent, "alias");
  await symlink(parent, alias);
  await assert.rejects(
    writeClientConfiguration(opened, join(alias, "session"), undefined),
    /unsafe-client-directory/,
  );
  const session = join(parent, "session");
  await writeClientConfiguration(opened, session, undefined);
  const denied = await run([session, "gh", "api", "https://api.github.com/repos/example/project"]);
  assert.equal(denied.status, 1);
  assert.equal(denied.stdout, "");
  assert.equal(denied.stderr.includes(opened.bearer), false);
  await rm(join(session, "bearer"));
  await symlink(join(session, "gh/hosts.yml"), join(session, "bearer"));
  const helper = await run(
    [session, "git", "credential", "fill"],
    "protocol=https\nhost=credentials.example.test\npath=example/project.git\n\n",
  );
  assert.notEqual(helper.status, 0);
  assert.equal(helper.stdout.includes(opened.bearer), false);
});

test(
  "actual Git enforces TLS, headers, redirects and proxies over URL-specific repository settings",
  { timeout: 30000 },
  async (t) => {
    const parent = await mkdtemp(join(tmpdir(), "credential-client-https-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const key = join(parent, "key.pem");
    const cert = join(parent, "cert.pem");
    const generated = spawnSync(
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
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const requests = [];
    let redirect = false;
    const server = createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      (request, response) => {
        requests.push({
          url: request.url,
          authorization: request.headers.authorization,
          ambient: request.headers["x-ambient"],
          userAgent: request.headers["user-agent"],
        });
        if (redirect) {
          response.writeHead(302, { location: "/redirected" });
        } else if (!request.headers.authorization) {
          response.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' });
        } else {
          response.writeHead(403);
        }
        response.end();
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () =>
        new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
    );
    const origin = `https://127.0.0.1:${server.address().port}`;
    const remote = `${origin}/example/project.git`;
    const sessionInput = {
      ...opened,
      client: { ...opened.client, gatewayOrigin: origin, gitRemote: remote, apiHost: "127.0.0.1" },
    };
    const untrusted = join(parent, "untrusted");
    const trusted = join(parent, "trusted");
    await writeClientConfiguration(sessionInput, untrusted, undefined);
    await writeClientConfiguration(sessionInput, trusted, await readFile(cert));
    const repository = join(parent, "repository");
    assert.equal(spawnSync("/usr/bin/git", ["init", repository], { encoding: "utf8" }).status, 0);
    const configure = (key, value) => {
      const result = spawnSync("/usr/bin/git", ["-C", repository, "config", "--add", key, value], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    };
    // The most-specific subsection used to defeat generic launcher overrides.
    const section = `http.${remote}`;
    configure(`${section}.sslVerify`, "false");
    configure(`${section}.followRedirects`, "true");
    configure(`${section}.extraHeader`, "Authorization: Basic ambient-authorization");
    configure(`${section}.extraHeader`, "X-Ambient: inherited-header");
    configure(`${section}.proxy`, "");
    const refused = await run([untrusted, "git", "-C", repository, "ls-remote", remote]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /certificate|SSL/i);
    assert.equal(requests.length, 0, "untrusted TLS must fail before any HTTP request");

    const template = join(parent, "template");
    await mkdir(template);
    await writeFile(join(template, "config"), `[http "${remote}"]\nsslVerify = false\n`);
    // Clone writes these settings after preflight, so every spelling must refuse before TLS.
    for (const configArgs of [
      ["-c", `${section}.sslVerify=false`],
      [`-c${section}.sslVerify=false`],
      ["--config", `${section}.sslVerify=false`],
      [`--config=${section}.sslVerify=false`],
      [`--conf=${section}.sslVerify=false`],
      ["-qc", `${section}.sslVerify=false`],
      ["--template", template],
    ]) {
      const denied = await run([
        untrusted,
        "git",
        "-C",
        parent,
        "clone",
        ...configArgs,
        remote,
        join(parent, "clone-config"),
      ]);
      assert.equal(
        requests.length,
        0,
        "clone configuration must not bypass certificate verification",
      );
      assert.notEqual(denied.status, 0);
      assert.equal(denied.stderr, "repository-client-failed\n");
    }

    for (const config of [
      `init.templateDir=${template}`,
      `includeIf.gitdir:${parent}/clone-conditional/.path=${join(template, "config")}`,
    ]) {
      const denied = await run([
        untrusted,
        "git",
        "-C",
        parent,
        "-c",
        config,
        "clone",
        remote,
        join(parent, "clone-conditional"),
      ]);
      assert.equal(
        requests.length,
        0,
        "clone must reject configuration deferred until destination setup",
      );
      assert.notEqual(denied.status, 0);
      assert.equal(denied.stderr, "repository-client-failed\n");
    }

    // Included URL-specific user agents can inject headers independently of extraHeader.
    const inherited = join(parent, "inherited.gitconfig");
    configure("include.path", inherited);
    for (const [setting, value] of [
      [
        `${section}.userAgent`,
        "git/2.0\r\nAuthorization: Basic ambient-authorization\r\nX-Ambient: inherited-header",
      ],
      ["http.userAgent", "git/2.0\rX-Ambient: inherited-header"],
      [`${section}.userAgent`, "git/2.0\nX-Ambient: inherited-header"],
    ]) {
      await writeFile(inherited, "");
      const configured = spawnSync(
        "/usr/bin/git",
        ["config", "--file", inherited, setting, value],
        {
          encoding: "utf8",
        },
      );
      assert.equal(configured.status, 0, configured.stderr);
      const injected = await run([trusted, "git", "-C", repository, "ls-remote", remote]);
      assert.equal(requests.length, 0, "unsafe user agents must fail before any HTTP request");
      assert.notEqual(injected.status, 0);
      assert.equal(injected.stdout, "");
      assert.equal(injected.stderr.includes("ambient-authorization"), false);
      assert.equal(injected.stderr.includes(opened.bearer), false);
    }
    await writeFile(inherited, "");
    assert.equal(
      spawnSync("/usr/bin/git", [
        "config",
        "--file",
        inherited,
        `${section}.userAgent`,
        "git/safe-client",
      ]).status,
      0,
    );

    configure(`${section}.proxy`, "http://127.0.0.1:9");
    configure("remote.origin.url", remote);
    configure("remote.origin.proxy", "http://127.0.0.1:9");
    // Git consumes URL userinfo before its credential helper, including rewrite destinations.
    const credentialUrls = [
      `https::${remote.replace("https://", "https://ambient-user:ambient-password@")}`,
      remote.replace("https://", "https://ambient-user:ambient-password@"),
      remote.replace("https://", "https://ambient-user@"),
      remote.replace("https://", "https://:ambient-password@"),
      remote.replace("https://", "https://%61mbient%40user:%70assword%3Aencoded@"),
    ];
    configure("user.name", "Fixture Author");
    configure("user.email", "fixture@example.test");
    const committed = await run([
      trusted,
      "git",
      "-C",
      repository,
      "commit",
      "--allow-empty",
      "-m",
      credentialUrls[0],
    ]);
    assert.equal(committed.status, 0, committed.stderr);
    for (const url of credentialUrls) {
      for (const command of [
        ["clone", url, join(parent, "clone")],
        ["fetch", url],
      ]) {
        const denied = await run([trusted, "git", "-C", repository, ...command]);
        assert.equal(requests.length, 0, "command URL credentials must fail before HTTP");
        assert.notEqual(denied.status, 0);
        assert.equal(denied.stderr, "repository-client-failed\n");
      }
    }
    for (const [setting, value, command] of credentialUrls.flatMap((url) => [
      ["remote.origin.url", url, ["fetch", "origin"]],
      ["remote.origin.pushurl", url, ["push", "origin", "HEAD"]],
      [`url.${url}.insteadOf`, remote, ["fetch", "origin"]],
      [`url.${url}.pushInsteadOf`, remote, ["push", "origin", "HEAD"]],
    ])) {
      await writeFile(inherited, "");
      const configured = spawnSync("/usr/bin/git", ["config", "--file", inherited, setting, value]);
      assert.equal(configured.status, 0);
      const denied = await run([trusted, "git", "-C", repository, ...command]);
      assert.equal(requests.length, 0, "configured URL credentials must fail before HTTP");
      assert.notEqual(denied.status, 0);
      assert.equal(denied.stderr, "repository-client-failed\n");
    }
    await writeFile(inherited, "");
    configure(`${section}.userAgent`, "git/safe-client");
    const authenticated = await run([trusted, "git", "-C", repository, "ls-remote", "origin"]);
    assert.notEqual(authenticated.status, 0); // The fixture deliberately denies the authenticated request.
    assert.equal(requests.length, 2, authenticated.stderr);
    assert.equal(requests[0].authorization, undefined);
    assert.equal(
      requests[1].authorization,
      `Basic ${Buffer.from(`${opened.client.gitUsername}:${opened.bearer}`).toString("base64")}`,
    );
    assert.ok(requests.every((request) => request.ambient === undefined));
    assert.ok(requests.every((request) => request.userAgent === "git/safe-client"));
    assert.equal(authenticated.stderr.includes(opened.bearer), false);

    requests.length = 0;
    const cloned = await run([
      trusted,
      "git",
      "-C",
      parent,
      "clone",
      "--depth=1",
      remote,
      join(parent, "plain-clone"),
    ]);
    assert.notEqual(cloned.status, 0); // Only the fixture's authenticated 403 stops this clone.
    assert.equal(requests.length, 2, cloned.stderr);
    assert.equal(requests[0].authorization, undefined);
    assert.equal(
      requests[1].authorization,
      `Basic ${Buffer.from(`${opened.client.gitUsername}:${opened.bearer}`).toString("base64")}`,
    );

    requests.length = 0;
    redirect = true;
    const redirected = await run([trusted, "git", "-C", repository, "ls-remote", remote]);
    assert.notEqual(redirected.status, 0);
    assert.equal(requests.length, 1, redirected.stderr);
    assert.ok(requests[0].url.startsWith("/example/project.git/info/refs?"));
    assert.equal(requests[0].authorization, undefined);

    // Local trust-root overrides must not make an untrusted gateway trusted.
    configure(`${section}.sslCAInfo`, cert);
    requests.length = 0;
    const customTrust = await run([untrusted, "git", "-C", repository, "ls-remote", remote]);
    assert.notEqual(customTrust.status, 0);
    assert.equal(requests.length, 0);
  },
);

test(
  "launcher preserves real Git mutation and failure outcomes when home cleanup fails",
  { timeout: 15000 },
  async (t) => {
    const parent = await mkdtemp(join(tmpdir(), "credential-client-cleanup-"));
    const marker = join(parent, "home");
    t.after(async () => {
      const home = await readFile(marker, "utf8").catch(() => undefined);
      if (home) {
        await chmod(join(home, "blocked"), 0o700).catch(() => undefined);
        await rm(home, { recursive: true, force: true });
      }
      await rm(parent, { recursive: true, force: true });
    });
    const session = join(parent, "session");
    await writeClientConfiguration(opened, session, undefined);
    const repository = join(parent, "repository");
    assert.equal(spawnSync("/usr/bin/git", ["init", repository]).status, 0);
    const bin = join(parent, "bin");
    await mkdir(bin);
    // A synchronous wrapper leaves an unreadable directory after native Git exits.
    // No background writer or mocked filesystem operation is needed to fail cleanup.
    await writeFile(
      join(bin, "git"),
      `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { mkdirSync, writeFileSync, chmodSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const result = spawnSync("/usr/bin/git", args, { stdio: "inherit" });
if (!args.includes("--list")) {
  const blocked = join(process.env.HOME, "blocked");
  mkdirSync(blocked);
  writeFileSync(join(blocked, "state"), "fixture");
  writeFileSync(${JSON.stringify(marker)}, process.env.HOME);
  chmodSync(blocked, 0);
}
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    const env = { PATH: `${bin}:/usr/bin:/bin` };
    for (const [args, expected] of [
      [
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "--allow-empty",
          "-m",
          "cleanup result",
        ],
        0,
      ],
      [["show", "nonexistent-ref"], 128],
    ]) {
      const result = await run([session, "git", "-C", repository, ...args], "", env);
      assert.equal(result.status, expected, result.stderr);
      const home = await readFile(marker, "utf8");
      assert.ok(
        result.stderr.includes(`repository-client-cleanup-pending ${JSON.stringify(home)}`),
      );
      assert.equal(result.stderr.includes("repository-client-failed"), false);
      assert.equal(result.stderr.includes(opened.bearer), false);
      await chmod(join(home, "blocked"), 0o700);
      await rm(home, { recursive: true, force: true });
      await rm(marker);
    }
    assert.equal(
      spawnSync("/usr/bin/git", ["-C", repository, "log", "-1", "--format=%s"], {
        encoding: "utf8",
      }).stdout.trim(),
      "cleanup result",
    );
  },
);
