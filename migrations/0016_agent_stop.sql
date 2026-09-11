ALTER TABLE occ.agents
  ADD COLUMN desired_runtime_state text NOT NULL DEFAULT 'stopped',
  ADD CONSTRAINT agents_desired_runtime_state_valid
    CHECK (desired_runtime_state IN ('running', 'stopped'));
--> statement-breakpoint
GRANT UPDATE (desired_runtime_state) ON occ.agents TO occ_app;
--> statement-breakpoint
-- occ_app retains table-level INSERT, so creation intent must be enforced by
-- the database rather than application convention alone.
CREATE FUNCTION occ.validate_agent_initial_runtime_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.desired_runtime_state <> 'stopped' THEN
    RAISE EXCEPTION 'a new agent must be stopped'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_initial_runtime_state_is_valid';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_initial_runtime_state_is_valid
BEFORE INSERT ON occ.agents
FOR EACH ROW EXECUTE FUNCTION occ.validate_agent_initial_runtime_state();
--> statement-breakpoint
ALTER TABLE occ.controller_work
  ADD COLUMN agent_target text,
  ADD CONSTRAINT controller_work_agent_target_valid
    CHECK (agent_target IS NULL OR agent_target = 'stopped');
--> statement-breakpoint
ALTER TABLE occ.controller_work
  DROP CONSTRAINT controller_work_namespace_target_valid,
  ADD CONSTRAINT controller_work_namespace_target_valid CHECK (
    (agent_id IS NULL AND revision_id IS NULL
      AND namespace_target IN ('ready', 'deleted') AND agent_target IS NULL)
    OR (agent_id IS NOT NULL AND revision_id IS NULL
      AND namespace_target IS NULL AND agent_target = 'stopped')
    OR (agent_id IS NOT NULL AND revision_id IS NOT NULL
      AND namespace_target IS NULL AND agent_target IS NULL)
  );
