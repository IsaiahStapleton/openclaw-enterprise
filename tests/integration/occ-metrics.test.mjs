import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import {
  metricsConfiguration,
  startMetricsListener,
} from "../../apps/controller/src/metrics/listener.ts";
import { createPostgresPool, PostgresMetricsSnapshot } from "../../packages/occ/src/index.ts";
import pg from "pg";
import { requiresPostgres, setup } from "../helpers/compute-singleton-worker.mjs";

test("API metrics follow real authenticated routes and keep replica registries isolated", async (t) => {
  const metrics = createOccMetrics("api");
  const other = createOccMetrics("api");
  const listener = await startMetricsListener(metrics, { host: "127.0.0.1", port: 0 });
  t.after(() => listener.close());
  const fixture = await createConsoleAppFixture(t, { metrics });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Metrics namespace");
  assert.equal((await fixture.request("GET", "/installation", { session: null })).status, 401);
  assert.equal((await fixture.request("GET", `/namespaces/${namespace.id}/agents`)).status, 200);
  assert.equal(
    (await fixture.request("GET", "/metrics-private-nonexistent?token=do-not-export")).status,
    404,
  );

  // Observe the real HTTP workflow from its independent scrape surface.
  const response = await fetch(`${listener.url}/metrics`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(
    body,
    /occ_http_requests_total\{[^\n]*route="\/namespaces\/:namespaceId\/agents"[^\n]*status_class="2xx"[^\n]*\} 1/,
  );
  assert.match(body, /occ_http_request_duration_seconds_bucket/);
  assert.match(body, /occ_process_resident_memory_bytes/);
  assert.match(
    body,
    /occ_http_requests_total\{[^\n]*route="\/installation"[^\n]*status_class="4xx"/,
  );
  assert.doesNotMatch(body, new RegExp(namespace.id));
  assert.doesNotMatch(body, /do-not-export|metrics-private-nonexistent/);
  assert.doesNotMatch(await other.exposition(), /occ_http_requests_total\{/);
  assert.equal((await fetch(`${listener.url}/missing`)).status, 404);
  assert.equal((await fetch(`${listener.url}/metrics`, { method: "POST" })).status, 405);
  const occupied = { host: "127.0.0.1", port: Number(new URL(listener.url).port) };
  await assert.rejects(startMetricsListener(other, occupied), { code: "EADDRINUSE" });
  await listener.close();
  // Graceful close releases the port and can be called again by process cleanup.
  const replacement = await startMetricsListener(other, occupied);
  await replacement.close();
});

test("metrics settings reject exposed development binds and disabled stray settings", () => {
  assert.equal(metricsConfiguration({}, "development"), undefined);
  for (const environment of [
    { OCC_METRICS_ENABLED: "true", OCC_METRICS_HOST: "0.0.0.0", OCC_METRICS_PORT: "9464" },
    { OCC_METRICS_ENABLED: "false", OCC_METRICS_PORT: "9464" },
    { OCC_METRICS_ENABLED: "yes" },
    { OCC_METRICS_ENABLED: "true", OCC_METRICS_HOST: "127.0.0.1", OCC_METRICS_PORT: "0" },
  ])
    assert.throws(() => metricsConfiguration(environment, "development"));
  for (const host of ["::", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "127.0.0.2"]) {
    assert.throws(() =>
      metricsConfiguration(
        { OCC_METRICS_ENABLED: "true", OCC_METRICS_HOST: host, OCC_METRICS_PORT: "9464" },
        "production",
      ),
    );
  }
});

test(
  "worker inventory reflects PostgreSQL activation and redeployment without replica multiplication",
  requiresPostgres,
  async (t) => {
    const fixture = await setup(t);
    const pool = await createPostgresPool(process.env.OCC_TEST_DATABASE_URL, {
      max: 1,
      connectionTimeoutMillis: 500,
      statement_timeout: 1500,
      query_timeout: 1500,
      options: "-c default_transaction_read_only=on",
    });
    let poolClosed = false;
    t.after(() => (poolClosed ? undefined : pool.end()));
    assert.equal(
      (await pool.query("SHOW default_transaction_read_only")).rows[0]
        .default_transaction_read_only,
      "on",
    );
    const snapshot = new PostgresMetricsSnapshot(pool);
    const a = createOccMetrics("worker", () => snapshot.collect());
    const before = await snapshot.collect();
    const agent = await fixture.agent();
    assert.deepEqual(await snapshot.collect(), { ...before, draft: before.draft + 1 });
    const first = await fixture.revision(agent, 1);
    // This existing deterministic Driver proves persistence/worker metrics, not
    // live runtime readiness. Production dedicated execution requires activation.
    await fixture.start(
      {
        ...fixture.compute,
        activationOrder: "beforeCommit",
        async preflight() {},
        async activateRevision() {},
      },
      30_000,
      900_000,
      "production",
      undefined,
      a,
    );
    await fixture.work(first);
    assert.equal((await snapshot.collect()).active, before.active + 1);
    const second = await fixture.revision(agent, 2);
    await fixture.work(second);
    assert.equal((await snapshot.collect()).active, before.active + 1);

    // Both workers see the same shared state; it must never be summed across replicas.
    const b = createOccMetrics("worker", () => snapshot.collect());
    const inventory = (body) => body.split("\n").filter((line) => line.startsWith("occ_agents{"));
    assert.deepEqual(inventory(await a.exposition()), inventory(await b.exposition()));
    const listener = await startMetricsListener(a, { host: "127.0.0.1", port: 0 });
    t.after(() => listener.close());
    assert.match(
      await a.exposition(),
      /occ_reconciliation_attempts_total\{[^\n]*work_kind="agent_revision"[^\n]*outcome="success"/,
    );
    assert.match(await a.exposition(), /occ_reconciliation_attempt_duration_seconds_count/);

    // Real table contention times out all overlapping scrapes together. Once the
    // lock is released, the next scrape must recover without stale fallback.
    await t.test(
      "real table contention fails overlapping scrapes and recovers",
      {
        skip: process.env.OCC_METRICS_TEST_MIGRATION_DATABASE_URL
          ? false
          : "Set OCC_METRICS_TEST_MIGRATION_DATABASE_URL for table-lock failure proof.",
      },
      async () => {
        const migrationUrl = new URL(process.env.OCC_METRICS_TEST_MIGRATION_DATABASE_URL);
        const applicationUrl = new URL(process.env.OCC_TEST_DATABASE_URL);
        assert.equal(migrationUrl.host, applicationUrl.host);
        assert.equal(migrationUrl.pathname, applicationUrl.pathname);
        const lockPool = new pg.Pool({ connectionString: migrationUrl.toString(), max: 1 });
        const locker = await lockPool.connect();
        try {
          await locker.query("BEGIN");
          await locker.query("LOCK TABLE occ.agents IN ACCESS EXCLUSIVE MODE");
          const started = Date.now();
          const blocked = await Promise.all(
            Array.from({ length: 4 }, () => fetch(`${listener.url}/metrics`)),
          );
          assert.ok(blocked.every((response) => response.status === 503));
          assert.ok(
            Date.now() - started < 3000,
            "concurrent scrapes must share bounded database work",
          );
        } finally {
          await locker.query("ROLLBACK");
          locker.release();
          await lockPool.end();
        }
        assert.equal((await fetch(`${listener.url}/metrics`)).status, 200);
      },
    );
    // A real closed database pool must fail the whole scrape rather than emit old counts.
    await pool.end();
    poolClosed = true;
    assert.equal((await fetch(`${listener.url}/metrics`)).status, 503);
  },
);
