DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM occ.agents) THEN
    RAISE EXCEPTION
      'Configuration migration requires an empty Agent table; export and recreate existing Agents before cutover'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.configuration_values_are_flat(configuration jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(configuration) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(configuration) AS entry
      WHERE jsonb_typeof(entry.value) <> 'string'
    );
$$;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_configuration_values_flat
  CHECK (occ.configuration_values_are_flat(admitted_spec->'draft_spec'));
--> statement-breakpoint
CREATE TABLE occ.configurations (
  id text PRIMARY KEY,
  namespace_id text NOT NULL REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  CONSTRAINT configurations_id_format CHECK (
    id ~ '^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT configurations_namespace_id_id_unique UNIQUE (namespace_id, id)
);
--> statement-breakpoint
ALTER TABLE occ.agents DROP COLUMN draft_spec;
--> statement-breakpoint
ALTER TABLE occ.agents ADD COLUMN configuration_id text NOT NULL;
--> statement-breakpoint
ALTER TABLE occ.agents ADD CONSTRAINT agents_configuration_owner
  FOREIGN KEY (namespace_id, configuration_id)
  REFERENCES occ.configurations(namespace_id, id)
  ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions DROP CONSTRAINT iam_restrictions_resource_kind_valid;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions ADD CONSTRAINT iam_restrictions_resource_kind_valid
  CHECK (resource_kind IN ('installation', 'namespace', 'configuration', 'agent', 'agent_revision'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.resource_belongs_to_namespace(
  checked_namespace_id text,
  checked_resource_kind text,
  checked_resource_id text
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF checked_namespace_id IS NULL THEN
    RETURN true;
  END IF;
  IF checked_resource_kind = 'installation' THEN
    RETURN false;
  END IF;
  IF checked_resource_id IS NULL THEN
    RETURN true;
  END IF;
  IF checked_resource_kind = 'namespace' THEN
    RETURN checked_resource_id = checked_namespace_id;
  ELSIF checked_resource_kind = 'configuration' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.configurations
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'agent' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.agents
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'agent_revision' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.agent_revisions
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  END IF;
  RETURN false;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.validate_namespace_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a deleted namespace is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'provisioning' AND NEW.status IN ('ready', 'failed', 'deleting'))
    OR (OLD.status IN ('ready', 'failed') AND NEW.status = 'deleting')
  ) THEN
    RAISE EXCEPTION 'invalid namespace lifecycle transition' USING ERRCODE = '23514';
  END IF;

  IF NEW.deleted_at IS NOT NULL AND (
    NEW.status <> 'deleting' OR NEW.deleted_at < NEW.created_at
  ) THEN
    RAISE EXCEPTION 'invalid namespace tombstone' USING ERRCODE = '23514';
  END IF;
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND (
    EXISTS (SELECT 1 FROM occ.agents WHERE namespace_id = NEW.id)
    OR EXISTS (SELECT 1 FROM occ.configurations WHERE namespace_id = NEW.id)
  ) THEN
    RAISE EXCEPTION 'a nonempty namespace cannot be tombstoned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER configuration_ownership_is_immutable
BEFORE UPDATE ON occ.configurations
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.configurations FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.configurations TO occ_app;
--> statement-breakpoint
GRANT UPDATE (configuration_id, execution_mode) ON occ.agents TO occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.configuration_values_are_flat(jsonb) TO occ_app;
