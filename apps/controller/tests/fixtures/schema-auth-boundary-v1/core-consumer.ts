import type {
  AuthTableSchemaV1,
  CoreResourceSchemaV1,
  CoreSchemaRootV1,
  SchemaAuthSchemaV1,
} from "@openclaw-enterprise/occ";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type ExactCoreTables = Assert<
  Equal<
    keyof CoreResourceSchemaV1,
    "installation" | "namespaces" | "configurations" | "secrets" | "serviceAccounts"
  >
>;
export type ExactAuthTables = Assert<
  Equal<keyof AuthTableSchemaV1, "user" | "session" | "account" | "verification" | "apikey">
>;
export type OriginalRootType = Assert<Equal<CoreSchemaRootV1, SchemaAuthSchemaV1["occSchema"]>>;
export type OriginalTableTypes = Assert<
  Equal<CoreResourceSchemaV1, Readonly<Pick<SchemaAuthSchemaV1, keyof CoreResourceSchemaV1>>>
>;
export type OriginalAuthTypes = Assert<
  Equal<AuthTableSchemaV1, Readonly<Pick<SchemaAuthSchemaV1, keyof AuthTableSchemaV1>>>
>;

export function consumeCoreSchema(
  core: CoreResourceSchemaV1,
  auth: AuthTableSchemaV1,
  replacement: CoreResourceSchemaV1,
) {
  const namespaceId: SchemaAuthSchemaV1["configurations"]["namespaceId"] =
    core.configurations.namespaceId;
  const sessionUserId: SchemaAuthSchemaV1["session"]["userId"] = auth.session.userId;
  const accountUserId: SchemaAuthSchemaV1["account"]["userId"] = auth.account.userId;
  const keyReferenceId: SchemaAuthSchemaV1["apikey"]["referenceId"] = auth.apikey.referenceId;
  // @ts-expect-error The narrowed core view excludes the Agent domain.
  void core.agents;
  // @ts-expect-error Namespace has no invented Installation ownership column.
  void core.namespaces.installationId;
  // @ts-expect-error Core table entries are readonly through the public view.
  core.namespaces = replacement.namespaces;
  // @ts-expect-error Auth metadata excludes IAM tables.
  void auth.iamIdentities;
  return { namespaceId, sessionUserId, accountUserId, keyReferenceId };
}
