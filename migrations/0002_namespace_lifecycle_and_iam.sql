ALTER TABLE occ.namespaces ADD COLUMN deleted_at timestamptz;
--> statement-breakpoint
ALTER TABLE occ.namespaces ADD CONSTRAINT namespaces_tombstone_valid CHECK (
  deleted_at IS NULL OR (status = 'deleting' AND deleted_at >= created_at)
);
--> statement-breakpoint
ALTER TABLE occ.iam_roles ADD CONSTRAINT iam_roles_namespace_id_id_unique
  UNIQUE NULLS NOT DISTINCT (namespace_id, id);
--> statement-breakpoint
CREATE TABLE occ.iam_groups (
  id text PRIMARY KEY,
  namespace_id text REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  name text COLLATE "C" NOT NULL,
  CONSTRAINT iam_groups_namespace_id_id_unique
    UNIQUE NULLS NOT DISTINCT (namespace_id, id),
  CONSTRAINT iam_groups_namespace_id_name_unique
    UNIQUE NULLS NOT DISTINCT (namespace_id, name),
  CONSTRAINT iam_groups_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT iam_groups_name_normalized CHECK (
    name = btrim(name) AND name !~ '[[:cntrl:]]'
  )
);
--> statement-breakpoint
CREATE TABLE occ.iam_group_memberships (
  namespace_id text REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  group_id text NOT NULL REFERENCES occ.iam_groups(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  principal_id text NOT NULL REFERENCES occ.iam_identities(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT iam_group_memberships_group_principal_unique
    UNIQUE (group_id, principal_id)
);
--> statement-breakpoint
ALTER TABLE occ.iam_access_bindings RENAME COLUMN subject_id TO identity_subject_id;
--> statement-breakpoint
ALTER TABLE occ.iam_access_bindings ALTER COLUMN identity_subject_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE occ.iam_access_bindings ADD COLUMN group_subject_id text
  REFERENCES occ.iam_groups(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE occ.iam_access_bindings ADD CONSTRAINT iam_access_bindings_one_subject
  CHECK (num_nonnulls(identity_subject_id, group_subject_id) = 1);
--> statement-breakpoint
CREATE TABLE occ.iam_restrictions (
  id text PRIMARY KEY,
  namespace_id text REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  action text NOT NULL,
  resource_kind text NOT NULL,
  resource_id text,
  effect text NOT NULL DEFAULT 'deny',
  CONSTRAINT iam_restrictions_action_valid CHECK (
    action IN ('create', 'read', 'update', 'delete', 'deploy', 'operate', 'administer')
  ),
  CONSTRAINT iam_restrictions_resource_kind_valid CHECK (
    resource_kind IN ('installation', 'namespace', 'agent', 'agent_revision')
  ),
  CONSTRAINT iam_restrictions_effect_deny CHECK (effect = 'deny'),
  CONSTRAINT iam_restrictions_resource_id_normalized CHECK (
    resource_id IS NULL OR (
      resource_id = btrim(resource_id) AND char_length(resource_id) BETWEEN 1 AND 200
    )
  )
);
--> statement-breakpoint
ALTER TABLE occ.controller_work ADD COLUMN namespace_target text;
--> statement-breakpoint
UPDATE occ.controller_work
SET idempotency_key = idempotency_key || ':ready', namespace_target = 'ready'
WHERE agent_id IS NULL AND revision_id IS NULL;
--> statement-breakpoint
ALTER TABLE occ.controller_work ADD CONSTRAINT controller_work_namespace_target_valid CHECK (
  (agent_id IS NULL AND revision_id IS NULL AND namespace_target IN ('ready', 'deleted'))
  OR (agent_id IS NOT NULL AND namespace_target IS NULL)
);
--> statement-breakpoint
CREATE FUNCTION occ.validate_namespace_lifecycle() RETURNS trigger
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
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM occ.agents WHERE namespace_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'a nonempty namespace cannot be tombstoned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER namespace_lifecycle_is_valid
BEFORE UPDATE OF status, deleted_at ON occ.namespaces
FOR EACH ROW EXECUTE FUNCTION occ.validate_namespace_lifecycle();
--> statement-breakpoint
CREATE FUNCTION occ.validate_group_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, occ AS $$
DECLARE
  group_scope text;
  identity_kind text;
BEGIN
  SELECT namespace_id INTO group_scope FROM occ.iam_groups WHERE id = NEW.group_id;
  SELECT kind INTO identity_kind FROM occ.iam_identities WHERE id = NEW.principal_id;

  IF NOT FOUND OR identity_kind <> 'principal' THEN
    RAISE EXCEPTION 'group memberships require a principal' USING ERRCODE = '23514';
  END IF;
  IF group_scope IS DISTINCT FROM NEW.namespace_id THEN
    RAISE EXCEPTION 'group membership scope does not match group scope'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER iam_group_membership_scope_is_valid
BEFORE INSERT OR UPDATE ON occ.iam_group_memberships
FOR EACH ROW EXECUTE FUNCTION occ.validate_group_membership();
--> statement-breakpoint
CREATE FUNCTION occ.resource_belongs_to_namespace(
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
CREATE FUNCTION occ.validate_access_binding_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, occ AS $$
DECLARE
  role_scope text;
  identity_scope text;
  group_scope text;
BEGIN
  SELECT namespace_id INTO role_scope FROM occ.iam_roles WHERE id = NEW.role_id;
  IF NOT FOUND OR (role_scope IS NOT NULL AND role_scope IS DISTINCT FROM NEW.namespace_id) THEN
    RAISE EXCEPTION 'access binding role scope is invalid' USING ERRCODE = '23514';
  END IF;

  IF NEW.identity_subject_id IS NOT NULL THEN
    SELECT namespace_id INTO identity_scope
    FROM occ.iam_identities WHERE id = NEW.identity_subject_id;
    IF NOT FOUND OR (
      identity_scope IS NOT NULL AND identity_scope IS DISTINCT FROM NEW.namespace_id
    ) THEN
      RAISE EXCEPTION 'access binding identity scope is invalid' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT namespace_id INTO group_scope FROM occ.iam_groups WHERE id = NEW.group_subject_id;
    IF NOT FOUND OR group_scope IS DISTINCT FROM NEW.namespace_id THEN
      RAISE EXCEPTION 'access binding group scope is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NOT occ.resource_belongs_to_namespace(
    NEW.namespace_id, NEW.resource_kind, NEW.resource_id
  ) THEN
    RAISE EXCEPTION 'access binding resource scope is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER iam_access_binding_scope_is_valid
BEFORE INSERT OR UPDATE ON occ.iam_access_bindings
FOR EACH ROW EXECUTE FUNCTION occ.validate_access_binding_scope();
--> statement-breakpoint
CREATE FUNCTION occ.validate_restriction_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, occ AS $$
BEGIN
  IF NEW.namespace_id IS NOT NULL AND NEW.resource_kind = 'installation' THEN
    RAISE EXCEPTION 'restriction cannot scope installation resources to a namespace'
      USING ERRCODE = '23514';
  END IF;
  IF NOT occ.resource_belongs_to_namespace(
    NEW.namespace_id, NEW.resource_kind, NEW.resource_id
  ) THEN
    RAISE EXCEPTION 'restriction resource scope is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER iam_restriction_scope_is_valid
BEFORE INSERT OR UPDATE ON occ.iam_restrictions
FOR EACH ROW EXECUTE FUNCTION occ.validate_restriction_scope();
--> statement-breakpoint
CREATE TRIGGER iam_group_ownership_is_immutable
BEFORE UPDATE OF id, namespace_id ON occ.iam_groups
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER iam_group_membership_is_immutable
BEFORE UPDATE OR DELETE ON occ.iam_group_memberships
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER iam_restriction_ownership_is_immutable
BEFORE UPDATE OF id, namespace_id ON occ.iam_restrictions
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA occ FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA occ FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA occ TO occ_app;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA occ TO occ_app;
--> statement-breakpoint
GRANT INSERT ON
  occ.installation,
  occ.namespaces,
  occ.agents,
  occ.agent_revisions,
  occ.audit_events,
  occ.controller_work,
  occ.iam_identities,
  occ.iam_roles,
  occ.iam_groups,
  occ.iam_group_memberships,
  occ.iam_access_bindings,
  occ.iam_restrictions
TO occ_app;
--> statement-breakpoint
GRANT UPDATE (status, deleted_at) ON occ.namespaces TO occ_app;
--> statement-breakpoint
GRANT UPDATE (active_revision_id) ON occ.agents TO occ_app;
--> statement-breakpoint
GRANT UPDATE (
  state,
  available_at,
  attempt_count,
  claim_token,
  lease_expires_at,
  completed_at,
  updated_at
) ON occ.controller_work TO occ_app;
