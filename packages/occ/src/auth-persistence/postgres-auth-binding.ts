import { Pool } from "pg";
import type { SchemaAuthBindingFactoryV1 } from "./schema-auth-boundary-v1.ts";

/** Bind the caller's pool to the original complete schema without acquiring it. */
export const createPostgresAuthBinding: SchemaAuthBindingFactoryV1 = async (pool) => {
  if (!(pool instanceof Pool)) {
    throw new TypeError("PostgreSQL auth requires a node-postgres Pool instance.");
  }
  const [{ drizzle }, schema] = await Promise.all([
    import("drizzle-orm/node-postgres"),
    import("../state/postgres-schema.ts"),
  ]);

  // Drizzle recognizes this pool and checks out a client for each transaction.
  // An explicit client keeps caller-added fields separate from Drizzle config.
  return { schema, database: drizzle({ client: pool, schema }) };
};
