import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ghVersion = "2.100.0";
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;

export async function prepareRepositoryCredentials({
  imagePrefix,
  receiptPath,
  execFile,
  registerImage,
  markImageReady,
}) {
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  await execFile(docker, ["version", "--format", "{{.Server.Version}}"]);
  await execFile("pnpm", ["--filter", "@openclaw-enterprise/repository-credentials", "build"], {
    timeoutMs: 300_000,
  });
  const context = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "credential-source-tools-"),
  );
  const tag = `${imagePrefix}/source-tools:local`;
  const resource = await registerImage(tag);
  try {
    await writeFile(
      join(context, "Dockerfile"),
      'FROM docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584 AS client-tools\nARG TARGETARCH\nRUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/*\nRUN --mount=type=secret,id=build-ca,required=false \\\n    set -eu; \\\n    if [ -f /run/secrets/build-ca ]; then export CURL_CA_BUNDLE=/run/secrets/build-ca; fi; \\\n    architecture="${TARGETARCH:-amd64}"; \\\n    case "$architecture" in amd64|arm64) ;; *) exit 1 ;; esac; \\\n    cd /tmp; \\\n    curl --fail --location --silent --show-error -O "https://github.com/cli/cli/releases/download/v2.100.0/gh_2.100.0_linux_${architecture}.tar.gz"; \\\n    curl --fail --location --silent --show-error -O "https://github.com/cli/cli/releases/download/v2.100.0/gh_2.100.0_checksums.txt"; \\\n    grep " gh_2.100.0_linux_${architecture}.tar.gz$" gh_2.100.0_checksums.txt | sha256sum --check --strict; \\\n    tar -xzf "gh_2.100.0_linux_${architecture}.tar.gz"; \\\n    install -m 0755 "gh_2.100.0_linux_${architecture}/bin/gh" /usr/local/bin/gh; \\\n    rm -rf /tmp/gh_2.100.0*; \\\n    gh --version | grep \'^gh version 2.100.0 \'\nWORKDIR /workspace\n',
      { mode: 0o600 },
    );
    await execFile(
      docker,
      [
        "build",
        "--builder",
        "default",
        "--load",
        "--pull=false",
        "-f",
        join(context, "Dockerfile"),
        "-t",
        tag,
        context,
      ],
      { timeoutMs: 900_000 },
    );
    const inspected = await execFile(docker, ["image", "inspect", "--format", "{{.Id}}", tag]);
    const id = inspected.stdout.trim();
    assert.match(id, imageIdPattern, "Invalid source toolchain image ID");
    await markImageReady(resource, id);
    const source = await execFile("git", ["rev-parse", "HEAD"]);
    await writeFile(
      receiptPath,
      `${JSON.stringify(
        {
          version: 1,
          lane: "repository-credentials-container",
          kind: "source-fixture",
          sourceCommit: source.stdout.trim(),
          ghVersion,
          images: { source: { tag, id } },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    return { REPOSITORY_CREDENTIALS_NODE_IMAGE: id };
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

export async function prepareRepositoryCredentialsFile({ clientImage, execFile }) {
  assert.match(clientImage ?? "", imageIdPattern, "A prepared source toolchain image is required");
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "openclaw-ci-gh-"));
  const binary = join(directory, "gh");
  const container = `openclaw-ci-gh-${randomUUID()}`;
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    // Extract the checksum-verified source toolchain binary. Do not trust the runner's
    // gh installation or expose its home directory to the extraction container.
    try {
      await execFile(
        docker,
        [
          "run",
          "--rm",
          "--name",
          container,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          `${process.getuid()}:${process.getgid()}`,
          "--mount",
          `type=bind,src=${directory},dst=/output`,
          "--entrypoint",
          "node",
          clientImage,
          "-e",
          'require("node:fs").copyFileSync("/usr/local/bin/gh", "/output/gh")',
        ],
        { timeoutMs: 60_000 },
      );
    } finally {
      await execFile(docker, ["rm", "-f", container], { timeoutMs: 30_000 }).catch((error) => {
        if (!/No such container/i.test(error.message)) throw error;
      });
    }
    await chmod(binary, 0o755);
    const version = await execFile(binary, ["--version"], { timeoutMs: 10_000 });
    assert.match(version.stdout, /^gh version 2\.100\.0\b/, `Expected gh ${ghVersion}`);
    return { env: { REPOSITORY_CREDENTIALS_GH_BINARY: binary }, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
