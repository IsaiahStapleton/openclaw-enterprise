# Feature Spec: Existing Kubernetes Tenant Namespaces

**Date:** 2026-08-26
**Status:** Implemented; live Kubernetes verification requires a disposable cluster
**Authority:** [OpenClaw Enterprise platform design](../docs/design.md)

## Problem and Decision

The bundled Kubernetes drivers normally create and remove a deterministically
named namespace for each OCC Namespace. Operators need to select an existing
namespace without pausing the shared worker, weakening tenant isolation, or
transferring ownership of the Kubernetes namespace.

Accept an optional `existingNamespace` when creating a platform Namespace:

```json
{ "name": "customer-support", "existingNamespace": "customer-support-prod" }
```

Persist the physical name with its Namespace before queuing worker provisioning.
Selection requires ordinary Namespace creation permission and Installation-level
`administer` authorization, checked again before worker adoption. A database
partial uniqueness constraint prevents multiple active platform Namespaces from
claiming the same external namespace; tombstoned selections no longer reserve it.
Only the selected bundled Kubernetes Compute Driver supports this field; Docker,
local-test, or installed external Compute Drivers reject it with `409`.

## Selection and Ownership

An operator-owned Kubernetes namespace can have any valid name. Before calling
`POST /namespaces`, prepare it with:

```yaml
metadata:
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
  annotations:
    openclaw.dev/namespace-lifecycle: external
```

Grant its existing tenant-local worker and API RoleBindings before creating the
platform Namespace. The running worker rechecks the actor's Installation
`administer` authority, reads the exact requested namespace, requires `Active`
status and the external-lifecycle annotation, verifies all three restricted Pod
Security labels, and rejects foreign tenant markers or NetworkPolicies. It then
binds the server-generated tenant identity:

```yaml
metadata:
  labels:
    openclaw.dev/namespace: <first-32-hex-characters-of-sha256-namespace-id>
  annotations:
    openclaw.dev/namespace-id: <exact-platform-namespace-id>
```

The worker binds both markers together using one `resourceVersion`-guarded,
non-forced patch; concurrent ownership changes fail safely rather than
overwriting another claimant. This narrow update preserves the manager,
security labels, external-lifecycle annotation, and unrelated metadata.
The Configuration Driver discovers the
bound namespace by tenant label and verifies its exact Namespace ID. Missing
requested namespaces, duplicate claims, incorrect ownership, unsafe security,
terminating namespaces, and foreign NetworkPolicies fail closed; never create
or substitute a managed namespace for an explicit request. A missing worker
RoleBinding keeps provisioning pending; a missing API RoleBinding instead makes
Configuration CRUD return `503`. Operators must exclusively dedicate each
namespace to its tenant; OCC cannot verify foreign-Pod absence.

Reconcile the same OCC-owned quota, limit range, and three NetworkPolicies as
managed namespaces. Place ConfigMaps, workloads, dedicated Agent-owned shared
PersistentVolumeClaims, and service-account credentials in the discovered
namespace with their existing exact ownership checks. Dedicated revision
retirement removes its Agent-owned claim; Namespace cleanup never adopts or
deletes unrelated claims. Apart from binding tenant identity, never take
ownership of, reconfigure, or delete the external Namespace object. Wait for
platform Namespace readiness before creating its first Configuration.

## Lifecycle and Cleanup

Prepare the existing namespace and tenant-local RoleBindings, then submit its
exact name with platform Namespace creation. The running worker retrieves the
persisted selection, rechecks Installation `administer`, binds generated tenant
identity, and provisions infrastructure without stopping any component. Other
tenants continue normal lifecycle processing. Omitting `existingNamespace`
retains deterministic managed placement. Installation settings and Driver
interfaces remain unchanged.

OCC rejects Namespace deletion while any Agent, Configuration, or service
account exists. Consequently, external-namespace cleanup need only delete the
five fixed, exact-owner infrastructure objects: `openclaw-quota`,
`openclaw-limits`, `allow-dns`, `allow-gateway-ingress`, and `default-deny`.
Delete `default-deny` last. Preserve the external namespace, its tenant identity,
manager, RoleBindings, Secrets, and unrelated resources. Deleting a failed
selection that never acquired either tenant marker does not mutate its external
namespace; partial or foreign ownership fails closed. Deleting a failed,
unclaimed tenant permits correcting operator preparation and retrying with a
new platform Namespace. After deleting a successfully claimed tenant, an
operator must deliberately clear both old tenant markers before an authorized
new tenant can adopt that physical namespace. An already-missing backing
namespace is successful idempotent deletion. Managed namespace deletion is
unchanged.

## Acceptance Criteria

1. `POST /namespaces` accepts optional `existingNamespace`, persists it before
   queuing provisioning, and returns it on the created Namespace; omission
   preserves existing managed placement. Non-Kubernetes Compute Drivers reject
   explicit existing-namespace selection with `409`.
2. Selection requires Installation `administer` at admission and immediately
   before adoption; revocation prevents side effects. Duplicate selections by
   active Namespaces fail; deleting an unclaimed failed tenant permits retry.
3. The running worker selects the exact external namespace, verifies its
   preconditions, and atomically binds generated tenant identity with a
   `resourceVersion`-guarded, non-forced patch without disrupting another tenant
   or changing the external namespace manager.
4. Missing targets, foreign tenant markers or NetworkPolicies, unsafe security,
   missing external ownership, terminating namespaces, and ambiguous identity
   fail closed without managed fallback; missing worker RBAC remains pending,
   while missing API RBAC makes Configuration operations return `503`.
5. An operator-prepared namespace supports actual Configuration placement, a
   dedicated Agent workload, and its exact shared PersistentVolumeClaim with
   existing NetworkPolicy isolation while preserving its namespace UID and
   external manager; retiring the Agent removes its owned claim. Configuration
   creation during explicitly external provisioning fails with `409` until the
   platform Namespace becomes ready.
6. Deleting an empty tenant removes only its five owned infrastructure objects,
   keeps `default-deny` until last, and preserves the external namespace;
   retained tenant markers prevent reassignment until an operator deliberately
   clears both, and an already-removed namespace also completes deletion.
7. Existing managed provisioning and deletion remain unchanged; Installation
   settings and Driver interfaces acquire no additional configuration.
8. Real Kubernetes claims require the existing disposable-cluster integration;
   unavailable cluster infrastructure is reported as a verification gap.

See the [Kubernetes Compute Driver guide](../docs/reference/drivers/kubernetes-compute.md),
[production deployment instructions](../docs/guides/deploy.md), and
[placement execution flow](../docs/flows/kubernetes-existing-namespace-placement.md).

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-26 00:44]: Replaced worker-paused discovery with administrator-authorized, persisted existing-namespace selection and worker-owned tenant binding. (01a03a24-5bf5-73f0-bc5c-21830985a7c2 - bcf21fb1bc6b)
- [2026-08-25 20:46]: Replaced configured placement with exact-label discovery, explicit external ownership, and fixed-infrastructure cleanup. (01a03a24-5bf5-73f0-bc5c-21830985a7c2 - 05f06c051bf4)
