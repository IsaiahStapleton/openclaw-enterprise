import { immutableCopy } from "@openclaw-enterprise/utils";
import { DependencyUnavailableError } from "../errors.ts";
import type {
  RepositorySessionAttempt,
  RepositorySessionPhase,
  RepositorySessionRepository,
} from "../ports/repository-sessions.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

const columns = `namespace_id, agent_id, revision_id, repository_ref, admission_id,
  duration_seconds, deadline_wall_ms, phase, session_id, created_at, updated_at,
  live_revision_id, cleanup_context`;

function attemptFromRow(value: unknown): Readonly<RepositorySessionAttempt> {
  const row = value as Record<string, unknown>;
  const text = (key: string): string => {
    if (typeof row[key] !== "string") {
      throw new DependencyUnavailableError("Persisted repository session state is invalid.");
    }
    return row[key];
  };
  const timestamp = (key: string): string => {
    const value = row[key];
    const date = value instanceof Date ? value : new Date(text(key));
    if (!Number.isFinite(date.getTime())) {
      throw new DependencyUnavailableError("Persisted repository session timestamp is invalid.");
    }
    return date.toISOString();
  };
  const durationSeconds = Number(row.duration_seconds);
  const deadlineWallMs = Number(row.deadline_wall_ms);
  const phase = text("phase");
  if (
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isSafeInteger(deadlineWallMs) ||
    deadlineWallMs <= 0 ||
    !["opening", "open", "closing", "disposed", "invalidated"].includes(phase)
  ) {
    throw new DependencyUnavailableError("Persisted repository session input or phase is invalid.");
  }
  return immutableCopy({
    namespaceId: text("namespace_id"),
    agentId: text("agent_id"),
    revisionId: text("revision_id"),
    liveRevisionId: row.live_revision_id === null ? null : text("live_revision_id"),
    cleanupContext: row.cleanup_context as RepositorySessionAttempt["cleanupContext"],
    repositoryRef: text("repository_ref"),
    admissionId: text("admission_id"),
    durationSeconds,
    deadlineWallMs,
    phase: phase as RepositorySessionPhase,
    ...(row.session_id === null ? {} : { sessionId: text("session_id") }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  });
}

/** Uses the enclosing State transaction; database constraints own persisted invariants. */
export function postgresRepositorySessions(
  client: PostgresQueryClient,
): RepositorySessionRepository {
  return {
    findAttempt: async (admissionId) => {
      const result = await client.query(
        `SELECT ${columns} FROM occ.repository_session_attempts WHERE admission_id = $1`,
        [admissionId],
      );
      return result.rows[0] === undefined ? undefined : attemptFromRow(result.rows[0]);
    },
    listRevisionAttempts: async (owner) => {
      const result = await client.query(
        `SELECT ${columns} FROM occ.repository_session_attempts
         WHERE namespace_id = $1 AND agent_id = $2 AND revision_id = $3
         ORDER BY created_at, admission_id`,
        [owner.namespaceId, owner.agentId, owner.revisionId],
      );
      return Object.freeze(result.rows.map(attemptFromRow));
    },
    listNamespaceAttempts: async (namespaceId) => {
      const result = await client.query(
        `SELECT ${columns} FROM occ.repository_session_attempts
         WHERE namespace_id = $1 ORDER BY created_at, admission_id`,
        [namespaceId],
      );
      return Object.freeze(result.rows.map(attemptFromRow));
    },
    createAttempt: async (input) => {
      const result = await client.query(
        `INSERT INTO occ.repository_session_attempts
         (namespace_id, agent_id, revision_id, repository_ref, admission_id,
          duration_seconds, deadline_wall_ms, phase, session_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'opening', NULL, $8, $8)
         RETURNING ${columns}`,
        [
          input.namespaceId,
          input.agentId,
          input.revisionId,
          input.repositoryRef,
          input.admissionId,
          input.durationSeconds,
          input.deadlineWallMs,
          input.createdAt,
        ],
      );
      return attemptFromRow(result.rows[0]);
    },
    advanceAttempt: async (input) => {
      const result = await client.query(
        `UPDATE occ.repository_session_attempts
         SET phase = $3, session_id = CASE WHEN $4::boolean THEN $5::text ELSE session_id END,
             updated_at = $6
         WHERE admission_id = $1 AND phase = $2
         RETURNING ${columns}`,
        [
          input.admissionId,
          input.expectedPhase,
          input.phase,
          input.sessionId !== undefined,
          input.sessionId ?? null,
          input.updatedAt,
        ],
      );
      return result.rows[0] === undefined ? undefined : attemptFromRow(result.rows[0]);
    },
  };
}
