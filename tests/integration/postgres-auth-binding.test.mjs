import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createPostgresAuthBinding } from "../../packages/occ/src/auth-persistence/postgres-auth-binding.ts";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;

test(
  "PostgreSQL auth binding pins transactions, rolls back failures, and preserves caller pool ownership",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_TEST_DATABASE_URL to a migrated disposable PostgreSQL database.",
  },
  async (context) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    const id = `binding-${randomUUID()}`;
    context.after(async () => {
      try {
        await pool.query("DELETE FROM occ.verification WHERE id = $1", [id]);
      } finally {
        await pool.end();
      }
    });
    const { database, schema } = await createPostgresAuthBinding(pool);
    const now = new Date();
    const verification = {
      id,
      identifier: `operator-${randomUUID()}@example.test`,
      value: randomUUID(),
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    };
    const failure = new Error("abort this transaction");
    await assert.rejects(
      database.transaction(async (transaction) => {
        await transaction.insert(schema.verification).values(verification);
        const ownRows = await transaction.select().from(schema.verification);
        assert.ok(ownRows.some((row) => row.id === id));
        // The pool's other connection cannot observe the pending insert. This
        // distinguishes a pinned transaction from BEGIN/writes via pool.query.
        const externalRows = await pool.query("SELECT id FROM occ.verification WHERE id = $1", [
          id,
        ]);
        assert.equal(externalRows.rowCount, 0);
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(
      (await pool.query("SELECT id FROM occ.verification WHERE id = $1", [id])).rowCount,
      0,
    );
    // The caller still owns a usable pool after rollback; a subsequent auth
    // transaction commits and becomes visible outside its checked-out client.
    await database.transaction(async (transaction) => {
      await transaction.insert(schema.verification).values(verification);
    });
    assert.equal(
      (await pool.query("SELECT id FROM occ.verification WHERE id = $1", [id])).rowCount,
      1,
    );
  },
);
