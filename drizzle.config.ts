import { defineConfig } from "drizzle-kit";

const migrationDatabaseUrl = process.env.OCC_MIGRATION_DATABASE_URL;

if (!migrationDatabaseUrl) {
  throw new Error("OCC_MIGRATION_DATABASE_URL must contain the dedicated migrator credential.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/occ/src/state/postgres-schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: migrationDatabaseUrl,
  },
  migrations: {
    schema: "drizzle",
    table: "__drizzle_migrations",
  },
  schemaFilter: ["occ"],
  strict: true,
  verbose: true,
});
