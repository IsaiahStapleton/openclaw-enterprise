# Platform API operations

<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->

<span id="platform"></span>

This generated page documents platform API operations. Use the [API index](../api.md) for the full operation list.

## `GET /installation`

<span id="get-installation"></span>

Get the singleton Installation

**Operation ID:** `getInstallation`

**Permissions:** Requires read permission on the requested Installation.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `installation` | `requested` |

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
| `data.id` | `string` | Yes | pattern: `^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## `POST /installation/bootstrap`

<span id="post-installationbootstrap"></span>

Bootstrap the singleton Installation

**Operation ID:** `bootstrapInstallation`

**Permissions:** Requires administer permission on the requested Installation.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

## Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |

## Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
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
| `data.id` | `string` | Yes | pattern: `^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## `GET /providers`

<span id="get-providers"></span>

List configured Providers

**Operation ID:** `listProviders`

**Permissions:** Requires administer permission on the requested Installation.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

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
| `data[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data[].type` | `"chatgpt"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Related

- [API index](../api.md)
