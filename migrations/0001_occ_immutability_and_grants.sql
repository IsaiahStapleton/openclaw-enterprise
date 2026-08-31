CREATE FUNCTION occ.reject_row_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_revisions_are_immutable
BEFORE UPDATE OR DELETE ON occ.agent_revisions
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_are_append_only
BEFORE UPDATE OR DELETE ON occ.audit_events
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER installation_identity_is_immutable
BEFORE UPDATE OF id ON occ.installation
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER installation_cannot_be_deleted
BEFORE DELETE ON occ.installation
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER namespace_owner_and_identity_are_immutable
BEFORE UPDATE OF id ON occ.namespaces
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_owner_and_identity_are_immutable
BEFORE UPDATE OF namespace_id, id, service_principal_id ON occ.agents
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER iam_identity_ownership_is_immutable
BEFORE UPDATE OF namespace_id, agent_id, id, kind ON occ.iam_identities
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON SCHEMA occ FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON SCHEMA drizzle FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA occ FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA occ FROM PUBLIC, occ_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE occ_migrator IN SCHEMA occ
  REVOKE ALL ON TABLES FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE occ_migrator IN SCHEMA drizzle
  REVOKE ALL ON TABLES FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE occ_migrator
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA occ TO occ_app;
--> statement-breakpoint
GRANT SELECT ON
  occ.installation,
  occ.namespaces,
  occ.agents,
  occ.agent_revisions,
  occ.iam_identities,
  occ.iam_roles,
  occ.iam_access_bindings,
  occ.audit_events,
  occ.controller_work
TO occ_app;
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
  occ.iam_access_bindings
TO occ_app;
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
