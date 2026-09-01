DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM occ.service_account_driver_bindings) THEN
    RAISE EXCEPTION
      'Provider migration requires managed ServiceAccount bindings to be cleaned up before cutover'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM occ.agent_revisions
    WHERE NOT (admitted_spec ? 'provider_id')
  ) THEN
    RAISE EXCEPTION
      'Provider migration requires AgentRevisions to be recreated with explicit provider_id'
      USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.agents ADD COLUMN provider_id text;
--> statement-breakpoint
ALTER TABLE occ.agents ADD CONSTRAINT agents_provider_id_valid CHECK (
  provider_id IS NULL OR (
    char_length(provider_id) BETWEEN 1 AND 200
    AND provider_id = btrim(provider_id)
    AND provider_id !~ '[[:cntrl:]]'
  )
);
--> statement-breakpoint
ALTER TABLE occ.service_account_driver_bindings
  DROP CONSTRAINT service_account_driver_bindings_external_account_unique;
--> statement-breakpoint
DROP TRIGGER service_account_driver_binding_identity_is_immutable
ON occ.service_account_driver_bindings;
--> statement-breakpoint
ALTER TABLE occ.service_account_driver_bindings ADD COLUMN provider_id text NOT NULL;
--> statement-breakpoint
ALTER TABLE occ.service_account_driver_bindings
  ADD CONSTRAINT service_account_driver_bindings_external_account_unique
  UNIQUE (driver_id, workspace_id, external_account_id);
--> statement-breakpoint
ALTER TABLE occ.service_account_driver_bindings
  ADD CONSTRAINT service_account_driver_bindings_provider_id_valid CHECK (
    char_length(provider_id) BETWEEN 1 AND 200 AND provider_id = btrim(provider_id)
  );
--> statement-breakpoint
CREATE TRIGGER service_account_driver_binding_identity_is_immutable
BEFORE UPDATE OF service_account_id, namespace_id, provider_id, driver_id,
  external_account_id, workspace_id
ON occ.service_account_driver_bindings
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
ALTER TABLE occ.agent_revisions DROP CONSTRAINT agent_revisions_admitted_snapshot;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_admitted_snapshot CHECK (
  admitted_spec ?& ARRAY[
    'configuration_id', 'configuration_kind', 'configuration_generation',
    'draft_spec', 'provider_id', 'harness', 'compute'
  ]
  AND admitted_spec
    - 'configuration_id' - 'configuration_kind' - 'configuration_generation'
    - 'draft_spec' - 'provider_id' - 'harness' - 'compute' - 'sandbox_driver_id'
    - 'secret_driver_id' - 'secret_bindings' - 'service_account' = '{}'::jsonb
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
  AND (
    jsonb_typeof(admitted_spec->'provider_id') = 'null'
    OR (
      jsonb_typeof(admitted_spec->'provider_id') = 'string'
      AND char_length(admitted_spec->>'provider_id') BETWEEN 1 AND 200
      AND admitted_spec->>'provider_id' = btrim(admitted_spec->>'provider_id')
      AND admitted_spec->>'provider_id' !~ '[[:cntrl:]]'
    )
  )
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
  AND (
    NOT (admitted_spec ? 'sandbox_driver_id')
    OR (
      jsonb_typeof(admitted_spec->'sandbox_driver_id') = 'string'
      AND COALESCE(btrim(admitted_spec->>'sandbox_driver_id'), '') <> ''
    )
  )
  AND (
    NOT (admitted_spec ? 'secret_driver_id')
    OR (
      jsonb_typeof(admitted_spec->'secret_driver_id') = 'string'
      AND COALESCE(btrim(admitted_spec->>'secret_driver_id'), '') <> ''
    )
  )
  AND (
    NOT (admitted_spec ? 'secret_bindings')
    OR occ.secret_bindings_are_valid(admitted_spec->'secret_bindings', namespace_id)
  )
  AND (
    NOT (admitted_spec ? 'service_account')
    OR (
      jsonb_typeof(admitted_spec->'service_account') = 'object'
      AND (admitted_spec->'service_account') ?& ARRAY['id', 'credential']
      AND (admitted_spec->'service_account') - 'id' - 'credential' = '{}'::jsonb
      AND jsonb_typeof(admitted_spec #> '{service_account,id}') = 'string'
      AND (admitted_spec #>> '{service_account,id}')
        ~ '^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND jsonb_typeof(admitted_spec #> '{service_account,credential}') = 'object'
      AND (admitted_spec #> '{service_account,credential}') ?& ARRAY['kind', 'secretRef']
      AND (admitted_spec #> '{service_account,credential}') - 'kind' - 'secretRef' = '{}'::jsonb
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,kind}') = 'string'
      AND (admitted_spec #>> '{service_account,credential,kind}') IN ('api_key', 'access_token')
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,secretRef}') = 'object'
      AND (admitted_spec #> '{service_account,credential,secretRef}') ?& ARRAY['name', 'key']
      AND (admitted_spec #> '{service_account,credential,secretRef}') - 'name' - 'key' = '{}'::jsonb
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,secretRef,name}') = 'string'
      AND char_length(admitted_spec #>> '{service_account,credential,secretRef,name}')
        BETWEEN 1 AND 253
      AND (admitted_spec #>> '{service_account,credential,secretRef,name}')
        ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,secretRef,key}') = 'string'
      AND char_length(admitted_spec #>> '{service_account,credential,secretRef,key}')
        BETWEEN 1 AND 253
      AND (admitted_spec #>> '{service_account,credential,secretRef,key}')
        ~ '^[-._a-zA-Z0-9]+$'
      AND (admitted_spec #>> '{service_account,credential,secretRef,key}') NOT IN ('.', '..')
    )
  )
);
--> statement-breakpoint
GRANT UPDATE (provider_id) ON occ.agents TO occ_app;
