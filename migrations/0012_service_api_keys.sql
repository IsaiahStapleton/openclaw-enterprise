CREATE TABLE occ.apikey (
  id text PRIMARY KEY,
  config_id text NOT NULL,
  name text,
  start text,
  reference_id text NOT NULL,
  prefix text,
  key text NOT NULL UNIQUE,
  refill_interval bigint,
  refill_amount integer,
  last_refill_at timestamptz,
  enabled boolean DEFAULT true,
  rate_limit_enabled boolean DEFAULT false,
  rate_limit_time_window bigint,
  rate_limit_max integer,
  request_count integer DEFAULT 0,
  remaining integer,
  last_request timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  permissions text,
  metadata text
);
--> statement-breakpoint
CREATE INDEX apikey_config_id_idx ON occ.apikey (config_id);
--> statement-breakpoint
CREATE INDEX apikey_reference_id_idx ON occ.apikey (reference_id);
--> statement-breakpoint
REVOKE ALL ON occ.apikey FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON occ.apikey TO occ_app;
