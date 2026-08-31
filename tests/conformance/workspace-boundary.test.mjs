import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const activeSourceRoots = [
  "apps/controller/src",
  "packages/utils/src",
  "packages/contracts/src",
  "packages/iam/src",
  "packages/occ/src",
  "packages/audit/src",
  "tests/conformance",
  "tests/integration",
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(entryPath);
      return entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name) ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

test("the active workspace explicitly excludes archived implementation packages", async () => {
  const workspace = await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /^packages:/m);
  assert.match(workspace, /^\s*-\s*apps\/controller\s*$/m);
  assert.match(workspace, /^\s*-\s*packages\/utils\s*$/m);
  assert.match(workspace, /["']?!legacy(?:\/\*\*)?["']?/);

  const packageManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.doesNotMatch(JSON.stringify(packageManifest.scripts ?? {}), /(?:^|[\s./])legacy\//);

  const tsconfig = JSON.parse(await readFile(join(repositoryRoot, "tsconfig.json"), "utf8"));
  assert.ok(
    tsconfig.references?.some((reference) => reference.path === "./apps/controller"),
    "The active controller must be included in the TypeScript solution.",
  );
  assert.ok(
    tsconfig.references?.some((reference) => reference.path === "./packages/utils"),
    "The shared utilities must be included in the TypeScript solution.",
  );
  assert.ok(
    tsconfig.exclude?.some((entry) => entry === "legacy" || entry.startsWith("legacy/")),
    "The active TypeScript project must explicitly exclude legacy/.",
  );
});

test("active package and verification sources never import the archived implementation", async () => {
  const sources = (
    await Promise.all(
      activeSourceRoots.map((sourceRoot) => sourceFiles(join(repositoryRoot, sourceRoot))),
    )
  ).flat();
  assert.ok(sources.length > activeSourceRoots.length, "The new package sources must exist.");

  for (const source of sources) {
    const content = await readFile(source, "utf8");
    const importSpecifiers = content.matchAll(
      /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    );
    for (const [, specifier] of importSpecifiers) {
      const resolved = specifier.startsWith(".")
        ? relative(repositoryRoot, join(dirname(source), specifier))
        : specifier;
      assert.ok(
        resolved !== "legacy" && !resolved.startsWith("legacy/"),
        `${relative(repositoryRoot, source)} imports archived code through ${specifier}.`,
      );
    }
  }
});
