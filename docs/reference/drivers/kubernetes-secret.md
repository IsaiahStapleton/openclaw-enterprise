# Kubernetes Secret Driver

The Kubernetes Secret Driver stores OCC Secret values in the Kubernetes
namespace selected for the owning OpenClaw Namespace. Each Secret belongs to one
Namespace, returns metadata only through OCC, and can be delivered as an
environment variable to an explicitly selected Agent's OpenClaw gateway through a
Configuration `secretBindings` entry and Agent assignment.

This driver is storage and env delivery only. It does not issue credentials,
share Secrets across Namespaces, keep value history, restart workloads after an
update, roll values back, or broker per-access secret reads. Native OpenClaw
`SecretRef` handling for `env`, `file`, and `exec` configuration remains the
gateway's responsibility.

## Requirements

- The bundled Kubernetes Compute Driver must select or create the backing
  Kubernetes namespace for the OpenClaw Namespace.
- The OpenClaw Namespace must be `ready` before Secret create, update, or
  projection validation can succeed.
- The controller API needs tenant-local Kubernetes Secret `get`, `create`,
  `update`, `patch`, and `delete` permission in each tenant namespace. The
  worker and workloads do not need direct Kubernetes Secret API permission.
- The caller must be authenticated through OCC and authorized to create or
  mutate the exact Secret. Configuration and Agent assignment changes that bind a
  Secret separately require `operate` on each exact Secret.
- Secret values must be nonempty UTF-8 strings without NUL bytes, at most
  65,536 UTF-8 bytes, and fit the OCC request-body limit.

The Installation operator remains responsible for Kubernetes at-rest
encryption, safe backups, tenant-local RoleBindings, and metadata-only audit
configuration for Kubernetes Secret operations.

## Configure the driver

Select the bundled driver in the trusted Installation startup YAML. The API and
worker must read the same file through `OCC_CONFIG_PATH`.

```yaml
drivers:
  secret:
    id: secret-kubernetes
    configuration:
      authentication:
        mode: inCluster
```

The driver also supports an explicit kubeconfig for local verification:

```yaml
drivers:
  secret:
    id: secret-kubernetes
    configuration:
      authentication:
        mode: kubeconfig
        kubeconfigPath: /secure/operator/oce-kubeconfig
        context: oce-production
```

The driver does not accept installed packages, injected Kubernetes clients,
ambient kubeconfig fallback, unverified TLS, caller-selected Kubernetes
namespaces, or caller-selected Kubernetes Secret names. Backend identity is
OCC-owned metadata.

## Create a Namespace-owned Secret

Create the Secret after the OpenClaw Namespace is ready. An Agent does not need
to exist yet. Keep the value in a protected file or secret manager output; do
not put it in a shell command, URL, log line, or example JSON checked into
source.

```bash
umask 077
SECRET_VALUE_FILE=/secure/operator/agent-model-key

node - "$SECRET_VALUE_FILE" <<'JS' | \
  curl -fsS "http://127.0.0.1:3000/namespaces/$NAMESPACE_ID/secrets" \
    -b "$OCC_SESSION_COOKIE_JAR" \
    -H 'Content-Type: application/json' \
    --data-binary @-
const { readFileSync } = require("node:fs");
const [valuePath] = process.argv.slice(2);
const value = readFileSync(valuePath, "utf8").replace(/\n$/, "");
process.stdout.write(JSON.stringify({ name: "model-api-key", value }));
JS
```

A successful create returns HTTP `201` with metadata only:

```json
{
  "data": {
    "id": "sec_123e4567-e89b-42d3-a456-426614174000",
    "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000",
    "name": "model-api-key",
    "ref": {
      "kind": "secret",
      "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000",
      "id": "sec_123e4567-e89b-42d3-a456-426614174000"
    }
  },
  "meta": { "requestId": "req_123e4567-e89b-42d3-a456-426614174000" }
}
```

OCC stores the Secret ID, Namespace ID, selected driver ID, and opaque
Kubernetes backend reference. The value is stored only by the driver and is
never returned by OCC.

## Bind a Secret to gateway environment

