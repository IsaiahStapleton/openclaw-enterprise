CREATE TABLE occ.service_account_driver_bindings (
  service_account_id text PRIMARY KEY,
  namespace_id text NOT NULL,
  driver_id text NOT NULL,
  external_account_id text NOT NULL,
  external_credential_id text,
  workspace_id text NOT NULL,
  CONSTRAINT service_account_driver_bindings_account_owner
    FOREIGN KEY (namespace_id, service_account_id)
    REFERENCES occ.service_accounts(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT service_account_driver_bindings_external_account_unique
    UNIQUE (driver_id, workspace_id, external_account_id),
  CONSTRAINT service_account_driver_bindings_driver_id_valid CHECK (
    char_length(driver_id) BETWEEN 1 AND 200 AND driver_id = btrim(driver_id)
  ),
  CONSTRAINT service_account_driver_bindings_external_account_id_valid CHECK (
    char_length(external_account_id) BETWEEN 1 AND 200
    AND external_account_id = btrim(external_account_id)
  ),
  CONSTRAINT service_account_driver_bindings_external_credential_id_valid CHECK (
    external_credential_id IS NULL OR (
      char_length(external_credential_id) BETWEEN 1 AND 200
      AND external_credential_id = btrim(external_credential_id)
    )
  ),
  CONSTRAINT service_account_driver_bindings_workspace_id_valid CHECK (
    char_length(workspace_id) BETWEEN 1 AND 200 AND workspace_id = btrim(workspace_id)
  )
);
--> statement-breakpoint
CREATE TRIGGER service_account_driver_binding_identity_is_immutable
BEFORE UPDATE OF service_account_id, namespace_id, driver_id, external_account_id, workspace_id
ON occ.service_account_driver_bindings
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
ALTER TABLE occ.service_accounts DROP CONSTRAINT service_accounts_credential_valid;
--> statement-breakpoint
ALTER TABLE occ.service_accounts ADD CONSTRAINT service_accounts_credential_valid CHECK (
  credential IS NULL OR (
    jsonb_typeof(credential) = 'object'
    AND credential ?& ARRAY['kind', 'secretRef']
    AND credential - 'kind' - 'secretRef' = '{}'::jsonb
    AND jsonb_typeof(credential->'kind') = 'string'
    AND credential->>'kind' IN ('api_key', 'oauth_access_token', 'access_token')
    AND jsonb_typeof(credential->'secretRef') = 'object'
    AND (credential->'secretRef') ?& ARRAY['name', 'key']
    AND (credential->'secretRef') - 'name' - 'key' = '{}'::jsonb
    AND jsonb_typeof(credential #> '{secretRef,name}') = 'string'
    AND char_length(credential #>> '{secretRef,name}') BETWEEN 1 AND 253
    AND (credential #>> '{secretRef,name}')
      ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'
    AND jsonb_typeof(credential #> '{secretRef,key}') = 'string'
    AND char_length(credential #>> '{secretRef,key}') BETWEEN 1 AND 253
    AND (credential #>> '{secretRef,key}') ~ '^[-._a-zA-Z0-9]+$'
    AND (credential #>> '{secretRef,key}') NOT IN ('.', '..')
  )
);
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
    - 'draft_spec' - 'harness' - 'compute' - 'service_account' = '{}'::jsonb
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
  AND (
    NOT (admitted_spec ? 'service_account')
    OR (
      jsonb_typeof(admitted_spec->'service_account') = 'object'
      AND (admitted_spec->'service_account') ?& ARRAY['id', 'credential']
      AND (admitted_spec->'service_account')
        - 'id' - 'credential' = '{}'::jsonb
      AND jsonb_typeof(admitted_spec #> '{service_account,id}') = 'string'
      AND (admitted_spec #>> '{service_account,id}')
        ~ '^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND jsonb_typeof(admitted_spec #> '{service_account,credential}') = 'object'
      AND (admitted_spec #> '{service_account,credential}') ?& ARRAY['kind', 'secretRef']
      AND (admitted_spec #> '{service_account,credential}')
        - 'kind' - 'secretRef' = '{}'::jsonb
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,kind}') = 'string'
      AND (admitted_spec #>> '{service_account,credential,kind}')
        IN ('api_key', 'access_token')
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,secretRef}') = 'object'
      AND (admitted_spec #> '{service_account,credential,secretRef}')
        ?& ARRAY['name', 'key']
      AND (admitted_spec #> '{service_account,credential,secretRef}')
        - 'name' - 'key' = '{}'::jsonb
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,secretRef,name}')
        = 'string'
      AND char_length(admitted_spec #>> '{service_account,credential,secretRef,name}')
        BETWEEN 1 AND 253
      AND (admitted_spec #>> '{service_account,credential,secretRef,name}')
        ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,secretRef,key}')
        = 'string'
      AND char_length(admitted_spec #>> '{service_account,credential,secretRef,key}')
        BETWEEN 1 AND 253
      AND (admitted_spec #>> '{service_account,credential,secretRef,key}')
        ~ '^[-._a-zA-Z0-9]+$'
      AND (admitted_spec #>> '{service_account,credential,secretRef,key}')
        NOT IN ('.', '..')
    )
  )
);
--> statement-breakpoint
REVOKE ALL ON occ.service_account_driver_bindings FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.service_account_driver_bindings TO occ_app;
--> statement-breakpoint
GRANT UPDATE (external_credential_id) ON occ.service_account_driver_bindings TO occ_app;
