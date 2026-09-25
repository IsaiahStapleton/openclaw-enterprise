import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chartPackage, chartPushParent } from "./chart-package.mjs";
import {
  ghcrPackageName,
  github,
  githubPages,
  inspectDigest,
  skopeo,
  validatePackage,
  verifyGhcr,
  verifyCi,
  verifyEnvironment,
  verifyMainSource,
} from "./container-release.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const integerPattern = /^[1-9][0-9]*$/;
const helm = process.env.OCC_HELM_BIN ?? "helm";

export function validateImageReceipt(receipt, expected) {
  assert.ok(Array.isArray(receipt) && receipt.length === 2, "Expected two published images.");
  const sorted = [...receipt].sort((left, right) => left.image.localeCompare(right.image));
  assert.deepEqual(
    sorted.map(({ image }) => image),
    ["controller", "runtime"],
    "Expected controller and runtime images once each.",
  );
  assert.match(expected.sourceSha, shaPattern);
  for (const image of sorted) {
    assert.equal(image.sourceSha, expected.sourceSha);
    assert.equal(image.workflowSha, expected.sourceSha);
    assert.equal(String(image.runId), expected.runId);
    assert.equal(String(image.attempt), expected.attempt);
    assert.equal(String(image.ciRunId), expected.ciRunId);
    assert.equal(String(image.ciAttempt), expected.ciAttempt);
    assert.equal(image.destination, expected[`${image.image}Image`]);
    assert.equal(image.tag, `sha-${expected.sourceSha}`);
    assert.match(image.digest, digestPattern);
  }
  assert.notEqual(sorted[0].destination, sorted[1].destination);
  return sorted;
}

export async function stageReleaseChart(directory, { sourceSha, version, images }) {
  assert.match(sourceSha, shaPattern);
  assert.match(version, versionPattern);
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.version, version, "OCE release version must match root package.json.");
  const destination = join(directory, "chart");
  await cp(join(root, "deploy/helm/openclaw-enterprise"), destination, { recursive: true });
  const metadataPath = join(destination, "Chart.yaml");
  const metadata = await readFile(metadataPath, "utf8");
  assert.equal(metadata.match(/^version: (.+)$/mu)?.[1], version);
  assert.equal(metadata.match(/^appVersion: "(.+)"$/mu)?.[1], version);
  assert.ok(!/^annotations:/mu.test(metadata), "Release annotations must be staged once.");
  const controller = images.find(({ image }) => image === "controller");
  const runtime = images.find(({ image }) => image === "runtime");
  assert.ok(controller && runtime, "Both verified images are required.");
  for (const selected of [controller, runtime]) {
    assert.match(selected.digest, digestPattern);
    assert.match(selected.destination, /^ghcr\.io\/openclaw\/[a-z0-9/_-]+$/u);
  }
  const controllerReference = `${controller.destination}@${controller.digest}`;
  const runtimeReference = `${runtime.destination}@${runtime.digest}`;
  await writeFile(
    metadataPath,
    `${metadata.trimEnd()}\nannotations:\n  openclaw.dev/source-revision: "${sourceSha}"\n  openclaw.dev/controller-image: "${controllerReference}"\n  openclaw.dev/runtime-image: "${runtimeReference}"\n`,
  );
  const valuesPath = join(destination, "values.yaml");
  const values = await readFile(valuesPath, "utf8");
  assert.match(
    values,
    /^[ ]{2}controller: ""$/mu,
    "Expected the source controller image placeholder.",
  );
  await writeFile(
    valuesPath,
    values.replace(/^[ ]{2}controller: ""$/mu, `  controller: "${controllerReference}"`),
  );
  return destination;
}

function remoteTagDigest(image, tag, authfile, listed) {
  try {
    return inspectDigest(`docker://${image}:${tag}`, authfile);
  } catch (error) {
    const missing = `reading manifest ${tag} in ${image}: manifest unknown`;
    const diagnostic = error.stderr?.toString().trim().replace(/"$/, "");
    if (
      listed ||
      error.status !== 1 ||
      (diagnostic !== missing &&
        !diagnostic?.endsWith(`: ${missing}`) &&
        !diagnostic?.endsWith(`${missing}: manifest unknown`))
    ) {
      throw error;
    }
    return null;
  }
}

async function verifyReleaseContext(env, packagePath) {
  assert.equal(env.PUBLISH, "true");
  assert.equal(env.SOURCE_SHA, env.GITHUB_WORKFLOW_SHA);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    env.SOURCE_SHA,
  );
  await verifyMainSource(env);
  await verifyCi(env);
  await verifyEnvironment();
  validatePackage(await github(packagePath), chartPackage, { allowMissingRepository: true });
}

function helmCommand(args, options = {}) {
  return execFileSync(helm, args, { encoding: "utf8", ...options });
}

