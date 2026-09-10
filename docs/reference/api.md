# Development OCC API reference

<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->

Version `0.1.0`; OpenAPI `3.1.0`.

This reference is generated from the
[checked-in OpenAPI contract](../../packages/contracts/openapi/occ-api.openapi.json).
Run `pnpm openapi:generate` after changing an API route or schema;
`pnpm openapi:check` verifies the generated contract and API reference pages.

The exported contract comes from the development-enabled OCC app, which is
why the generated title is `Development OCC API`. Use
`POST /installation/bootstrap` only for development or bootstrap flows
that create the first Installation; production bootstraps through the
[Helm initialization Job](../guides/deploy/production-installation.md#provision-system-secrets-and-install)
before serving requests.
After bootstrap, production uses the same authenticated controller resource
operations through the selected Drivers and settings described in
[settings](settings.md).

See [authentication](authentication.md) for supported credentials and their scope.

## Error responses

Non-success JSON responses use the following envelope.
Each operation lists its supported status codes.

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `error` | `object` | Yes | — |
| `error.code` | `"INVALID_REQUEST" or "UNAUTHENTICATED" or "FORBIDDEN" or "NOT_FOUND" or "METHOD_NOT_ALLOWED" or "INSTALLATION_EXISTS" or "RESOURCE_CONFLICT" or "NAMESPACE_NOT_READY" or "NAMESPACE_NOT_EMPTY" or "PAYLOAD_TOO_LARGE" or "UNSUPPORTED_MEDIA_TYPE" or "UNKNOWN_OUTCOME" or "INTERNAL_ERROR" or "DEPENDENCY_UNAVAILABLE"` | Yes | — |
| `error.details` | `array<object>` | No | max items: 32 |
| `error.details[].code` | `"REQUIRED" or "UNKNOWN_FIELD" or "INVALID_TYPE" or "INVALID_FORMAT" or "INVALID_VALUE" or "TOO_LONG" or "TOO_DEEP"` | Yes | — |
| `error.details[].path` | `string` | Yes | max length: 512; pattern: `^(?:/(?:[^~/]\|~0\|~1)*)*$` |
| `error.message` | `string` | Yes | min length: 1; max length: 256 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Resources

| Resource | Operations |
| --- | --- |
| [Authentication](api/authentication.md#authentication) | 6 operations |
| [Platform](api/platform.md#platform) | 3 operations |
| [Namespaces](api/namespaces.md#namespaces) | 4 operations |
| [Agents](api/agents.md#agents) | 4 operations |
| [Agent deployment](api/agents-deployment.md#agent-deployment) | 1 operation |
| [Agent runtime credentials](api/agents-runtime-credentials.md#agent-runtime-credentials) | 2 operations |
| [Agent workspace files](api/agents-workspace.md#agent-workspace-files) | 2 operations |
| [Agent revisions](api/agent-revisions.md#agent-revisions) | 2 operations |
| [Configurations](api/configurations.md#configurations) | 4 operations |
| [Secrets](api/secrets.md#secrets) | 4 operations |
| [Service accounts](api/service-accounts.md#service-accounts) | 6 operations |

## Operations

### Authentication

| Operation | Summary |
| --- | --- |
| <span id="post-apiauthaccounts"></span>[`POST /api/auth/accounts`](api/authentication.md#post-apiauthaccounts) | Create an administrator-controlled local auth account |
| <span id="post-apiauthservicekeys"></span>[`POST /api/auth/service-keys`](api/authentication.md#post-apiauthservicekeys) | Issue a service API key |
| <span id="delete-apiauthservicekeyskeyid"></span>[`DELETE /api/auth/service-keys/{keyId}`](api/authentication.md#delete-apiauthservicekeyskeyid) | Revoke a service API key |
| <span id="get-apiauthsession"></span>[`GET /api/auth/session`](api/authentication.md#get-apiauthsession) | Inspect authentication without revealing session tokens |
| <span id="post-apiauthsigninemail"></span>[`POST /api/auth/sign-in/email`](api/authentication.md#post-apiauthsigninemail) | Sign in with email and password |
| <span id="post-apiauthsignout"></span>[`POST /api/auth/sign-out`](api/authentication.md#post-apiauthsignout) | Sign out of the current session |

### Platform

| Operation | Summary |
| --- | --- |
| <span id="get-installation"></span>[`GET /installation`](api/platform.md#get-installation) | Get the singleton Installation |
| <span id="post-installationbootstrap"></span>[`POST /installation/bootstrap`](api/platform.md#post-installationbootstrap) | Bootstrap the singleton Installation |
| <span id="get-providers"></span>[`GET /providers`](api/platform.md#get-providers) | List configured Providers |

### Namespaces

| Operation | Summary |
| --- | --- |
| <span id="get-namespaces"></span>[`GET /namespaces`](api/namespaces.md#get-namespaces) | List authorized Namespaces |
| <span id="post-namespaces"></span>[`POST /namespaces`](api/namespaces.md#post-namespaces) | Create an Installation-owned Namespace |
| <span id="delete-namespacesnamespaceid"></span>[`DELETE /namespaces/{namespaceId}`](api/namespaces.md#delete-namespacesnamespaceid) | Begin deletion of an empty Installation-owned Namespace |
| <span id="get-namespacesnamespaceid"></span>[`GET /namespaces/{namespaceId}`](api/namespaces.md#get-namespacesnamespaceid) | Get an exact Installation-owned Namespace |

### Agents

| Operation | Summary |
| --- | --- |
| <span id="get-namespacesnamespaceidagents"></span>[`GET /namespaces/{namespaceId}/agents`](api/agents.md#get-namespacesnamespaceidagents) | List authorized Agents in one exact Namespace |
| <span id="post-namespacesnamespaceidagents"></span>[`POST /namespaces/{namespaceId}/agents`](api/agents.md#post-namespacesnamespaceidagents) | Create a Namespace-owned Agent |
| <span id="get-namespacesnamespaceidagentsagentid"></span>[`GET /namespaces/{namespaceId}/agents/{agentId}`](api/agents.md#get-namespacesnamespaceidagentsagentid) | Get an exact Namespace-owned Agent |
| <span id="patch-namespacesnamespaceidagentsagentid"></span>[`PATCH /namespaces/{namespaceId}/agents/{agentId}`](api/agents.md#patch-namespacesnamespaceidagentsagentid) | Replace an exact Namespace-owned Agent's editable draft |

### Agent deployment

| Operation | Summary |
| --- | --- |
| <span id="post-namespacesnamespaceidagentsagentiddeploy"></span>[`POST /namespaces/{namespaceId}/agents/{agentId}/deploy`](api/agents-deployment.md#post-namespacesnamespaceidagentsagentiddeploy) | Admit an immutable revision from the Agent's saved draft |

### Agent runtime credentials

| Operation | Summary |
| --- | --- |
| <span id="get-namespacesnamespaceidagentsagentidruntimecredentials"></span>[`GET /namespaces/{namespaceId}/agents/{agentId}/runtime-credentials`](api/agents-runtime-credentials.md#get-namespacesnamespaceidagentsagentidruntimecredentials) | Get metadata for one Agent's provisioned runtime credentials |
| <span id="post-namespacesnamespaceidagentsagentidruntimecredentials"></span>[`POST /namespaces/{namespaceId}/agents/{agentId}/runtime-credentials`](api/agents-runtime-credentials.md#post-namespacesnamespaceidagentsagentidruntimecredentials) | Provision initial runtime credentials for one undeployed Agent |

### Agent workspace files

| Operation | Summary |
| --- | --- |
| <span id="get-namespacesnamespaceidagentsagentidworkspacefilesname"></span>[`GET /namespaces/{namespaceId}/agents/{agentId}/workspace/files/{name}`](api/agents-workspace.md#get-namespacesnamespaceidagentsagentidworkspacefilesname) | Read an allowed workspace file from one active Agent |
| <span id="put-namespacesnamespaceidagentsagentidworkspacefilesname"></span>[`PUT /namespaces/{namespaceId}/agents/{agentId}/workspace/files/{name}`](api/agents-workspace.md#put-namespacesnamespaceidagentsagentidworkspacefilesname) | Create or replace an allowed workspace file for one active Agent |

### Agent revisions

| Operation | Summary |
| --- | --- |
| <span id="get-namespacesnamespaceidagentsagentidrevisions"></span>[`GET /namespaces/{namespaceId}/agents/{agentId}/revisions`](api/agent-revisions.md#get-namespacesnamespaceidagentsagentidrevisions) | List authorized immutable revisions for one exact Agent |
| <span id="get-namespacesnamespaceidagentsagentidrevisionsrevisionid"></span>[`GET /namespaces/{namespaceId}/agents/{agentId}/revisions/{revisionId}`](api/agent-revisions.md#get-namespacesnamespaceidagentsagentidrevisionsrevisionid) | Get an exact authorized immutable Agent revision |

### Configurations

| Operation | Summary |
| --- | --- |
| <span id="post-namespacesnamespaceidconfigurations"></span>[`POST /namespaces/{namespaceId}/configurations`](api/configurations.md#post-namespacesnamespaceidconfigurations) | Create a native Namespace-owned Agent Configuration |
| <span id="delete-namespacesnamespaceidconfigurationsconfigurationid"></span>[`DELETE /namespaces/{namespaceId}/configurations/{configurationId}`](api/configurations.md#delete-namespacesnamespaceidconfigurationsconfigurationid) | Delete an exact unreferenced Namespace-owned Configuration |
| <span id="get-namespacesnamespaceidconfigurationsconfigurationid"></span>[`GET /namespaces/{namespaceId}/configurations/{configurationId}`](api/configurations.md#get-namespacesnamespaceidconfigurationsconfigurationid) | Get an exact Namespace-owned Configuration |
| <span id="patch-namespacesnamespaceidconfigurationsconfigurationid"></span>[`PATCH /namespaces/{namespaceId}/configurations/{configurationId}`](api/configurations.md#patch-namespacesnamespaceidconfigurationsconfigurationid) | Replace values and increment an exact Namespace-owned Configuration generation |

### Secrets

| Operation | Summary |
| --- | --- |
| <span id="post-namespacesnamespaceidsecrets"></span>[`POST /namespaces/{namespaceId}/secrets`](api/secrets.md#post-namespacesnamespaceidsecrets) | Create exact Namespace-owned Secret material and return metadata only |
| <span id="delete-namespacesnamespaceidsecretssecretid"></span>[`DELETE /namespaces/{namespaceId}/secrets/{secretId}`](api/secrets.md#delete-namespacesnamespaceidsecretssecretid) | Delete exact unbound Namespace-owned Secret material |
| <span id="get-namespacesnamespaceidsecretssecretid"></span>[`GET /namespaces/{namespaceId}/secrets/{secretId}`](api/secrets.md#get-namespacesnamespaceidsecretssecretid) | Get exact Namespace-owned Secret metadata without revealing material |
| <span id="patch-namespacesnamespaceidsecretssecretid"></span>[`PATCH /namespaces/{namespaceId}/secrets/{secretId}`](api/secrets.md#patch-namespacesnamespaceidsecretssecretid) | Replace exact Namespace-owned Secret material and return stable metadata |

### Service accounts

| Operation | Summary |
| --- | --- |
| <span id="get-namespacesnamespaceidserviceaccounts"></span>[`GET /namespaces/{namespaceId}/service-accounts`](api/service-accounts.md#get-namespacesnamespaceidserviceaccounts) | List authorized Namespace-owned ServiceAccounts in one exact Namespace |
| <span id="post-namespacesnamespaceidserviceaccounts"></span>[`POST /namespaces/{namespaceId}/service-accounts`](api/service-accounts.md#post-namespacesnamespaceidserviceaccounts) | Create a native Namespace-owned ServiceAccount |
| <span id="delete-namespacesnamespaceidserviceaccountsserviceaccountid"></span>[`DELETE /namespaces/{namespaceId}/service-accounts/{serviceAccountId}`](api/service-accounts.md#delete-namespacesnamespaceidserviceaccountsserviceaccountid) | Delete an exact unreferenced Namespace-owned ServiceAccount |
| <span id="get-namespacesnamespaceidserviceaccountsserviceaccountid"></span>[`GET /namespaces/{namespaceId}/service-accounts/{serviceAccountId}`](api/service-accounts.md#get-namespacesnamespaceidserviceaccountsserviceaccountid) | Get an exact Namespace-owned ServiceAccount |
| <span id="patch-namespacesnamespaceidserviceaccountsserviceaccountidcredential"></span>[`PATCH /namespaces/{namespaceId}/service-accounts/{serviceAccountId}/credential`](api/service-accounts.md#patch-namespacesnamespaceidserviceaccountsserviceaccountidcredential) | Associate an exact Namespace-local credential reference with a ServiceAccount |
| <span id="post-namespacesnamespaceidserviceaccountsserviceaccountidcredentials"></span>[`POST /namespaces/{namespaceId}/service-accounts/{serviceAccountId}/credentials`](api/service-accounts.md#post-namespacesnamespaceidserviceaccountsserviceaccountidcredentials) | Issue a managed credential for an exact Namespace-owned ServiceAccount |

## Shared schemas

Reusable schema names are referenced by operation request and response tables.

| Schema | Type |
| --- | --- |
| `SafeJsonValue` | `string or boolean or number or null or array<SafeJsonValue> or object<string, SafeJsonValue>` |
| `ErrorResponse` | `object` |
| `AgentRuntimeCredentialResponse` | `object` |
| `SecretResponse` | `object` |
