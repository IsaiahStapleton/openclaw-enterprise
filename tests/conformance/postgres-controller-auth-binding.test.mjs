import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire, registerHooks } from "node:module";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = fileURLToPath(new URL("../../", import.meta.url));
const self = fileURLToPath(import.meta.url);
const controllerURL = new URL("../../apps/controller/src/auth/index.ts", import.meta.url);
const requireController = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const bindingSpecifier = requireController.resolve(
  "@openclaw-enterprise/occ/auth-persistence/postgres-auth-binding",
);
const mode = process.argv[2];

function options(pool, extra = {}) {
  return {
    pool,
    mode: "production",
    installationId: "ins_auth_binding",
    baseURL: "https://controller.example.test",
    secret: "controller-auth-binding-test-secret-at-least-32-characters",
    ...extra,
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
  const realBinding = await import(bindingSpecifier);
  const adapterURL = requireController.resolve("better-auth/adapters/drizzle");
  const realAdapter = await import(adapterURL);
  const canonicalSchema = await import("../../packages/occ/src/state/postgres-schema.ts");
  const bindings = [];
  const adapters = [];
  // These observation wrappers delegate to both actual implementations. No
  // replacement database, schema, adapter result or auth API is supplied.
  mock.module(bindingSpecifier, {
    namedExports: {
      ...realBinding,
      async createPostgresAuthBinding(pool) {
        const binding = await realBinding.createPostgresAuthBinding(pool);
        bindings.push({ pool, binding });
        return binding;
      },
    },
  });
  mock.module(adapterURL, {
    namedExports: {
      ...realAdapter,
      drizzleAdapter(database, config) {
        const adapter = realAdapter.drizzleAdapter(database, config);
        adapters.push({ database, config, adapter });
        return adapter;
      },
    },
  });
  try {
    const { createPostgresControllerAuth } = await import(controllerURL);
    for (const extra of [{}, { secureCookies: false }, { mode: "development" }]) {
      const { pool, calls } = refusingPool();
      const selected = options(pool, extra);
      const controller = await createPostgresControllerAuth(selected);
      // Complete BetterAuth initialization is also part of constructor-I/O
      // observation; it must not acquire or end the caller's resource.
      await controller.auth.$context;
      assert.deepEqual(calls, []);
      assert.equal(bindings.length, adapters.length);
      const observed = bindings.at(-1);
      const adapter = adapters.at(-1);
      assert.strictEqual(observed.pool, pool);
      assert.strictEqual(observed.binding.database.$client, pool);
      assert.strictEqual(observed.binding.schema, canonicalSchema);
      assert.strictEqual(observed.binding.database._.fullSchema, canonicalSchema);
      assert.strictEqual(adapter.database, observed.binding.database);
      assert.strictEqual(adapter.config.schema, observed.binding.schema);
      assert.deepEqual(adapter.config, {
        provider: "pg",
        schema: canonicalSchema,
        camelCase: true,
        transaction: true,
      });
      assert.strictEqual(controller.auth.options.database, adapter.adapter);
      assert.equal(controller.issuer, `occ:installation:${selected.installationId}:better-auth`);
      assert.equal(controller.auth.options.baseURL, selected.baseURL);
      assert.equal(controller.auth.options.secret, selected.secret);
      assert.deepEqual(controller.auth.options.trustedOrigins, [selected.baseURL]);
      assert.deepEqual(controller.auth.options.advanced.defaultCookieAttributes, {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: selected.secureCookies ?? selected.mode === "production",
      });
      assert.equal(controller.auth.options.advanced.cookiePrefix, "openclaw_occ");

      // Invoke the real controller method directly. This small reply observer
      // records its public envelope; it does not claim Fastify route coverage.
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
      // The real adapter reaches the supplied pool and reports a sanitized
      // failure. This does not claim successful PostgreSQL persistence.
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
    assert.equal(bindings.length, 3);
    assert.equal(adapters.length, 3);
  } finally {
    mock.restoreAll();
  }
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
      const result = spawnSync(
        process.execPath,
        ["--max-old-space-size=512", "--experimental-test-module-mocks", self, childMode],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          killSignal: "SIGKILL",
          maxBuffer: 256 * 1024,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.signal, null, `Child terminated: ${result.signal}`);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });
  }
}
