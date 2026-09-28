import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../..", import.meta.url));
const script =
  process.env.OCC_UPGRADE_SCRIPT ?? join(repository, "scripts/upgrade-production-images");
const controller = `registry.example.invalid/controller@sha256:${"a".repeat(64)}`;
const runtime = `registry.example.invalid/runtime@sha256:${"b".repeat(64)}`;
const oldRuntime = `registry.example.invalid/runtime@sha256:${"c".repeat(64)}`;

// This fixture substitutes the external command protocols, not the upgrade
// script. It records accepted writes independently of the client response.
const executable = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = process.env.UPGRADE_FIXTURE;
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const stateFile = path.join(root, 'state.json');
const state = JSON.parse(fs.readFileSync(stateFile));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const log = (value) => fs.appendFileSync(path.join(root, 'events'), value + '\\n');
const take = (name) => { const p = path.join(root, name); if (!fs.existsSync(p)) return false; fs.unlinkSync(p); return true; };
const out = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
const fileArg = (name) => args[args.indexOf(name) + 1];
if (tool === 'helm') {
  if (args[0] === 'status') {
    out(args.includes('json') ? {version: state.version, info: {status: state.helmStatus}} : state.helmStatus);
  } else if (args[0] === 'get') {
    out(fs.readFileSync(path.join(root, 'live-values'), 'utf8'));
  } else if (args[0] === 'template') {
    out('rendered');
  } else if (args[0] === 'upgrade' && !args.includes('--dry-run=server')) {
    if (state.api !== 0 || state.worker !== 0) { console.error('old writers were not stopped'); process.exit(2); }
    log('migration');
    state.version += 1;
    fs.copyFileSync(fileArg('--values'), path.join(root, 'live-values'));
    if (take('fail-migration')) { state.helmStatus = 'failed'; save(); process.exit(9); }
    state.helmStatus = 'deployed';
    state.controller = execFileSync('yq', ['-r', '.images.controller', fileArg('--values')], {encoding: 'utf8'}).trim();
    state.checksum = execFileSync('yq', ['-r', '.controlPlane.installationChecksum', fileArg('--values')], {encoding: 'utf8'}).trim();
    state.api = 1;
    state.worker = 1;
    save();
    if (take('lost-helm-response')) process.exit(9);
  }
} else if (tool === 'kubectl') {
  if (args.includes('--raw=/readyz')) out('ok');
  else if (args.includes('create') && args.includes('secret')) {
    const file = args.find((a) => a.startsWith('--from-file=')).slice('--from-file='.length).split('=');
    out({metadata: {name: 'occ-installation-startup'}, data: {[file[0]]: fs.readFileSync(file[1]).toString('base64')}});
  } else if (args.includes('apply')) {
    const secret = JSON.parse(execFileSync('yq', ['-o=json', '.', '-'], {input: fs.readFileSync(0)}));
    state.secret.data = {...state.secret.data, ...secret.data}; save(); log('secret-replaced');
    if (take('lost-secret-response')) process.exit(9);
  }
  else if (args.includes('scale')) {
    const component = args.find((a) => a.startsWith('deployment/')).split('-').at(-1);
    if (component === 'worker' && take('fail-scale-worker')) process.exit(9);
    state[component] = 0; save(); log('scale-' + component);
  } else if (args.includes('replace')) {
    const secret = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (secret.metadata.resourceVersion !== state.secret.metadata.resourceVersion) process.exit(11);
    secret.metadata.resourceVersion = String(Number(secret.metadata.resourceVersion) + 1);
    state.secret = secret; save(); log('secret-replaced');
    if (take('lost-secret-response')) process.exit(9);
  } else if (args.includes('get') && args.includes('secret')) out(state.secret);
  else if (args.some((a) => a.startsWith('deployment/')) && args.includes('get')) {
    if (args.some((a) => a.startsWith('jsonpath='))) out(state.controller);
    else {
      const component = args.find((a) => a.startsWith('deployment/')).split('-').at(-1);
      out({metadata: {labels: {'app.kubernetes.io/instance': 'oce', 'app.kubernetes.io/component': component}}, spec: {replicas: state[component], template: {metadata: {annotations: {'openclaw.dev/installation-checksum': state.checksum}}}}});
    }
  } else if (args.includes('get') && args.includes('pods')) {
    const initialization = args.some((a) => a.includes('component=initialization'));
    const revision = args.some((a) => a.includes('openclaw.dev/revision=rev_new'));
    out({items: initialization && state.initActive ? [{status: {phase: 'Running'}}] : revision ? [{metadata: {namespace: 'tenant', name: 'gateway'}, spec: {containers: [{name: 'gateway', image: '${runtime}'}]}, status: {phase: 'Running', conditions: [{type: 'Ready', status: 'True'}]}}] : []});
  } else if (args.includes('get')) out({items: []});
  else if (args.includes('exec')) out('{}');
} else if (tool === 'occ') {
  if (args.includes('deployment-inventory')) {
    out({installationId: 'ins_test', namespaces: [{id: 'ns_test', status: 'ready', agents: state.agent ? [{id: 'agt_test', status: 'active', desiredRuntimeState: 'running', executionMode: 'embedded', activeRevisionId: 'rev_old', deploymentInProgress: false}] : []}]});
  } else if (args.includes('deploy')) {
    state.dispatches += 1; state.activeRevision = 'rev_new'; save(); log('agent-deploy');
    if (take('lost-agent-response')) process.exit(9);
    out({id: 'rev_new'});
  } else if (args.includes('agent') && args.includes('get')) out({id: 'agt_test', activeRevisionId: state.activeRevision ?? 'rev_old'});
  else if (args.includes('deployment-status')) out({status: 'succeeded'});
  else out({id: 'ins_test'});
}
`;

async function fixture(t, { agent = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "occ-upgrade-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  for (const name of ["helm", "kubectl", "occ"]) {
    const path = join(bin, name);
    await writeFile(path, executable);
    await chmod(path, 0o755);
  }
  const values = JSON.stringify({
    images: { controller },
    installation: { secretName: "occ-installation-startup", key: "installation.yaml" },
  });
  const installation = JSON.stringify({
    drivers: { compute: { configuration: { images: { agent: oldRuntime, gateway: oldRuntime } } } },
  });
  const state = {
    version: 1,
    helmStatus: "deployed",
    api: 1,
    worker: 1,
    controller,
    agent,
    dispatches: 0,
    initActive: false,
    secret: {
      metadata: {
        name: "occ-installation-startup",
        uid: "secret-uid",
        resourceVersion: "1",
        annotations: { "openclaw.dev/installation-id": "ins_test", retained: "yes" },
      },
      data: {
        "installation.yaml": Buffer.from(installation).toString("base64"),
        retained: "cHJlc2VydmVk",
      },
    },
  };
  await writeFile(join(directory, "state.json"), JSON.stringify(state));
  await writeFile(join(directory, "live-values"), values);
  await writeFile(join(directory, "events"), "");
  for (const [name, content] of Object.entries({
    kubeconfig: "cluster-config",
    key: "key",
    values,
    installation,
  })) {
    await writeFile(join(directory, name), content, { mode: 0o600 });
  }
  const evidence = join(directory, "evidence");
  const args = [
    "--kubeconfig",
    join(directory, "kubeconfig"),
    "--context",
    "selected",
    "--namespace",
    "system",
    "--release",
    "oce",
    "--values",
    join(directory, "values"),
    "--installation",
    join(directory, "installation"),
    "--runtime-image",
    runtime,
    "--source-revision",
    "d".repeat(40),
    "--evidence-dir",
    evidence,
    "--occ",
    join(bin, "occ"),
  ];
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    UPGRADE_FIXTURE: directory,
    OCC_URL: "https://occ.example.invalid",
    OCC_SERVICE_KEY_FILE: join(directory, "key"),
  };
  return {
    directory,
    evidence,
    run: (...extra) => execute(script, [...args, ...extra], { cwd: repository, env }),
    state: async () => JSON.parse(await readFile(join(directory, "state.json"), "utf8")),
    events: async () =>
      (await readFile(join(directory, "events"), "utf8")).trim().split("\n").filter(Boolean),
    failNext: (name) => writeFile(join(directory, name), ""),
  };
}

test("resume reads an accepted Secret write before Helm and preserves its other data", async (t) => {
  const f = await fixture(t);
  await f.failNext("lost-secret-response");
  await assert.rejects(f.run());
  const interrupted = await f.state();
  assert.match(
    Buffer.from(interrupted.secret.data["installation.yaml"], "base64").toString(),
    /bbbbbbbbbbbbbbbb/,
  );
  await f.run("--resume");
  assert.deepEqual(await f.events(), [
    "scale-api",
    "scale-worker",
    "secret-replaced",
    "scale-api",
    "scale-worker",
    "migration",
  ]);
  const state = await f.state();
  assert.equal(state.secret.metadata.annotations.retained, "yes");
  assert.equal(state.secret.data.retained, "cHJlc2VydmVk");
  assert.equal(state.api, 1);
  assert.equal(state.worker, 1);
});

test("resume recognizes a committed Helm release without rerunning its migration", async (t) => {
  const f = await fixture(t);
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run());
  await f.run("--resume");
  assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
});

test("an interrupted quiescence never starts migration while the worker still runs", async (t) => {
  const f = await fixture(t);
  await f.failNext("fail-scale-worker");
  await assert.rejects(f.run());
  assert.equal((await f.state()).api, 0);
  assert.equal((await f.state()).worker, 1);
  assert.deepEqual(await f.events(), ["scale-api"]);
  await f.run("--resume");
  assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
});

test("failed Helm migration keeps old writers stopped and requires checked history and a terminal Job", async (t) => {
  const f = await fixture(t);
  await f.failNext("fail-migration");
  await assert.rejects(f.run());
  assert.equal((await f.state()).api, 0);
  assert.equal((await f.state()).worker, 0);
  await assert.rejects(f.run("--resume"), /migration --check/);
  const state = await f.state();
  state.initActive = true;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await assert.rejects(
    f.run("--resume", "--migration-history-checked"),
    /initialization Pod is still active/,
  );
  state.initActive = false;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await f.run("--resume", "--migration-history-checked");
  assert.equal((await f.events()).filter((event) => event === "migration").length, 2);
});

test("resume reads back and stops on an unknown Agent deployment instead of retrying", async (t) => {
  const f = await fixture(t, { agent: true });
  await f.failNext("lost-agent-response");
  await assert.rejects(f.run(), /deployment outcome is unknown/);
  await assert.rejects(f.run("--resume"), /unknown deployment outcome/);
  assert.equal((await f.state()).dispatches, 1);
  const readback = JSON.parse(
    await readFile(join(f.evidence, "dispatch/ns_test--agt_test.readback.json"), "utf8"),
  );
  assert.equal(readback.id, "agt_test");
  assert.equal(readback.activeRevisionId, "rev_new");
  // Simulate the operator confirming this revision in durable history and
  // recording the accepted request before resuming the readiness checks.
  await writeFile(
    join(f.evidence, "dispatch/ns_test--agt_test.json"),
    JSON.stringify({ id: "rev_new" }),
  );
  await f.run("--resume");
  assert.equal((await f.state()).dispatches, 1);
});

test("resume refuses a pending Helm release or unrelated Secret changes", async (t) => {
  const f = await fixture(t);
  await f.failNext("lost-secret-response");
  await assert.rejects(f.run());
  const state = await f.state();
  state.helmStatus = "pending-upgrade";
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await assert.rejects(f.run("--resume"), /Helm reports pending-upgrade/);
  state.helmStatus = "deployed";
  state.secret.data.retained = "Y2hhbmdlZA==";
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await assert.rejects(f.run("--resume"), /Installation Secret identity or unrelated data changed/);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 0);
});

test("resume rejects malformed protected inputs before another mutation", async (t) => {
  const f = await fixture(t);
  await f.failNext("lost-secret-response");
  await assert.rejects(f.run());
  await writeFile(join(f.directory, "values"), "");
  await assert.rejects(f.run("--resume"), /protected Helm values changed/);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 0);
});
