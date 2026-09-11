import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { BetterAuthOptions } from "better-auth";
import { createPostgresAuthBinding } from "@openclaw-enterprise/occ/auth-persistence/postgres-auth-binding";
import type { SchemaAuthAdapterOptionsV1 } from "@openclaw-enterprise/occ/auth-persistence/schema-auth-boundary-v1";

export async function consumeBinding(pool: Parameters<typeof createPostgresAuthBinding>[0]) {
  const binding = await createPostgresAuthBinding(pool);
  const options = {
    provider: "pg",
    schema: binding.schema,
    camelCase: true,
    transaction: true,
  } satisfies SchemaAuthAdapterOptionsV1;
  const database: NonNullable<BetterAuthOptions["database"]> = drizzleAdapter(
    binding.database,
    options,
  );
  return database;
}
