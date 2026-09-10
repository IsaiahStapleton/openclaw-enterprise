import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { generateApiReferenceOutputs } from "../../scripts/generate-occ-api-reference.mjs";
import { DEFAULT_MAX_WORDS, countMarkdownWords } from "../../scripts/docs-site/word-count.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const docsRoot = fileURLToPath(new URL("../../docs/", import.meta.url));
const contractPath = fileURLToPath(
  new URL("../../packages/contracts/openapi/occ-api.openapi.json", import.meta.url),
);

test("generated API reference is split into bounded index, resource, and topic pages", async () => {
  const document = JSON.parse(await readFile(contractPath, "utf8"));
  const outputs = generateApiReferenceOutputs(document);
  const paths = new Set(outputs.map((output) => output.path));

  assert.ok(paths.has("docs/reference/api.md"));
  assert.ok(paths.has("docs/reference/api/agents.md"));
  assert.ok(paths.has("docs/reference/api/agents-workspace.md"));
  assert.ok(paths.has("docs/reference/api/agents-deployment.md"));

  for (const output of outputs) {
    const counts = countMarkdownWords(output.content, {
      sourceFile: join(repositoryRoot, output.path),
      root: docsRoot,
    });
    assert.ok(
      counts.totalWords <= DEFAULT_MAX_WORDS,
      `${output.path} has ${counts.totalWords} words`,
    );
  }

  const index = outputs.find((output) => output.path === "docs/reference/api.md").content;
  assert.match(
    index,
    /<span id="get-namespacesnamespaceidagentsagentidworkspacefilesname"><\/span>/,
  );
  assert.match(
    index,
    /api\/agents-workspace\.md#get-namespacesnamespaceidagentsagentidworkspacefilesname/,
  );

  const operation = outputs.find(
    (output) => output.path === "docs/reference/api/agents-workspace.md",
  ).content;
  assert.match(
    operation,
    /^## `GET \/namespaces\/\{namespaceId\}\/agents\/\{agentId\}\/workspace\/files\/\{name\}`/m,
  );
  assert.match(
    operation,
    /<span id="get-namespacesnamespaceidagentsagentidworkspacefilesname"><\/span>/,
  );
});

test("OpenAPI check rejects unexpected generated API child pages in an isolated CLI fixture", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "occ-api-reference-check-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));

  await mkdir(join(fixture, "scripts"), { recursive: true });
  await copyFile(
    join(repositoryRoot, "scripts/generate-occ-openapi.mjs"),
    join(fixture, "scripts/generate-occ-openapi.mjs"),
  );
  await copyFile(
    join(repositoryRoot, "scripts/generate-occ-api-reference.mjs"),
    join(fixture, "scripts/generate-occ-api-reference.mjs"),
  );
  await copyFile(join(repositoryRoot, "package.json"), join(fixture, "package.json"));
  await symlink(join(repositoryRoot, "apps"), join(fixture, "apps"));
  await symlink(join(repositoryRoot, "node_modules"), join(fixture, "node_modules"));
  await mkdir(join(fixture, "packages/contracts/openapi"), { recursive: true });
  await copyFile(contractPath, join(fixture, "packages/contracts/openapi/occ-api.openapi.json"));

  const generateResult = spawnSync(process.execPath, ["scripts/generate-occ-openapi.mjs"], {
    cwd: fixture,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(generateResult.status, 0, generateResult.stderr + generateResult.stdout);

  await writeFile(
    join(fixture, "docs/reference/api/unexpected-ci-check.md"),
    "# Unexpected API page\n",
    "utf8",
  );

  const result = spawnSync(process.execPath, ["scripts/generate-occ-openapi.mjs", "--check"], {
    cwd: fixture,
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.notEqual(result.status, 0, "OpenAPI check accepted an unexpected generated page");
  assert.match(
    result.stderr + result.stdout,
    /Unexpected generated API reference file: docs\/reference\/api\/unexpected-ci-check\.md/,
  );
});
