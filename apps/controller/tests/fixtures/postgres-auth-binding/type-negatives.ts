import { createPostgresAuthBinding } from "@openclaw-enterprise/occ/auth-persistence/postgres-auth-binding";
import type {
  SchemaAuthAdapterOptionsV1,
  SchemaAuthBoundaryV1,
} from "@openclaw-enterprise/occ/auth-persistence/schema-auth-boundary-v1";

declare const pool: Parameters<typeof createPostgresAuthBinding>[0];
declare const binding: SchemaAuthBoundaryV1;
// @ts-expect-error Construction accepts the original caller pool, not a URL.
createPostgresAuthBinding("postgresql://localhost/example");
// @ts-expect-error A query-only object does not provide pool connect/end ownership.
createPostgresAuthBinding({ query: async () => ({ rows: [] }) });
// @ts-expect-error A checked-out client cannot replace the owning pool.
createPostgresAuthBinding({ query: async () => ({ rows: [] }), release() {} });
// @ts-expect-error Construction remains asynchronous.
const synchronous: SchemaAuthBoundaryV1 = createPostgresAuthBinding(pool);
// @ts-expect-error The binding offers no pool teardown operation.
binding.end();
// @ts-expect-error The schema retains its real inferred columns.
binding.schema.user.nonexistent;
// @ts-expect-error The selected original namespace has no installationId column.
binding.schema.namespaces.installationId;
// @ts-expect-error The database cannot be replaced through the readonly boundary.
binding.database = binding.database;
// @ts-expect-error The schema cannot be replaced through the readonly boundary.
binding.schema = binding.schema;
const options: SchemaAuthAdapterOptionsV1 = {
  provider: "pg",
  schema: binding.schema,
  camelCase: true,
  // @ts-expect-error The actual auth adapter must retain transactions.
  transaction: false,
};
void synchronous;
void options;

// @ts-expect-error A connect/end wrapper is not a real node-postgres pool.
createPostgresAuthBinding({ connect: pool.connect.bind(pool), end: pool.end.bind(pool) });
// @ts-expect-error Adding query does not preserve Drizzle pool transaction detection.
createPostgresAuthBinding({
  connect: pool.connect.bind(pool),
  end: pool.end.bind(pool),
  query: pool.query.bind(pool),
});
