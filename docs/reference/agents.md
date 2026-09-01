# Agents

An Agent is a named, persistent resource representing one AI workload inside a
[Namespace](namespaces.md). Each Agent has its own identity and revision
history. Agents in the same Namespace remain separate, and Agents never cross
Namespace boundaries.

```text
Namespace: support
├── Agent: ticket-triage
│   ├── Service principal: unique to ticket-triage
│   └── Gateway: unique to deployed ticket-triage
└── Agent: customer-help
    ├── Service principal: unique to customer-help
    └── Gateway: unique to deployed customer-help
```

Creating an Agent records its platform resource, exact Namespace-owned
Configuration reference, and identity. It does not start a workload, deploy a
model, or create a revision until an authorized caller explicitly requests
deployment.

## Supported operations

Agent operations are scoped beneath `/namespaces/:namespaceId/agents`. Creation
returns `201`, reads and updates return `200`, and deployment returns `202`
with the newly admitted AgentRevision. Collection reads include only Agents
for which the caller has an exact `read` grant. The [API reference](api.md)
owns route schemas, response envelopes, and permission annotations.

A representative creation body is:

```json
{
  "name": "ticket-triage",
  "configurationId": "cfg_123e4567-e89b-42d3-a456-426614174000",
  "executionMode": "dedicated",
  "providerId": null
}
```

Creation requires an existing Namespace in `provisioning` or `ready` status
and a same-Namespace Configuration with `kind: "agent"`. The caller needs
Agent `create` permission in that Namespace and `read` permission on the
exact Configuration. An optional associated service account requires its own
exact `read` permission. [Authentication](authentication.md) establishes the
caller; [authorization](authorization.md) defines its grants.

## Provider association

An Agent can reference one Installation-configured [Provider](providers.md)
through `providerId`. Create omission means `null`; PATCH omission preserves the
saved value, while explicit `null` clears the draft reference. A nonnull ID must
resolve to a configured Provider. No default is inferred. The nullable reference
is returned on both Agent and AgentRevision responses.

