type CanonicalSchema = typeof import("../state/postgres-schema.ts");

/** The existing schema root; a consumer must not construct a second pgSchema. */
export type CoreSchemaRootV1 = CanonicalSchema["occSchema"];

/**
 * A type view of the five core tables. Their original columns, checks, indexes
 * and foreign-key targets stay with the canonical table objects.
 * This view is not a replacement runtime schema for the auth adapter.
 */
export type CoreResourceSchemaV1 = Readonly<
  Pick<
    CanonicalSchema,
    "installation" | "namespaces" | "configurations" | "secrets" | "serviceAccounts"
  >
>;

/**
 * Auth model metadata only. The adapter still receives the complete canonical
 * schema, including other domain exports. apikey.referenceId has no
 * inferred IAM foreign key.
 */
export type AuthTableSchemaV1 = Readonly<
  Pick<CanonicalSchema, "user" | "session" | "account" | "verification" | "apikey">
>;
