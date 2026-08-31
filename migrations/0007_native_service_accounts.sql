CREATE TABLE occ.service_accounts (
  id text PRIMARY KEY,
  namespace_id text NOT NULL REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  name text COLLATE "C" NOT NULL,
  credential jsonb,
  CONSTRAINT service_accounts_namespace_id_id_unique UNIQUE (namespace_id, id),
  CONSTRAINT service_accounts_namespace_id_name_unique UNIQUE (namespace_id, name),
  CONSTRAINT service_accounts_id_format CHECK (
    id ~ '^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT service_accounts_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT service_accounts_name_normalized CHECK (
    name = btrim(name) AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT service_accounts_credential_valid CHECK (
    credential IS NULL OR (
      jsonb_typeof(credential) = 'object'
      AND credential ?& ARRAY['kind', 'secretRef']
      AND credential - 'kind' - 'secretRef' = '{}'::jsonb
      AND jsonb_typeof(credential->'kind') = 'string'
      AND credential->>'kind' IN ('api_key', 'oauth_access_token')
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
  )
);
--> statement-breakpoint
CREATE TRIGGER service_account_identity_is_immutable
BEFORE UPDATE OF id, namespace_id, name ON occ.service_accounts
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
ALTER TABLE occ.agents ADD COLUMN service_account_id text;
--> statement-breakpoint
ALTER TABLE occ.agents ADD CONSTRAINT agents_service_account_owner
  FOREIGN KEY (namespace_id, service_account_id)
  REFERENCES occ.service_accounts(namespace_id, id)
  ON UPDATE RESTRICT ON DELETE RESTRICT;
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
        = 'api_key'
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
ALTER TABLE occ.iam_restrictions DROP CONSTRAINT iam_restrictions_resource_kind_valid;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions ADD CONSTRAINT iam_restrictions_resource_kind_valid CHECK (
  resource_kind IN (
    'installation', 'namespace', 'configuration', 'service_account', 'agent', 'agent_revision'
  )
);
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
  ELSIF checked_resource_kind = 'service_account' THEN
    RETURN checked_resource_id = checked_namespace_id OR EXISTS (
      SELECT 1 FROM occ.service_accounts
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
    OR EXISTS (SELECT 1 FROM occ.service_accounts WHERE namespace_id = NEW.id)
  ) THEN
    RAISE EXCEPTION 'a nonempty namespace cannot be tombstoned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON occ.service_accounts FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.service_accounts TO occ_app;
--> statement-breakpoint
GRANT UPDATE (credential) ON occ.service_accounts TO occ_app;
--> statement-breakpoint
GRANT UPDATE (service_account_id) ON occ.agents TO occ_app;
