# Agent revisions API operations

<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->

<span id="agent-revisions"></span>

This generated page documents agent revisions API operations. Use the [API index](../api.md) for the full operation list.

## `GET /namespaces/{namespaceId}/agents/{agentId}/revisions`

<span id="get-namespacesnamespaceidagentsagentidrevisions"></span>

List authorized immutable revisions for one exact Agent

**Operation ID:** `listAgentRevisions`

**Permissions:** Requires read permission on the requested Agent. Only AgentRevision resources with individual read permission are returned.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `agent` | `requested` |
| `read` | `agent_revision` | `each_returned` |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `array<object>` | Yes | — |
| `data[].agentId` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].compute` | `object` | Yes | — |
| `data[].compute.id` | `string` | Yes | min length: 1 |
| `data[].compute.implementation` | `string` | Yes | min length: 1 |
| `data[].configuration` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |
| `data[].configurationGeneration` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |
| `data[].configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].configurationKind` | `"agent"` | Yes | — |
| `data[].createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data[].harness` | `object` | Yes | — |
| `data[].harness.id` | `string` | Yes | min length: 1 |
| `data[].harness.mode` | `"embedded" or "dedicated"` | Yes | — |
| `data[].harness.version` | `string` | Yes | min length: 1 |
| `data[].id` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].providerId` | `string or null` | Yes | — |
| `data[].revision` | `integer` | Yes | minimum: 1 |
| `data[].secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables; `OPENAI_API_KEY` is the only allowed `OPENAI_*` destination. |
| `data[].secretDriverId` | `string` | No | min length: 1 |
| `data[].serviceAccount` | `object` | No | — |
| `data[].serviceAccount.credential` | `object` | Yes | — |
| `data[].serviceAccount.credential.kind` | `"api_key" or "access_token"` | Yes | — |
| `data[].serviceAccount.credential.secretRef` | `object` | Yes | — |
| `data[].serviceAccount.credential.secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `data[].serviceAccount.credential.secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |
| `data[].serviceAccount.id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## `GET /namespaces/{namespaceId}/agents/{agentId}/revisions/{revisionId}`

<span id="get-namespacesnamespaceidagentsagentidrevisionsrevisionid"></span>

Get an exact authorized immutable Agent revision

**Operation ID:** `getAgentRevision`

**Permissions:** Requires read permission on the requested AgentRevision.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `agent_revision` | `requested` |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `revisionId` | path | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.agentId` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.compute` | `object` | Yes | — |
| `data.compute.id` | `string` | Yes | min length: 1 |
| `data.compute.implementation` | `string` | Yes | min length: 1 |
| `data.configuration` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |
| `data.configurationGeneration` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |
| `data.configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.configurationKind` | `"agent"` | Yes | — |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.harness` | `object` | Yes | — |
| `data.harness.id` | `string` | Yes | min length: 1 |
| `data.harness.mode` | `"embedded" or "dedicated"` | Yes | — |
| `data.harness.version` | `string` | Yes | min length: 1 |
| `data.id` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.providerId` | `string or null` | Yes | — |
| `data.revision` | `integer` | Yes | minimum: 1 |
| `data.secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables; `OPENAI_API_KEY` is the only allowed `OPENAI_*` destination. |
| `data.secretDriverId` | `string` | No | min length: 1 |
| `data.serviceAccount` | `object` | No | — |
| `data.serviceAccount.credential` | `object` | Yes | — |
| `data.serviceAccount.credential.kind` | `"api_key" or "access_token"` | Yes | — |
| `data.serviceAccount.credential.secretRef` | `object` | Yes | — |
| `data.serviceAccount.credential.secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `data.serviceAccount.credential.secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |
| `data.serviceAccount.id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Related

- [API index](../api.md)
