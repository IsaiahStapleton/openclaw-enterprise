import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const prefix = "openclaw-ci-openshell-launcher";

function preparedState(root = repositoryRoot, owner = prefix) {
  return {
    version: 1,
    repositoryRoot: root,
    lane: "openshell",
    prefix,
    resources: [
      {
        kind: "compose-postgres",
        name: "openclaw_ci_pg_openshell",
        owner,
        status: "ready",
      },
      {
        kind: "k3d-cluster",
        name: "openclaw-k8s-openshell",
        owner,
        status: "ready",
        kubeconfig: "/private/openshell/kubeconfig",
        context: "k3d-openclaw-k8s-openshell",
      },
    ],
  };
}

async function prepareFakeEnvironment(context, { foreignState = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "oce-openshell-launcher-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const stateDirectory = join(root, "state", "openclaw-enterprise", "openshell-docker-pre7");
  const prepareLog = join(root, "prepare.log");
  const testRecord = join(root, "test-record.txt");
  await mkdir(bin);

  const command = async (name, source) => {
    const path = join(bin, name);
    await writeFile(path, source, { mode: 0o700 });
    await chmod(path, 0o700);
  };

  await command(
    "docker",
    `#!/bin/sh
case "$1 $2" in
  "info "|"compose version"|"image inspect"|"pull "*) exit 0 ;;
esac
exit 90
`,
  );
  for (const name of ["corepack", "helm", "k3d", "openssl"]) {
    await command(name, "#!/bin/sh\nexit 0\n");
  }
  await command(
    "node",
    `#!/bin/sh
if [ "$1" = -e ]; then exec '${process.execPath}' "$@"; fi
if printf '%s' "$*" | grep -q 'scripts/ci/prepare.mjs'; then
  [ -n "$OPENCLAW_CI_COREPACK_BIN" ] || exit 94
  printf '%s\n' "$*" >> '${prepareLog}'
  mkdir -p '${stateDirectory}'
  if printf '%s' "$*" | grep -q -- '--file'; then
    printf '%s\n' 'OCC_TEST_DATABASE_URL=postgres://fixture-only@127.0.0.1/openclaw_k8s_openshell' >> '${join(
      stateDirectory,
      "environment",
    )}'
  else
    printf '%s\n' '${JSON.stringify(preparedState())}' > '${join(stateDirectory, "state.json")}'
    printf '%s\n' \\
      'OCC_TEST_KUBERNETES_KUBECONFIG=/private/openshell/kubeconfig' \\
      'OCC_TEST_KUBERNETES_CONTEXT=k3d-openclaw-k8s-openshell' \\
      'OCC_TEST_OPENSHELL_K3D_REAL=1' > '${join(stateDirectory, "environment")}'
  fi
  exit 0
fi
if printf '%s' "$*" | grep -q 'scripts/ci/cleanup.mjs'; then
  rm -f '${join(stateDirectory, "state.json")}'
  exit 0
fi
printf '%s\n%s\n%s\n' "$*" "\${OCC_TEST_OPENSHELL_SECRET_PROJECTION:-}" "\${OPENAI_API_KEY:+set}" > '${testRecord}'
`,
  );

  if (foreignState) {
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      join(stateDirectory, "state.json"),
      `${JSON.stringify(preparedState(join(root, "different-checkout")))}\n`,
    );
    await writeFile(
      join(stateDirectory, "environment"),
      "OCC_TEST_KUBERNETES_KUBECONFIG=/private/openshell/kubeconfig\nOCC_TEST_KUBERNETES_CONTEXT=k3d-openclaw-k8s-openshell\n",
    );
    await writeFile(join(stateDirectory, "ready"), "");
  }

  return {
    env: {
      ...process.env,
      DOCKER_HOST: "",
      OPENAI_API_KEY: "test-only-openai-key",
      OCC_OPENSHELL_CONTAINER_ENGINE: "docker",
      XDG_STATE_HOME: join(root, "state"),
      PATH: `${bin}:/usr/bin:/bin`,
    },
    prepareLog,
    root,
    stateDirectory,
    testRecord,
  };
}

