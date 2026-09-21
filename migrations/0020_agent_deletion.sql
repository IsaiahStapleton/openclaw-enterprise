ALTER TABLE occ.agents
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD CONSTRAINT agents_status_valid CHECK (status IN ('active', 'deleting')),
  ADD CONSTRAINT agents_deleting_is_stopped
    CHECK (status <> 'deleting' OR desired_runtime_state = 'stopped');
--> statement-breakpoint
GRANT UPDATE (status) ON occ.agents TO occ_app;
--> statement-breakpoint
-- occ_app holds table-level INSERT, which no column grant or check constraint
-- can narrow, so the lifecycle invariants live here: an Agent is created
-- active, and deleting is terminal because teardown removes the row.
CREATE FUNCTION occ.validate_agent_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'a new agent must be active' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (
    OLD.status = NEW.status
    OR (OLD.status = 'active' AND NEW.status = 'deleting')
  ) THEN
    RAISE EXCEPTION 'invalid agent lifecycle transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_lifecycle_is_valid
BEFORE INSERT OR UPDATE OF status ON occ.agents
FOR EACH ROW EXECUTE FUNCTION occ.validate_agent_lifecycle();
--> statement-breakpoint
-- An Agent teardown work item is Agent-scoped with no single revision. The
-- previous form required a revision whenever an Agent was named, so an
-- Agent-scoped item could not be queued at all.
ALTER TABLE occ.controller_work
  DROP CONSTRAINT controller_work_agent_target_valid,
  ADD CONSTRAINT controller_work_agent_target_valid
    CHECK (agent_target IS NULL OR agent_target IN ('stopped', 'deleted'));
--> statement-breakpoint
ALTER TABLE occ.controller_work
  DROP CONSTRAINT controller_work_namespace_target_valid,
  ADD CONSTRAINT controller_work_namespace_target_valid CHECK (
    (agent_id IS NULL AND revision_id IS NULL
      AND namespace_target IS NOT NULL
      AND namespace_target IN ('ready', 'deleted') AND agent_target IS NULL)
    OR (agent_id IS NOT NULL AND revision_id IS NULL
      AND namespace_target IS NULL AND agent_target IS NOT NULL
      AND agent_target IN ('stopped', 'deleted'))
    OR (agent_id IS NOT NULL AND revision_id IS NOT NULL
      AND namespace_target IS NULL AND agent_target IS NULL)
  );
--> statement-breakpoint
-- Revision content stays immutable, but deletion must become possible for the
-- Agent teardown path. Triggers are not privilege-gated, so the rejecting
-- DELETE arm would also block the migrator-owned deletion function. Deletion is
-- instead gated by privilege: occ_app holds no DELETE on this table.
DROP TRIGGER agent_revisions_are_immutable ON occ.agent_revisions;
--> statement-breakpoint
CREATE TRIGGER agent_revisions_are_immutable
BEFORE UPDATE ON occ.agent_revisions
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
-- RESTRICT actions run immediately even on a deferrable constraint. Recreate
-- these ownership constraints with deferred NO ACTION checks so the finalizer
-- can delete the Agent and revisions before their work rows inside one atomic
-- transaction. Outside that transaction, the same ownership is still enforced.
ALTER TABLE occ.controller_work
  DROP CONSTRAINT controller_work_agent_owner,
  DROP CONSTRAINT controller_work_revision_owner,
  ADD CONSTRAINT controller_work_agent_owner
    FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT controller_work_revision_owner
    FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.agent_revisions(namespace_id, agent_id, id)
    ON UPDATE RESTRICT ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
-- The Agent and its service principal also form a cycle whose RESTRICT actions
-- ignore deferral. Preserve the deferred ownership checks with NO ACTION so the
-- finalizer can remove both rows and validate the empty end state at commit.
ALTER TABLE occ.agents
  DROP CONSTRAINT agent_service_principal_owner,
  ADD CONSTRAINT agent_service_principal_owner
    FOREIGN KEY (namespace_id, id, service_principal_id)
    REFERENCES occ.iam_identities(namespace_id, agent_id, id)
    ON UPDATE RESTRICT ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE occ.iam_identities
  DROP CONSTRAINT iam_identities_agent_owner,
  ADD CONSTRAINT iam_identities_agent_owner
    FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION occ.finalize_agent_deletion(
  p_namespace_id text,
  p_agent_id text,
  p_idempotency_key text,
  p_claim_token uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, occ
AS $$
DECLARE
  v_service_principal_id text;
  v_actor_id text;
  v_attempt_count integer;
BEGIN
  SELECT work.actor_id, work.attempt_count
    INTO v_actor_id, v_attempt_count
  FROM occ.controller_work AS work
  WHERE work.idempotency_key = p_idempotency_key
    AND work.namespace_id = p_namespace_id
    AND work.agent_id = p_agent_id
    AND work.revision_id IS NULL
    AND work.agent_target = 'deleted'
    AND work.state = 'claimed'
    AND work.claim_token = p_claim_token
    AND work.lease_expires_at > pg_catalog.clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT agent.service_principal_id
    INTO v_service_principal_id
  FROM occ.agents AS agent
  WHERE agent.namespace_id = p_namespace_id
    AND agent.id = p_agent_id
    AND agent.status = 'deleting'
    AND agent.desired_runtime_state = 'stopped'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE occ.agents
  SET active_revision_id = NULL
  WHERE namespace_id = p_namespace_id AND id = p_agent_id;

  DELETE FROM occ.iam_access_bindings AS binding
  WHERE binding.identity_subject_id = v_service_principal_id
    OR (binding.resource_kind = 'agent' AND binding.resource_id = p_agent_id)
    OR (binding.resource_kind = 'agent_revision' AND binding.resource_id IN (
      SELECT revision.id FROM occ.agent_revisions AS revision
      WHERE revision.namespace_id = p_namespace_id AND revision.agent_id = p_agent_id
    ));

  DELETE FROM occ.iam_restrictions AS restriction
  WHERE (restriction.resource_kind = 'agent' AND restriction.resource_id = p_agent_id)
    OR (restriction.resource_kind = 'agent_revision' AND restriction.resource_id IN (
      SELECT revision.id FROM occ.agent_revisions AS revision
      WHERE revision.namespace_id = p_namespace_id AND revision.agent_id = p_agent_id
    ));

  DELETE FROM occ.apikey WHERE reference_id = v_service_principal_id;
  DELETE FROM occ.agent_revisions
    WHERE namespace_id = p_namespace_id AND agent_id = p_agent_id;
  DELETE FROM occ.iam_identities
    WHERE id = v_service_principal_id
      AND namespace_id = p_namespace_id
      AND agent_id = p_agent_id
      AND kind = 'service_principal';
  DELETE FROM occ.agents
    WHERE namespace_id = p_namespace_id AND id = p_agent_id;

  INSERT INTO occ.audit_events (
    id, occurred_at, kind, actor_id, action, namespace_id,
    resource_kind, resource_id, outcome, details
  ) VALUES (
    'aud_' || pg_catalog.gen_random_uuid()::text,
    pg_catalog.clock_timestamp(),
    'mutation',
    v_actor_id,
    'openclaw.agents.lifecycle.delete',
    p_namespace_id,
    'agent',
    p_agent_id,
    'success',
    pg_catalog.jsonb_build_object(
      'reasonCode', 'AGENT_DELETED',
      'attemptCount', v_attempt_count
    )
  );

  DELETE FROM occ.controller_work
  WHERE namespace_id = p_namespace_id AND agent_id = p_agent_id;
  RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.finalize_agent_deletion(text, text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.finalize_agent_deletion(text, text, text, uuid) TO occ_app;
