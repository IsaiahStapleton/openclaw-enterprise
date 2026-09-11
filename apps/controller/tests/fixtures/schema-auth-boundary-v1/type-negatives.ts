import type {
  SchemaAuthAdapterOptionsV1,
  SchemaAuthBindingFactoryV1,
  SchemaAuthBoundaryV1,
  SchemaAuthSchemaV1,
} from "@openclaw-enterprise/occ/auth-persistence/schema-auth-boundary-v1";
import type {
  AuthTableSchemaV1,
  CoreResourceSchemaV1,
} from "@openclaw-enterprise/occ/schema/core-schema-boundary-v1";

declare const factory: SchemaAuthBindingFactoryV1;
declare const binding: SchemaAuthBoundaryV1;
declare const schema: SchemaAuthSchemaV1;
declare const core: CoreResourceSchemaV1;
declare const auth: AuthTableSchemaV1;
declare const queryClient: { query(sql: string): Promise<unknown> };
declare const client: Awaited<ReturnType<Parameters<SchemaAuthBindingFactoryV1>[0]["connect"]>>;

// @ts-expect-error The caller supplies a pool, never a connection URL.
factory("postgres://localhost/example");
// @ts-expect-error Query access is not caller-owned pool lifecycle capability.
factory(queryClient);
// @ts-expect-error A checked-out transaction client is not the pool.
factory(client);
// @ts-expect-error The full schema must accompany the database.
const withoutSchema: SchemaAuthBoundaryV1 = { database: binding.database };
// @ts-expect-error The binding must expose a typed database.
const withoutDatabase: SchemaAuthBoundaryV1 = { schema };
// @ts-expect-error An auth-model projection is not the full canonical namespace.
const authOnly: SchemaAuthSchemaV1 = auth;
// @ts-expect-error A core-table projection is not the full canonical namespace.
const coreOnly: SchemaAuthSchemaV1 = core;
// @ts-expect-error Unknown database values cannot cross this typed boundary.
const unknownDatabase: SchemaAuthBoundaryV1["database"] = {} as unknown;
// @ts-expect-error Unknown schema values cannot cross this typed boundary.
const unknownSchema: SchemaAuthSchemaV1 = {} as unknown;
// @ts-expect-error Factory construction retains its asynchronous failure surface.
const synchronousFactory: SchemaAuthBindingFactoryV1 = () => binding;

// @ts-expect-error Only the existing PostgreSQL provider is supported.
const wrongProvider: SchemaAuthAdapterOptionsV1["provider"] = "mysql";
// @ts-expect-error Existing camelCase mapping remains enabled.
const wrongCasing: SchemaAuthAdapterOptionsV1["camelCase"] = false;
// @ts-expect-error Adapter-owned transactions remain enabled.
const wrongTransaction: SchemaAuthAdapterOptionsV1["transaction"] = false;
// @ts-expect-error Binding fields cannot be replaced through the public type.
binding.schema = schema;
// @ts-expect-error Database ownership cannot be reassigned through the binding.
binding.database = binding.database;
// @ts-expect-error The binding does not acquire pool teardown ownership.
binding.close();
// @ts-expect-error The binding does not acquire pool teardown ownership.
binding.end();
// @ts-expect-error Core views do not expose the excluded Agent domain.
core.agents;
// @ts-expect-error Namespace has no invented Installation ownership column.
core.namespaces.installationId;
// @ts-expect-error Core table entries cannot be replaced through the view.
core.namespaces = core.namespaces;
// @ts-expect-error Auth metadata does not expose an invented IAM table.
auth.iamIdentities;
// @ts-expect-error Typed database selection rejects unknown columns.
binding.database.select({ id: binding.schema.user.nonexistentColumn });