The Provider reference is independent of native model names and Harness
selection. Providerless Agents remain supported with native API-key or
independently supplied model credentials. A managed access token requires the
matching Provider and private account binding at admission and reconciliation;
see [Provider deployment checks](providers.md#agent-association-and-immutable-deployment).
Creating an Agent does not create a provider account or issue credentials.

## Workspace files

`GET /namespaces/:namespaceId/agents/:agentId/workspace/files/:name` reads one
allowed native workspace file through the Agent's active gateway. `PUT` to the
same path creates or replaces that mutable Agent workspace file. The only supported names are
`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md`.

The caller must authenticate with a Better Auth session or scoped service API
key. `GET` requires exact Agent `read`; `PUT` requires exact Agent `operate` and
the browser CSRF boundary when the caller uses a session. Agent
ServicePrincipal credentials are rejected at authentication admission, even if
the principal has an explicit IAM grant.

OCC validates the file name before provider access. `PUT` accepts a closed JSON
body with `content`, rejects NUL bytes and unpaired UTF-16 surrogates, enforces
a 16 KiB UTF-8 content limit, and uses a 48 KiB request-body limit. The response
body for a read is `{ name, content }`; the write response is `{ name, size }`.
The native provider may return a missing file as `404`.

These routes are a narrow workspace-file shim, not a generic native RPC or CLI
execution surface. They do not expose `agents.files.list`, chat, configuration,
status, device enrollment, browser-to-gateway credentials, caller-selected
URLs, arbitrary native methods, or a full native administration UI. OCC does
not store file bytes in its database, does not implement compare-and-swap or
revisioned file updates, and does not replay a write whose provider outcome is
unknown.

Write audit events contain the Agent resource, authorization action, outcome,
reason code when present, and file name metadata. Audit details do not contain
file contents. Reads do not create mutation audit events.

The server-side access path is opt-in. Set `OCC_WORKSPACE_FILES_CONFIG_PATH` on
the API process to an absolute YAML file with a single top-level `endpoints`
array. OCC reads that file once at startup, rejects invalid files before
serving, and does not reload it. Each endpoint maps one Enterprise
`namespaceId` and `agentId` to an operator-owned native WSS target:

```yaml
endpoints:
  - namespaceId: ns_123e4567-e89b-42d3-a456-426614174000
    agentId: agt_123e4567-e89b-42d3-a456-426614174000
    url: wss://agent-files.example.internal/openclaw
    nativeAgentId: main
    identity: occ-workspace-files
    userHeader: x-openclaw-operator
    tlsFingerprint: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

The `url` must be `wss://` and must not contain embedded credentials, a query,
or a fragment. `tlsFingerprint` is optional; when present, it must be one
64-character hexadecimal certificate fingerprint. The operator owns the
assertion that each URL and `nativeAgentId` belong to the exact Enterprise
Agent named by the mapping. OCC does not derive the mapping from a revision,
does not store a per-revision native attestation, and returns `503
DEPENDENCY_UNAVAILABLE` for unmapped, offline, unavailable, or rejected targets.

The private TLS proxy must accept OCC, not browsers or other workloads. It must
authenticate the source before forwarding the trusted identity header, derive
`x-forwarded-for` from the actual OCC peer connection, and avoid blindly
trusting caller-supplied forwarded headers. Native trusted-proxy configuration
must grant that service identity `operator.admin`; OCC still enforces the
caller-facing Agent `read` and `operate` permissions before reaching the proxy.
Native rejects all-loopback forwarded addresses, so loopback development needs a
real non-loopback OCC-to-proxy connection such as a separate proxy container,
not a fake IP or TLS bypass. The operator supplies the trust chain through the
Node.js trust store, `NODE_EXTRA_CA_CERTS`, or the pinned fingerprint. OCC does
not manage certificate issuance, renewal, proxy deployment, or network trust.

See the [workspace files flow](../flows/workspace-files.md) for the endpoint
map, proxy boundary, and request flow. The generated [HTTP API](api.md) owns the
wire schema.

## Namespace ownership

An Agent belongs to the Namespace in its creation URL. The controller assigns
that ownership; request bodies cannot select a different Namespace or
Installation.

Names are unique within one Namespace. Two different Namespaces can each own an
Agent with the same name, but neither can read or operate the other's Agent
without its own scoped permissions.

You can create an Agent while its Namespace is still `provisioning`. A failed
or deleting Namespace rejects new Agents.

## Agent service principal and workload credentials

Every Agent owns exactly one stable, platform-owned service principal.
Separate Agents receive separate service principals, even when they share a
Namespace. The service principal is immutable, belongs to its exact Agent and
Namespace, and remains the same across every revision of that Agent.

An Agent service principal does not inherit your permissions, session cookie,
provider credentials, or another Agent's identity. It has the same
role-granted capabilities as a human Principal: an appropriately scoped Role
and AccessBinding can grant any platform action, including administrative
actions and access to another Agent in the same Namespace. Its Namespace scope,
exact resource grants, and matching Restrictions still apply. The public Agent
response intentionally does not expose its internal `servicePrincipalId`.

Workload identity is execution credential evidence, not a third platform
principal. For a `dedicated` Agent, the
[Kubernetes Compute Driver](drivers/kubernetes-compute.md) uses separate
gateway and Codex ServiceAccounts. Only Codex receives the short-lived,
audience-scoped projected token for its exact Agent's existing
`servicePrincipalId`; production requires this projection. An `embedded`
gateway necessarily shares its exact Agent's projected workload identity and
Agent-specific model credential because that same process runs the built-in
Harness. Both modes are supported in production. OCC token verification,
identity exchange, and ServicePrincipal
authentication through the controller API remain deferred.

An Agent may also reference one same-Namespace, OCC-owned
[service account](service-accounts.md) through `serviceAccountId`; updating
the field to `null` detaches it. This optional credential reference does not
replace its ServicePrincipal or Kubernetes ServiceAccount.

## Execution mode

Each Agent explicitly records how its selected Harness runs:

- `embedded` starts one OpenClaw gateway with its built-in Harness. It is the
  default when creation omits `executionMode` and is supported in development
  and production; the combined workload receives its own Agent identity and
  model key.
- `dedicated` starts an Agent-owned gateway and a separate Codex app-server.
  Production uses separate workload identities, authenticated gateway-to-Codex
  transport, and either an operator-owned model API key or an associated
  account's directly projected access token mounted only into Codex.

The Agent's native Configuration selects a Harness through model/provider
`agentRuntime.id` policy. The [Harness execution reference](harness-execution.md)
owns supported runtime selections, model catalogs, transport, and credential
boundaries. OCC rejects conflicting, unknown, or mode-incompatible selections
before admitting a revision. A selected SandboxDriver currently requires
`dedicated` Codex execution; it does not support embedded OpenClaw.

An Agent update may include `executionMode`, `serviceAccountId`, and `providerId`
alongside its required `configurationId`. Omission preserves the current value;
`serviceAccountId: null` detaches the account and `providerId: null` clears the
Provider. Existing revisions retain their immutable placement, account, and
Provider association.
See the
[Harness execution topology flow](../flows/harness-execution-topology.md) for
runtime selection, identity boundaries, and activation.

## Editable configuration

An Agent's `configurationId` selects exactly one native OpenClaw Configuration
document with `kind: "agent"` in its own Namespace. A PATCH requires
`configurationId`, exact-Agent `update`, and exact-Configuration `read`.
For example, the body below replaces the reference and preserves the current
execution mode, service account, and Provider:

```json
{
  "configurationId": "cfg_123e4567-e89b-42d3-a456-426614174000"
}
```

The request returns `200` with the updated Agent. Update the Configuration's
native nested document through its own exact-resource PATCH endpoint; see
[Configuration CRUD](configuration.md#create-read-update-and-delete). Changing
the Agent reference or Configuration values does not queue Compute work,
change the active revision, or mutate earlier revisions. Agent create and update
accept a Configuration reference, optional execution mode, and optional service
account and Provider associations; they do not accept an inline configuration
document or competing gateway settings. Multiple Agents can
share the same Configuration;
each deployed Agent still owns its own gateway and stable service principal.

## Revisions and deployment

An AgentRevision is the immutable admitted configuration for one deployment
of its owning Agent. An Agent owns an ordered revision history and at most one
active revision, identified by `activeRevisionId`. Deployment does not overwrite
an earlier revision or make the new revision active immediately.

The revision records the source `configurationId`, `configurationKind`, and
`configurationGeneration`, its complete admitted native `configuration`
document, the approved Harness identity/version/mode, selected Compute identity,
nullable `providerId`, and any associated service account's opaque credential
reference. The account association contains no credential bytes. Native Configuration values must use
unresolved inline SecretRefs because the admitted document is persisted and
returned through the API; see [secret boundaries](configuration.md#secret-boundaries).
Nested objects and arrays are immutable.

When a SandboxDriver is selected, its `configureAgent` hook can transform a
copy of the source document before admission and snapshotting; it does not
update the reusable Configuration or its generation. The admitted revision
therefore records the source generation and the effective document after that
transformation. Its SandboxDriver selection and the Agent's stable service
principal are retained internally and are not exposed by the current HTTP
revision schema. See [SandboxDriver](drivers/sandbox.md).

An authorized `POST /namespaces/:namespaceId/agents/:agentId/deploy` has no
request body. It requires a `ready` Namespace, exact-Agent `deploy`, exact
Configuration `read`, and exact associated-account `read` when present. A
successful `202` means the immutable revision was admitted and its work queued;
it does not mean the workload is ready. Later Configuration edits or changes to
an account's selected credential reference affect only future deployments. A
snapshot freezes a Secret reference, not the value stored at that reference.

The separate PostgreSQL controller worker prepares the exact Agent gateway and
revision, activates its route, retires its predecessor, and sets
`activeRevisionId`. Each Agent owns its gateway; sibling Agents never share
one. The default PostgreSQL-backed development Compute Driver starts Docker
runtime containers for embedded OpenClaw or dedicated Codex topologies. Selected
Kubernetes Compute starts either an Agent-owned gateway plus a dedicated
Codex workload with its separate ServiceAccount, or one embedded combined
gateway/Harness. Without a SandboxDriver, Compute owns the Codex Deployment;
with one selected, that Driver provisions the dedicated Harness workload.
Both embedded and dedicated modes are supported in production, subject to the
selected Drivers' mode constraints. A replacement must preserve
its predecessor's Service selector until activation succeeds. Without an
eligible worker, revision work remains queued.

Revision list and read operations are scoped beneath the exact Namespace and
Agent. Each returned revision requires its own authorized read; substituting a
parent does not grant access to another Agent's history. Public response shapes
are defined by the [API reference](api.md).

## Current limitations

The public API has no Agent deletion operation, revision mutation/deletion,
or explicit rollback endpoint. An Agent therefore prevents deletion of its
Namespace. Editing a Configuration or Agent does not update a running workload;
a new deployment is required. Brokered model credentials and controller API
authentication for Agent service principals remain unavailable. The optional
[OpenShell SandboxDriver](drivers/openshell-sandbox.md) is supported with the
bundled Kubernetes Compute Driver and dedicated Codex; other sandbox execution
combinations are rejected.

## Failure semantics

- `400 INVALID_REQUEST`: The Provider ID is malformed or empty.
- `404 NOT_FOUND`: The nonempty Provider ID does not name a configured Provider.
- `401`: The session cookie is missing, invalid, expired, or revoked.
- `403`: Your principal lacks the exact permission for the Agent or Namespace.
- `404`: The Namespace or Agent does not exist under the requested parent.
- `404`: The selected Configuration does not belong to the Agent's Namespace.
- `404`: An associated service account does not belong to the Agent's Namespace.
- `409 RESOURCE_CONFLICT`: The associated account has no credential, stores an
  unsupported OAuth credential, or uses a provider-managed access token with
  an unsupported non-Codex or embedded Harness, or lacks a matching Provider
  and private managed-account binding.
- `409 RESOURCE_CONFLICT`: Another Agent already uses that name in the same
  Namespace, or the Namespace cannot accept new Agents.
- `409 NAMESPACE_NOT_READY`: The backing Namespace infrastructure is not ready
  for deployment.
- `503 DEPENDENCY_UNAVAILABLE`: A selected Harness descriptor, Compute
  implementation, or other required dependency is unavailable.

## Related

- [Quickstart](../guides/quickstart.md)
- [Development and production deployment](../guides/deploy.md)
- [Harness execution](harness-execution.md)
- [Namespaces](namespaces.md)
- [Controller worker](controller.md)
- [Namespace Configuration and immutable snapshots](configuration.md)
- [Service accounts](service-accounts.md)
- [Kubernetes Compute Driver](drivers/kubernetes-compute.md)
- [IAM](authorization.md)
- [Controller configuration](settings.md)
- [Implementation architecture](../ARCHITECTURE.md)
- [Agent lifecycle implementation](../../packages/occ/src/index.ts)
- [HTTP resource schemas](../../packages/contracts/src/api/resources.ts)
- [API integration coverage](../../tests/integration/occ-api.test.mjs)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-01 08:47: Document nullable providerId selection, immutable revision association, and managed binding admission. (01a05d97-f2b0-71d0-bfc3-01ee7d6d58f9 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)

- [2026-08-28 17:55]: Recast as the current Agent and AgentRevision feature reference; separate procedures and correct Harness and SandboxDriver boundaries. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
