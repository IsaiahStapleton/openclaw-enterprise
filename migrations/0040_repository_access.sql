CREATE FUNCTION occ.repository_access_is_valid(access jsonb, bindings jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  repository jsonb;
  resolved jsonb := '[]'::jsonb;
  refs text[] := ARRAY[]::text[];
BEGIN
  IF access IS NULL THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(access) IS DISTINCT FROM 'object'
    OR access - 'defaultProfile' - 'repositories' <> '{}'::jsonb
    OR jsonb_typeof(access->'defaultProfile') IS DISTINCT FROM 'string'
    OR (access->>'defaultProfile') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    OR jsonb_typeof(access->'repositories') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(access->'repositories') > 16 THEN
    RETURN false;
  END IF;
  FOR repository IN SELECT value FROM jsonb_array_elements(access->'repositories') LOOP
    IF jsonb_typeof(repository) IS DISTINCT FROM 'object'
      OR repository - 'repositoryRef' - 'profile' <> '{}'::jsonb
      OR jsonb_typeof(repository->'repositoryRef') IS DISTINCT FROM 'string'
      OR (repository->>'repositoryRef') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      OR (repository->>'repositoryRef') = ANY(refs)
      OR (repository ? 'profile' AND (
        jsonb_typeof(repository->'profile') IS DISTINCT FROM 'string'
        OR (repository->>'profile') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      )) THEN
      RETURN false;
    END IF;
    refs := array_append(refs, repository->>'repositoryRef');
    resolved := resolved || jsonb_build_array(jsonb_build_object(
      'repositoryRef', repository->>'repositoryRef',
      'profile', COALESCE(repository->>'profile', access->>'defaultProfile')
    ));
  END LOOP;
  RETURN resolved = COALESCE(bindings, '[]'::jsonb);
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.repository_access_is_valid(jsonb, jsonb) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.agents
  ADD COLUMN repository_access jsonb,
  ADD CONSTRAINT agents_repository_access_valid
    CHECK (occ.repository_access_is_valid(repository_access, repository_bindings));
--> statement-breakpoint
GRANT UPDATE (repository_access) ON occ.agents TO occ_app;
