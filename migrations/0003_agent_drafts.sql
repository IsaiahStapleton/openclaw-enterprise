ALTER TABLE occ.agents
ADD COLUMN draft_spec jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE occ.agents
ADD CONSTRAINT agents_draft_spec_object CHECK (jsonb_typeof(draft_spec) = 'object');
--> statement-breakpoint
GRANT UPDATE (draft_spec) ON occ.agents TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions
ADD CONSTRAINT agent_revisions_admitted_snapshot CHECK (
  admitted_spec ?& ARRAY['draft_spec', 'harness', 'compute']
  AND admitted_spec - 'draft_spec' - 'harness' - 'compute' = '{}'::jsonb
  AND jsonb_typeof(admitted_spec->'draft_spec') = 'object'
  AND jsonb_typeof(admitted_spec->'harness') = 'object'
  AND (admitted_spec->'harness') ?& ARRAY['id', 'version']
  AND (admitted_spec->'harness') - 'id' - 'version' = '{}'::jsonb
  AND jsonb_typeof(admitted_spec #> '{harness,id}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{harness,id}'), '') <> ''
  AND jsonb_typeof(admitted_spec #> '{harness,version}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{harness,version}'), '') <> ''
  AND jsonb_typeof(admitted_spec->'compute') = 'object'
  AND (admitted_spec->'compute') ?& ARRAY['id', 'implementation']
  AND (admitted_spec->'compute') - 'id' - 'implementation' = '{}'::jsonb
  AND jsonb_typeof(admitted_spec #> '{compute,id}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{compute,id}'), '') <> ''
  AND jsonb_typeof(admitted_spec #> '{compute,implementation}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{compute,implementation}'), '') <> ''
);
--> statement-breakpoint
ALTER TABLE occ.controller_work
DROP CONSTRAINT controller_work_namespace_target_valid,
ADD CONSTRAINT controller_work_namespace_target_valid CHECK (
  (agent_id IS NULL AND revision_id IS NULL AND namespace_target IS NOT NULL
    AND namespace_target IN ('ready', 'deleted'))
  OR (agent_id IS NOT NULL AND revision_id IS NOT NULL AND namespace_target IS NULL)
);
