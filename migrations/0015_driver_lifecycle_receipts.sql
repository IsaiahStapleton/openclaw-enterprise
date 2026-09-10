CREATE TABLE occ.driver_lifecycle_receipts (
  installation_id text NOT NULL REFERENCES occ.installation(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  capability text NOT NULL,
  driver_id text NOT NULL,
  implementation_family text NOT NULL,
  version text NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT driver_lifecycle_receipts_identity
    UNIQUE (installation_id, capability, driver_id),
  CONSTRAINT driver_lifecycle_receipts_capability_valid CHECK (
    capability IN ('iam', 'compute', 'configuration', 'service_account', 'secret', 'sandbox')
  ),
  CONSTRAINT driver_lifecycle_receipts_driver_id_valid CHECK (
    char_length(driver_id) BETWEEN 1 AND 200
    AND driver_id = btrim(driver_id)
    AND driver_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT driver_lifecycle_receipts_family_valid CHECK (
    char_length(implementation_family) BETWEEN 1 AND 200
    AND implementation_family = btrim(implementation_family)
    AND implementation_family !~ '[[:cntrl:]]'
  ),
  CONSTRAINT driver_lifecycle_receipts_version_valid CHECK (
    char_length(version) BETWEEN 1 AND 200
    AND version = btrim(version)
    AND version !~ '[[:cntrl:]]'
  )
);
--> statement-breakpoint
CREATE TRIGGER driver_lifecycle_receipt_identity_is_immutable
BEFORE UPDATE OF installation_id, capability, driver_id, implementation_family
ON occ.driver_lifecycle_receipts
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.driver_lifecycle_receipts FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.driver_lifecycle_receipts TO occ_app;
--> statement-breakpoint
GRANT UPDATE (version, updated_at) ON occ.driver_lifecycle_receipts TO occ_app;

