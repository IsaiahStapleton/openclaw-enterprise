ALTER TABLE occ.controller_work
ADD COLUMN reason_code text,
ADD COLUMN result_data jsonb;
--> statement-breakpoint
UPDATE occ.controller_work AS work
SET reason_code = CASE
    WHEN work.state = 'succeeded'
      AND work.revision_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM occ.audit_events AS activation
        WHERE activation.namespace_id = work.namespace_id
          AND activation.resource_kind = 'agent_revision'
          AND activation.resource_id = work.revision_id
          AND activation.action = 'openclaw.agents.lifecycle.activate'
          AND activation.outcome = 'success'
          AND activation.occurred_at BETWEEN work.created_at AND work.completed_at
      )
      THEN 'REVISION_ACTIVATED'
    ELSE COALESCE((
      SELECT terminal.details->>'reasonCode'
      FROM occ.audit_events AS terminal
      WHERE terminal.namespace_id = work.namespace_id
        AND terminal.resource_kind = CASE
          WHEN work.revision_id IS NOT NULL THEN 'agent_revision'
          WHEN work.agent_id IS NOT NULL THEN 'agent'
          ELSE 'namespace'
        END
        AND terminal.resource_id = COALESCE(work.revision_id, work.agent_id, work.namespace_id)
        AND terminal.actor_id = work.actor_id
        AND terminal.action = 'reconcile'
        AND terminal.outcome = CASE
          WHEN work.state = 'succeeded' THEN 'success'
          ELSE 'failure'
        END
        AND terminal.details->>'attemptCount' = work.attempt_count::text
        AND terminal.occurred_at BETWEEN work.completed_at AND work.completed_at + INTERVAL '1 second'
        AND char_length(terminal.details->>'reasonCode') BETWEEN 1 AND 64
      ORDER BY terminal.occurred_at, terminal.id
      LIMIT 1
    ), 'LEGACY_OUTCOME_UNKNOWN')
  END,
  result_data = NULL
WHERE work.state IN ('succeeded', 'failed_permanent')
  AND work.reason_code IS NULL;
--> statement-breakpoint
ALTER TABLE occ.controller_work
DROP CONSTRAINT controller_work_completion_state,
ADD CONSTRAINT controller_work_completion_state CHECK (
  (
    state IN ('succeeded', 'failed_permanent')
    AND completed_at IS NOT NULL
    AND reason_code IS NOT NULL
  )
  OR (
    state NOT IN ('succeeded', 'failed_permanent')
    AND completed_at IS NULL
    AND reason_code IS NULL
    AND result_data IS NULL
  )
),
ADD CONSTRAINT controller_work_reason_code_length CHECK (
  reason_code IS NULL OR char_length(reason_code) BETWEEN 1 AND 64
),
ADD CONSTRAINT controller_work_result_data_state CHECK (
  result_data IS NULL
  OR (
    jsonb_typeof(result_data) = 'object'
    AND (
      (
        state = 'failed_permanent'
        AND reason_code = 'CONVERGENCE_DEADLINE_EXCEEDED'
        AND result_data ? 'timeoutMs'
        AND (result_data - 'timeoutMs') = '{}'::jsonb
        AND jsonb_typeof(result_data->'timeoutMs') = 'number'
        AND (result_data->>'timeoutMs') ~ '^[1-9][0-9]{0,15}$'
        AND (result_data->>'timeoutMs')::numeric <= 9007199254740991
      )
      OR (
        state = 'succeeded'
        AND reason_code IN ('REVISION_ACTIVATED', 'REVISION_ALREADY_ACTIVE')
        AND result_data ? 'warnings'
        AND (result_data - 'warnings') = '{}'::jsonb
        AND jsonb_typeof(result_data->'warnings') = 'array'
        AND NOT jsonb_path_exists(
          result_data,
          '$.warnings[*] ? (@.type() != "object" || !(exists(@.code)) || !(exists(@.pluginId)) || @.code.type() != "string" || @.pluginId.type() != "string" || !(@.code == "PLUGIN_INSTALL_FAILED" || @.code == "PLUGIN_AUTH_REQUIRED") || !(@.pluginId like_regex "^[A-Za-z0-9._~:@-]{1,253}$"))'
        )
        AND NOT jsonb_path_exists(
          result_data,
          '$.warnings[*].keyvalue() ? (@.key != "code" && @.key != "pluginId")'
        )
      )
    )
  )
);
--> statement-breakpoint
GRANT UPDATE (
  reason_code,
  result_data
) ON occ.controller_work TO occ_app;
