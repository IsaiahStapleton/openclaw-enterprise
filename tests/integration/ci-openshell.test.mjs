import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  gvisorVersion,
  k3sImage,
  kubectlVersion,
  prepareOpenShell,
  prepareOpenShellNodeImage,
  selectCliAsset,
  selectGvisorAsset,
  selectKubectlAsset,
} from "../../scripts/ci/openshell.mjs";
import { openShellChartImageValues } from "../helpers/openshell-kubernetes-real.mjs";

async function fixture(t, prefix = "ci-openshell-test") {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function ownedCluster(root, name = "openclaw-k8s-openshell-test") {
  return {
    name,
    directory: root,
    kubeconfig: join(root, "kubeconfig"),
    context: `k3d-${name}`,
  };
}

test("selectCliAsset rejects unsupported OpenShell host artifacts", () => {
  assert.equal(selectCliAsset("linux", "x64").sha256.length, 64);
  assert.throws(() => selectCliAsset("darwin", "x64"), /no pinned CLI asset/);
});

test("node-image asset selection keeps Docker daemon and kubectl host platforms separate", () => {
  assert.equal(selectGvisorAsset("linux", "aarch64").name, "gvisor-aarch64.tar.bz2");
  assert.equal(selectKubectlAsset("darwin", "arm64").name, "kubectl-darwin-arm64");
  assert.throws(() => selectGvisorAsset("windows", "amd64"), /requires a Linux Docker daemon/);
  assert.throws(() => selectKubectlAsset("darwin", "x64"), /no pinned kubectl/);
});

test("OpenShell Helm chart image values preserve immutable digests in rendered tags", () => {
  const digest = "@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  assert.deepEqual(
    openShellChartImageValues("image", `localhost/example/gateway:local${digest}`, "0.0.113"),
    [
      "--set-string=image.repository=localhost/example/gateway",
      `--set-string=image.tag=local${digest}`,
    ],
  );
  assert.deepEqual(
    openShellChartImageValues(
      "supervisor.image",
      `localhost/example/supervisor${digest}`,
      "0.0.113",
    ),
    [
      "--set-string=supervisor.image.repository=localhost/example/supervisor",
      `--set-string=supervisor.image.tag=0.0.113${digest}`,
    ],
  );
  assert.throws(
    () => openShellChartImageValues("image", "localhost/example/gateway:local", "0.0.113"),
    /immutable OpenShell image digest/,
  );
});

