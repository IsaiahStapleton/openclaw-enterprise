ALTER TABLE occ.namespaces ADD COLUMN existing_namespace text;
--> statement-breakpoint
CREATE UNIQUE INDEX namespaces_existing_namespace_unique ON occ.namespaces (existing_namespace)
WHERE existing_namespace IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE occ.namespaces ADD CONSTRAINT namespaces_existing_namespace_valid CHECK (
  existing_namespace IS NULL OR (
    char_length(existing_namespace) BETWEEN 1 AND 63
    AND existing_namespace ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
  )
);
--> statement-breakpoint
DROP TRIGGER namespace_owner_and_identity_are_immutable ON occ.namespaces;
--> statement-breakpoint
CREATE TRIGGER namespace_owner_and_identity_are_immutable
BEFORE UPDATE OF id, existing_namespace ON occ.namespaces
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
