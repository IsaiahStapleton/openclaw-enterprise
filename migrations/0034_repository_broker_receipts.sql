-- Preserve nonsecret broker admission and confirmed disposal evidence.
ALTER TABLE occ.repository_session_attempts
  ADD COLUMN broker_protocol pg_catalog.int2 NOT NULL DEFAULT 0
  CONSTRAINT repository_session_attempts_broker_protocol_valid CHECK (broker_protocol IN (0, 1));
--> statement-breakpoint
CREATE TABLE occ.repository_broker_receipts (
  admission_id pg_catalog.text PRIMARY KEY
    REFERENCES occ.repository_session_attempts(admission_id) ON DELETE RESTRICT,
  state pg_catalog.text NOT NULL,
  generation pg_catalog.uuid,
  session_id pg_catalog.text UNIQUE,
  deadline_wall_ms pg_catalog.int8,
  revoked pg_catalog.int8,
  expired pg_catalog.int8,
  CONSTRAINT repository_broker_receipts_state_valid CHECK (
    (state = 'fenced' AND generation IS NULL AND session_id IS NULL
      AND deadline_wall_ms IS NULL AND revoked IS NULL AND expired IS NULL)
    OR (state = 'reserved' AND generation IS NOT NULL AND session_id IS NULL
      AND deadline_wall_ms IS NULL AND revoked IS NULL AND expired IS NULL)
    OR (state = 'active' AND generation IS NOT NULL AND session_id IS NOT NULL
      AND deadline_wall_ms IS NOT NULL AND deadline_wall_ms BETWEEN 1 AND 9007199254740991
      AND revoked IS NULL AND expired IS NULL)
    OR (state = 'disposed' AND generation IS NOT NULL AND session_id IS NOT NULL
      AND deadline_wall_ms IS NOT NULL AND deadline_wall_ms BETWEEN 1 AND 9007199254740991
      AND revoked IS NOT NULL AND revoked BETWEEN 0 AND 9007199254740991
      AND expired IS NOT NULL AND expired BETWEEN 0 AND 9007199254740991)
  ),
  CONSTRAINT repository_broker_receipts_session_valid CHECK (
    session_id IS NULL OR session_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  )
);
--> statement-breakpoint
CREATE FUNCTION occ.guard_repository_broker_receipt() RETURNS pg_catalog.trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  owner occ.repository_session_attempts%ROWTYPE;
BEGIN
  SELECT * INTO owner FROM occ.repository_session_attempts
    WHERE admission_id = NEW.admission_id FOR UPDATE;
  IF NOT FOUND OR owner.broker_protocol <> 1 OR owner.phase IN ('invalidated', 'disposed') THEN
    RAISE EXCEPTION 'Repository broker receipt requires a current durable admission'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('fenced', 'reserved')
      OR (NEW.state = 'reserved' AND owner.phase <> 'opening')
      OR (NEW.state = 'fenced' AND (owner.phase = 'open' OR owner.session_id IS NOT NULL)) THEN
      RAISE EXCEPTION 'Repository broker receipt must begin reserved or fenced'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.admission_id IS DISTINCT FROM OLD.admission_id
    OR NEW.generation IS DISTINCT FROM OLD.generation
    OR (OLD.session_id IS NOT NULL AND NEW.session_id IS DISTINCT FROM OLD.session_id)
    OR (OLD.deadline_wall_ms IS NOT NULL AND NEW.deadline_wall_ms IS DISTINCT FROM OLD.deadline_wall_ms)
    OR NOT ((OLD.state = 'reserved' AND NEW.state = 'active')
      OR (OLD.state = 'active' AND NEW.state = 'disposed'))
    OR (NEW.session_id IS NOT NULL AND owner.session_id IS NOT NULL AND NEW.session_id <> owner.session_id)
    OR (NEW.deadline_wall_ms IS NOT NULL AND NEW.deadline_wall_ms > owner.deadline_wall_ms) THEN
    RAISE EXCEPTION 'Repository broker receipt identity or transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER repository_broker_receipts_guard
  BEFORE INSERT OR UPDATE ON occ.repository_broker_receipts
  FOR EACH ROW EXECUTE FUNCTION occ.guard_repository_broker_receipt();
--> statement-breakpoint
CREATE TRIGGER repository_broker_receipts_cannot_be_deleted
  BEFORE DELETE ON occ.repository_broker_receipts
  FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE FUNCTION occ.guard_repository_attempt_broker_receipt() RETURNS pg_catalog.trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  receipt occ.repository_broker_receipts%ROWTYPE;
BEGIN
  SELECT * INTO receipt FROM occ.repository_broker_receipts WHERE admission_id = NEW.admission_id;
  IF FOUND AND receipt.session_id IS NOT NULL AND NEW.session_id IS NOT NULL
    AND receipt.session_id <> NEW.session_id THEN
    RAISE EXCEPTION 'Repository attempt does not match its broker receipt' USING ERRCODE = '23514';
  END IF;
  IF NEW.broker_protocol = 1 AND NEW.phase = 'disposed'
    AND (NOT FOUND OR receipt.state <> 'disposed' OR receipt.session_id IS DISTINCT FROM NEW.session_id) THEN
    RAISE EXCEPTION 'Repository attempt disposal requires a matching broker receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER repository_attempt_broker_receipt_guard
  BEFORE UPDATE ON occ.repository_session_attempts
  FOR EACH ROW EXECUTE FUNCTION occ.guard_repository_attempt_broker_receipt();
--> statement-breakpoint
REVOKE ALL ON occ.repository_broker_receipts FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.repository_broker_receipts TO occ_app;
--> statement-breakpoint
GRANT UPDATE (state, session_id, deadline_wall_ms, revoked, expired)
  ON occ.repository_broker_receipts TO occ_app;