Add the returned reference to `secretBindings` on the Agent's Configuration. The
[Configuration reference](../configuration.md#secret-bindings) owns the binding
shape and full native OpenClaw example. OCC validates binding sources, env
delivery, and reserved environment destinations; the selected SecretDriver only
resolves and validates the stored backend identity:

```json
{
  "secretBindings": {
    "OPENAI_API_KEY": {
      "source": {
        "kind": "secret",
        "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000",
        "id": "sec_123e4567-e89b-42d3-a456-426614174000"
      }
    }
  }
}
```

All bound Secrets must belong to the same Namespace as the Configuration and
consuming Agent. OCC rejects cross-Namespace references. It permits
same-Namespace sharing only when the caller has the normal Configuration or
Agent mutation permission and `operate` on each exact Secret. Namespace
membership, Configuration access, Agent access, or possession of a ref is not
enough.

Deployment freezes the normalized bindings and selected Secret Driver ID in the
immutable AgentRevision. It does not snapshot backend locators or value bytes.
The API asks the selected Secret Driver to validate the backend during admission.
The worker resolves current OCC metadata and passes an ephemeral projection
context to the Compute Driver; it does not call the Secret Driver or Kubernetes
Secret API. The Compute Driver renders Kubernetes `secretKeyRef` environment variables only
into each explicitly selected consuming gateway. Native OpenClaw configuration
then resolves the env SecretRefs normally.

Dedicated Codex model credentials do not use this binding path: the separate
Codex workload keeps its existing Agent-specific model Secret or provider-issued
account token path, and the dedicated gateway does not receive the model
credential. The combined embedded OpenClaw gateway may use a Secret binding for
its own Agent-specific `OPENAI_API_KEY`.

## Update and redeploy

Patch only the value with
`PATCH /namespaces/:namespaceId/secrets/:secretId { "value": "..." }`. Keep the
value in a protected file or secret manager output and pass the request body
through stdin, as in the create example. The Secret reference stays stable.

The response returns the same metadata and `ref`. Update success means the
driver stored the new value; it does not restart a gateway, edit an existing
AgentRevision, or prove that a running process has consumed the value. Deploy or
restart each consuming Agent again to create a new revision or process with the
current Kubernetes Secret value. Restarting an older revision also consumes the
current value because revisions hold references, not historical Secret bytes.

There is no value history, automatic rotation, automatic workload restart, or
value rollback. Immediate revocation requires stopping the workload, deleting or
updating the Secret, or revoking the upstream credential.

## Delete

Delete only unreferenced Secrets:

```bash
curl -fsS \
  "http://127.0.0.1:3000/namespaces/$NAMESPACE_ID/secrets/$SECRET_ID" \
  -X DELETE \
  -b "$OCC_SESSION_COOKIE_JAR"
```

Successful deletion returns HTTP `204`. OCC denies deletion while the Secret is
referenced by any current Configuration, active revision, or pending deployment.
Namespace removal is also blocked while owned Secrets remain. Agent removal does
not own or garbage-collect Namespace Secret storage.

Missing or foreign backend objects fail closed during binding validation and
mutation. The driver never silently adopts an existing Kubernetes Secret. If a
delete partially succeeds, retrying the same exact Secret delete can finish
metadata cleanup after OCC verifies the stored backend identity.

## Troubleshooting

- **Secret create returns `409`:** Wait until the platform Namespace is `ready`
  and its backing Kubernetes namespace is bound to the exact Namespace ID.
- **Secret operation returns `403`:** Verify OCC permission for the exact Secret
  or parent Namespace. For binding or Agent assignment, also verify `operate` on
  each exact Secret. Kubernetes tenant-local Secret RBAC is a separate
  requirement.
- **Secret operation returns `503`:** Check Kubernetes authentication, TLS,
  tenant namespace readiness, API RoleBinding, and whether the backend object
  still has exact OCC labels and annotations.
- **Configuration update is rejected:** Confirm every binding references a
  Secret in the same Namespace and that the caller has `operate` on every
  selected Secret, including retained bindings when PATCH omits `secretBindings`.
  Omit `secretBindings` on PATCH to preserve existing bindings, or send an empty
  map to clear them.
- **A rotated value is not visible:** Secret update does not restart workloads.
  Deploy or restart each consuming Agent and verify the new process or revision
  became active.

## Verification status

The approved implementation must pass API, PostgreSQL, and real Kubernetes
runtime coverage before this guide is proof of production behavior. Until that
manager-owned proof is reported, treat route/schema checks and documentation
formatting as documentation verification only.

## Related

- [Namespace configuration](../configuration.md)
- [Settings](../settings.md)
- [Production Kubernetes deployment](../../guides/deploy.md)
- [Kubernetes Compute Driver](kubernetes-compute.md)
- [Platform design](../../design.md#secret-access)
- [SecretDriver storage and delivery spec](../../../specs/.archive/14-secret-driver.md)
