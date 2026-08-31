DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM occ.configurations)
    OR EXISTS (SELECT 1 FROM occ.agent_revisions) THEN
    RAISE EXCEPTION
      'Configuration kind migration requires empty Configuration and AgentRevision tables; export and recreate existing resources before cutover'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.configurations
  ADD COLUMN kind text NOT NULL,
  ADD COLUMN generation bigint NOT NULL,
  ADD CONSTRAINT configurations_kind_valid CHECK (kind = 'agent'),
  ADD CONSTRAINT configurations_generation_valid
    CHECK (generation BETWEEN 1 AND 9007199254740991);
--> statement-breakpoint
CREATE FUNCTION occ.validate_configuration_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.namespace_id IS DISTINCT FROM OLD.namespace_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'configuration identity, owner, kind, and creation time are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.generation <> OLD.generation + 1 THEN
    RAISE EXCEPTION 'configuration generation must advance exactly once'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER configuration_ownership_is_immutable ON occ.configurations;
--> statement-breakpoint
CREATE TRIGGER configuration_ownership_is_immutable
BEFORE UPDATE ON occ.configurations
FOR EACH ROW EXECUTE FUNCTION occ.validate_configuration_ownership();
--> statement-breakpoint
GRANT UPDATE (generation) ON occ.configurations TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions DROP CONSTRAINT agent_revisions_admitted_snapshot;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_admitted_snapshot CHECK (
  admitted_spec ?& ARRAY[
    'configuration_id', 'configuration_kind', 'configuration_generation',
    'draft_spec', 'harness', 'compute'
  ]
  AND admitted_spec
    - 'configuration_id' - 'configuration_kind' - 'configuration_generation'
    - 'draft_spec' - 'harness' - 'compute' = '{}'::jsonb
  AND jsonb_typeof(admitted_spec->'configuration_id') = 'string'
  AND (admitted_spec->>'configuration_id')
    ~ '^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND jsonb_typeof(admitted_spec->'configuration_kind') = 'string'
  AND admitted_spec->>'configuration_kind' = 'agent'
  AND jsonb_typeof(admitted_spec->'configuration_generation') = 'number'
  AND (admitted_spec->>'configuration_generation')::numeric
    BETWEEN 1 AND 9007199254740991
  AND mod((admitted_spec->>'configuration_generation')::numeric, 1) = 0
  AND jsonb_typeof(admitted_spec->'draft_spec') = 'object'
  AND jsonb_typeof(admitted_spec->'harness') = 'object'
  AND (admitted_spec->'harness') ?& ARRAY['id', 'version', 'mode']
  AND (admitted_spec->'harness') - 'id' - 'version' - 'mode' = '{}'::jsonb
  AND jsonb_typeof(admitted_spec #> '{harness,id}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{harness,id}'), '') <> ''
  AND jsonb_typeof(admitted_spec #> '{harness,version}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{harness,version}'), '') <> ''
  AND jsonb_typeof(admitted_spec #> '{harness,mode}') = 'string'
  AND (admitted_spec #>> '{harness,mode}') IN ('embedded', 'dedicated')
  AND jsonb_typeof(admitted_spec->'compute') = 'object'
  AND (admitted_spec->'compute') ?& ARRAY['id', 'implementation']
  AND (admitted_spec->'compute') - 'id' - 'implementation' = '{}'::jsonb
  AND jsonb_typeof(admitted_spec #> '{compute,id}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{compute,id}'), '') <> ''
  AND jsonb_typeof(admitted_spec #> '{compute,implementation}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{compute,implementation}'), '') <> ''
);
