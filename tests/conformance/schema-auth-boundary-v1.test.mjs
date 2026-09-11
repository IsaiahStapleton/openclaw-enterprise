import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const compiler = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));
const projects = [
  [
    "producer and query inference",
    "apps/controller/tests/fixtures/schema-auth-boundary-v1/producer.tsconfig.json",
  ],
  [
    "independent core consumer",
    "apps/controller/tests/fixtures/schema-auth-boundary-v1/core-consumer.tsconfig.json",
  ],
  [
    "expected type rejections",
    "apps/controller/tests/fixtures/schema-auth-boundary-v1/negatives.tsconfig.json",
  ],
  [
    "controller-owned BetterAuth adapter",
    "apps/controller/tests/fixtures/schema-auth-boundary-v1/consumer.tsconfig.json",
  ],
];

for (const [name, project] of projects) {
  test(`SchemaAuthBoundaryV1 compiles ${name}`, () => {
    assert.ok(
      existsSync(compiler),
      "Prepare the worktree-local TypeScript dependency before testing",
    );
    const result = spawnSync(
      process.execPath,
      [compiler, "--project", project, "--pretty", "false"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null, `Compiler terminated: ${result.signal}`);
    assert.equal(result.status, 0, `${project}\n${result.stdout}\n${result.stderr}`);
  });
}

test("SchemaAuthBoundaryV1 exports definitions without runtime construction", async () => {
  // The projects above check public export resolution from a declared consumer.
  // These direct imports check only the actual definition modules' runtime surface.
  const auth = await import("../../packages/occ/src/auth-persistence/schema-auth-boundary-v1.ts");
  const core = await import("../../packages/occ/src/schema/core-schema-boundary-v1.ts");
  assert.deepEqual(Object.keys(auth), []);
  assert.deepEqual(Object.keys(core), []);
});
