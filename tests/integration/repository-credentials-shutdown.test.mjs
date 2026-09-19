import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.mjs";
import {
  appRoot,
  appExtension,
  createServiceConfiguration,
} from "../fixtures/repository-credentials/service.mjs";

// The child uses the real process composition and common settlement owner. An
// unresolved alternate-provider callback must never defeat finite process exit.
test(
  "process shutdown reports unresolved ownership and exits within grace",
  { timeout: 10000 },
  async (t) => {
    const tls = await createTlsMaterial(t);
    const original = await createServiceConfiguration(t, { shutdownGraceMs: 100 });
    const config = { ...original, gateway: { ...original.gateway, listen: "127.0.0.1:0" } };
    const program = `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { request } from 'node:https';
    import { pathToFileURL } from 'node:url';
    import { join } from 'node:path';
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const load = (name) => import(pathToFileURL(join(input.appRoot, name + '.' + input.extension)).href);
    const [{runService}, {createSystemClock}, {createAlternateDriverFactory}] = await Promise.all([load('composition/repository-credentials/service'), load('drivers/repo/credentials/clock'), import(input.adapter)]);
    const clock = createSystemClock();
    const factory = createAlternateDriverFactory({origin:'https://upstream.example.test',gatewayOrigin:input.config.gateway.publicOrigin,clock,controls:{lateCapture:new Promise(() => {})}});
    const tls = {key:await readFile(input.key),cert:await readFile(input.cert)};
    const {service,listeners} = await runService({config:input.config,tls,factory,trustedUpstreamOrigins:new Set(),close(){}},clock);
    assert.deepEqual(Reflect.ownKeys(service).sort(), ['close','open','shutdown','status']);
    assert.equal(Object.isFrozen(service), true);
    const opened = service.open({durationSeconds:86400,profile:'git-write'});
    const status = await new Promise((resolve,reject) => {
      const outbound = request({hostname:'127.0.0.1',port:listeners.address.port,path:'/team/nested/project',ca:tls.cert,headers:{host:new URL(input.config.gateway.publicOrigin).host,authorization:'Bearer '+opened.bearer}}, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      });
      outbound.once('error', reject);
      outbound.end();
    });
    assert.equal(status, 503);
    assert.equal(factory.events.some(event => event.kind === 'rotate'), true);
    setInterval(() => {},1000);
    process.stdout.write('ready\\n');
  `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
      env: { PATH: process.env.PATH, REPOSITORY_CREDENTIALS_APP_ROOT: appRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.end(
      JSON.stringify({
        config,
        appRoot,
        extension: appExtension,
        key: tls.keyFile,
        cert: tls.certFile,
        adapter: pathToFileURL(
          fileURLToPath(
            new URL("../fixtures/repository-credentials/alternate.mjs", import.meta.url),
          ),
        ).href,
      }),
    );
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const readyDeadline = Date.now() + 5000;
    while (!stdout.includes("ready\n") && child.exitCode === null && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(stdout.includes("ready\n"), "child did not reach pending-settlement readiness");
    const started = Date.now();
    child.kill("SIGTERM");
    const outcome = await exited;
    assert.equal(outcome.code, 1);
    assert.equal(outcome.signal, null);
    assert.ok(Date.now() - started < 2000);
    const summary = [...stdout.split("\n"), ...stderr.split("\n")]
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .find((item) => item.event === "shutdown");
    assert.equal(summary?.graceExpired, true);
    assert.ok(summary.unresolved === true || summary.pendingActions > 0);
    assert.ok(!("bearer" in summary));
  },
);
