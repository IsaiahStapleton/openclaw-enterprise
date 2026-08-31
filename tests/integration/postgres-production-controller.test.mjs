import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import {
  PostgresWorkQueue,
  WorkClaimLostError,
} from "../../packages/occ/src/state/postgres-work-queue.ts";

const databaseUrl = process.env.OCC_PSQL_TEST_DATABASE_URL;
const run = promisify(execFile);
const requiresPostgres = {
  skip: databaseUrl
    ? false
    : "Set OCC_PSQL_TEST_DATABASE_URL to run real PostgreSQL production queue integration.",
};

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("SQL test values must be finite.");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parseCsv(output) {
  if (output.trim().length === 0) return [];
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index];
    if (character === '"') {
      if (quoted && output[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      record.push(field);
      field = "";
    } else if (character === "\n" && !quoted) {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += character;
  }
  if (record.length > 0 || field.length > 0) records.push([...record, field]);
  const [headers, ...rows] = records;
  return rows.map((values) =>
    Object.fromEntries(
      headers.map((header, index) => {
        const value = values[index];
        if (value === "__OCE_NULL__") return [header, null];
        if (header === "attempt_count" || header === "count") return [header, Number(value)];
        return [header, value];
      }),
    ),
  );
}

async function execute(sql, values = []) {
  // Exercise real migrated PostgreSQL as the application role instead of faking queue responses.
  const statement = sql.replace(/\$(\d+)\b/g, (_placeholder, index) => {
    const valueIndex = Number(index) - 1;
    if (valueIndex >= values.length) throw new Error("A PostgreSQL test parameter is missing.");
    return literal(values[valueIndex]);
  });
  const { stdout } = await run("psql", [
    databaseUrl,
    "--no-psqlrc",
    "--set",
    "ON_ERROR_STOP=1",
    "--pset",
    "footer=off",
    "--pset",
    "null=__OCE_NULL__",
    "--csv",
    "--command",
    statement,
  ]);
  const rows = parseCsv(stdout);
  return { rows, rowCount: rows.length };
}

async function seedTenant(namespaceId, agentId, revisionId) {
  // Model a production-admitted dedicated revision with its complete tenant ownership chain.
  const identityId = `service-production-${randomUUID()}`;
  const configurationId = `cfg_${randomUUID()}`;
  await execute(`
    BEGIN;
    INSERT INTO occ.namespaces (id, name, status, created_at)
    VALUES (
      ${literal(namespaceId)}, ${literal(`production-${randomUUID()}`)},
      'ready', clock_timestamp()
    );
    INSERT INTO occ.configurations (id, namespace_id, kind, generation, created_at)
    VALUES (${literal(configurationId)}, ${literal(namespaceId)}, 'agent', 1, clock_timestamp());
    INSERT INTO occ.agents
      (id, namespace_id, name, configuration_id, execution_mode, service_principal_id, created_at)
    VALUES (${literal(agentId)}, ${literal(namespaceId)}, 'production-agent',
      ${literal(configurationId)}, 'dedicated', ${literal(identityId)}, clock_timestamp());
    INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind)
    VALUES (
      ${literal(identityId)}, ${literal(namespaceId)},
      ${literal(agentId)}, 'service_principal'
    );
    INSERT INTO occ.agent_revisions
      (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at)
    VALUES (${literal(revisionId)}, ${literal(namespaceId)}, ${literal(agentId)}, 1,
      ${literal(
        JSON.stringify({
          draft_spec: {},
          configuration_id: configurationId,
          configuration_kind: "agent",
          configuration_generation: 1,
          harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
          compute: { id: "compute-kubernetes-local", implementation: "kubernetes-local" },
        }),
      )}::jsonb, clock_timestamp());
    COMMIT;
  `);
}

test(
  "production PostgreSQL queue processes revisions and fences pending Namespace convergence",
  requiresPostgres,
  async () => {
    const revisionNamespaceId = `ns_${randomUUID()}`;
    const namespaceId = `ns_${randomUUID()}`;
    const agentId = `agt_${randomUUID()}`;
    const revisionId = `rev_${randomUUID()}`;

    // Existing revision work belongs to a ready tenant; new provisioning belongs to another tenant.
    await seedTenant(revisionNamespaceId, agentId, revisionId);
    await execute(
      `INSERT INTO occ.namespaces (id, name, status, created_at)
       VALUES ($1, $2, 'provisioning', clock_timestamp())`,
      [namespaceId, `production-provisioning-${randomUUID()}`],
    );

    // Zero jitter makes deferred work immediately claimable without changing queue behavior.
    const queue = new PostgresWorkQueue(
      { query: execute },
      { maxAttempts: 5, leaseDurationMs: 30_000, random: () => 0 },
    );
    // Production must process the earlier Agent revision instead of silently filtering it out.
    const revision = await queue.enqueue({
      idempotencyKey: `revision:${revisionId}`,
      namespaceId: revisionNamespaceId,
      agentId,
      revisionId,
      actorId: "principal-existing-development",
      availableAt: new Date(Date.now() - 5_000),
    });
    const namespace = await queue.enqueue({
      idempotencyKey: `namespace:${namespaceId}:ready`,
      namespaceId,
      actorId: "principal-production-controller",
      namespaceTarget: "ready",
    });

    // Namespace lifecycle and Agent revisions share one real durable production backlog.
    assert.equal(await queue.pending(), 2);
    const revisionClaim = await queue.claim();
    assert.equal(revisionClaim.idempotencyKey, revision.idempotencyKey);
    await queue.complete(revisionClaim);
    assert.equal(await queue.pending(), 1);

    // Seven incomplete observations exceed maxAttempts=5 without exhausting the failure budget.
    for (let observation = 0; observation < 7; observation += 1) {
      const claim = await queue.claim();
      assert.equal(claim.idempotencyKey, namespace.idempotencyKey);
      assert.equal(claim.attemptCount, 1);
      await queue.defer(claim, { code: "NAMESPACE_INCOMPLETE" });

      // Pending convergence releases the claim and restores its consumed failure attempt.
      const persisted = await execute(
        "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
        [namespace.idempotencyKey],
      );
      assert.deepEqual(persisted.rows, [{ state: "queued", attempt_count: 0 }]);
    }

    // Once the Namespace converges, complete its job while preserving the completed Agent revision.
    const claim = await queue.claim();
    await queue.complete(claim);
    const completed = await execute(
      "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [namespace.idempotencyKey],
    );
    assert.deepEqual(completed.rows, [{ state: "succeeded", attempt_count: 1 }]);
    assert.equal(await queue.pending(), 0);

    // A production worker that loses a revision lease must leave recoverable Agent work.
    const recoverable = await queue.enqueue({
      idempotencyKey: `revision:${revisionId}:recover`,
      namespaceId: revisionNamespaceId,
      agentId,
      revisionId,
      actorId: "principal-production-controller",
    });
    const lostRevision = await queue.claim();
    assert.equal(lostRevision.idempotencyKey, recoverable.idempotencyKey);
    await execute(
      `UPDATE occ.controller_work
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE idempotency_key = $1`,
      [recoverable.idempotencyKey],
    );
    assert.deepEqual(await queue.recoverStale(), {
      recovered: 1,
      requeued: 1,
      failedPermanent: 0,
      exhaustedQueued: 0,
    });
    const recovered = await execute(
      `SELECT state, claim_token, attempt_count
       FROM occ.controller_work WHERE idempotency_key = $1`,
      [recoverable.idempotencyKey],
    );
    assert.deepEqual(recovered.rows, [{ state: "queued", claim_token: null, attempt_count: 1 }]);
    const recoveredClaim = await queue.claim();
    assert.equal(recoveredClaim.idempotencyKey, recoverable.idempotencyKey);
    await queue.complete(recoveredClaim);
    assert.equal(await queue.pending(), 0);

    // Every pending observation must retain durable, attributable convergence audit evidence.
    const evidence = await execute(
      `SELECT count(*)::integer AS count FROM occ.audit_events
       WHERE namespace_id = $1 AND details->>'reasonCode' = 'NAMESPACE_INCOMPLETE'`,
      [namespaceId],
    );
    assert.deepEqual(evidence.rows, [{ count: 7 }]);
  },
);

test("real PostgreSQL rejects stale production convergence claims", requiresPostgres, async () => {
  const namespaceId = `ns_${randomUUID()}`;
  await execute(
    `INSERT INTO occ.namespaces (id, name, status, created_at)
     VALUES ($1, $2, 'provisioning', clock_timestamp())`,
    [namespaceId, `production-fence-${randomUUID()}`],
  );
  const queue = new PostgresWorkQueue(
    { query: execute },
    { leaseDurationMs: 30_000, random: () => 0 },
  );
  await queue.enqueue({
    idempotencyKey: `namespace:${namespaceId}:ready`,
    namespaceId,
    actorId: "principal-production-controller",
    namespaceTarget: "ready",
  });
  const claim = await queue.claim();

  // Expire the real persisted lease to model a worker losing ownership mid-convergence.
  await execute(
    `UPDATE occ.controller_work
     SET lease_expires_at = clock_timestamp() - interval '1 second'
     WHERE idempotency_key = $1`,
    [claim.idempotencyKey],
  );

  // A stale worker cannot defer, requeue, or otherwise mutate another worker's claimed job.
  await assert.rejects(queue.defer(claim, { code: "NAMESPACE_INCOMPLETE" }), WorkClaimLostError);
  const persisted = await execute(
    "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
    [claim.idempotencyKey],
  );
  assert.deepEqual(persisted.rows, [{ state: "claimed", attempt_count: 1 }]);
});
