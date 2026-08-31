CREATE SCHEMA IF NOT EXISTS occ;
--> statement-breakpoint
CREATE TABLE occ.installation (
  id text PRIMARY KEY,
  name text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT installation_id_format CHECK (
    id ~ '^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT installation_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT installation_name_normalized CHECK (
    name = btrim(name) AND name !~ '[[:cntrl:]]'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX installation_one_row ON occ.installation ((true));
--> statement-breakpoint
CREATE TABLE occ.namespaces (
  id text PRIMARY KEY,
  name text COLLATE "C" NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'provisioning',
  created_at timestamptz NOT NULL,
  CONSTRAINT namespaces_id_format CHECK (
    id ~ '^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT namespaces_status_valid CHECK (
    status IN ('provisioning', 'ready', 'failed', 'deleting')
  ),
  CONSTRAINT namespaces_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT namespaces_name_normalized CHECK (
    name = btrim(name) AND name !~ '[[:cntrl:]]'
  )
);
--> statement-breakpoint
CREATE TABLE occ.agents (
  id text PRIMARY KEY,
  namespace_id text NOT NULL REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  name text COLLATE "C" NOT NULL,
  execution_mode text NOT NULL,
  service_principal_id text NOT NULL,
  active_revision_id text,
  created_at timestamptz NOT NULL,
  CONSTRAINT agents_namespace_id_id_unique UNIQUE (namespace_id, id),
  CONSTRAINT agents_namespace_id_name_unique UNIQUE (namespace_id, name),
  CONSTRAINT agents_namespace_id_id_service_principal_id_unique
    UNIQUE (namespace_id, id, service_principal_id),
  CONSTRAINT agents_id_format CHECK (
    id ~ '^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT agents_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT agents_execution_mode_valid CHECK (execution_mode IN ('embedded', 'dedicated')),
  CONSTRAINT agents_name_normalized CHECK (
    name = btrim(name) AND name !~ '[[:cntrl:]]'
  )
);
--> statement-breakpoint
CREATE TABLE occ.agent_revisions (
  id text PRIMARY KEY,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_number bigint NOT NULL,
  admitted_spec jsonb NOT NULL,
  admitted_at timestamptz NOT NULL,
  CONSTRAINT agent_revisions_namespace_id_agent_id_id_unique
    UNIQUE (namespace_id, agent_id, id),
  CONSTRAINT agent_revisions_namespace_id_agent_id_revision_number_unique
    UNIQUE (namespace_id, agent_id, revision_number),
  CONSTRAINT agent_revisions_agent_owner
    FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT agent_revisions_id_format CHECK (
    id ~ '^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT agent_revisions_revision_positive CHECK (revision_number > 0),
  CONSTRAINT agent_revisions_spec_object CHECK (jsonb_typeof(admitted_spec) = 'object')
);
--> statement-breakpoint
ALTER TABLE occ.agents
  ADD CONSTRAINT agent_active_revision_owner
  FOREIGN KEY (namespace_id, id, active_revision_id)
  REFERENCES occ.agent_revisions(namespace_id, agent_id, id)
  ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint
CREATE TABLE occ.iam_identities (
  id text PRIMARY KEY,
  namespace_id text,
  agent_id text,
  kind text NOT NULL,
  issuer text,
  subject text,
  CONSTRAINT iam_identities_namespace_id_agent_id_id_unique
    UNIQUE NULLS NOT DISTINCT (namespace_id, agent_id, id),
  FOREIGN KEY (namespace_id)
    REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT iam_identities_agent_owner
    FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT iam_identities_kind_valid CHECK (
    kind IN ('principal', 'service_principal')
  ),
  CONSTRAINT iam_identities_kind_ownership CHECK (
    (kind = 'principal'
      AND namespace_id IS NULL AND agent_id IS NULL
      AND issuer IS NOT NULL AND subject IS NOT NULL)
    OR (kind = 'service_principal'
      AND (agent_id IS NULL OR namespace_id IS NOT NULL)
      AND issuer IS NULL AND subject IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX iam_principal_external_subject
  ON occ.iam_identities (issuer, subject)
  WHERE kind = 'principal';
--> statement-breakpoint
CREATE UNIQUE INDEX iam_one_service_principal_per_agent
  ON occ.iam_identities (namespace_id, agent_id)
  WHERE kind = 'service_principal' AND agent_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE occ.agents
  ADD CONSTRAINT agent_service_principal_owner
  FOREIGN KEY (namespace_id, id, service_principal_id)
  REFERENCES occ.iam_identities(namespace_id, agent_id, id)
  ON UPDATE RESTRICT ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE TABLE occ.iam_roles (
  id text PRIMARY KEY,
  namespace_id text REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  name text COLLATE "C",
  permissions jsonb NOT NULL,
  CONSTRAINT iam_roles_permissions_array CHECK (jsonb_typeof(permissions) = 'array')
);
--> statement-breakpoint
CREATE TABLE occ.iam_access_bindings (
  id text PRIMARY KEY,
  namespace_id text REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  subject_id text NOT NULL REFERENCES occ.iam_identities(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  role_id text NOT NULL REFERENCES occ.iam_roles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  resource_kind text,
  resource_id text,
  CONSTRAINT iam_access_bindings_resource_pair CHECK (
    (resource_kind IS NULL) = (resource_id IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE occ.audit_events (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  namespace_id text,
  resource_kind text NOT NULL,
  resource_id text NOT NULL,
  outcome text NOT NULL,
  details jsonb,
  CONSTRAINT audit_events_id_format CHECK (
    id ~ '^aud_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT audit_events_outcome_valid CHECK (outcome IN ('success', 'denied', 'failure')),
  CONSTRAINT audit_events_details_object CHECK (
    details IS NULL OR jsonb_typeof(details) = 'object'
  )
);
--> statement-breakpoint
CREATE TABLE occ.controller_work (
  idempotency_key text PRIMARY KEY,
  namespace_id text NOT NULL REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  agent_id text,
  revision_id text,
  actor_id text NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  available_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  claim_token uuid,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT controller_work_agent_owner
    FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT controller_work_revision_owner
    FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.agent_revisions(namespace_id, agent_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT controller_work_idempotency_key_length CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 512
  ),
  CONSTRAINT controller_work_state_valid CHECK (
    state IN ('queued', 'claimed', 'succeeded', 'failed_permanent')
  ),
  CONSTRAINT controller_work_attempt_count_valid CHECK (attempt_count >= 0),
  CONSTRAINT controller_work_revision_requires_agent CHECK (
    revision_id IS NULL OR agent_id IS NOT NULL
  ),
  CONSTRAINT controller_work_claim_state CHECK (
    (state = 'claimed'
      AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'claimed'
      AND claim_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT controller_work_completion_state CHECK (
    (state IN ('succeeded', 'failed_permanent') AND completed_at IS NOT NULL)
    OR (state NOT IN ('succeeded', 'failed_permanent') AND completed_at IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX controller_work_ready
  ON occ.controller_work (available_at, created_at, idempotency_key)
  WHERE state = 'queued';
--> statement-breakpoint
CREATE INDEX controller_work_expired
  ON occ.controller_work (lease_expires_at, idempotency_key)
  WHERE state = 'claimed';
--> statement-breakpoint
CREATE UNIQUE INDEX controller_work_one_claim_per_resource
  ON occ.controller_work ((COALESCE(agent_id, namespace_id)))
  WHERE state = 'claimed';