async function publish(directory, env) {
  const packagePath = `orgs/openclaw/packages/container/${encodeURIComponent(ghcrPackageName(chartPackage))}`;
  await verifyReleaseContext(env, packagePath);
  for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "CI_RUN_ID", "CI_ATTEMPT"]) {
    assert.match(env[key] ?? "", integerPattern);
  }
  const images = validateImageReceipt(
    JSON.parse(await readFile(join(directory, "publication.json"), "utf8")),
    {
      sourceSha: env.SOURCE_SHA,
      runId: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
      ciRunId: env.CI_RUN_ID,
      ciAttempt: env.CI_ATTEMPT,
      controllerImage: env.GHCR_CONTROLLER_IMAGE,
      runtimeImage: env.GHCR_RUNTIME_IMAGE,
    },
  );
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const version = packageJson.version;
  assert.match(version, versionPattern);
  const temporary = await mkdtemp(join(tmpdir(), "enterprise-chart-release-"));
  const authfile = join(temporary, "auth.json");
  try {
    const staged = await stageReleaseChart(temporary, {
      sourceSha: env.SOURCE_SHA,
      version,
      images,
    });
    helmCommand(["package", staged, "--destination", temporary]);
    const archive = join(temporary, `openclaw-enterprise-${version}.tgz`);
    const expectedBytes = await readFile(archive);
    const metadata = helmCommand(["show", "chart", archive]);
    assert.match(metadata, new RegExp(`^version: ${version.replaceAll(".", "\\.")}$`, "mu"));
    assert.match(metadata, new RegExp(`^appVersion: ${version.replaceAll(".", "\\.")}$`, "mu"));
    skopeo(
      [
        "login",
        "--authfile",
        authfile,
        "--username",
        env.GITHUB_ACTOR,
        "--password-stdin",
        "ghcr.io",
      ],
      { input: env.GH_TOKEN, stdio: ["pipe", "ignore", "pipe"] },
    );
    helmCommand(
      ["registry", "login", "ghcr.io", "--username", env.GITHUB_ACTOR, "--password-stdin"],
      {
        input: env.GH_TOKEN,
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    const chartVersions = await githubPages(`${packagePath}/versions`);
    const existingCharts = chartVersions.filter((entry) =>
      entry.metadata?.container?.tags?.includes(version),
    );
    assert.ok(existingCharts.length <= 1, "Chart version must resolve to one package version.");
    const existingChartDigest = remoteTagDigest(
      chartPackage,
      version,
      authfile,
      existingCharts.length > 0,
    );
    const imageTags = [];
    for (const image of images) {
      const listed = await verifyGhcr(image.destination, image.digest, version);
      const actual = remoteTagDigest(image.destination, version, authfile, listed);
      if (actual) {
        assert.equal(actual, image.digest, "Existing image release tag has different bytes.");
      }
      assert.equal(
        inspectDigest(`docker://${image.destination}:sha-${env.SOURCE_SHA}`, authfile),
        image.digest,
        "Source image tag does not match the publication receipt.",
      );
      imageTags.push({ ...image, exists: Boolean(actual) });
    }
    if (existingChartDigest) {
      const pulled = join(temporary, "existing");
      await mkdir(pulled);
      helmCommand(["pull", `oci://${chartPackage}`, "--version", version, "--destination", pulled]);
      assert.deepEqual(
        await readFile(join(pulled, `openclaw-enterprise-${version}.tgz`)),
        expectedBytes,
        "Existing chart version has different bytes.",
      );
    }
    for (const image of imageTags) {
      if (image.exists) {
        continue;
      }
      await verifyReleaseContext(env, packagePath);
      const listed = await verifyGhcr(image.destination, image.digest, version);
      assert.equal(
        remoteTagDigest(image.destination, version, authfile, listed),
        null,
        "Image release tag appeared before publication.",
      );
      skopeo(
        [
          "copy",
          "--all",
          "--preserve-digests",
          "--authfile",
          authfile,
          `docker://${image.destination}@${image.digest}`,
          `docker://${image.destination}:${version}`,
        ],
        { stdio: "inherit" },
      );
      assert.equal(
        inspectDigest(`docker://${image.destination}:${version}`, authfile),
        image.digest,
      );
    }
    for (const image of images) {
      assert.equal(
        inspectDigest(`docker://${image.destination}:${version}`, authfile),
        image.digest,
      );
    }
    if (!existingChartDigest) {
      await verifyReleaseContext(env, packagePath);
      const refreshed = await githubPages(`${packagePath}/versions`);
      assert.ok(
        refreshed.every((entry) => !entry.metadata?.container?.tags?.includes(version)),
        "Chart version appeared before publication.",
      );
      assert.equal(
        remoteTagDigest(chartPackage, version, authfile, false),
        null,
        "Chart version appeared before publication.",
      );
      helmCommand(["push", archive, chartPushParent], { stdio: "inherit" });
    }
    const pulled = join(temporary, "verified");
    await mkdir(pulled);
    helmCommand(["pull", `oci://${chartPackage}`, "--version", version, "--destination", pulled]);
    assert.deepEqual(
      await readFile(join(pulled, `openclaw-enterprise-${version}.tgz`)),
      expectedBytes,
      "Published chart bytes differ from the staged archive.",
    );
    await verifyReleaseContext(env, packagePath);
    const chartDigest = inspectDigest(`docker://${chartPackage}:${version}`, authfile);
    assert.match(chartDigest, digestPattern);
    const receipt = {
      version,
      sourceSha: env.SOURCE_SHA,
      chart: { reference: `${chartPackage}@${chartDigest}`, version, digest: chartDigest },
      controller: `${images[0].destination}@${images[0].digest}`,
      runtime: `${images[1].destination}@${images[1].digest}`,
    };
    await writeFile(
      join(directory, "chart-publication.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `\n- OCE ${version} chart: \`${receipt.chart.reference}\`\n- Controller: \`${receipt.controller}\`\n- Runtime: \`${receipt.runtime}\`\n`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, directory] = process.argv.slice(2);
  if (command !== "publish" || !directory) {
    throw new Error("Expected publish <prepared-directory>.");
  }
  publish(directory, process.env).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
