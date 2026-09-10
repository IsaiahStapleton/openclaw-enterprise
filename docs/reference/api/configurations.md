# Configurations API operations

<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->

<span id="configurations"></span>

This generated page documents configurations API operations. Use the [API index](../api.md) for the full operation list.

## `POST /namespaces/{namespaceId}/configurations`

<span id="post-namespacesnamespaceidconfigurations"></span>

Create a native Namespace-owned Agent Configuration

**Operation ID:** `createConfiguration`

**Permissions:** Requires create permission for Configuration resources in the requested Namespace. Requires operate permission on each Secret supplied in request body Secret bindings.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `configuration` | `namespace` |
| `operate` | `secret` | `request_body` (when bound) |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `kind` | `"agent"` | Yes | — |
| `secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables; `OPENAI_API_KEY` is the only allowed `OPENAI_*` destination. |
| `values` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |

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
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.generation` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |
| `data.id` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.kind` | `"agent"` | Yes | — |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables; `OPENAI_API_KEY` is the only allowed `OPENAI_*` destination. |
| `data.values` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## `DELETE /namespaces/{namespaceId}/configurations/{configurationId}`

<span id="delete-namespacesnamespaceidconfigurationsconfigurationid"></span>

Delete an exact unreferenced Namespace-owned Configuration

**Operation ID:** `deleteConfiguration`

**Permissions:** Requires delete permission on the requested Configuration.

| Action | Resource | Scope |
| --- | --- | --- |
| `delete` | `configuration` | `requested` |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `configurationId` | path | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Responses

| Status | Meaning |
| --- | --- |
| `204` | No Content |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

## `GET /namespaces/{namespaceId}/configurations/{configurationId}`

<span id="get-namespacesnamespaceidconfigurationsconfigurationid"></span>

Get an exact Namespace-owned Configuration

**Operation ID:** `getConfiguration`

**Permissions:** Requires read permission on the requested Configuration.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `configuration` | `requested` |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `configurationId` | path | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.generation` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |
| `data.id` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.kind` | `"agent"` | Yes | — |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables; `OPENAI_API_KEY` is the only allowed `OPENAI_*` destination. |
| `data.values` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## `PATCH /namespaces/{namespaceId}/configurations/{configurationId}`

<span id="patch-namespacesnamespaceidconfigurationsconfigurationid"></span>

Replace values and increment an exact Namespace-owned Configuration generation

**Operation ID:** `updateConfiguration`

**Permissions:** Requires update permission on the requested Configuration. Requires operate permission on each Secret bound by the resulting Configuration.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `configuration` | `requested` |
| `operate` | `secret` | `requested` (when bound) |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `configurationId` | path | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables; `OPENAI_API_KEY` is the only allowed `OPENAI_*` destination. |
| `values` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |

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
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.generation` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |
| `data.id` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.kind` | `"agent"` | Yes | — |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables; `OPENAI_API_KEY` is the only allowed `OPENAI_*` destination. |
| `data.values` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Related

- [API index](../api.md)
