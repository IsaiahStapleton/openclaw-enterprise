# Authentication API operations

<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->

<span id="authentication"></span>

This generated page documents authentication API operations. Use the [API index](../api.md) for the full operation list.

## `POST /api/auth/accounts`

<span id="post-apiauthaccounts"></span>

Create an administrator-controlled local auth account

**Operation ID:** `createAuthAccount`

**Permissions:** Requires administer permission on the Installation. Creates a Better Auth account, an explicit IAM Principal, and a binding to the requested existing IAM Role; public signup remains disabled.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

## Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `email` | `string` | Yes | min length: 3; max length: 320 |
| `name` | `string` | No | min length: 1; max length: 200 |
| `password` | `string` | Yes | min length: 12; max length: 128 |
| `roleId` | `string` | Yes | min length: 1; max length: 200 |

## Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `409` | Conflict |
| `503` | Service Unavailable |

**`201` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.email` | `string (email)` | Yes | — |
| `data.id` | `string` | Yes | — |
| `data.name` | `string` | Yes | — |
| `data.principalId` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

## `POST /api/auth/service-keys`

<span id="post-apiauthservicekeys"></span>

Issue a service API key

**Operation ID:** `createServiceKey`

**Permissions:** Requires a session or Installation-scoped service key with administer on the Installation. Issues a Better Auth key for an existing non-Agent ServicePrincipal in its exact scope; creates no identity or IAM grant. The plaintext key is returned only here.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

## Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `expiresIn` | `integer` | No | minimum: 86400; maximum: 31536000; Lifetime in seconds; defaults to 30 days. |
| `name` | `string` | Yes | min length: 1; max length: 32; pattern: `\S` |
| `namespaceId` | `string` | No | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `servicePrincipalId` | `string` | Yes | min length: 1; max length: 200 |

## Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `503` | Service Unavailable |

**`201` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.expiresAt` | `string (date-time)` | Yes | — |
| `data.id` | `string` | Yes | — |
| `data.key` | `string` | Yes | — |
| `data.name` | `string` | Yes | — |
| `data.namespaceId` | `string` | No | — |
| `data.servicePrincipalId` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

## `DELETE /api/auth/service-keys/{keyId}`

<span id="delete-apiauthservicekeyskeyid"></span>

Revoke a service API key

**Operation ID:** `revokeServiceKey`

**Permissions:** Requires a session or Installation-scoped service key with administer on the Installation. Deletes the stored Better Auth key; subsequent requests cannot authenticate with it.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

## Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `keyId` | path | `string` | Yes | min length: 1; max length: 200 |

## Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.id` | `string` | Yes | — |
| `data.revoked` | `true` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

## `GET /api/auth/session`

<span id="get-apiauthsession"></span>

Inspect authentication without revealing session tokens

**Operation ID:** `getAuthSession`

**Permissions:** Returns only authenticated status and public account identity, or null without a valid session; session tokens and credentials are never returned.

## Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `null or object` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

## `POST /api/auth/sign-in/email`

<span id="post-apiauthsigninemail"></span>

Sign in with email and password

**Operation ID:** `signInEmail`

**Permissions:** Authenticates a local account and issues a user session cookie.

## Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `email` | `string` | Yes | min length: 3; max length: 320 |
| `password` | `string` | Yes | min length: 12; max length: 128 |

## Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Unauthorized |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.authenticated` | `true` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

## `POST /api/auth/sign-out`

<span id="post-apiauthsignout"></span>

Sign out of the current session

**Operation ID:** `signOut`

**Permissions:** Revokes the current user session cookie.

## Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Unauthorized |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

## Related

- [API index](../api.md)