test("OpenShell launcher prepares one owned reusable verification environment", async (context) => {
  const fixture = await prepareFakeEnvironment(context);

  // The launcher must select the dedicated lane twice: once for immutable
  // infrastructure and once for the migrated test database.
  const first = await execute("scripts/openshell", ["up"], {
    cwd: repositoryRoot,
    env: fixture.env,
  });
  assert.match(first.stdout, /OpenShell verification environment is ready/);
  assert.match(first.stdout, /v0\.1\.0-pre\.7 compatibility bridge/);
  assert.equal(
    await readFile(fixture.prepareLog, "utf8"),
    [
      `scripts/ci/prepare.mjs --lane openshell --state ${join(
        fixture.stateDirectory,
        "state.json",
      )} --github-env ${join(fixture.stateDirectory, "environment")}`,
      `scripts/ci/prepare.mjs --lane openshell --file tests/integration/sandbox-driver-openshell-k3d-real.test.mjs --state ${join(
        fixture.stateDirectory,
        "state.json",
      )} --github-env ${join(fixture.stateDirectory, "environment")}`,
      "",
    ].join("\n"),
  );

  const second = await execute("scripts/openshell", ["up"], {
    cwd: repositoryRoot,
    env: fixture.env,
  });
  assert.match(second.stdout, /Reusing the prepared OpenShell cluster/);
  assert.equal((await readFile(fixture.prepareLog, "utf8")).trim().split("\n").length, 2);
});

test("OpenShell launcher runs the positive compatibility proof with the selected credential", async (context) => {
  const fixture = await prepareFakeEnvironment(context);
  await execute("scripts/openshell", ["test"], { cwd: repositoryRoot, env: fixture.env });

  const [argumentsLine, projection, credential] = (await readFile(fixture.testRecord, "utf8"))
    .trim()
    .split("\n");
  assert.match(argumentsLine, /--test/);
  assert.match(argumentsLine, /tests\/integration\/sandbox-driver-openshell-k3d-real\.test\.mjs/);
  assert.equal(projection, "1");
  assert.equal(credential, "set");
});

test("OpenShell launcher accepts a private credential file without persisting it", async (context) => {
  const fixture = await prepareFakeEnvironment(context);
  const credentialFile = join(fixture.root, "openshell.env");
  await writeFile(credentialFile, "OPENAI_API_KEY=private-file-value\n", { mode: 0o600 });
  await chmod(credentialFile, 0o600);

  await execute("scripts/openshell", ["up"], {
    cwd: repositoryRoot,
    env: {
      ...fixture.env,
      OPENAI_API_KEY: "",
      OCC_OPENSHELL_ENV_FILE: credentialFile,
    },
  });

  assert.match(
    await readFile(fixture.prepareLog, "utf8"),
    new RegExp(`--env-file=${credentialFile}`),
  );
  const persisted = `${await readFile(join(fixture.stateDirectory, "state.json"), "utf8")}${await readFile(
    join(fixture.stateDirectory, "environment"),
    "utf8",
  )}`;
  assert.doesNotMatch(persisted, /private-file-value/);
});

test("OpenShell launcher reports non-secret state and cleans only its recorded resources", async (context) => {
  const fixture = await prepareFakeEnvironment(context);
  await execute("scripts/openshell", ["up"], { cwd: repositoryRoot, env: fixture.env });

  const info = await execute("scripts/openshell", ["info"], {
    cwd: repositoryRoot,
    env: { ...fixture.env, OPENAI_API_KEY: "" },
  });
  assert.match(info.stdout, /Prepared state:\s+ready/);
  assert.match(info.stdout, /Kubeconfig:\s+\/private\/openshell\/kubeconfig/);
  assert.doesNotMatch(info.stdout, /postgres:\/\//);
  assert.doesNotMatch(info.stdout, /test-only-openai-key/);

  const down = await execute("scripts/openshell", ["down"], {
    cwd: repositoryRoot,
    env: {
      ...fixture.env,
      OPENAI_API_KEY: "",
      OCC_OPENSHELL_ENV_FILE: join(fixture.root, "removed-credential.env"),
    },
  });
  assert.match(down.stdout, /OpenShell environment removed/);
  await assert.rejects(readFile(join(fixture.stateDirectory, "state.json"), "utf8"), {
    code: "ENOENT",
  });
});

test("OpenShell launcher rejects prepared state from another checkout", async (context) => {
  const fixture = await prepareFakeEnvironment(context, { foreignState: true });
  await assert.rejects(
    execute("scripts/openshell", ["info"], {
      cwd: repositoryRoot,
      env: { ...fixture.env, OPENAI_API_KEY: "" },
    }),
    /prepared state belongs to another repository checkout/,
  );
});
