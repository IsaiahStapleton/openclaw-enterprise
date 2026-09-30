CREATE INDEX audit_events_work_attempt_idx
  ON occ.audit_events ((details->>'workId'), occurred_at DESC, id DESC)
  WHERE kind = 'mutation' AND action = 'reconcile' AND resource_kind = 'agent_revision';
