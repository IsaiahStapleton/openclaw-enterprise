-- Local-only PostgreSQL bootstrap. Production administrators provision these
-- roles and schemas using deployment-managed credentials instead.
CREATE ROLE occ_migrator
  LOGIN PASSWORD 'occ-migrator-local'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE ROLE occ_app
  LOGIN PASSWORD 'occ-app-local'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- Drizzle always issues CREATE SCHEMA IF NOT EXISTS for its migration history,
-- and PostgreSQL requires database CREATE even when that schema already exists.
GRANT CREATE ON DATABASE openclaw_enterprise TO occ_migrator;

CREATE SCHEMA occ AUTHORIZATION occ_migrator;
CREATE SCHEMA drizzle AUTHORIZATION occ_migrator;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
