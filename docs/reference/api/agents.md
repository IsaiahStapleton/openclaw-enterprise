# Agents API operations

<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->

<span id="agents"></span>

This generated page documents agents API operations. Use the [API index](../api.md) for the full operation list.

## `GET /namespaces/{namespaceId}/agents`

<span id="get-namespacesnamespaceidagents"></span>

List authorized Agents in one exact Namespace

**Operation ID:** `listAgents`

**Permissions:** Requires read permission on the requested Namespace. Only Agent resources with individual read permission are returned.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `namespace` | `requested` |
| `read` | `agent` | `each_returned` |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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
| `data[].activeRevisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data[].executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data[].id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].providerId` | `string or null` | Yes | — |
| `data[].serviceAccountId` | `string` | No | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## `POST /namespaces/{namespaceId}/agents`

<span id="post-namespacesnamespaceidagents"></span>

Create a Namespace-owned Agent

**Operation ID:** `createAgent`

**Permissions:** Requires create permission for Agent resources in the requested Namespace. Requires read permission on the requested Configuration. Requires read permission on each currently associated or newly associated ServiceAccount when present. Requires operate permission on each bound Secret when Secret bindings are present or selected.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `agent` | `namespace` |
| `read` | `configuration` | `requested` |
| `read` | `service_account` | `requested` (when associated) |
| `operate` | `secret` | `requested` (when bound) |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `executionMode` | `"embedded" or "dedicated"` | No | — |
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `providerId` | `string or null` | No | — |
| `serviceAccountId` | `string` | No | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`201` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.activeRevisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.providerId` | `string or null` | Yes | — |
| `data.serviceAccountId` | `string` | No | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## `GET /namespaces/{namespaceId}/agents/{agentId}`

<span id="get-namespacesnamespaceidagentsagentid"></span>

Get an exact Namespace-owned Agent

**Operation ID:** `getAgent`

**Permissions:** Requires read permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `agent` | `requested` |

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
| `data` | `object` | Yes | — |
| `data.activeRevisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.providerId` | `string or null` | Yes | — |
| `data.serviceAccountId` | `string` | No | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## `PATCH /namespaces/{namespaceId}/agents/{agentId}`

<span id="patch-namespacesnamespaceidagentsagentid"></span>

Replace an exact Namespace-owned Agent's editable draft

**Operation ID:** `updateAgent`

**Permissions:** Requires update permission on the requested Agent. Requires read permission on the requested Configuration. Requires read permission on each currently associated or newly associated ServiceAccount when present. Requires operate permission on each bound Secret when Secret bindings are present or selected.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `agent` | `requested` |
| `read` | `configuration` | `requested` |
| `read` | `service_account` | `requested` (when associated) |
| `operate` | `secret` | `requested` (when bound) |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `executionMode` | `"embedded" or "dedicated"` | No | — |
| `providerId` | `string or null` | No | — |
| `serviceAccountId` | `string or null` | No | — |

## Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.activeRevisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.providerId` | `string or null` | Yes | — |
| `data.serviceAccountId` | `string` | No | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Related

- [API index](../api.md)
