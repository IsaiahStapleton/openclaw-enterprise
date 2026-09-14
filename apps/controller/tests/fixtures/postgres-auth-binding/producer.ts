import { createPostgresAuthBinding } from "@openclaw-enterprise/occ";
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

export function produceStructuralBinding(pool: Parameters<SchemaAuthBindingFactoryV1>[0]) {
  const structuralPool = {
    connect: () => pool.connect(),
    end: () => pool.end(),
    schema: {},
  };
  // @ts-expect-error A structural wrapper cannot guarantee pinned pool transactions.
  return factory(structuralPool);
}
