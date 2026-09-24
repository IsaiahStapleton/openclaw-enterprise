import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("production image upgrade accepts GNU stat fallback and a bootstrapped controller", async (t) => {
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
  await writeFile(helm, '#!/usr/bin/env bash\n[[ "$1" != "template" ]] || exit 47\nexit 0\n');
  await chmod(helm, 0o755);

  const jq = join(bin, "jq");
  await writeFile(
    jq,
    `#!/usr/bin/env bash
case "$*" in
  *'.data['*) printf 'cHJvdGVjdGVkCg==\\n' ;;
  *'.installationId == '*) exit 0 ;;
  *'.deploymentInProgress'*|*'.activeRevisionId == null'*|*'.status != "ready"'*) exit 1 ;;
  *'namespaceId: $namespace.id'*) printf '%s\\n' '{"namespaceId":"ns_test","agentId":"agt_test","baselineRevisionId":"rev_test"}' ;;
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
  await writeFile(python, "#!/usr/bin/env bash\nexit 0\n");
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
  for (const name of ["kubeconfig", "values", "installation", "service-key"]) {
    const path = join(directory, name);
    await writeFile(path, "protected\n", { mode: 0o600 });
    protectedFiles[name] = path;
  }

  // GNU stat can emit filesystem details before rejecting the BSD format flag.
  // That output must not corrupt the fallback mode or reject an owner-only file.
  await assert.rejects(
    execute(
      upgradeScript,
      [
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
        join(directory, "evidence"),
        "--occ",
        occ,
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          OCC_SERVICE_KEY_FILE: protectedFiles["service-key"],
          OCC_URL: "https://occ.example.invalid",
          PATH: `${bin}:/bin:/usr/bin`,
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 47);
      assert.doesNotMatch(error.stderr, /must not grant group or other permissions/);
      assert.doesNotMatch(error.stderr, /controller image already selects/);
      return true;
    },
  );
});
