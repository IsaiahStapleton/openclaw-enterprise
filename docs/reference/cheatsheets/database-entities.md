# Database entities cheat sheet

Look up the SQL table and column names stored by OpenClaw Control Plane (OCC).
The tables below are in the `occ` PostgreSQL schema; use `occ."user"` when
querying the `user` table.

The [database schema](../../../packages/occ/src/state/postgres-schema.ts) defines
columns and constraints. The [Drizzle migration-history table](../../../drizzle.config.ts),
`drizzle.__drizzle_migrations`, is excluded. See [platform repositories](../platform-repositories.md)
for how OCC reads and writes its data.

## Platform resources

### `installation`

- `id`
- `name`
- `created_at`

### `namespaces`

- `id`
- `name`
- `existing_namespace`
- `status`
- `created_at`
- `deleted_at`

### `agents`

- `id`
- `namespace_id`
- `name`
- `configuration_id`
- `provider_id`
- `execution_mode`
- `plugins`
- `service_principal_id`
- `harness_auth`
- `harness_auth_secret_id`
- `harness_auth_service_account_id`
- `active_revision_id`
- `desired_runtime_state`
- `status`
- `created_at`

### `agent_revisions`

- `id`
- `namespace_id`
- `agent_id`
- `revision_number`
- `provider_id`
- `admitted_spec`
- `admitted_at`

### `configurations`

- `id`
- `namespace_id`
- `kind`
- `generation`
- `secret_bindings`
- `created_at`

### `secrets`

- `id`
- `namespace_id`
- `name`
- `driver_id`
- `backend_namespace_name`
- `backend_name`
- `backend_key`
- `backend_uid`
- `created_at`

### `service_accounts`

- `id`
- `namespace_id`
- `name`
- `credential`

### `service_account_driver_bindings`

- `service_account_id`
- `namespace_id`
- `provider_id`
- `driver_id`
- `external_account_id`
- `external_credential_id`
- `workspace_id`

## Identity and access

### `iam_identities`

- `id`
- `namespace_id`
- `agent_id`
- `kind`
- `issuer`
- `subject`

### `iam_groups`

- `id`
- `namespace_id`
- `name`

### `iam_group_memberships`

- `namespace_id`
- `group_id`
- `principal_id`

### `iam_roles`

- `id`
- `namespace_id`
- `name`
- `permissions`

### `iam_access_bindings`

- `id`
- `namespace_id`
- `identity_subject_id`
- `group_subject_id`
- `role_id`
- `resource_kind`
- `resource_id`

### `iam_restrictions`

- `id`
- `namespace_id`
- `action`
- `resource_kind`
- `resource_id`
- `effect`

## Audit and controller

### `audit_events`

- `id`
- `occurred_at`
- `kind`
- `actor_id`
- `action`
- `namespace_id`
- `resource_kind`
- `resource_id`
- `outcome`
- `details`

### `controller_work`

- `idempotency_key`
- `namespace_id`
- `agent_id`
- `revision_id`
- `actor_id`
- `namespace_target`
- `agent_target`
- `state`
- `available_at`
- `attempt_count`
- `claim_token`
- `lease_expires_at`
- `completed_at`
- `reason_code`
- `result_data`
- `created_at`
- `updated_at`

## Browser authentication and service API keys

### `user`

- `id`
- `name`
- `email`
- `email_verified`
- `image`
- `created_at`
- `updated_at`

### `session`

- `id`
- `expires_at`
- `token`
- `created_at`
- `updated_at`
- `ip_address`
- `user_agent`
- `user_id`

### `account`

- `id`
- `account_id`
- `provider_id`
- `user_id`
- `access_token`
- `refresh_token`
- `id_token`
- `access_token_expires_at`
- `refresh_token_expires_at`
- `scope`
- `password`
- `created_at`
- `updated_at`

### `verification`

- `id`
- `identifier`
- `value`
- `expires_at`
- `created_at`
- `updated_at`

### `apikey`

- `id`
- `config_id`
- `name`
- `start`
- `reference_id`
- `prefix`
- `key`
- `refill_interval`
- `refill_amount`
- `last_refill_at`
- `enabled`
- `rate_limit_enabled`
- `rate_limit_time_window`
- `rate_limit_max`
- `request_count`
- `remaining`
- `last_request`
- `expires_at`
- `created_at`
- `updated_at`
- `permissions`
- `metadata`
