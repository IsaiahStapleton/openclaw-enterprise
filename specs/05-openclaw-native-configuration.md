# Feature Spec: OpenClaw-Native Namespace Configuration

**Date:** 2026-08-20
**Status:** Completed
**Owner:** OCC, ConfigurationDriver, and immutable AgentRevision contracts

## Problem and Decision

OCC currently accepts only flat string maps, but OpenClaw consumes one nested
`openclaw.json` document containing models, agents, gateway, plugins, and inline
SecretRefs. Make each Namespace Configuration's existing `values` field the
actual OpenClaw configuration document; snapshot that same document unchanged
into each AgentRevision. Kubernetes stores it as one `openclaw.json` ConfigMap
entry. Secret references remain unresolved and are owned by OpenClaw and the
selected SecretBroker, not ConfigurationDriver.

OpenClaw defines the upstream [configuration document](https://github.com/openclaw/openclaw/blob/1410ffcd23dc079d49ece5944fa47040d98716c9/src/config/types.openclaw.ts),
[SecretRef shape](https://github.com/openclaw/openclaw/blob/1410ffcd23dc079d49ece5944fa47040d98716c9/src/config/types.secrets.ts),
and [supported credential fields](https://github.com/openclaw/openclaw/blob/1410ffcd23dc079d49ece5944fa47040d98716c9/docs/reference/secretref-credential-surface.md).

## Scope

**Changes:** Namespace Configuration and AgentRevision document shapes; HTTP and
OpenAPI schemas; deep immutable admission; ConfigMap document serialization;
PostgreSQL revision constraints; credential-safe validation; existing tests and
current Configuration documentation.

**Does not change:** Installation startup YAML, ConfigurationDriver methods,
IAM authorization, Namespace ownership, ConfigMap RBAC, revision lifecycle,
ComputeDriver hooks, workload mounting, OpenClaw runtime startup, or broker and
credential-gateway implementation. Add no OpenClaw dependency, compatibility
format, parallel SecretRef map, configuration-merging system, or plugin registry.

## Contract

`Configuration.values` and `AgentRevision.configuration` are the same deeply
immutable, root-object JSON document. Reuse the existing recursive
[`SafeJsonValue` schema](../packages/contracts/src/api/common.ts) for nested
objects, arrays, strings, finite numbers, booleans, and null. Preserve OpenClaw field
names and structure exactly; OCC does not flatten or recreate its application schema.

```json
{
  "values": {
    "models": {
      "providers": {
        "openai": {
          "baseUrl": "https://api.openai.com/v1",
          "apiKey": {
            "source": "env",
            "name": "OPENAI_API_KEY"
          }
        }
      }
    },
    "secrets": {
      "egressProxy": { "enabled": true }
    },
    "agents": { "defaults": { "sandbox": { "mode": "all" } } }
  }
}
```

OCC preserves native OpenClaw configuration and inline SecretRefs exactly as
submitted. OpenClaw owns configuration validation, SecretRef shape, supported
sources, provider aliases, and source-specific identifiers. SecretBroker owns
credential policy and resolution. ConfigurationDriver stores JSON; it does not
inspect, validate, resolve, or redact credentials. Operators must use SecretRefs
instead of plaintext because ConfigMaps and API responses are not secret
storage.

OCC retains exact Namespace/resource authorization and creates one immutable
snapshot at deployment. Later Configuration edits cannot alter existing nested
revision values or SecretRefs. Cross-Namespace references remain inaccessible.
The ConfigMap contains exactly `data["openclaw.json"] = JSON.stringify(values)`;
existing exact ownership annotations/labels, resource-version concurrency, and
the Kubernetes size limit remain unchanged. Reads parse and validate that one
document; malformed JSON, extra data entries, or ownership mismatches fail
closed.

PostgreSQL still stores only Configuration ownership metadata; immutable
`admitted_spec.draft_spec` stores the canonical JSON document. One forward
migration removes the obsolete flat-values constraint and its validation
function. The existing admitted-snapshot constraint already requires an object;
preserve it and all ownership/immutability invariants without adding a duplicate.
Existing development databases migrate in place with no dual formats,
reserved JSON keys, or string sentinels.

## Implementation

1. Update [`Configuration` and `AgentRevision`](../packages/contracts/src/index.ts),
   [`ConfigurationValues` and request schemas](../packages/contracts/src/api/common.ts),
   [route metadata](../packages/contracts/src/api/routes.ts),
   [controller request casts](../apps/controller/src/index.ts), and
   [resource responses](../packages/contracts/src/api/resources.ts). Reuse
   `Type.Ref("SafeJsonValue")` and Fastify's existing schema registration.
2. Require a root JSON object in [OCC](../packages/occ/src/index.ts) and reuse
   existing [`immutableCopy`](../packages/utils/src/index.ts). Preserve exact IAM checks,
   Configuration ownership, and immutable revision snapshots;
   remove the obsolete flat-only guard from
   [in-memory revision state](../packages/occ/src/state/platform-state.ts).
3. Update the [Kubernetes ConfigurationDriver](../apps/controller/src/drivers/configuration/kubernetes/index.ts)
   to round-trip exactly one bounded `openclaw.json` ConfigMap data entry.
4. Add the next forward migration beside
   [`0004_configuration_driver.sql`](../migrations/0004_configuration_driver.sql)
   and update [the PostgreSQL schema](../packages/occ/src/state/postgres-schema.ts)
   and migration journal; drop only the obsolete flat constraint/function.
5. Replace flat-only fixtures and add real coverage in
   API-schema tests (historical path: `tests/contracts/api-schema.test.mjs`,
   commit `ab560806dbd945436835ab092ebd10bf3e50d942`),
   [OCC configuration conformance](../tests/conformance/configuration-occ.test.mjs),
   [Kubernetes configuration conformance](../tests/conformance/kubernetes-configuration.test.mjs),
   [HTTP integration](../tests/integration/configuration-controller.test.mjs),
   PostgreSQL integration (the historical dedicated migration test was removed;
   current persisted coverage is in
   [PostgreSQL platform-state integration](../tests/integration/postgres-platform-state.test.mjs)),
   OpenAPI tests (historical path: `tests/contracts/openapi.test.mjs`,
   commit `c11ba6418d068c2cb15a1f3ecf9339eef1d2797b`), and
   API-reference tests (historical path: `tests/contracts/openapi-markdown.test.mjs`,
   commit `ab560806dbd945436835ab092ebd10bf3e50d942`).
   Regenerate both [OpenAPI](../packages/contracts/openapi/occ-api.openapi.json)
   and the [API reference](../docs/reference/api.md). Update the current
   [Configuration guide](../docs/reference/configuration.md), [Agent guide](../docs/reference/agents.md), and
   [Configuration flow](../docs/flows/configuration-driver.md); leave the
   historical [completed ConfigurationDriver spec](.archive/03-configuration-driver.md)
   unchanged.

## Verification

| Required outcome                 | Concrete proof                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual OpenClaw configuration    | Real HTTP create/read/replace accepts nested `models`, `agents`, `plugins`, `gateway`, `secrets`, arrays, booleans, numbers, and null; OpenAPI advertises the same recursive root-object shape.                 |
| Inline reference compatibility   | Native OpenClaw SecretRefs and ordinary plugin/provider settings round-trip unchanged; OpenClaw and SecretBroker own reference validation and credential handling.                                              |
| Kubernetes representation        | The real ConfigurationDriver writes exactly one `openclaw.json` ConfigMap data entry, rejects malformed/extra entries and oversized documents, and preserves exact tenant placement/ownership.                  |
| Immutable nested snapshots       | Deploy snapshots the complete document and inline references; later nested input mutation or Configuration replacement cannot mutate prior AgentRevisions.                                                      |
| PostgreSQL invariants            | Execute the forward migration against real PostgreSQL; nested revision documents succeed while nonobject snapshots, malformed admitted envelopes, foreign ownership, and revision mutation remain rejected.     |
| Isolation and downstream handoff | Existing IAM denial/cross-Namespace tests remain valid; a revision exposes the exact source document to existing lifecycle hooks without resolving credentials, changing hook contracts, or starting a gateway. |
| Upstream compatibility           | The documented OpenClaw model-provider/store-reference and file-reference examples retain their exact native structure after API, ConfigMap, and revision round trips.                                          |

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-31 18:06]: Repaired repository links while preserving historical citations and implementation decisions. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4e16a74272e716d998c6da59fff95fde806d86fa)

- [2026-08-21 11:38]: Replaced the obsolete dedicated migration-test link with surviving PostgreSQL platform-state coverage while preserving the historical implementation plan. (01a0119a-9843-7423-a4c6-955ff4187bd9 - 9ae2efc)
- [2026-08-20 19:03]: Removed duplicate OpenClaw configuration and SecretRef validation; OCC stores immutable native JSON while OpenClaw and SecretBroker own credential semantics. (01a01add-3345-76a2-8bf2-221bf4075636 - ba62d21b422da3175ce0035162b05c19323c95e1)
- [2026-08-20 18:51]: Implemented native documents, canonical SecretRefs, immutable snapshots, single-document ConfigMaps, PostgreSQL migration, generated contracts, and independently reviewed compatibility/security coverage. (01a01add-3345-76a2-8bf2-221bf4075636 - 2a82234a9214da410e75f94c07cd29aa165a6fa1)
- [2026-08-20 18:01]: Incorporated one independent review: centralized credential validation, completed recursive-schema/generated-document touchpoints, and removed redundant PostgreSQL constraints. (01a01add-3345-76a2-8bf2-221bf4075636 - 2a82234a9214da410e75f94c07cd29aa165a6fa1)
- [2026-08-20 17:49]: Defined native OpenClaw Configuration documents, inline SecretRefs, canonical ConfigMap/PostgreSQL representation, ownership boundaries, migration, and integration verification. (01a01add-3345-76a2-8bf2-221bf4075636 - 2a82234a9214da410e75f94c07cd29aa165a6fa1)
