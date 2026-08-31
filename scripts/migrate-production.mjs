import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.OCC_MIGRATION_DATABASE_URL;
let pool;

try {
  if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
    throw new Error("OCC_MIGRATION_DATABASE_URL must contain the dedicated migrator credential.");
  }
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("The migration connection must identify a PostgreSQL database.");
  }

  const dependency = createRequire(new URL("../packages/occ/package.json", import.meta.url));
  const { Pool } = dependency("pg");
  const { drizzle } = dependency("drizzle-orm/node-postgres");
  const { migrate } = dependency("drizzle-orm/node-postgres/migrator");
  pool = new Pool({ connectionString: databaseUrl, max: 1 });
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  process.stdout.write(`${JSON.stringify({ event: "migration.completed" })}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      event: "migration.failed",
      error: error instanceof Error ? error.message : "The reviewed migrations failed.",
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  if (pool !== undefined) await pool.end();
}
