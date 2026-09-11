import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { BetterAuthOptions } from "better-auth";
import type {
  SchemaAuthAdapterOptionsV1,
  SchemaAuthBindingFactoryV1,
  SchemaAuthBoundaryV1,
} from "@openclaw-enterprise/occ/auth-persistence/schema-auth-boundary-v1";

export function consumeAuthBinding(
  binding: SchemaAuthBoundaryV1,
): NonNullable<BetterAuthOptions["database"]> {
  const options = {
    provider: "pg",
    schema: binding.schema,
    camelCase: true,
    transaction: true,
  } satisfies SchemaAuthAdapterOptionsV1;
  return drizzleAdapter(binding.database, options);
}

export async function composeAuthDatabase(
  factory: SchemaAuthBindingFactoryV1,
  pool: Parameters<SchemaAuthBindingFactoryV1>[0],
): Promise<NonNullable<BetterAuthOptions["database"]>> {
  return consumeAuthBinding(await factory(pool));
}
