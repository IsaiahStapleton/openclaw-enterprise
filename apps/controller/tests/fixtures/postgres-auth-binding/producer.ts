import { createPostgresAuthBinding, createPostgresPool } from "@openclaw-enterprise/occ";
import type { SchemaAuthBindingFactoryV1 } from "@openclaw-enterprise/occ";

const factory: SchemaAuthBindingFactoryV1 = createPostgresAuthBinding;
export async function produceBinding(pool: Parameters<SchemaAuthBindingFactoryV1>[0]) {
  const binding = await factory(pool);
  // The actual producer preserves query inference through the original columns.
  const rows = await binding.database
    .select({ id: binding.schema.user.id, verified: binding.schema.user.emailVerified })
    .from(binding.schema.user);
  const selected: { id: string; verified: boolean }[] = rows;
  return selected;
}

// Production and development composition use this actual pool producer.
export type ConfiguredPoolFitsFactory =
  Awaited<ReturnType<typeof createPostgresPool>> extends Parameters<SchemaAuthBindingFactoryV1>[0]
    ? true
    : never;
const configuredPoolFitsFactory: ConfiguredPoolFitsFactory = true;
void configuredPoolFitsFactory;
