import type {
  SchemaAuthBindingFactoryV1,
  SchemaAuthBoundaryV1,
  SchemaAuthSchemaV1,
} from "@openclaw-enterprise/occ/auth-persistence/schema-auth-boundary-v1";

type Pool = Parameters<SchemaAuthBindingFactoryV1>[0];
type Database = SchemaAuthBoundaryV1["database"];

// Supplied canonical values exercise the producer contract without claiming to
// construct a real Drizzle database or establish runtime pool/schema identity.
export function producerFixture(
  schema: SchemaAuthSchemaV1,
  databaseForPool: (pool: Pool) => Promise<Database>,
): SchemaAuthBindingFactoryV1 {
  return async (pool) => ({ schema, database: await databaseForPool(pool) });
}

export async function consumeProducedBinding(factory: SchemaAuthBindingFactoryV1, pool: Pool) {
  const binding = await factory(pool);
  // Query inference must retain the original column names and selected types.
  const rows = await binding.database
    .select({ id: binding.schema.user.id, verified: binding.schema.user.emailVerified })
    .from(binding.schema.user);
  const selected: { id: string; verified: boolean }[] = rows;
  return selected;
}
