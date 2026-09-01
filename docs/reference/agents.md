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

## Gateway administration

`POST /namespaces/:namespaceId/agents/:agentId/gateway/` dispatches one
allowlisted native gateway command to the Agent's current active gateway. The
caller must authenticate with a Better Auth session that satisfies the
controller CSRF boundary or with a scoped service API key, and must have exact
Agent `administer` permission. Agent ServicePrincipal credentials are rejected
at authentication admission, even if the principal has an explicit IAM grant.

The request body contains a native method and optional JSON parameters. OpenClaw
Controller (OCC) rejects extra top-level fields, caller-selected URLs, arbitrary
shell input, and methods outside this code-owned allowlist before contacting the
gateway:

| Methods                                                                                    | Purpose                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `health`, `status`, `config.get`, `config.schema.lookup`, `agents.list`, `channels.status` | Inspect the selected gateway and its effective configuration. |
| `agents.files.list`, `agents.files.get`, `agents.files.set`                                | Use native workspace file semantics for the selected Agent.   |
| `chat.send`, `chat.history`, `chat.abort`                                                  | Submit, inspect, or abort native chat work.                   |

Native configuration mutation, update/device administration, arbitrary RPC,
offline native initialization, and browser-to-gateway credentials are not exposed
through this route. OCC rejects
malformed request bodies and unsupported methods with `400`, unauthenticated or
expired caller credentials with `401`, and authenticated callers that fail IAM
or browser CSRF checks with `403`. If gateway administration is unavailable,
missing a current owned running Kubernetes gateway Pod, or selected for an
unsupported Compute implementation, the route returns `503` before dispatch and
has no gateway side effects.

The `config.get` payload omits OpenClaw 2026.8.1's internal
`sourceConfigBeforeMigrations` snapshot because it contains unredacted secrets.
The supported public configuration fields retain native redaction.

OCC records an audit dispatch before forwarding and records success, native
rejection, or an unknown transport outcome after the attempt. If the command
was sent and the transport times out, disconnects, or is cancelled, OCC reports
`UNKNOWN_OUTCOME` instead of replaying the command; the native gateway may have
already applied the operation. `chat.send` returns the native started
acknowledgment; it does not wait for model-turn completion. Use `chat.history`
to inspect the resulting messages.

Gateway administration is currently implemented by the bundled Kubernetes
Compute Driver. The private adapter resolves the Agent's current active
revision, verifies the selected Service, EndpointSlice, Deployment, and one
ready owned gateway Pod, then executes a fixed helper in that gateway container
through Kubernetes `pods/exec`. The helper receives bounded JSON on stdin, calls
the ordinary OpenClaw CLI/API against the Pod-local gateway port using the
gateway's existing local configuration and authentication, and returns captured
JSON. It is not a caller-controlled shell, WebSocket proxy, native SDK client,
or device-enrollment path.

OCC does not create an independent native device, store a gateway
administration token Secret, pin identity on the gateway PVC, or project OCC
private keys or controller Kubernetes credentials into Agent workloads. Runtime
authority comes from the OCC caller's IAM authorization plus the controller API's
Kubernetes permission to execute the fixed helper in the exact owned Pod. Docker
and external Compute Drivers return unsupported until they implement the same
owned-Pod command contract. See the
[gateway administration flow](../flows/gateway-administration.md) and
[production deployment guide](../guides/deploy.md#enable-gateway-administration)
for runtime details and operator setup.
