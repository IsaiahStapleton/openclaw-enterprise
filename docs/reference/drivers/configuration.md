# ConfigurationDriver contract

`ConfigurationDriver` stores and retrieves native Agent configuration documents
for an exact OpenClaw Namespace. OCC owns resource IDs, Namespace ownership,
generation changes, authorization, and revision admission. The Driver owns the
selected storage representation; it does not authorize callers or deploy Agents.

The [Configuration feature reference](../configuration.md) defines the resource
and snapshot semantics. The exported interface is in
[shared contracts](../../../packages/contracts/src/index.ts).

## Operations and ownership

| Operation                     | Contract                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `create(configuration)`       | Persist an OCC-admitted Configuration and return the stored resource.                     |
| `read({ namespaceId, id })`   | Return the Configuration belonging to that exact Namespace and ID.                        |
| `update(configuration)`       | Store the admitted replacement while preserving resource identity and immutable metadata. |
| `delete({ namespaceId, id })` | Remove the exact owned Configuration from provider storage.                               |
| `validate(configuration)`     | Reject a Configuration that the selected provider cannot represent.                       |

Each Configuration contains `id`, `namespaceId`, `kind`, `generation`, `values`,
and `createdAt`. The current kind is `agent`; `values` is a native OpenClaw JSON
document. A Driver cannot substitute another Namespace's document or return a
different resource identity. Provider validation supplements OCC validation and
does not confer permission to use a document.

Revision admission reads the selected document and freezes the effective
configuration in the AgentRevision. Updating or deleting provider storage does
not mutate an already admitted revision. Referenced-resource deletion and
generation rules are enforced by OCC; Drivers are not a public bypass for them.

## Bundled implementations

The [Kubernetes Configuration Driver](../../../apps/controller/src/drivers/configuration/kubernetes/index.ts)
is the bundled selection in trusted Installation YAML. It stores one ConfigMap
per Configuration in the resolved tenant namespace, with native JSON under
`openclaw.json` and exact ownership metadata. Reads reject mismatched ownership,
invalid kind or generation, binary data, and malformed document storage.

The serialized document must be smaller than 1 MiB; Kubernetes may also reject
an object that exceeds its total object limits. Updates require a Kubernetes
resource version and a generation difference of exactly one; the reverse
direction supports OCC compensation, not user-controlled generation rollback.
Deletion checks ownership and uses the observed UID as a precondition when
available. Missing objects, conflicts, or unavailable Kubernetes access fail
the operation without adopting another object.

The [filesystem development Driver](../../../apps/controller/src/drivers/configuration/filesystem/index.ts)
stores JSON beneath `OCC_DEVELOPMENT_CONFIGURATION_ROOT`, under the exact
Namespace and Configuration IDs. It writes a private temporary file and renames
it into place; directories use mode `0700` and files `0600`. Its validation is
limited to safe, typed resource IDs; OCC still owns document validation. Default
Compose development persists this controller-only directory in a named volume.
It is not the production Kubernetes Driver or a secret store.

Installed Configuration packages implement the same five methods and their own
closed startup schema. See [Driver selection](selection.md) for package and
trust requirements, [settings](../settings.md) for configuration fields, and
[deployment](../../guides/deploy.md) for startup procedures.
