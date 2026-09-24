import type { PoolClient } from "pg";
import { createPostgresAuthBinding } from "@openclaw-enterprise/occ";
import type {
  SchemaAuthAdapterOptionsV1,
  SchemaAuthBoundaryV1,
  SchemaAuthSchemaV1,
} from "@openclaw-enterprise/occ";

declare const pool: Parameters<typeof createPostgresAuthBinding>[0];
declare const binding: SchemaAuthBoundaryV1;
declare const replacement: SchemaAuthBoundaryV1;
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
void binding.schema.user.nonexistent;
// @ts-expect-error The selected original namespace has no installationId column.
void binding.schema.namespaces.installationId;
// @ts-expect-error The database cannot be replaced through the readonly boundary.
binding.database = replacement.database;
// @ts-expect-error The schema cannot be replaced through the readonly boundary.
binding.schema = replacement.schema;
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

// @ts-expect-error The full schema must accompany the database.
const _withoutSchema: SchemaAuthBoundaryV1 = { database: binding.database };
// @ts-expect-error The binding must expose a typed database.
const _withoutDatabase: SchemaAuthBoundaryV1 = { schema: binding.schema };
// @ts-expect-error Authentication tables alone are not the complete schema.
const _authOnly: SchemaAuthSchemaV1 = {
  user: binding.schema.user,
  session: binding.schema.session,
};
// @ts-expect-error Core resource tables alone are not the complete schema.
const _coreOnly: SchemaAuthSchemaV1 = { namespaces: binding.schema.namespaces };
declare const unknownValue: unknown;
// @ts-expect-error Unknown database values cannot cross this typed boundary.
const _unknownDatabase: SchemaAuthBoundaryV1["database"] = unknownValue;
// @ts-expect-error Unknown schema values cannot cross this typed boundary.
const _unknownSchema: SchemaAuthSchemaV1 = unknownValue;
// @ts-expect-error Only the existing PostgreSQL provider is supported.
const _wrongProvider: SchemaAuthAdapterOptionsV1["provider"] = "mysql";
// @ts-expect-error Existing camelCase mapping remains enabled.
const _wrongCasing: SchemaAuthAdapterOptionsV1["camelCase"] = false;
declare const client: PoolClient;
// @ts-expect-error A checked-out transaction client is not the pool.
createPostgresAuthBinding(client);
