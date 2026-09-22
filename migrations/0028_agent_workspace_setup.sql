CREATE FUNCTION occ.workspace_setup_files_valid(files jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE entry record;
BEGIN
  IF files IS NULL OR jsonb_typeof(files) <> 'object' OR files = '{}'::jsonb THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT key, value FROM jsonb_each(files) LOOP
    IF entry.key NOT IN ('AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md')
      OR jsonb_typeof(entry.value) <> 'string'
      OR octet_length(entry.value #>> '{}') > 16384 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE TABLE occ.workspace_setups (
  id text PRIMARY KEY CONSTRAINT workspace_setups_id_length CHECK (char_length(id) BETWEEN 1 AND 200),
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  defaults_id text CONSTRAINT workspace_setups_defaults_id_valid CHECK (defaults_id ~ '^[a-f0-9]{64}$'),
  files jsonb,
  completed boolean NOT NULL DEFAULT false,
  CONSTRAINT workspace_setups_agent_unique UNIQUE (namespace_id, agent_id),
  CONSTRAINT workspace_setups_agent_owner FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT workspace_setups_completion_valid CHECK (
    (completed AND files IS NULL) OR (NOT completed AND occ.workspace_setup_files_valid(files))
  )
);
--> statement-breakpoint
CREATE FUNCTION occ.validate_workspace_setup() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.completed OR NOT EXISTS (
      SELECT 1 FROM occ.agents WHERE namespace_id = NEW.namespace_id AND id = NEW.agent_id
        AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'workspace setup requires an active Agent and pending files' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.namespace_id IS DISTINCT FROM OLD.namespace_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.defaults_id IS DISTINCT FROM OLD.defaults_id
     OR (OLD.completed AND NEW IS DISTINCT FROM OLD)
     OR (NOT NEW.completed AND NEW.files IS DISTINCT FROM OLD.files) THEN
    RAISE EXCEPTION 'workspace setup identity and submitted input are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workspace_setup_lifecycle BEFORE INSERT OR UPDATE ON occ.workspace_setups
FOR EACH ROW EXECUTE FUNCTION occ.validate_workspace_setup();
--> statement-breakpoint
REVOKE ALL ON occ.workspace_setups FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.workspace_setups TO occ_app;
--> statement-breakpoint
GRANT UPDATE (files, completed) ON occ.workspace_setups TO occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.workspace_setup_files_valid(jsonb) TO occ_app;