test("prepareOpenShellNodeImage builds a pinned gVisor k3d node image", async (t) => {
  const root = await fixture(t, "openshell-node-image-test");
  const calls = [];
  const imageTag = "localhost/openclaw-ci-image-openshell/node:local";

  async function execFile(command, args) {
    calls.push([command, args]);
    if (command === "docker" && args[0] === "info") {
      return { stdout: "linux/aarch64\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }

  const result = await prepareOpenShellNodeImage({
    directory: root,
    imageTag,
    execFile,
    hostPlatform: "darwin",
    hostArch: "arm64",
    downloadArtifact: async (url, destination, sha256) => {
      assert.match(url, /(?:kubectl|gvisor-aarch64\.tar\.bz2)$/);
      assert.equal(sha256.length, 64);
      await writeFile(destination, "fake archive", { mode: 0o600 });
    },
  });

  assert.deepEqual(result, {
    image: imageTag,
    runtimeClass: "openshell-sandbox",
    runtimeHandler: "runsc",
    kubectl: join(root, "bin", `kubectl-darwin-arm64-${kubectlVersion}`),
    k3sImage,
    gvisorVersion,
    kubectlVersion,
  });
  assert.deepEqual(
    calls.map(([command]) =>
      command.endsWith("kubectl-darwin-arm64-v1.36.4") ? "kubectl" : command,
    ),
    ["docker", "kubectl", "docker", "docker", "docker"],
  );
  assert.deepEqual(calls[0][1], ["info", "--format", "{{.OSType}}/{{.Architecture}}"]);
  assert.deepEqual(calls[2][1], [
    "build",
    "--pull=true",
    "-t",
    imageTag,
    join(root, "openshell-node-image"),
  ]);
  assert.deepEqual(calls[3][1], ["image", "inspect", imageTag]);
  assert.equal(calls[4][1][0], "run");
  assert.ok(calls[4][1].includes(imageTag));

  const dockerfile = await readFile(join(root, "openshell-node-image", "Dockerfile"), "utf8");
  assert.ok(dockerfile.includes(`FROM ${k3sImage}`));
  assert.match(dockerfile, /COPY gvisor-aarch64\.tar\.bz2 \/tmp\/gvisor\.tar\.bz2/);
  const config = await readFile(join(root, "openshell-node-image", "config-v3.toml.tmpl"), "utf8");
  assert.match(config, /{{ template "base" \. }}/);
  assert.match(config, /runtimes\.'runsc'\]/);
  assert.match(config, /runtime_type = "io\.containerd\.runsc\.v1"/);
});

test("prepareOpenShellNodeImage fails before downloads or build on unsupported Docker daemons", async (t) => {
  const root = await fixture(t, "openshell-node-image-test");
  const cases = [
    { stdout: "windows/amd64\n", error: /requires a Linux Docker daemon/ },
    { stdout: "linux/s390x\n", error: /no pinned gVisor asset/ },
  ];

  for (const row of cases) {
    const calls = [];
    await assert.rejects(
      () =>
        prepareOpenShellNodeImage({
          directory: root,
          imageTag: "localhost/openclaw-ci-image-openshell/node:local",
          execFile: async (command, args) => {
            calls.push([command, args]);
            if (command === "docker" && args[0] === "info")
              return { stdout: row.stdout, stderr: "" };
            return { stdout: "", stderr: "" };
          },
          hostPlatform: "darwin",
          hostArch: "arm64",
          downloadArtifact: async () => {
            throw new Error("download should not run");
          },
        }),
      row.error,
    );
    assert.deepEqual(calls, [["docker", ["info", "--format", "{{.OSType}}/{{.Architecture}}"]]]);
  }
});

test("prepareOpenShellNodeImage rejects nonlocal image tags before downloads or Docker", async (t) => {
  const root = await fixture(t, "openshell-node-image-test");
  const calls = [];

  await assert.rejects(
    () =>
      prepareOpenShellNodeImage({
        directory: root,
        imageTag: "ghcr.io/openclaw/node:latest",
        execFile: async (command, args) => {
          calls.push([command, args]);
          return { stdout: "", stderr: "" };
        },
        hostPlatform: "linux",
        hostArch: "x64",
        downloadArtifact: async () => {
          throw new Error("download should not run");
        },
      }),
    /run-owned local Docker tag/,
  );

  assert.deepEqual(calls, []);
});

test("prepareOpenShell rejects foreign clusters before kubectl, Docker, or image registration", async (t) => {
  const root = await fixture(t, "foreign-openshell-test");
  const calls = [];
  let registerCalls = 0;

  await assert.rejects(
    () =>
      prepareOpenShell({
        cluster: {
          name: "foreign",
          directory: root,
          kubeconfig: join(root, "kubeconfig"),
          context: "foreign",
        },
        execFile: async (command, args) => {
          calls.push([command, args]);
          return { stdout: "", stderr: "" };
        },
        registerImage: async () => {
          registerCalls += 1;
        },
        env: {},
      }),
    /unowned cluster|cluster\.name must be a Kubernetes DNS label/,
  );

  assert.deepEqual(calls, []);
  assert.equal(registerCalls, 0);
});

test("prepareOpenShell rejects mutable OpenShell image overrides before kubectl or Docker", async (t) => {
  const clusterName = "openclaw-k8s-openshell-test";
  const root = await fixture(t, clusterName);
  const calls = [];
  let registerCalls = 0;

  await assert.rejects(
    () =>
      prepareOpenShell({
        cluster: ownedCluster(root, clusterName),
        execFile: async (command, args) => {
          calls.push([command, args]);
          return { stdout: "", stderr: "" };
        },
        registerImage: async () => {
          registerCalls += 1;
        },
        env: {
          OCC_TEST_OPENSHELL_GATEWAY_IMAGE: "ghcr.io/nvidia/openshell/gateway:latest",
        },
      }),
    /OCC_TEST_OPENSHELL_GATEWAY_IMAGE must be an immutable image@sha256 reference/,
  );

  assert.deepEqual(calls, []);
  assert.equal(registerCalls, 0);
});

test("prepareOpenShell fails before downloads when the gVisor smoke Pod fails", async (t) => {
  const clusterName = "openclaw-k8s-openshell-test";
  const root = await fixture(t, clusterName);
  const calls = [];
  let registerCalls = 0;
  const cluster = ownedCluster(root, clusterName);
  const agentImage =
    "localhost/openclaw-k8s-openshell-test/agent@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  async function execFile(command, args) {
    calls.push([command, args]);
    if (command === "docker" && args[0] === "exec") {
      return {
        stdout: "[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'runsc']\n",
        stderr: "",
      };
    }
    if (
      command === "kubectl" &&
      args.includes("--dry-run=server") &&
      args.some((arg) => arg.endsWith("openshell-psa-restricted-rejection.yaml"))
    ) {
      throw new Error(
        'Error from server (Forbidden): pods "openshell-psa-violation" is forbidden: violates PodSecurity "restricted:latest": privileged',
      );
    }
    if (command === "kubectl" && args.includes("--for=jsonpath={.status.phase}=Succeeded")) {
      throw new Error("pod reached Failed phase");
    }
    if (command === "kubectl" && args.includes("describe")) {
      return { stdout: "FailedCreatePodSandBox runsc permission denied", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }

  await assert.rejects(
    () =>
      prepareOpenShell({
        cluster,
        execFile,
        registerImage: async () => {
          registerCalls += 1;
        },
        env: {
          OCC_KUBECTL_BIN: "kubectl",
          OCC_HELM_BIN: "helm",
          OCC_DOCKER_BIN: "docker",
          OCC_TEST_KUBERNETES_AGENT_IMAGE: agentImage,
        },
      }),
    /FailedCreatePodSandBox runsc permission denied/,
  );

  assert.equal(registerCalls, 0);
  assert.equal(
    calls.some(([command]) => command === "tar"),
    false,
  );
  assert.equal(
    calls.some(([command, args]) => command === "helm" && args[0] === "pull"),
    false,
  );
  assert.ok(
    calls.some(
      ([command, args]) =>
        command === "kubectl" && args.includes("delete") && args.includes("openshell-gvisor-smoke"),
    ),
  );

  const manifest = await readFile(join(root, "openshell", "openshell-gvisor-smoke.yaml"), "utf8");
  assert.match(manifest, /runtimeClassName: openshell-sandbox/);
  assert.match(manifest, new RegExp(`image: "${agentImage}"`));
  assert.match(manifest, /imagePullPolicy: Never/);
});

test("prepareOpenShell fails before downloads when the k3d node lacks gVisor", async (t) => {
  const clusterName = "openclaw-k8s-openshell-test";
  const root = await fixture(t, clusterName);
  const calls = [];
  let registerCalls = 0;
  const cluster = ownedCluster(root, clusterName);

  async function execFile(command, args) {
    calls.push([command, args]);
    if (command === "docker" && args[0] === "exec") return { stdout: "", stderr: "" };
    return { stdout: "", stderr: "" };
  }

  await assert.rejects(
    () =>
      prepareOpenShell({
        cluster,
        execFile,
        registerImage: async () => {
          registerCalls += 1;
        },
        env: {
          OCC_KUBECTL_BIN: "kubectl",
          OCC_HELM_BIN: "helm",
          OCC_DOCKER_BIN: "docker",
        },
      }),
    /RuntimeClass alone is not proof of sandbox isolation/,
  );

  assert.equal(registerCalls, 0);
  assert.equal(
    calls.some(([command]) => command === "tar"),
    false,
  );
  assert.equal(
    calls.some(([command, args]) => command === "helm" && args[0] === "pull"),
    false,
  );
  assert.equal(
    calls.some(([command, args]) => command === "docker" && args[0] !== "exec"),
    false,
  );
  assert.deepEqual(
    calls.filter(([command]) => command === "docker").map(([, args]) => args[1]),
    [`k3d-${cluster.name}-server-0`],
  );
  for (const [, args] of calls.filter(([command]) => command === "kubectl")) {
    assert.deepEqual(args.slice(0, 4), [
      "--kubeconfig",
      cluster.kubeconfig,
      "--context",
      cluster.context,
    ]);
  }
});
