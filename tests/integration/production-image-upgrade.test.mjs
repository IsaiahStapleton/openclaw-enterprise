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
const upgradeScript = fileURLToPath(
  new URL("../../scripts/upgrade-production-images", import.meta.url),
);

test("production image upgrade guards protected inputs, supports an empty fleet, and waits for ready Pods", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-production-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controllerImage = `registry.example.invalid/controller@sha256:${"a".repeat(64)}`;
  const runtimeImage = `registry.example.invalid/runtime@sha256:${"b".repeat(64)}`;

  const bin = join(directory, "bin");
  await mkdir(bin);
  const stat = join(bin, "stat");
  await writeFile(
    stat,
    `#!/usr/bin/env bash
if [[ "$1" == "-f" ]]; then
  printf 'GNU filesystem report\\n'
  exit 1
fi
printf '600\\n'
`,
  );
  await chmod(stat, 0o755);

  const helm = join(bin, "helm");
  await writeFile(
    helm,
    `#!/usr/bin/env bash
if [[ "$*" == *'get values'* ]]; then
  cat "$LIVE_VALUES_FILE"
elif [[ "$1" == "template" ]]; then
  exit 47
fi
`,
  );
  await chmod(helm, 0o755);

  const jq = join(bin, "jq");
  await writeFile(
    jq,
    `#!/usr/bin/env bash
case "$*" in
  *'.data['*) printf 'cHJvdGVjdGVkCg==\\n' ;;
  *'openclaw.dev/installation-id'*) printf '%s\\n' "$CLUSTER_INSTALLATION_ID" ;;
  '-S '*) cat ;;
  *'.installationId == '*) exit 0 ;;
  *'.deploymentInProgress'*|*'.activeRevisionId == null'*|*'.status != "ready"'*) exit 1 ;;
  *'namespaceId: $namespace.id'*) exit 0 ;;
  *'.id'*) printf 'ins_upgrade_test\\n' ;;
esac
`,
  );
  await chmod(jq, 0o755);

  const yq = join(bin, "yq");
  await writeFile(
    yq,
    `#!/usr/bin/env bash
case "$*" in
  '-o=json '*)
    for path in "$@"; do :; done
    cat "$path"
    ;;
  *'.installation.secretName'*) printf 'occ-installation-startup\\n' ;;
  *'.installation.key'*) printf 'installation.yaml\\n' ;;
  *'.images.controller'*) printf '%s\\n' '${controllerImage}' ;;
  *'.images.gateway'*) printf '%s\\n' 'registry.example.invalid/runtime@sha256:${"d".repeat(64)}' ;;
  *'.images.agent'*) printf '%s\\n' 'registry.example.invalid/runtime@sha256:${"d".repeat(64)}' ;;
esac
`,
  );
  await chmod(yq, 0o755);

  const python = join(bin, "python3");
  await writeFile(
    python,
    `#!/usr/bin/env bash
if (($# == 3)); then
  printf '%s\\n' '${"e".repeat(64)}'
else
  cat >/dev/null
  cat "$LIVE_INSTALLATION_FILE"
fi
`,
  );
  await chmod(python, 0o755);
  const kubectl = join(bin, "kubectl");
  await writeFile(kubectl, "#!/usr/bin/env bash\nexit 0\n");
  await chmod(kubectl, 0o755);

  const occ = join(bin, "occ");
  await writeFile(
    occ,
    `#!/usr/bin/env bash
if [[ "$*" == *'deployment-inventory'* ]]; then
  printf '%s\\n' '{"installationId":"ins_upgrade_test","namespaces":[{"id":"ns_test","status":"ready","agents":[{"id":"agt_test","status":"active","desiredRuntimeState":"running","activeRevisionId":"rev_test","deploymentInProgress":false}]}]}'
else
  printf '%s\\n' '{"id":"ins_upgrade_test"}'
fi
`,
  );
  await chmod(occ, 0o755);

  const protectedFiles = {};
  for (const name of ["kubeconfig", "service-key"]) {
    const path = join(directory, name);
    await writeFile(path, "protected\n", { mode: 0o600 });
    protectedFiles[name] = path;
  }

  const baselineRuntimeImage = `registry.example.invalid/runtime@sha256:${"d".repeat(64)}`;
  const liveValues = join(directory, "live-values.json");
  const liveInstallation = join(directory, "live-installation.json");
  const valuesDocument = JSON.stringify({
    database: { host: "current.example.invalid" },
    images: { controller: controllerImage },
    installation: { key: "installation.yaml", secretName: "occ-installation-startup" },
  });
  const installationDocument = JSON.stringify({
    drivers: {
      compute: {
        configuration: {
          images: { agent: baselineRuntimeImage, gateway: baselineRuntimeImage },
        },
      },
    },
  });
  await writeFile(liveValues, valuesDocument, { mode: 0o600 });
  await writeFile(liveInstallation, installationDocument, { mode: 0o600 });
  protectedFiles.values = join(directory, "values");
  protectedFiles.installation = join(directory, "installation");
  await writeFile(protectedFiles.installation, installationDocument, { mode: 0o600 });

  const upgradeArguments = (evidenceDirectory) => [
    "--kubeconfig",
    protectedFiles.kubeconfig,
    "--context",
    "k3d-upgrade-test",
    "--namespace",
    "openclaw-system",
    "--release",
    "oce",
    "--values",
    protectedFiles.values,
    "--installation",
    protectedFiles.installation,
    "--controller-image",
    controllerImage,
    "--runtime-image",
    runtimeImage,
    "--source-revision",
    "c".repeat(40),
    "--evidence-dir",
    evidenceDirectory,
    "--occ",
    occ,
  ];
  const environment = {
    ...process.env,
    CLUSTER_INSTALLATION_ID: "ins_upgrade_test",
    LIVE_INSTALLATION_FILE: liveInstallation,
    LIVE_VALUES_FILE: liveValues,
    OCC_SERVICE_KEY_FILE: protectedFiles["service-key"],
    OCC_URL: "https://occ.example.invalid",
    PATH: `${bin}:/bin:/usr/bin`,
  };

  // Refuse stale recovery input before rendering or mutating the release.
  await writeFile(
    protectedFiles.values,
    JSON.stringify({ ...JSON.parse(valuesDocument), database: { host: "stale.example.invalid" } }),
    { mode: 0o600 },
  );
  await assert.rejects(
    execute(upgradeScript, upgradeArguments(join(directory, "stale-evidence")), {
      cwd: repository,
      env: environment,
    }),
    /protected Helm values differ from the live release outside the controller image/,
  );
  await writeFile(protectedFiles.values, valuesDocument, { mode: 0o600 });

  // The authenticated OCC endpoint and selected kube context must identify the
  // same Installation before either control plane can be changed.
  await assert.rejects(
    execute(upgradeScript, upgradeArguments(join(directory, "wrong-cluster-evidence")), {
      cwd: repository,
      env: { ...environment, CLUSTER_INSTALLATION_ID: "ins_other_cluster" },
    }),
    /OCC Installation ins_upgrade_test does not match Kubernetes Installation ins_other_cluster/,
  );

  // GNU stat can emit filesystem details before rejecting the BSD format flag.
  // That output must not corrupt the fallback mode or reject an owner-only file.
  await assert.rejects(
    execute(upgradeScript, upgradeArguments(join(directory, "evidence")), {
      cwd: repository,
      env: environment,
    }),
    (error) => {
      assert.equal(error.code, 47);
      assert.doesNotMatch(error.stderr, /must not grant group or other permissions/);
      assert.doesNotMatch(error.stderr, /controller image already selects/);
      assert.doesNotMatch(error.stderr, /contains no running Agents/);
      return true;
    },
  );

  const readinessCounter = join(directory, "readiness-counter");
  await writeFile(
    helm,
    `#!/usr/bin/env bash
if [[ "$*" == *'get values'* ]]; then
  cat "$LIVE_VALUES_FILE"
fi
`,
  );
  await writeFile(
    jq,
    `#!/usr/bin/env bash
if [[ "$*" == '-S '* ]]; then
  cat
  exit 0
fi
case "$*" in
  *'.data['*) printf 'cHJvdGVjdGVkCg==\\n' ;;
  *'openclaw.dev/installation-id'*) printf '%s\\n' "$CLUSTER_INSTALLATION_ID" ;;
  *'.installationId == '*) exit 0 ;;
  *'.deploymentInProgress'*|*'.activeRevisionId == null'*|*'.status != "ready"'*) exit 1 ;;
  *'namespaceId: $namespace.id'*) printf '%s\\n' '{"namespaceId":"ns_test","agentId":"agt_test","baselineRevisionId":"rev_test"}' ;;
  *'{namespaceId: $namespaceId'*) printf '%s\\n' '{"namespaceId":"ns_test","agentId":"agt_test","deploymentId":"rev_candidate"}' ;;
  *'spec.containers'*'length'*) printf '2\\n' ;;
  *'all(.items[].spec.containers'*) exit 0 ;;
  *'.status.phase == "Running"'*)
    attempts=0
    [[ ! -f "$READINESS_COUNTER" ]] || attempts=$(cat "$READINESS_COUNTER")
    attempts=$((attempts + 1))
    printf '%s\\n' "$attempts" >"$READINESS_COUNTER"
    ((attempts >= 2))
    ;;
  *'.activeRevisionId'*) cat >/dev/null; printf 'rev_candidate\\n' ;;
  *'.deploymentId'*) printf 'rev_candidate\\n' ;;
  *'.namespaceId'*) cat >/dev/null; printf 'ns_test\\n' ;;
  *'.agentId'*) cat >/dev/null; printf 'agt_test\\n' ;;
  *'.status'*) printf 'succeeded\\n' ;;
  *'.id'*'installation.json'*) printf 'ins_upgrade_test\\n' ;;
  *'.id'*) printf 'rev_candidate\\n' ;;
esac
`,
  );
  await writeFile(
    kubectl,
    `#!/usr/bin/env bash
case "$*" in
  *'jsonpath='*) printf '%s\\n' '${controllerImage}' ;;
  *'get pods'*) printf '%s\\n' '{"items":[]}' ;;
esac
`,
  );
  await writeFile(
    occ,
    `#!/usr/bin/env bash
case "$*" in
  *'deployment-inventory'*) printf '%s\\n' '{"installationId":"ins_upgrade_test","namespaces":[{"id":"ns_test","status":"ready","agents":[{"id":"agt_test","status":"active","desiredRuntimeState":"running","activeRevisionId":"rev_test","deploymentInProgress":false}]}]}' ;;
  *'agent deploy'*) printf '%s\\n' '{"id":"rev_candidate"}' ;;
  *'deployment-status'*) printf '%s\\n' '{"status":"succeeded"}' ;;
  *'agent get'*) printf '%s\\n' '{"activeRevisionId":"rev_candidate"}' ;;
  *) printf '%s\\n' '{"id":"ins_upgrade_test"}' ;;
esac
`,
  );

  // Durable deployment completion can precede Kubernetes readiness. The
  // command must observe a ready revision before reporting fleet success.
  const completed = await execute(
    upgradeScript,
    upgradeArguments(join(directory, "ready-evidence")),
    {
      cwd: repository,
      env: { ...environment, READINESS_COUNTER: readinessCounter },
    },
  );
  assert.match(completed.stdout, /1 running Agents selected new revisions/);
  assert.equal((await readFile(readinessCounter, "utf8")).trim(), "2");
  assert.equal(
    (await readFile(join(directory, "ready-evidence", "installation-checksum"), "utf8")).trim(),
    "e".repeat(64),
  );
});
