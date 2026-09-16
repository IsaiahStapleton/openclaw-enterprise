import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

/** A real node-postgres pool, whose transactions acquire a dedicated client. */
export type SchemaAuthPoolV1 = Pool;

/** The complete canonical module, including tables outside the auth model list. */
export type SchemaAuthSchemaV1 = typeof import("../state/postgres-schema.ts");

/** Drizzle and the auth adapter share this canonical schema and caller-owned pool. */
export interface SchemaAuthBoundaryV1 {
  readonly schema: SchemaAuthSchemaV1;
  readonly database: NodePgDatabase<SchemaAuthSchemaV1>;
}

/**
 * Construction performs no I/O and never closes the pool. Failures reject without
 * a memory fallback. Sharing a pool does not join auth and OCC transactions.
 */
export type SchemaAuthBindingFactoryV1 = (pool: SchemaAuthPoolV1) => Promise<SchemaAuthBoundaryV1>;

/** Options required by the controller-owned Better Auth adapter. */
export interface SchemaAuthAdapterOptionsV1 {
  readonly provider: "pg";
  readonly schema: SchemaAuthSchemaV1;
  readonly camelCase: true;
  readonly transaction: true;
}
