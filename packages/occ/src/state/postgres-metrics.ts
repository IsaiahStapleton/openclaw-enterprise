import type { PostgresPool } from "./postgres-state.ts";
import { PENDING_WORK_PREDICATE } from "./postgres-work-queue.ts";

export interface PlatformMetricsSnapshot {
  readonly draft: number;
  readonly active: number;
  readonly pending: number;
}

/** Read-only operational projection of this database's singleton Installation. */
export class PostgresMetricsSnapshot {
  private readonly pool: PostgresPool;
  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async collect(): Promise<PlatformMetricsSnapshot> {
    const client = await this.pool.connect();
    let failed = false;
    try {
      // One statement gives all gauges the same MVCC snapshot. The dedicated
      // pool supplies connection and server-side statement deadlines.
      const result = await client.query(`
        SELECT
          (SELECT count(*)::float8 FROM occ.agents a
             JOIN occ.namespaces n ON n.id = a.namespace_id
             WHERE n.deleted_at IS NULL AND a.active_revision_id IS NULL) AS draft,
          (SELECT count(*)::float8 FROM occ.agents a
             JOIN occ.namespaces n ON n.id = a.namespace_id
             WHERE n.deleted_at IS NULL AND a.active_revision_id IS NOT NULL) AS active,
          (SELECT count(*)::float8 FROM occ.controller_work
             WHERE ${PENDING_WORK_PREDICATE}) AS pending
        FROM occ.installation`);
      const row = result.rows[0] as PlatformMetricsSnapshot | undefined;
      if (row === undefined) throw new Error("Metrics require the singleton Installation.");
      return row;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      client.release(failed);
    }
  }
}
