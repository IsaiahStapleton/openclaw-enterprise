-- Keep caller-owned temporary types out of every inherited privileged function.
-- Historical SQL and its applied receipts remain unchanged.
ALTER FUNCTION occ.finalize_agent_deletion(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.uuid)
  SET search_path = pg_catalog, occ, pg_temp;
--> statement-breakpoint
ALTER FUNCTION occ.validate_group_membership()
  SET search_path = pg_catalog, occ, pg_temp;
--> statement-breakpoint
ALTER FUNCTION occ.validate_access_binding_scope()
  SET search_path = pg_catalog, occ, pg_temp;
--> statement-breakpoint
ALTER FUNCTION occ.validate_restriction_scope()
  SET search_path = pg_catalog, occ, pg_temp;
