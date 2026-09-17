# ServiceAccountDriver contract

`ServiceAccountDriver` provisions provider accounts and credentials for
Namespace-scoped ServiceAccounts. OCC owns the resource's identity, ownership,
authorization, Agent references, and API response. The Driver owns provider
operations and private mappings from OCC resources to provider resources.

The [ServiceAccount reference](../service-accounts.md) defines the feature's
lifecycle and deployment limits. The exported interface is in
[shared contracts](../../../packages/contracts/src/index.ts).

## Operations and credential boundary

| Operation                   | Contract                                                                      |
| --------------------------- | ----------------------------------------------------------------------------- |
| `create(account)`           | Provision the selected provider's account for the admitted ServiceAccount.    |
| `createCredential(account)` | Issue a credential and return its kind and secret reference.                  |
| `delete(account)`           | Revoke and remove the provider-owned resources for that exact ServiceAccount. |

The shared interface has no account-update, credential-refresh, or standalone
credential-delete operation. Provider changes happen only through implemented
lifecycle operations; callers cannot select external account IDs.

A returned credential contains a `kind` and `secretRef: { name, key }`, never
the credential value. The shared type includes `api_key`, `access_token`, and
`oauth_access_token`; this does not mean every kind is supported for revision
admission or by every provider. Current harness bindings accept only managed ChatGPT
`access_token` credentials for dedicated Codex. API keys instead use
Namespace-owned OCC Secrets through [Agent harness authentication](../agents.md#harness-authentication). OCC's provider credential-creation operation currently accepts only
an `access_token` result; an otherwise well-formed result of another kind is
rejected.

## Bundled ChatGPT implementation

The [ChatGPT Driver](../../../apps/controller/src/drivers/service-account/chatgpt.ts)
is an optional Installation selection. Trusted startup requires its owning
`type: chatgpt` Provider and exact `service_account` membership together. The
Driver receives `Provider<ChatGPTClient>` and keeps ownership private; the
[Provider reference](../providers.md) owns membership and client construction.
The Driver selection accepts `id` and an empty
`configuration`; installing an arbitrary ServiceAccount package through the
`package` selector is not currently supported.

The Driver creates the provider account, stores its Namespace-scoped binding
in PostgreSQL, and issues an `access_token`. The selected Compute credential
storage writes the token and workspace identity to an account-owned Secret;
the Driver returns only the secret reference. Provider account IDs, credential
IDs, and workspace bindings remain internal.

Credential creation rejects a missing exact binding or an existing credential.
Provider and Secret creation register compensation with OCC so a failed
operation can remove resources it created. Deletion revokes the provider
credential, removes its stored Secret, and deletes the provider account. Missing
bindings make provider deletion a no-op; conflicting Provider, Driver, or
workspace identity fails instead of deleting a different account. Issuance and
deletion recheck the stored binding against the configured Provider.

Provider access tokens are delivered only to a dedicated Codex Harness. This
Driver does not implement credential renewal; an expired or revoked credential
does not silently fall back to an operator API key. See
[settings](../settings.md) and [deployment](../../guides/deploy.md) for the
operator configuration and credential-file requirements.
