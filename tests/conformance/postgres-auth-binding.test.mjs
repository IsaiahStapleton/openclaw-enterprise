import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPostgresAuthBinding } from "../../packages/occ/src/auth-persistence/postgres-auth-binding.ts";
import * as canonicalSchema from "../../packages/occ/src/state/postgres-schema.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const compiler = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));
const fixtures = "apps/controller/tests/fixtures/postgres-auth-binding/";

function run(args) {
  const result = spawnSync(process.execPath, ["--max-old-space-size=1536", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `Child terminated: ${result.signal}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test("the real factory retains the caller pool and complete canonical schema without I/O", async () => {
  const pool = new pg.Pool({ max: 1 });
  Object.assign(pool, { schema: {}, logger: false, connection: {}, client: {} });
  const calls = [];
  // These observations belong to the caller's real resource. The factory and
  // Drizzle are unchanged; construction must not borrow, query or close it.
  for (const method of ["connect", "query", "end"]) {
    Object.defineProperty(pool, method, {
      configurable: true,
      value() {
        calls.push(method);
        throw new Error(`Unexpected pool ${method}`);
      },
    });
  }
  let pending;
  assert.doesNotThrow(() => {
    pending = createPostgresAuthBinding(pool);
  });
  assert.ok(pending instanceof Promise);
  const binding = await pending;
  assert.strictEqual(binding.schema, canonicalSchema);
  assert.strictEqual(binding.database.$client, pool);
  assert.strictEqual(binding.database._.fullSchema, canonicalSchema);
  for (const key of Object.keys(canonicalSchema)) {
    assert.strictEqual(binding.schema[key], canonicalSchema[key], key);
  }
  assert.deepEqual(Object.keys(binding).sort(), ["database", "schema"]);
  assert.equal("end" in binding, false);
  assert.equal("close" in binding, false);
  assert.equal(pool.totalCount, 0);
  assert.equal(pool.idleCount, 0);
  assert.equal(pool.waitingCount, 0);
  assert.deepEqual(calls, []);
  // Independent bindings retain the same supplied resource and table objects.
  const second = await createPostgresAuthBinding(pool);
  assert.notStrictEqual(second.database, binding.database);
  assert.strictEqual(second.database.$client, pool);
  assert.strictEqual(second.schema, binding.schema);
  assert.deepEqual(calls, []);
});

test("structural wrappers and checked-out clients cannot replace a real pool", async () => {
  const underlying = new pg.Pool({ max: 1 });
  const calls = [];
  const connect = async () => {
    calls.push("connect");
    throw new Error("Unexpected I/O");
  };
  const end = async () => {
    calls.push("end");
  };
  const query = async () => {
    calls.push("query");
    throw new Error("Unexpected I/O");
  };
  // A pool-like query method can dispatch BEGIN and later writes on different
  // clients. Reject these wrappers rather than silently losing atomicity.
  for (const caller of [
    { connect, end },
    { connect, end, query },
    { query, release() {} },
    { connect, end, query, schema: {}, logger: false, connection: {}, client: {} },
    null,
    "postgresql://localhost/example",
  ]) {
    await assert.rejects(createPostgresAuthBinding(caller), /requires a node-postgres Pool/);
  }
  assert.deepEqual(calls, []);
  assert.equal(underlying.totalCount, 0);
  await underlying.end();
});

for (const dependency of ["drizzle", "schema"]) {
  test(`actual ${dependency} import rejection propagates without pool teardown`, () => {
    run([`${fixtures}import-failure.mjs`, dependency]);
  });
}

test("construction rejects an unsupported caller without inspecting its constructor accessor", () => {
  run([`${fixtures}constructor-failure.mjs`]);
});

for (const project of ["producer", "consumer", "negatives"]) {
  test(`supported auth binding compiles the independent ${project} project`, () => {
    run([compiler, "--project", `${fixtures}${project}.tsconfig.json`, "--pretty", "false"]);
  });
}
