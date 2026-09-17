import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function grantAgentSecretOperate(pool, agent, secretId) {
  // Public Agent responses hide the service Principal; grant its persisted identity
  // only the selected Secret, independently of the operator's API permissions.
  const granted = await pool.query(
    `WITH principal AS (
       SELECT service_principal_id FROM occ.agents WHERE namespace_id = $1 AND id = $2
     ), role AS (
       INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       SELECT $3, $1, 'Harness Secret operate',
              '[{"action":"operate","resourceKind":"secret"}]'::jsonb
       FROM principal RETURNING id
     )
     INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
     SELECT $4, $1, principal.service_principal_id, role.id, 'secret', $5
     FROM principal CROSS JOIN role`,
    [agent.namespaceId, agent.id, `role-${randomUUID()}`, `binding-${randomUUID()}`, secretId],
  );
  assert.equal(granted.rowCount, 1, "the Agent must have a persisted service Principal");
}
