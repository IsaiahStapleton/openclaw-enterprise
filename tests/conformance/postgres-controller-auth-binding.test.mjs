import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = fileURLToPath(new URL("../../", import.meta.url));
const self = fileURLToPath(import.meta.url);
const controllerURL = new URL("../../apps/controller/src/auth/index.ts", import.meta.url);
const mode = process.argv[2];

function options(pool) {
  return {
    pool,
    mode: "production",
    installationId: "ins_auth_binding",
    baseURL: "https://controller.example.test",
    secret: "controller-auth-binding-test-secret-at-least-32-characters",
  };
}

function refusingPool() {
  const calls = [];
  const refusal = new Error("private database refusal detail");
  // Refuse at the external database resource. The actual pool class is retained
  // so Drizzle's transaction detection matches the production composition.
  const pool = new pg.Pool({ max: 1 });
  for (const method of ["connect", "query", "end"]) {
    Object.defineProperty(pool, method, {
      configurable: true,
      value: async function () {
        calls.push({ method, receiver: this });
        throw refusal;
      },
    });
  }
  return { pool, calls };
}

async function constructionAndRefusal() {
  const { createPostgresControllerAuth } = await import(controllerURL);
  const { pool, calls } = refusingPool();
  const selected = options(pool);
  const controller = await createPostgresControllerAuth(selected);
  // Complete BetterAuth initialization must not acquire or end the caller's pool.
  await controller.auth.$context;
  assert.deepEqual(calls, []);

  // Invoke the real controller method directly. This reply observer records its
  // public envelope; successful persistence and Fastify routes have separate tests.
  const response = { headers: {} };
  const reply = {
    header(name, value) {
      response.headers[name] = value;
      return this;
    },
    status(value) {
      response.status = value;
      return this;
    },
    send(value) {
      response.body = value;
      return this;
    },
  };
  await controller.signInEmail(
    {
      id: "auth-binding-request",
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: selected.baseURL },
      raw: { socket: { remoteAddress: "127.0.0.1" } },
      body: { email: "person@example.test", password: "test-password-long-enough" },
    },
    reply,
  );
  // The real adapter reaches the supplied pool and sanitizes its refusal.
  assert.deepEqual(calls, [{ method: "query", receiver: pool }]);
  assert.deepEqual(response, {
    status: 503,
    headers: {},
    body: {
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message: "The caller did not provide valid authentication credentials.",
      },
      meta: { requestId: "auth-binding-request" },
    },
  });
}

async function dependencyFailure(dependency) {
  const expected = new Error("auth binding dependency could not load");
  let refusals = 0;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      // Refuse the actual producer's import, before dependency evaluation. The
      // unchanged binding and controller must preserve this exact error.
      if (
        context.parentURL?.endsWith("/auth-persistence/postgres-auth-binding.ts") &&
        specifier ===
          (dependency === "drizzle" ? "drizzle-orm/node-postgres" : "../state/postgres-schema.ts")
      ) {
        refusals++;
        throw expected;
      }
      return nextResolve(specifier, context);
    },
  });
  const { pool, calls } = refusingPool();
  try {
    const { createPostgresControllerAuth } = await import(controllerURL);
    await assert.rejects(
      createPostgresControllerAuth(options(pool)),
      (error) => error === expected,
    );
    assert.equal(refusals, 1);
    assert.deepEqual(calls, []);
  } finally {
    hooks.deregister();
  }
}

if (mode === "construction") {
  await constructionAndRefusal();
} else if (mode === "drizzle" || mode === "schema") {
  await dependencyFailure(mode);
} else {
  assert.equal(mode, undefined, "Unsupported child mode");
  for (const [childMode, name] of [
    [
      "construction",
      "controller delegates real binding/adapter construction and preserves database refusal",
    ],
    [
      "drizzle",
      "controller preserves actual Drizzle dependency rejection without fallback or teardown",
    ],
    [
      "schema",
      "controller preserves actual schema dependency rejection without fallback or teardown",
    ],
  ]) {
    test(name, () => {
      // Each child isolates module hooks/caches. These modes spawn no processes;
      // synchronous collection waits for exit, with finite capture and SIGKILL
      // on timeout so a failed child cannot retain an unbounded wait.
      const result = spawnSync(process.execPath, ["--max-old-space-size=512", self, childMode], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 256 * 1024,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null, `Child terminated: ${result.signal}`);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });
  }
}
