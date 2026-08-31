ALTER TABLE occ.agent_revisions
  DROP CONSTRAINT agent_revisions_configuration_values_flat;
--> statement-breakpoint
DROP FUNCTION occ.configuration_values_are_flat(jsonb);
