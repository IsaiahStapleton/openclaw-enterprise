# Providers

A Provider is Installation-owned configuration that gives related Drivers an
authenticated client for one provider backend. An Agent can select one configured
Provider through nullable `providerId`. The reference is independent of native
model names and Harness selection; it does not grant model access or create an
account.

The bundled `chatgpt` Provider uses an admin API key to manage upstream service
accounts. It does not perform inference. Providers are not OCC resources and
have no CRUD, discovery, or authorization API.

## Installation configuration

Add this fragment to the existing required `occ` and Driver settings:

```yaml
provider:
  - id: openai
    type: chatgpt
    configuration:
      workspaceId: "11111111-1111-4111-8111-111111111111"
      apiKeyPath: /etc/openclaw/chatgpt/admin-key
      credentialTtlSeconds: 2592000
    drivers:
      service_account: chatgpt-service-accounts
drivers:
  service_account:
    id: chatgpt-service-accounts
    configuration: {}
```

The singular `provider` key contains an array. Omission or `[]` means no
Providers. IDs are unique strings of 1–200 characters, without leading or
trailing whitespace or ASCII control characters. `openai` is an operator-chosen ID;
`type: chatgpt` selects the bundled implementation. `workspaceId` must be a valid
workspace UUID and is a provider connection identity, not a Namespace mapping.

`apiKeyPath` is an absolute path to a protected mounted file, never an inline
key. The key requires `chatgpt.enterprise.service_account.write` and authority
for the configured workspace. The client uses its fixed trusted endpoint;
operators cannot configure an upstream URL. `credentialTtlSeconds` defaults to
2,592,000 seconds (30 days), accepts 1–2,592,000, and does not renew existing
credentials when changed.

`provider[].drivers` is the sole membership declaration. Each capability maps
to the exact selected ID in `drivers`. A ChatGPT Provider requires its
`service_account` member, and that Driver requires its owning Provider. Startup
rejects duplicate Provider IDs, missing or unselected members, and assignment of
one Driver to multiple Providers. All related Drivers are required. Since OCC
selects only one Driver per capability, the bundled configuration currently
permits at most one ChatGPT Provider.

The retired `integrations` configuration and `adminKeyPath` are rejected. The
current format uses `provider` and `apiKeyPath`; no automatic conversion guesses
ownership of old managed accounts or revisions.

## Driver and client contract

The [shared contracts](../../packages/contracts/src/index.ts) expose the current
runtime shape:

```ts
interface Provider<Client = unknown> {
  readonly id: string;
  readonly client: Client;
  readonly drivers: Readonly<Partial<Record<DriverCapability, string>>>;
}
```

`Client` is the implementation's concrete API, not a common inference or HTTP
interface. Composition passes `Provider<ChatGPTClient>` to the bundled
`ChatGPTServiceAccountDriver`. The Driver declares its matching `providerId`;
provider-independent Drivers omit that field. Registry keys remain
`(capability, id)` and selection remains Installation-wide.

Only the API reads the mounted key, constructs the client, and registers this
ServiceAccount Driver after controller/state injection. The Driver still uses
Compute's account-credential storage and its existing lifecycle methods. The
worker loads the same nonsecret Provider definitions and validates membership,
but receives no runtime Provider object, admin key, or ServiceAccount Driver.
Installed Driver factory signatures and package trust rules remain unchanged.

## Agent association and immutable deployment

Create an Agent with a configured Provider:

```http
POST /namespaces/{namespaceId}/agents
Content-Type: application/json

{"name":"helper","configurationId":"cfg_11111111-1111-4111-8111-111111111111","providerId":"openai"}
```

The existing `201 { data, meta }` response includes `data.providerId`.
Deployment is a separate bodyless
`POST /namespaces/{namespaceId}/agents/{agentId}/deploy`; its `202` response
contains the admitted AgentRevision with the saved `providerId`.

| Input                           | Create        | Agent PATCH                     |
| ------------------------------- | ------------- | ------------------------------- |
| Omitted                         | Save `null`.  | Preserve the current reference. |
| `null`                          | Save `null`.  | Clear the draft reference.      |
| Known nonempty ID               | Save that ID. | Replace the draft reference.    |
| Empty, malformed, or unknown ID | Reject.       | Reject.                         |

