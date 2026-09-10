# Agent runtime credentials API operations

<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->

<span id="agent-runtime-credentials"></span>

This generated page documents agent runtime credentials API operations. Use the [API index](../api.md) for the full operation list.

## `GET /namespaces/{namespaceId}/agents/{agentId}/runtime-credentials`

<span id="get-namespacesnamespaceidagentsagentidruntimecredentials"></span>

Get metadata for one Agent's provisioned runtime credentials

**Operation ID:** `getAgentRuntimeCredentials`

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
| `data.modelConfigured` | `boolean` | Yes | — |
| `data.slackConfigured` | `boolean` | Yes | — |
| `data.transportConfigured` | `boolean` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## `POST /namespaces/{namespaceId}/agents/{agentId}/runtime-credentials`

<span id="post-namespacesnamespaceidagentsagentidruntimecredentials"></span>

Provision initial runtime credentials for one undeployed Agent

**Operation ID:** `provisionAgentRuntimeCredentials`

**Permissions:** Requires operate permission on the requested Agent. Requires read permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `operate` | `agent` | `requested` |
| `read` | `agent` | `requested` |

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
| `modelApiKey` | `string` | No | min length: 1; max length: 65536; pattern: `^[^\u0000]*$`; Protected Agent runtime credential value. OCC accepts at most 65,536 UTF-8 bytes and never returns the value. |
| `slack` | `object` | No | — |
| `slack.appToken` | `string` | Yes | min length: 1; max length: 65536; pattern: `^[^\u0000]*$`; Protected Agent runtime credential value. OCC accepts at most 65,536 UTF-8 bytes and never returns the value. |
| `slack.botToken` | `string` | Yes | min length: 1; max length: 65536; pattern: `^[^\u0000]*$`; Protected Agent runtime credential value. OCC accepts at most 65,536 UTF-8 bytes and never returns the value. |

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
| `data.modelConfigured` | `boolean` | Yes | — |
| `data.slackConfigured` | `boolean` | Yes | — |
| `data.transportConfigured` | `boolean` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Related

- [API index](../api.md)
