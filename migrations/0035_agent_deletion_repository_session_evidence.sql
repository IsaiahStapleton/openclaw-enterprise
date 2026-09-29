-- Agent deletion retains repository session evidence without waiting for cleanup.
ALTER TABLE occ.repository_session_attempts
  DROP CONSTRAINT repository_session_attempts_live_revision_valid,
  ADD CONSTRAINT repository_session_attempts_live_revision_valid CHECK (
    live_revision_id IS NULL OR live_revision_id = revision_id
  );
--> statement-breakpoint
ALTER TABLE occ.controller_work
  DROP CONSTRAINT controller_work_namespace_target_valid,
  ADD CONSTRAINT controller_work_namespace_target_valid CHECK (
    (work_kind = 'lifecycle' AND agent_id IS NULL AND revision_id IS NULL
      AND namespace_target IS NOT NULL
      AND namespace_target IN ('ready', 'deleted') AND agent_target IS NULL)
    OR (work_kind = 'lifecycle' AND agent_id IS NOT NULL AND revision_id IS NULL
      AND namespace_target IS NULL AND agent_target IS NOT NULL
      AND agent_target IN ('stopped', 'deleted'))
    OR (work_kind = 'lifecycle' AND agent_id IS NOT NULL AND revision_id IS NOT NULL
      AND namespace_target IS NULL AND agent_target IS NULL)
    OR (work_kind = 'provisioning' AND agent_id IS NULL AND revision_id IS NULL
      AND namespace_target IS NULL AND agent_target IS NULL)
    OR (work_kind = 'lifecycle' AND agent_id IS NULL AND revision_id IS NULL
      AND namespace_target IS NULL AND agent_target IS NULL
      AND idempotency_key ~ '^agent_revision:rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:repository_cleanup:(retire:)?[0-9a-f]{64}$')
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.guard_repository_session_attempt() RETURNS pg_catalog.trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  credentials pg_catalog.jsonb;
  context pg_catalog.jsonb;
  namespace_status pg_catalog.text;
  namespace_deleted_at pg_catalog.timestamptz;
  agent_status pg_catalog.text;
  runtime_state pg_catalog.text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.phase IS DISTINCT FROM 'opening' OR NEW.session_id IS NOT NULL THEN
      RAISE EXCEPTION 'Repository session attempts must begin opening without a session ID'
        USING ERRCODE = '23514';
    END IF;
    -- Serialize admission with lifecycle owners in the same Namespace/Agent order.
    SELECT namespace.status, namespace.deleted_at INTO namespace_status, namespace_deleted_at
    FROM occ.namespaces AS namespace WHERE namespace.id = NEW.namespace_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Repository session Namespace does not exist' USING ERRCODE = '23503';
    END IF;
    SELECT agent.status, agent.desired_runtime_state INTO agent_status, runtime_state
    FROM occ.agents AS agent
    WHERE agent.namespace_id = NEW.namespace_id AND agent.id = NEW.agent_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Repository session Agent does not exist' USING ERRCODE = '23503';
    END IF;
    IF namespace_status <> 'ready' OR namespace_deleted_at IS NOT NULL
      OR agent_status <> 'active' OR runtime_state <> 'running' THEN
      RAISE EXCEPTION 'Repository session admission requires a live running owner'
        USING ERRCODE = '23514';
    END IF;
    SELECT revision.admitted_spec->'repository_credentials' INTO credentials
    FROM occ.agent_revisions AS revision
    WHERE revision.namespace_id = NEW.namespace_id AND revision.agent_id = NEW.agent_id
      AND revision.id = NEW.revision_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Repository session revision does not exist' USING ERRCODE = '23503';
    END IF;
    IF NOT occ.repository_credentials_are_valid(credentials) THEN
      RAISE EXCEPTION 'Repository session attempt requires an admitted repository binding'
        USING ERRCODE = '23514';
    END IF;
    SELECT pg_catalog.jsonb_build_object('driver', credentials->'driver', 'binding', binding)
      INTO context FROM pg_catalog.jsonb_array_elements(credentials->'bindings') AS binding
      WHERE binding->>'repositoryRef' = NEW.repository_ref;
    IF NOT FOUND OR NEW.deadline_wall_ms IS DISTINCT FROM
      (credentials->>'deadlineWallMs')::pg_catalog.numeric::pg_catalog.int8
      OR (NEW.live_revision_id IS NOT NULL AND NEW.live_revision_id <> NEW.revision_id)
      OR (NEW.cleanup_context IS NOT NULL AND NEW.cleanup_context IS DISTINCT FROM context) THEN
      RAISE EXCEPTION 'Repository session attempt must match its admitted cleanup context'
        USING ERRCODE = '23514';
    END IF;
    NEW.live_revision_id := NEW.revision_id;
    NEW.cleanup_context := context;
    RETURN NEW;
  END IF;
  IF ROW(NEW.namespace_id, NEW.agent_id, NEW.revision_id, NEW.repository_ref,
      NEW.admission_id, NEW.duration_seconds, NEW.deadline_wall_ms, NEW.created_at,
      NEW.cleanup_context)
    IS DISTINCT FROM ROW(OLD.namespace_id, OLD.agent_id, OLD.revision_id, OLD.repository_ref,
      OLD.admission_id, OLD.duration_seconds, OLD.deadline_wall_ms, OLD.created_at,
      OLD.cleanup_context)
    OR (OLD.session_id IS NOT NULL AND NEW.session_id IS DISTINCT FROM OLD.session_id) THEN
    RAISE EXCEPTION 'Repository session identity, cleanup context and known session are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.live_revision_id IS DISTINCT FROM OLD.live_revision_id THEN
    -- Only the migrator-owned finalizer has the app-callable privilege to detach.
    IF CURRENT_USER = 'occ_migrator' AND OLD.live_revision_id IS NOT NULL
      AND NEW.live_revision_id IS NULL AND NEW.phase = OLD.phase
      AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at
      AND EXISTS (
        SELECT 1 FROM occ.agents AS agent
        WHERE agent.namespace_id = OLD.namespace_id AND agent.id = OLD.agent_id
          AND agent.status = 'deleting' AND agent.desired_runtime_state = 'stopped'
      ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Repository session live owner can detach only during Agent deletion'
      USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.phase = 'opening' AND NEW.phase IN ('open', 'closing', 'invalidated'))
    OR (OLD.phase = 'open' AND NEW.phase IN ('closing', 'invalidated'))
    OR (OLD.phase = 'closing' AND NEW.phase IN ('closing', 'disposed', 'invalidated'))
  ) THEN
    RAISE EXCEPTION 'Repository session attempt phase transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.finalize_agent_deletion(
  p_namespace_id text,
  p_agent_id text,
  p_idempotency_key text,
  p_claim_token uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, occ, pg_temp
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
    AND work.work_kind = 'lifecycle'
    AND work.state = 'claimed'
    AND work.claim_token = p_claim_token
    AND work.lease_expires_at > pg_catalog.clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM namespace.id FROM occ.namespaces AS namespace
  WHERE namespace.id = p_namespace_id FOR UPDATE;
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

  PERFORM attempt.admission_id FROM occ.repository_session_attempts AS attempt
  WHERE attempt.namespace_id = p_namespace_id AND attempt.agent_id = p_agent_id
  ORDER BY attempt.revision_id, attempt.admission_id FOR UPDATE;

  -- Revalidate lease time after every potentially blocking ownership lock.
  IF NOT EXISTS (
    SELECT 1 FROM occ.controller_work AS work
    WHERE work.idempotency_key = p_idempotency_key AND work.claim_token = p_claim_token
      AND work.state = 'claimed' AND work.lease_expires_at > pg_catalog.clock_timestamp()
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM occ.agent_provisioning_work AS provisioning
    JOIN occ.controller_work AS work ON work.idempotency_key = provisioning.work_id
    WHERE provisioning.namespace_id = p_namespace_id
      AND provisioning.agent_id = p_agent_id
      AND (
        (
          provisioning.progress ? 'pendingEffect'
          AND NOT (
            provisioning.progress ? 'effectReceipt'
            AND provisioning.progress->'effectReceipt'->>'kind' =
              provisioning.progress->'pendingEffect'->>'kind'
            AND provisioning.progress->'effectReceipt'->>'owner' =
              provisioning.progress->'pendingEffect'->>'owner'
            AND provisioning.progress->'effectReceipt'->>'targetId' =
              provisioning.progress->'pendingEffect'->>'targetId'
          )
        )
        OR (
          provisioning.progress ? 'effectReceipt'
          AND NOT (provisioning.progress ? 'pendingEffect')
        )
        OR provisioning.status IN ('queued', 'running')
        OR work.state IN ('queued', 'claimed')
      )
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE occ.repository_session_attempts SET live_revision_id = NULL
  WHERE namespace_id = p_namespace_id AND agent_id = p_agent_id
    AND live_revision_id IS NOT NULL;

  UPDATE occ.controller_work AS work
  SET agent_id = NULL,
      revision_id = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE work.namespace_id = p_namespace_id
    AND work.agent_id = p_agent_id
    AND work.revision_id IS NOT NULL
    AND work.namespace_target IS NULL
    AND work.agent_target IS NULL
    AND work.revision_id ~ '^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND work.idempotency_key ~ (
      '^agent_revision:' || work.revision_id ||
      ':repository_cleanup:(retire:)?[0-9a-f]{64}$'
    );

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
  DELETE FROM occ.controller_work AS work
  USING occ.agent_provisioning_work AS provisioning
  WHERE work.idempotency_key = provisioning.work_id
    AND provisioning.namespace_id = p_namespace_id
    AND provisioning.agent_id = p_agent_id
    AND work.work_kind = 'provisioning';
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
