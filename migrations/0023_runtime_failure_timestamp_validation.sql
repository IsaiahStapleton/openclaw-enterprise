CREATE OR REPLACE FUNCTION occ.iso_timestamp_is_valid(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN value ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
      THEN substring(value FROM 9 FOR 2)::integer <= CASE substring(value FROM 6 FOR 2)::integer
        WHEN 2 THEN CASE
          WHEN (
            substring(value FROM 1 FOR 4)::integer % 4 = 0
            AND substring(value FROM 1 FOR 4)::integer % 100 <> 0
          )
          OR substring(value FROM 1 FOR 4)::integer % 400 = 0
            THEN 29
          ELSE 28
        END
        WHEN 4 THEN 30
        WHEN 6 THEN 30
        WHEN 9 THEN 30
        WHEN 11 THEN 30
        ELSE 31
      END
    ELSE false
  END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.iso_timestamp_is_valid(text) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.controller_work
DROP CONSTRAINT controller_work_result_data_state,
ADD CONSTRAINT controller_work_result_data_state CHECK (
  result_data IS NULL
  OR (
    jsonb_typeof(result_data) = 'object'
    AND (
      (
        state = 'failed_permanent'
        AND reason_code = 'CONVERGENCE_DEADLINE_EXCEEDED'
        AND result_data ? 'timeoutMs'
        AND (result_data - 'timeoutMs' - 'runtimeFailure') = '{}'::jsonb
        AND jsonb_typeof(result_data->'timeoutMs') = 'number'
        AND (result_data->>'timeoutMs') ~ '^[1-9][0-9]{0,15}$'
        AND (result_data->>'timeoutMs')::numeric <= 9007199254740991
        AND (
          NOT (result_data ? 'runtimeFailure')
          OR (
            jsonb_typeof(result_data->'runtimeFailure') = 'object'
            AND (result_data->'runtimeFailure') ?& ARRAY['component', 'check', 'checkedAt', 'code']
            AND ((result_data->'runtimeFailure') - 'component' - 'check' - 'checkedAt' - 'code') = '{}'::jsonb
            AND jsonb_typeof(result_data #> '{runtimeFailure,component}') = 'string'
            AND char_length(result_data #>> '{runtimeFailure,component}') BETWEEN 1 AND 64
            AND (result_data #>> '{runtimeFailure,component}') ~ '^[A-Za-z0-9._~:@-]{1,64}$'
            AND jsonb_typeof(result_data #> '{runtimeFailure,check}') = 'string'
            AND char_length(result_data #>> '{runtimeFailure,check}') BETWEEN 1 AND 64
            AND (result_data #>> '{runtimeFailure,check}') ~ '^[A-Za-z0-9._~:@-]{1,64}$'
            AND jsonb_typeof(result_data #> '{runtimeFailure,checkedAt}') = 'string'
            AND occ.iso_timestamp_is_valid(result_data #>> '{runtimeFailure,checkedAt}')
            AND jsonb_typeof(result_data #> '{runtimeFailure,code}') = 'string'
            AND char_length(result_data #>> '{runtimeFailure,code}') BETWEEN 1 AND 64
            AND (result_data #>> '{runtimeFailure,code}') ~ '^[A-Za-z0-9._~:@-]{1,64}$'
          )
        )
      )
      OR (
        state = 'succeeded'
        AND reason_code IN ('REVISION_ACTIVATED', 'REVISION_ALREADY_ACTIVE')
        AND result_data ? 'warnings'
        AND (result_data - 'warnings') = '{}'::jsonb
        AND jsonb_typeof(result_data->'warnings') = 'array'
        AND NOT jsonb_path_exists(
          result_data,
          '$.warnings[*] ? (@.type() != "object" || !(exists(@.code)) || !(exists(@.pluginId)) || @.code.type() != "string" || @.pluginId.type() != "string" || !(@.code == "PLUGIN_INSTALL_FAILED" || @.code == "PLUGIN_AUTH_REQUIRED") || !(@.pluginId like_regex "^[A-Za-z0-9._~:@-]{1,253}$"))'
        )
        AND NOT jsonb_path_exists(
          result_data,
          '$.warnings[*].keyvalue() ? (@.key != "code" && @.key != "pluginId")'
        )
      )
    )
  )
);