Malformed or empty IDs return `400 INVALID_REQUEST`; an unknown nonempty ID
returns `404 NOT_FOUND`, following existing scoped-reference behavior.

PATCH still requires `configurationId`. `ProviderRef` names the shared nullable
type; the wire field is always `providerId`. No Provider is inferred from model
configuration, configured Providers, or an associated ServiceAccount. Creating
or updating an Agent does not call the provider or issue credentials. Each
revision freezes the association; later draft changes affect only a subsequent
deployment.

Providerless Agents remain valid with independently supplied model credentials
or native `api_key` account references. An attached managed `access_token`
requires a matching nonnull Provider and dedicated Codex execution. Admission
checks the exact Namespace/account binding, owning Provider, selected member
Driver, configured workspace, and recorded credential issuance. Public
credential kind alone never establishes ownership. A mismatch is a
`409 RESOURCE_CONFLICT`; missing runtime dependencies fail closed.

The worker repeats the binding check after IAM reauthorization and before
workload effects using a read-only metadata projection. External account and
credential IDs stay private. Failure prevents candidate activation and follows
normal reconciliation recovery. The account-owned token and workspace Secret
is projected only into its compatible dedicated Codex workload.

## Startup identity and safe Provider changes

API and worker startup validate stored managed bindings against the configured
Provider ID, Driver ID, and workspace before accepting work. Agent drafts and
active or nonterminal candidate revisions must resolve their nonnull references.
Historical inactive revisions do not prevent removal. Removing a Provider or
retargeting its workspace while those bindings or references remain rejects
startup; it cannot reinterpret an old binding as a new provider account.

Before removing or retargeting a Provider, retain its original configuration.
Detach managed accounts from affected Agent drafts, clear or change their
`providerId`, supply valid independent credentials, and deploy the drafts. Wait
for replacement activation and retirement of old/candidate workloads. Then
revoke and delete the exact managed accounts through the ServiceAccount API.
Remove the Provider only after its bindings and live references are gone. If
cleanup fails, retain the original configuration and retry. Key and TTL changes
retain identity and do not rewrite issued credentials.

Existing pre-Provider managed state requires the approved clean development-state
transition in the [implementation specification](../../specs/17-provider-driver-abstraction.md#migration-and-implementation-boundaries).
There is no in-place adoption or backfill. Stop affected workloads and complete
exact upstream cleanup through the old API/configuration before deliberately
recreating selected disposable state. Draft edits and control-plane shutdown do
not stop workloads; the API has no Agent stop/delete operation. Failed cleanup
preserves the old state for recovery.

## Production packaging and verification

Helm uses a separate packaging object, not the Installation array:

```yaml
provider:
  chatgpt:
    enabled: true
    secretName: occ-chatgpt-admin
    key: admin-key
    providerCidr: "203.0.113.10/32" # Replace with the approved provider/proxy IP.
```

Enable this together with the Installation Provider entry. The chart mounts the
dedicated Secret at `/etc/openclaw/chatgpt/admin-key` only in the API Pod;
Installation `apiKeyPath` must match that path. API-only TCP/443 egress targets
one approved `/32`. The worker gets neither the mount nor the egress exception.
Disabled defaults retain `occ-chatgpt-admin`, `admin-key`, and an empty CIDR.
See [deployment](../guides/deploy.md) for the complete setup and
[security](security.md) for credential and Kubernetes authority boundaries.

Use configuration-startup, API, ServiceAccount conformance, PostgreSQL, and Helm
packaging tests for the relevant contract. The
[Provider lifecycle flow](../flows/provider-driver-lifecycle.md) identifies
entry points and observable failure outcomes. Unit or fixture coverage does not
prove live provider calls, Kubernetes policy enforcement, or a model response;
[real ServiceAccount testing](../../tests/integration/service-account-driver-real.test.mjs)
requires authorized credentials and explicitly selected disposable infrastructure.

## Deferred behavior

Required/optional Driver selection, per-Agent Driver selection, automatic
account creation, clientless Providers, Provider package loading or injection
into installed factories, UI discovery, OAuth/refresh, renewal, and a common
inference API are outside the current contract.

## Related

- [Agents](agents.md)
- [Service accounts](service-accounts.md)
- [Driver selection](drivers/selection.md)
- [ServiceAccountDriver](drivers/service-account.md)
- [Platform design](../design.md#drivers-and-providers)
