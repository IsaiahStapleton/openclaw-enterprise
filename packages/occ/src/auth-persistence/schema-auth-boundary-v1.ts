import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

/** A real node-postgres pool, whose transactions acquire a dedicated client. */
export type SchemaAuthPoolV1 = Pool;

/** The complete canonical module, including tables outside the auth model list. */
export type SchemaAuthSchemaV1 = typeof import("../state/postgres-schema.ts");

/**
 * A database and its original canonical schema object. The same schema object
 * must be supplied to Drizzle and the controller-owned auth adapter.
 *
 * This structural type does not establish runtime object identity or transaction
 * isolation. A binding owns neither the caller's pool nor its teardown.
 */
export interface SchemaAuthBoundaryV1 {
  readonly schema: SchemaAuthSchemaV1;
  readonly database: NodePgDatabase<SchemaAuthSchemaV1>;
}

/**
 * The producer uses the supplied pool without connecting, migrating or ending it
 * during construction. Construction failures reject; there is no memory fallback.
 * Sharing this pool does not join auth transactions to OCC transactions.
 */
export type SchemaAuthBindingFactoryV1 = (pool: SchemaAuthPoolV1) => Promise<SchemaAuthBoundaryV1>;

/** Existing options consumed by the controller-owned BetterAuth adapter. */
export interface SchemaAuthAdapterOptionsV1 {
  readonly provider: "pg";
  readonly schema: SchemaAuthSchemaV1;
  readonly camelCase: true;
  readonly transaction: true;
}
