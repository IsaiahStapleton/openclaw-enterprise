import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import {
  repositoryCredentials,
  seedSessionRevision,
  sessionAttempt,
  verifyRepositorySessions,
} from "../conformance/repository-sessions.contract.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;

function insertAttempt(
  pool,
  input,
  phase = "opening",
  sessionId = null,
  updatedAt = input.createdAt,
) {
  return pool.query(
    `INSERT INTO occ.repository_session_attempts
       (namespace_id, agent_id, revision_id, repository_ref, admission_id,
        duration_seconds, deadline_wall_ms, phase, session_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      input.namespaceId,
      input.agentId,
      input.revisionId,
      input.repositoryRef,
      input.admissionId,
      input.durationSeconds,
      input.deadlineWallMs,
      phase,
      sessionId,
      input.createdAt,
      updatedAt,
    ],
  );
}

test(
  "PostgreSQL repository sessions enforce durable admission boundaries",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_TEST_DATABASE_URL to a disposable migrated PostgreSQL database.",
    timeout: 60_000,
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    t.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    await verifyRepositorySessions(t, store);

    await t.test(
      "SQL rejects owner mismatches, unadmitted repositories and altered deadlines",
      async () => {
        const { revision } = await seedSessionRevision(store);
        const other = await seedSessionRevision(store);
        for (const override of [
          { namespaceId: other.namespace.id },
          { agentId: other.agent.id },
          { revisionId: `rev_${randomUUID()}` },
        ]) {
          await assert.rejects(insertAttempt(pool, sessionAttempt(revision, override)), {
            code: "23503",
          });
        }
        for (const override of [
          { repositoryRef: "unadmitted" },
          { deadlineWallMs: revision.repositoryCredentials.deadlineWallMs + 1 },
          { durationSeconds: 0 },
          { durationSeconds: -1 },
          { durationSeconds: "9007199254740992" },
          { admissionId: "bad admission" },
          { admissionId: "admission\n" },
          { admissionId: "a".repeat(129) },
        ]) {
          await assert.rejects(insertAttempt(pool, sessionAttempt(revision, override)), {
            code: "23514",
          });
        }
        await assert.rejects(insertAttempt(pool, sessionAttempt(revision), "unknown"), {
          code: "23514",
        });
        await assert.rejects(
          insertAttempt(pool, sessionAttempt(revision), "opening", "session-present"),
          { code: "23514" },
        );
        await assert.rejects(
          insertAttempt(pool, sessionAttempt(revision, { createdAt: "infinity" })),
          { code: "23514" },
        );
        await assert.rejects(
          insertAttempt(
            pool,
            sessionAttempt(revision),
            "opening",
            null,
            "2030-03-17T17:46:39.000Z",
          ),
          { code: "23514" },
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::integer AS count FROM occ.repository_session_attempts WHERE revision_id = $1",
              [revision.id],
            )
          ).rows[0].count,
          0,
        );
      },
    );

    await t.test(
      "SQL uniqueness and lifecycle retain one active admission and immutable session IDs",
      async () => {
        const { revision } = await seedSessionRevision(store);
        const input = sessionAttempt(revision);
        await insertAttempt(pool, input);
        await assert.rejects(insertAttempt(pool, input), { code: "23505" });
        await assert.rejects(insertAttempt(pool, sessionAttempt(revision)), { code: "23505" });
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET phase = 'open' WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "23514" },
        );
        const sessionId = `session-${randomUUID()}`;
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET phase = 'open', session_id = $2 WHERE admission_id = $1",
            [input.admissionId, "session\n"],
          ),
          { code: "23514" },
        );
        await pool.query(
          "UPDATE occ.repository_session_attempts SET phase = 'open', session_id = $2 WHERE admission_id = $1",
          [input.admissionId, sessionId],
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET phase = 'disposed' WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "23514" },
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET session_id = NULL WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "55000" },
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET phase = 'closing', session_id = 'replacement' WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "55000" },
        );
        await pool.query(
          "UPDATE occ.repository_session_attempts SET phase = 'closing' WHERE admission_id = $1",
          [input.admissionId],
        );
        // Cleanup evidence remains while a replacement admission can be persisted.
        const replacement = sessionAttempt(revision);
        await insertAttempt(pool, replacement);
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET phase = 'open', session_id = $2 WHERE admission_id = $1",
            [replacement.admissionId, sessionId],
          ),
          { code: "23505" },
        );
        await pool.query(
          "UPDATE occ.repository_session_attempts SET phase = 'disposed' WHERE admission_id = $1",
          [input.admissionId],
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET phase = 'open' WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "23514" },
        );
      },
    );

    await t.test(
      "application grants permit lifecycle changes while protecting identity and history",
      async () => {
        const role = (
          await pool.query(
            "SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
          )
        ).rows[0];
        assert.equal(role.name, "occ_app");
        assert.equal(role.rolsuper, false);
        assert.equal(role.rolbypassrls, false);
        const { revision } = await seedSessionRevision(store);
        const input = sessionAttempt(revision);
        await insertAttempt(pool, input);
        for (const column of [
          "namespace_id",
          "agent_id",
          "revision_id",
          "repository_ref",
          "admission_id",
          "duration_seconds",
          "deadline_wall_ms",
          "created_at",
        ]) {
          await assert.rejects(
            pool.query(
              `UPDATE occ.repository_session_attempts SET ${column} = ${column} WHERE admission_id = $1`,
              [input.admissionId],
            ),
            { code: "42501" },
          );
        }
        await assert.rejects(
          pool.query("DELETE FROM occ.repository_session_attempts WHERE admission_id = $1", [
            input.admissionId,
          ]),
          { code: "42501" },
        );
        await pool.query(
          "UPDATE occ.repository_session_attempts SET phase = 'invalidated', updated_at = $2 WHERE admission_id = $1",
          [input.admissionId, "2030-03-17T17:46:41.000Z"],
        );
        assert.equal(
          (await store.read((view) => view.repositorySessions.findAttempt(input.admissionId)))
            .phase,
          "invalidated",
        );
      },
    );

    await t.test(
      "SQL validates canonical draft and immutable revision repository snapshots",
      async () => {
        const { agent, revision } = await seedSessionRevision(store);
        for (const bindings of [
          [],
          [{ repositoryRef: "source\n", profile: "git-read" }],
          [{ repositoryRef: "source", profile: "git-read\n" }],
          [{ repositoryRef: "source", profile: "read", bearer: "extra" }],
          [
            { repositoryRef: "source", profile: "read" },
            { repositoryRef: "source", profile: "write" },
          ],
        ]) {
          await assert.rejects(
            pool.query("UPDATE occ.agents SET repository_bindings = $2::jsonb WHERE id = $1", [
              agent.id,
              JSON.stringify(bindings),
            ]),
            { code: "23514" },
          );
        }
        const variants = [
          null,
          { ...repositoryCredentials(), bindings: [] },
          { ...repositoryCredentials(), bindings: {} },
          {
            ...repositoryCredentials(),
            driver: { ...repositoryCredentials().driver, bearer: "unexpected" },
          },
          {
            ...repositoryCredentials(),
            bindings: [{ ...repositoryCredentials().bindings[0], bearer: "unexpected" }],
          },
          {
            ...repositoryCredentials(),
            bindings: [{ ...repositoryCredentials().bindings[0], grant: null }],
          },
          {
            ...repositoryCredentials(),
            bindings: [
              {
                ...repositoryCredentials().bindings[0],
                grant: { ...repositoryCredentials().bindings[0].grant, bearer: "unexpected" },
              },
            ],
          },
          { ...repositoryCredentials(), deadlineWallMs: 1.5 },
          { ...repositoryCredentials(), driver: { id: "bad\nidentity", implementation: "native" } },
          {
            ...repositoryCredentials(),
            driver: { id: `${"é".repeat(256)}x`, implementation: "github" },
          },
          {
            ...repositoryCredentials(),
            bindings: [{ ...repositoryCredentials().bindings[0], providerId: " provider " }],
          },
          {
            ...repositoryCredentials(),
            bindings: [{ ...repositoryCredentials().bindings[0], providerId: "😀".repeat(101) }],
          },
          {
            ...repositoryCredentials(),
            bindings: [{ ...repositoryCredentials().bindings[0], providerId: "\u00a0provider" }],
          },
          {
            ...repositoryCredentials(),
            bindings: [
              {
                ...repositoryCredentials().bindings[0],
                grant: { ...repositoryCredentials().bindings[0].grant, grantId: "" },
              },
            ],
          },
          { ...repositoryCredentials(), bearer: "extra" },
        ];
        // Insert variants of a real admitted row so the repository snapshot is the only invalid input.
        for (const credentials of variants) {
          await assert.rejects(
            pool.query(
              `INSERT INTO occ.agent_revisions (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at)
         SELECT $2, namespace_id, agent_id, 2,
           jsonb_set(admitted_spec, '{repository_credentials}', $3::jsonb), admitted_at
         FROM occ.agent_revisions WHERE id = $1`,
              [revision.id, `rev_${randomUUID()}`, JSON.stringify(credentials)],
            ),
            { code: "23514" },
          );
        }
        const row = (
          await pool.query(
            "SELECT admitted_spec->'repository_credentials' AS credentials FROM occ.agent_revisions WHERE id = $1",
            [revision.id],
          )
        ).rows[0];
        assert.deepEqual(row.credentials, revision.repositoryCredentials);
      },
    );
  },
);
