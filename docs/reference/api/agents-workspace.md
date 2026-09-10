# Agent workspace files API operations

<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->

<span id="agent-workspace-files"></span>

This generated page documents agent workspace files API operations. Use the [API index](../api.md) for the full operation list.

## `GET /namespaces/{namespaceId}/agents/{agentId}/workspace/files/{name}`

<span id="get-namespacesnamespaceidagentsagentidworkspacefilesname"></span>

Read an allowed workspace file from one active Agent

**Operation ID:** `getAgentWorkspaceFile`

**Permissions:** Requires read permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `agent` | `requested` |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `name` | path | `"AGENTS.md" or "SOUL.md" or "IDENTITY.md" or "USER.md"` | Yes | — |

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
| `data.content` | `string` | Yes | max length: 16384; pattern: `^[^\u0000]*$` |
| `data.name` | `"AGENTS.md" or "SOUL.md" or "IDENTITY.md" or "USER.md"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## `PUT /namespaces/{namespaceId}/agents/{agentId}/workspace/files/{name}`

<span id="put-namespacesnamespaceidagentsagentidworkspacefilesname"></span>

Create or replace an allowed workspace file for one active Agent

**Operation ID:** `putAgentWorkspaceFile`

**Permissions:** Requires operate permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `operate` | `agent` | `requested` |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `name` | path | `"AGENTS.md" or "SOUL.md" or "IDENTITY.md" or "USER.md"` | Yes | — |

## Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `content` | `string` | Yes | max length: 16384; pattern: `^[^\u0000]*$`; Workspace file content. The controller also enforces a 16 KiB UTF-8 byte limit and rejects unpaired UTF-16 surrogates. |

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
| `data.name` | `"AGENTS.md" or "SOUL.md" or "IDENTITY.md" or "USER.md"` | Yes | — |
| `data.size` | `integer` | No | minimum: 0; maximum: 16384 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Related

- [API index](../api.md)
