ALTER TABLE occ.account ADD COLUMN authentication_version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE occ.account ADD COLUMN identity_only boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE occ.account ADD CONSTRAINT account_authentication_version_positive CHECK (authentication_version > 0);
--> statement-breakpoint
ALTER TABLE occ.account ADD CONSTRAINT account_identity_only CHECK (
  NOT identity_only OR (provider_id <> 'credential' AND password IS NULL AND access_token IS NULL
    AND refresh_token IS NULL AND id_token IS NULL AND access_token_expires_at IS NULL
    AND refresh_token_expires_at IS NULL AND scope IS NULL)
);
--> statement-breakpoint
CREATE TABLE occ.human_authentication_accounts (
  user_id text PRIMARY KEY REFERENCES occ."user"(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  principal_id text NOT NULL REFERENCES occ.iam_identities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CONSTRAINT human_authentication_version_positive CHECK (version > 0),
  disabled boolean NOT NULL DEFAULT false,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT human_authentication_principal_unique UNIQUE (principal_id)
);
--> statement-breakpoint
CREATE TABLE occ.human_authentication_sessions (
  session_id text PRIMARY KEY REFERENCES occ.session(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES occ.human_authentication_accounts(user_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  method_id text NOT NULL REFERENCES occ.account(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  version integer NOT NULL CONSTRAINT human_authentication_session_version_positive CHECK (version > 0),
  method_version integer NOT NULL CONSTRAINT human_authentication_session_method_version_positive CHECK (method_version > 0)
);
--> statement-breakpoint
CREATE TABLE occ.human_authentication_recovery (
  installation_id text PRIMARY KEY REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id text NOT NULL UNIQUE REFERENCES occ.human_authentication_accounts(user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  principal_id text NOT NULL REFERENCES occ.iam_identities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  method_id text NOT NULL REFERENCES occ.account(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE occ.human_authentication_attempts (
  state_hash text PRIMARY KEY CONSTRAINT human_authentication_state_hash CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  browser_hash text NOT NULL CONSTRAINT human_authentication_browser_hash CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  provider_id text NOT NULL CONSTRAINT human_authentication_provider_length CHECK (char_length(provider_id) BETWEEN 1 AND 200 AND provider_id <> 'credential'),
  callback_url text NOT NULL CONSTRAINT human_authentication_callback_length CHECK (char_length(callback_url) BETWEEN 1 AND 2048),
  code_verifier text NOT NULL CONSTRAINT human_authentication_verifier CHECK (code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT human_authentication_attempt_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes')
);
--> statement-breakpoint
CREATE INDEX human_authentication_attempt_expiry ON occ.human_authentication_attempts (expires_at);
--> statement-breakpoint
CREATE FUNCTION occ.guard_authentication_method() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ, pg_temp AS $$
BEGIN
  IF (NEW.user_id, NEW.provider_id, NEW.account_id, NEW.password, NEW.identity_only)
     IS DISTINCT FROM (OLD.user_id, OLD.provider_id, OLD.account_id, OLD.password, OLD.identity_only) THEN
    IF EXISTS (SELECT 1 FROM occ.human_authentication_recovery r WHERE r.method_id = OLD.id)
      AND (NEW.user_id <> OLD.user_id OR NEW.provider_id <> 'credential' OR NEW.account_id <> OLD.account_id
           OR NEW.password IS NULL OR NEW.password = '') THEN
      RAISE EXCEPTION 'The recovery credential cannot be removed or reassigned';
    END IF;
    NEW.authentication_version := OLD.authentication_version + 1;
    NEW.updated_at := clock_timestamp();
  ELSE
    NEW.authentication_version := OLD.authentication_version;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_authentication_method BEFORE UPDATE ON occ.account
FOR EACH ROW EXECUTE FUNCTION occ.guard_authentication_method();
--> statement-breakpoint
REVOKE ALL ON occ.human_authentication_accounts, occ.human_authentication_sessions,
  occ.human_authentication_recovery, occ.human_authentication_attempts FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.human_authentication_accounts, occ.human_authentication_sessions,
  occ.human_authentication_recovery, occ.human_authentication_attempts TO occ_app;
--> statement-breakpoint
GRANT UPDATE (version, disabled, changed_at) ON occ.human_authentication_accounts TO occ_app;
--> statement-breakpoint
GRANT DELETE ON occ.human_authentication_attempts TO occ_app;
