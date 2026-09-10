# Service accounts API operations

<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->

<span id="service-accounts"></span>

This generated page documents service accounts API operations. Use the [API index](../api.md) for the full operation list.

## `GET /namespaces/{namespaceId}/service-accounts`

<span id="get-namespacesnamespaceidserviceaccounts"></span>

List authorized Namespace-owned ServiceAccounts in one exact Namespace

**Operation ID:** `listServiceAccounts`

**Permissions:** Requires read permission on the requested Namespace. Only ServiceAccount resources with individual read permission are returned.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `namespace` | `requested` |
| `read` | `service_account` | `each_returned` |

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
| `data[].credential` | `object` | No | — |
| `data[].credential.kind` | `"api_key" or "access_token" or "oauth_access_token"` | Yes | — |
| `data[].credential.secretRef` | `object` | Yes | — |
| `data[].credential.secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `data[].credential.secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |
| `data[].id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## `POST /namespaces/{namespaceId}/service-accounts`

<span id="post-namespacesnamespaceidserviceaccounts"></span>

Create a native Namespace-owned ServiceAccount

**Operation ID:** `createServiceAccount`

**Permissions:** Requires create permission for ServiceAccount resources in the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `service_account` | `namespace` |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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
| `data.credential` | `object` | No | — |
| `data.credential.kind` | `"api_key" or "access_token" or "oauth_access_token"` | Yes | — |
| `data.credential.secretRef` | `object` | Yes | — |
| `data.credential.secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `data.credential.secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |
| `data.id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## `DELETE /namespaces/{namespaceId}/service-accounts/{serviceAccountId}`

<span id="delete-namespacesnamespaceidserviceaccountsserviceaccountid"></span>

Delete an exact unreferenced Namespace-owned ServiceAccount

**Operation ID:** `deleteServiceAccount`

**Permissions:** Requires delete permission on the requested ServiceAccount.

| Action | Resource | Scope |
| --- | --- | --- |
| `delete` | `service_account` | `requested` |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `serviceAccountId` | path | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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

## `GET /namespaces/{namespaceId}/service-accounts/{serviceAccountId}`

<span id="get-namespacesnamespaceidserviceaccountsserviceaccountid"></span>

Get an exact Namespace-owned ServiceAccount

**Operation ID:** `getServiceAccount`

**Permissions:** Requires read permission on the requested ServiceAccount.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `service_account` | `requested` |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `serviceAccountId` | path | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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
| `data.credential` | `object` | No | — |
| `data.credential.kind` | `"api_key" or "access_token" or "oauth_access_token"` | Yes | — |
| `data.credential.secretRef` | `object` | Yes | — |
| `data.credential.secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `data.credential.secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |
| `data.id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## `PATCH /namespaces/{namespaceId}/service-accounts/{serviceAccountId}/credential`

<span id="patch-namespacesnamespaceidserviceaccountsserviceaccountidcredential"></span>

Associate an exact Namespace-local credential reference with a ServiceAccount

**Operation ID:** `updateServiceAccountCredential`

**Permissions:** Requires update permission on the requested ServiceAccount.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `service_account` | `requested` |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `serviceAccountId` | path | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `kind` | `"api_key" or "oauth_access_token"` | Yes | — |
| `secretRef` | `object` | Yes | — |
| `secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |

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
| `data.credential` | `object` | No | — |
| `data.credential.kind` | `"api_key" or "access_token" or "oauth_access_token"` | Yes | — |
| `data.credential.secretRef` | `object` | Yes | — |
| `data.credential.secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `data.credential.secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |
| `data.id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## `POST /namespaces/{namespaceId}/service-accounts/{serviceAccountId}/credentials`

<span id="post-namespacesnamespaceidserviceaccountsserviceaccountidcredentials"></span>

Issue a managed credential for an exact Namespace-owned ServiceAccount

**Operation ID:** `createServiceAccountCredential`

**Permissions:** Requires update permission on the requested ServiceAccount.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `service_account` | `requested` |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `serviceAccountId` | path | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Request body

**Required:** Yes

**Content type:** `application/json`

Schema: `object`.

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
| `data.credential` | `object` | No | — |
| `data.credential.kind` | `"api_key" or "access_token" or "oauth_access_token"` | Yes | — |
| `data.credential.secretRef` | `object` | Yes | — |
| `data.credential.secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `data.credential.secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |
| `data.id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Related

- [API index](../api.md)
