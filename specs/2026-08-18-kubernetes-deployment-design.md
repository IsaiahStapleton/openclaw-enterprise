# Feature Design: Production Kubernetes Compute Driver

**Date:** 2026-08-18
**Status:** Draft
**Owner:** OpenClaw Controller and Kubernetes Compute Driver

## Goal

Run one production-capable Kubernetes `ComputeDriver` against an explicitly selected cluster, and verify that same driver against disposable k3d clusters. Provision isolated tenant namespaces, one steady-state gateway Pod per tenant, protected Agent revision workloads, and production-safe Agent ServicePrincipal credential projection without introducing a separate local-only driver.

The [authoritative design](../docs/design.md) owns platform architecture and production security requirements.

## Current State

- [`apps/controller/src/drivers/compute/kubernetes/index.ts`](../apps/controller/src/drivers/compute/kubernetes/index.ts) uses pinned `@kubernetes/client-node` APIs, explicit in-cluster or named-kubeconfig authentication, verified HTTPS, server-side apply, tenant-local authorization, enforcing NetworkPolicies, hardened gateway and Agent workloads, projected ServicePrincipal tokens, observed readiness, ownership checks, and scoped deletion. Production driver execution does not invoke `kubectl`; only the isolated real-cluster test harness requires a loopback endpoint and uses `kubectl` for setup and independent observation.
- [`apps/controller/src/worker.ts`](../apps/controller/src/worker.ts) already claims, recovers, validates, prepares, activates, and retires revision work using PostgreSQL-backed leases.
- [`apps/controller/src/composition/development-postgres.ts`](../apps/controller/src/composition/development-postgres.ts) already accepts an injected `ComputeDriver`; the retired `apps/controller/src/composition/development.ts` retained the deterministic fake default at the time of this historical spec.
- [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts) on the merged `origin/main` defines the same `servicePrincipalId` on each Agent and immutable AgentRevision. Its Driver exposes `ensureNamespace`, `deleteNamespace`, `prepareRevision`, and `retireRevision`, but has no sandbox-verification, Harness-release, or traffic-activation operation.
- [`apps/controller/src/composition/production.ts`](../apps/controller/src/composition/production.ts) rejects production OCC startup. A production-capable Compute Driver does not make the OCC API or complete platform production-ready.
- [`tests/integration/kubernetes-compute-real.test.mjs`](../tests/integration/kubernetes-compute-real.test.mjs) has passed both real-cluster cases against a k3d-provisioned cluster using an explicit `k3d-*` kubeconfig context and an image imported with `k3d image import`. Verified coverage includes scoped ServiceAccount-token credentials, per-tenant RoleBinding denial, exact ownership, enforced allowed and denied network paths, one steady-state gateway Pod, projected tokens, scoped retirement and deletion, and authenticated OCC/PostgreSQL worker recovery. Real in-cluster authentication and a shared-cluster admission policy have not yet been exercised.

## Scope

Use the existing Kubernetes `ComputeDriver` with the official Kubernetes Node client, production and local cluster credentials, least-privilege controller access, tenant NetworkPolicies, hardened production workloads, Agent ServicePrincipal credential projection, and mandatory real-cluster conformance against k3d. Preserve existing OCC ownership, the four-method Driver contract, the PostgreSQL worker, authorization, audit, and one logical gateway per platform Namespace. OCC retains its singleton Installation identifier for persisted bootstrap, worker configuration, audit, and external integration boundaries; the driver and its Kubernetes ownership metadata inherit that Installation without repeating its identifier.

Defer multiple independently managed gateways per tenant, production OCC admission/OAG, installation packaging, application container images, Helm, managed databases, backup, secret-broker integration, external secret backends, cloud identity federation, custom Agent Pod egress, and full platform deployment. Also defer OCC token verification or exchange, sandbox verification, Harness activation, gateway route release, populated-tenant offboarding, and complete production Agent serving until their OCC-owned lifecycle contracts exist. The driver is production-capable infrastructure; end-to-end production workload execution remains explicitly blocked by those separate prerequisites.

## Requirements -> Design Mapping

| Requirement               | Design                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Production Kubernetes API | Use official `@kubernetes/client-node` client and request types without duplicated API interfaces.             |
| Explicit cluster identity | Select in-cluster credentials or one explicit kubeconfig/context; never use an ambient fallback.               |
| Existing OCC lifecycle    | Inject one selected driver into the existing composition and worker without changing authorization ownership.  |
| Tenant isolation          | Use one owned Kubernetes namespace, default-deny NetworkPolicies, and exact ownership per platform Namespace.  |
| Tenant gateway            | Maintain one fixed-name, single-replica `Recreate` gateway Deployment, Service, and ServiceAccount per tenant. |
| Agent identity            | Use dedicated Agent ServiceAccounts; project scoped tokens only to authenticate the Agent ServicePrincipal.    |
| Agent workload            | Use one stable nonserving Agent Service and one hardened, owned Deployment per AgentRevision.                  |
| Controller permissions    | Use install-time RBAC plus admission guardrails because RBAC alone cannot label-scope namespace creation.      |
| Production reconciliation | Verify ownership, apply idempotently, observe actual readiness, classify failures, and repair owned drift.     |
| Local verification        | Exercise the same production driver and isolation against a disposable k3d cluster.                            |

## Proposed Design

```text
OCC worker + KubernetesComputeDriver + @kubernetes/client-node
  └── Installation-selected Kubernetes cluster: production or disposable k3d
      ├── oce-<namespace-a>-<hash>
      │   ├── default-deny NetworkPolicies + explicit traffic allowances
      │   ├── openclaw-gateway: Deployment + Service + ServiceAccount
      │   ├── agent-<agent-a-hash>: Service + ServiceAccount
      │   └── agent-<agent-a-hash>-rev-<revision-hash>: Deployment
      └── oce-<namespace-b>-<hash>
          ├── default-deny NetworkPolicies + explicit traffic allowances
          ├── openclaw-gateway: Deployment + Service + ServiceAccount
          └── agent-<agent-b-hash>-rev-<revision-hash>: Deployment
```

### Kubernetes client and cluster selection

Add the official [`@kubernetes/client-node`](https://github.com/kubernetes-client/javascript) dependency to the controller package and pin a version compatible with the supported Kubernetes server versions. Use the SDK's own `CoreV1Api`, `AppsV1Api`, `DiscoveryV1Api`, and `NetworkingV1Api` types and concrete request/response signatures for Namespaces, ServiceAccounts, Services, Deployments, EndpointSlices, and NetworkPolicies; do not duplicate or erase those interfaces behind generic request methods. Production runtime must not depend on an installed `kubectl` binary.

Select exactly one cluster credential source per Installation: the controller Pod's in-cluster ServiceAccount, or an explicitly provided kubeconfig file plus explicitly named context. Reject absent, mixed, ambiguous, or mismatched configuration; do not call an ambient default-context loader. Production API endpoints may be remote but must use verified HTTPS and the configured cluster trust roots. Local integration tests separately require a dedicated loopback k3d cluster and a `k3d-*` context and must never select an existing production context; the production driver itself accepts any explicitly configured Kubernetes context. In-cluster authentication is implemented and covered by configuration/conformance checks, but has not yet been exercised from a real in-cluster Job.

Production driver options must not accept injected Kubernetes API clients. Every request uses clients created only after the selected credentials, context, cluster identity, and HTTPS trust have been verified. Configuration conformance tests exercise the production constructor directly; tenant lifecycle and security behavior are verified against actual Kubernetes API clients and a disposable k3d cluster.

Use the same driver identity, manifests, ownership checks, readiness criteria, and reconciliation logic in production Kubernetes and local k3d. Only cluster credentials, image references, and explicitly configured resource limits vary by environment.

The driver constructor must make required production policy explicit instead of hiding it in defaults:

```ts
type KubernetesResourceRequirements = {
  readonly requests: { readonly cpu: string; readonly memory: string };
  readonly limits: { readonly cpu: string; readonly memory: string };
};

type KubernetesWorkloadPeer = {
  readonly namespace: string;
  readonly podLabels: Readonly<Record<string, string>>;
};

type KubernetesComputeDriverOptions = {
  readonly authentication:
    | { readonly mode: "inCluster" }
    | { readonly mode: "kubeconfig"; readonly kubeconfigPath: string; readonly context: string };
  readonly images: {
    readonly gateway: string;
    readonly agent: string;
    readonly requireImmutableDigest: boolean;
  };
  readonly resources: {
    readonly gateway: KubernetesResourceRequirements;
    readonly agent: KubernetesResourceRequirements;
    readonly namespace: {
      readonly quota: Readonly<Record<string, string>>;
      readonly containerDefaults: KubernetesResourceRequirements;
    };
  };
  readonly network: {
    readonly dns: KubernetesWorkloadPeer;
    readonly gatewayPort: number;
    readonly gatewayClients: readonly KubernetesWorkloadPeer[];
  };
  readonly servicePrincipalCredentials:
    | { readonly mode: "disabled" }
    | {
        readonly mode: "projectedServiceAccountToken";
        readonly audience: string;
        readonly expirationSeconds: number;
      };
};
```

Resource requirements and namespace quota/defaults are explicit Kubernetes CPU and memory quantities. Each workload peer names one exact namespace and nonempty Pod labels; NetworkPolicies use the namespace's immutable `kubernetes.io/metadata.name` label, those Pod labels, and explicit ports. DNS permits TCP/UDP 53; gateway ingress uses `gatewayPort`. Production requires immutable image digests and nonempty resource requests and limits. k3d may use imported local fixture tags only when `requireImmutableDigest=false` is explicitly set for that test Installation.

### Resource ownership and reconciliation

Derive the Kubernetes namespace as `oce-<slug>-<hash>`, where `<slug>` is the lowercase, DNS-sanitized immutable platform Namespace ID truncated to 46 characters, and `<hash>` is the first 12 hexadecimal characters of its SHA-256 digest; the result is at most 63 characters. Use `ns` when sanitization leaves an empty slug.

Every managed object carries `app.kubernetes.io/managed-by=openclaw-enterprise`, `openclaw.dev/namespace=<sha256(namespace-id)[:32]>`, and an annotation containing the exact original Namespace ID. Agent-owned objects additionally identify the exact Agent and its `servicePrincipalId`; revision Deployments additionally identify the exact revision. Neither driver options nor managed object labels or annotations carry an Installation identifier. Verify ownership before adopting, applying, repairing, or deleting an existing object. Missing, mismatched, or ambiguous ownership fails permanently without mutation.

Use idempotent API operations with an explicit server-side-apply field manager for owned fields, including the initial resource creation; never mix an initial non-apply creation with later apply operations or force ownership conflicts on fields belonging to another controller. Set bounded request timeouts; retry throttling, temporary server errors, transient network failures, and safe reconciliation conflicts. Treat invalid configuration, denied authorization, wrong-cluster identity, and foreign ownership as permanent failures. Preserve existing worker claim fencing, exact-resource authorization, retry ownership, and attributable audit evidence.

### Controller permissions and tenant isolation

The controller runs under its own dedicated ServiceAccount. Installation supplies a ClusterRole and ClusterRoleBinding granting only required Namespace lifecycle operations, plus a separate namespaced resource ClusterRole. An operator-owned provisioning authority creates a RoleBinding to that resource role inside each verified tenant namespace; the driver waits until that tenant-local grant exists before creating workloads and never creates or escalates its own RoleBindings. That role covers only owned Deployments, Services, ServiceAccounts, EndpointSlices, NetworkPolicies, ResourceQuotas, and LimitRanges. It must not grant wildcard privileges, broad Secret reads, `pods/exec`, ClusterRoleBinding writes, or workload access to controller credentials. No ClusterRoleBinding grants namespaced resource access across every tenant.

Kubernetes RBAC cannot restrict namespace `create` by resource name, label, or annotation. Shared-cluster production therefore requires an independently installed admission guardrail, such as ValidatingAdmissionPolicy or an equivalent cluster policy controller, that restricts the OCC controller identity to deterministic `oce-...` namespace names, the `app.kubernetes.io/managed-by=openclaw-enterprise` marker, and exact Namespace ownership metadata, and blocks mutation of those ownership fields. An Installation-dedicated cluster is acceptable only when that broader namespace authority is an explicit operator-owned trust boundary. Existing real-cluster coverage proves per-tenant RoleBinding denial and refusal to adopt an existing foreign namespace; it does not install an admission policy or prove denial of foreign namespace creation. Installing and exercising an equivalent admission fixture remains required before claiming shared-cluster production readiness.

Create namespace-wide default-deny ingress and egress NetworkPolicies before creating gateway or Agent Pods. Add exact allow rules only for DNS and required platform-to-gateway communication from configured `gatewayClients`. DNS is the only driver-created Agent egress exception; custom Agent Pod egress and secret-broker connectivity are deferred. Do not allow gateway-to-Agent traffic, including direct candidate Pod IP traffic: candidate Agent Services are nonserving, no active-route label exists yet, and the four-method `ComputeDriver` cannot perform sandbox verification or route release. Deny traffic between tenant namespaces, Agent-to-Agent traffic, Agent-to-Kubernetes-API traffic, and cloud metadata endpoints. The Installation operator must attest an enforcing NetworkPolicy implementation, and real k3d verification must prove denied and allowed traffic; resource existence without demonstrated enforcement is insufficient.

Apply restricted Pod Security Admission namespace labels, configured ResourceQuota and LimitRange policies, nonroot execution, RuntimeDefault seccomp, dropped Linux capabilities, `allowPrivilegeEscalation=false`, bounded CPU/memory, and read-only root filesystems with declared writable volumes where required. Images must be explicitly approved and immutable in production; disposable k3d fixture images use the same Pod and security model.

### Namespace lifecycle

`ensureNamespace(namespace)` creates or reconciles its deterministic Kubernetes namespace and security labels, waits for the externally provisioned tenant-local RoleBinding, then reconciles ResourceQuota, LimitRange, default-deny and approved NetworkPolicies, and the fixed-name `openclaw-gateway` ServiceAccount, Deployment, and ClusterIP Service. The gateway Deployment always specifies one desired replica and the `Recreate` strategy because OpenClaw does not support concurrent gateway replicas. `Recreate` stops the old Pod before starting its replacement during normal Pod-template rollouts, accepting a brief gateway outage; a Deployment cannot guarantee absolute singleton execution during manual replacement, node failures, or other exceptional reconciliation races. A newly created namespace awaiting its external tenant-local grant returns incomplete readiness; unrelated or persistent authorization denials fail permanently. Security boundaries must exist before workload Pods. Repeated calls repair the same owned objects and restore the gateway's single desired replica if it drifts.

Return `namespaceReady=true` only when the owned Kubernetes namespace is `Active`. Return `gatewayReady=true` only when its owned Deployment has `spec.replicas=1`, `status.observedGeneration >= metadata.generation`, and one ready replica, and its owned Service has at least one ready endpoint; reject gateway readiness while the desired replica count differs from one. Pending readiness returns existing readiness booleans; transient API errors fail retryably; foreign ownership fails permanently. The existing worker alone promotes the platform Namespace to `ready`.

`deleteNamespace(namespace)` first verifies exact ownership of the backing namespace and managed gateway resources. Delete only that owned namespace, using observed object identity where supported; return completion only after Kubernetes confirms it no longer exists. Once the owned namespace is terminating or has a deletion timestamp, poll only its cluster-scoped Namespace state: Kubernetes may already have garbage-collected the tenant RoleBinding, so namespaced reads are neither required nor reliable. A missing deterministic namespace is an idempotent completed deletion. Do not delete foreign resources, add Agent deletion, or claim populated-tenant offboarding.

### Agent lifecycle

`prepareRevision(revision)` verifies the ready, owned tenant namespace, gateway, and isolation policies. It creates a stable `agent-<agent-hash>` ServiceAccount and ClusterIP Service, plus an `agent-<agent-hash>-rev-<revision-hash>` Deployment. Names are DNS-safe and bounded; each Kubernetes ServiceAccount carries the exact `revision.servicePrincipalId` ownership annotation and maps only to the immutable Agent/AgentRevision ServicePrincipal already validated by the OCC worker. Reject an absent ServicePrincipal ID or an existing Agent ServiceAccount, Service, or revision Deployment whose exact Namespace, Agent, ServicePrincipal, or revision ownership differs.

Use distinct gateway and Agent ServiceAccounts. Agent ServiceAccounts receive no RoleBinding by default. Disable automatic Kubernetes API token mounting for gateway and Agent Pods. When ServicePrincipal credential projection is enabled, mount only a projected `serviceAccountToken` volume with the configured nonempty OCC audience, bounded expiration, read-only mount path, and no broad Kubernetes API audience. That credential may represent only the Agent's existing ServicePrincipal; token verification, trust configuration, and exchange remain deferred OCC responsibilities, and this driver must not claim they are implemented or introduce another platform identity. Never mount controller Kubernetes credentials, provider secrets, raw broker secrets, or reusable backend credentials into gateway or Agent Pods.

The revision Deployment runs the configured approved Agent image with restricted Pod settings, bounded resources, readiness probes, and nonsecret configuration. Return `ready=true` only when the owned Deployment has observed its current generation and all requested replicas are ready. Test fixtures may replace production images but cannot weaken identity, isolation, ownership, or readiness checks.

The Agent Service remains nonserving until a separately specified OCC-owned activation contract can verify sandbox containment, confirm predecessor termination, release the candidate Harness, and activate its exact gateway route. The current four-method `ComputeDriver` cannot express those gates; this work must not expose candidate traffic, start an unverified production Harness, or describe existing database revision activation as production traffic cutover.

`retireRevision(revision)` deletes only the exactly owned revision Deployment. It preserves the Namespace, gateway, Agent ServiceAccount, Agent Service, and other Agent revisions. Transient failures retry; ownership or descriptor mismatches fail closed. Existing worker authorization, claims, recovery, fencing, audit, and activation remain the sole lifecycle authorities.

### Kubernetes resources

| Scope                  | Resources                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| Controller             | Dedicated ServiceAccount, namespace-only cluster grant, and installation-supplied per-tenant RoleBindings.      |
| Per platform Namespace | Owned Namespace, restricted security labels, ResourceQuota, LimitRange, and default-deny/allow NetworkPolicies. |
| Per tenant gateway     | One fixed-name, single-replica `Recreate` Deployment, ClusterIP Service, and dedicated ServiceAccount.          |
| Per Agent              | One dedicated ServiceAccount, optional audience-scoped projected token, and nonserving ClusterIP Service.       |
| Per AgentRevision      | One owned, hardened, nonroot Deployment with the configured Agent image and no provider credentials.            |
| Local verification     | Existing OCC/worker/PostgreSQL, disposable k3d, scoped test credentials, and imported fixture images.           |

## Detailed File Plan

- [`apps/controller/package.json`](../apps/controller/package.json) and [`pnpm-lock.yaml`](../pnpm-lock.yaml): declare and pin the official Kubernetes client without introducing another workspace package.
- [`apps/controller/src/drivers/compute/kubernetes/index.ts`](../apps/controller/src/drivers/compute/kubernetes/index.ts): use official Kubernetes SDK client and request types, reject production client injection, and validate in-cluster or explicit kubeconfig selection; reconcile ownership, hardened workloads, single-replica `Recreate` gateway rollout, isolation policies, projected tokens, readiness, retries, and scoped deletion.
- [`tests/conformance/kubernetes-compute.test.mjs`](../tests/conformance/kubernetes-compute.test.mjs): exercise the real production constructor and verify authentication, image, resource, network, and projected-token configuration; deterministic namespace naming; and fail-closed revision identity checks without fake clients or monkeypatched behavior.
- [`tests/integration/kubernetes-compute-real.test.mjs`](../tests/integration/kubernetes-compute-real.test.mjs): verify observable production-driver outcomes against a disposable k3d cluster, including real NetworkPolicy enforcement, tenant-local RBAC denial, restricted namespace security, one steady-state `Recreate` gateway, rejection of externally scaled gateways and foreign-driver revisions, ServicePrincipal credential projection, drift repair, worker restart, scoped retirement, and idempotent deletion.
- [`tests/fixtures/kubernetes/`](../tests/fixtures/kubernetes): retain the existing lightweight nonroot test image and Pod traffic/token probe; tenant-local RBAC is created by the integration harness. Admission-policy and in-cluster client-probe Job fixtures remain planned and unimplemented.
- [`docs/drivers/kubernetes-compute.md`](../docs/reference/drivers/kubernetes-compute.md), [`docs/config.md`](../docs/reference/settings.md), and [`docs/controller.md`](../docs/reference/controller.md): document production client configuration, required permissions and network enforcement, k3d setup, current lifecycle boundaries, and troubleshooting.
- Preserve the existing OCC API, four-method Driver contract, local-process driver, and production-admission boundary. Add a separate lifecycle specification before changing sandbox verification, Harness activation, gateway routing, or worker activation ordering.

## Planning & Milestones

### Milestone 1: Native Kubernetes client and owned tenant namespaces

**Shipped functionality:** One production-capable driver supports explicitly selected in-cluster credentials or a named kubeconfig and provisions one owned, ready namespace and one single-replica `Recreate` gateway per tenant; real-cluster execution has verified named-kubeconfig credentials only.

**Tasks:** Add the pinned Kubernetes client, typed API operations, explicit cluster selection, verified TLS, production policy options, bounded names, exact ownership metadata, controller RBAC and admission prerequisites, server-side apply, error classification, gateway resources, observed readiness, and owned empty-namespace deletion.

**Verification:** The completed k3d run proves explicit scoped kubeconfig authentication, independent ready tenant gateways with one steady-state Pod each, exact Namespace ownership without Installation metadata, tenant-local RBAC denial, foreign ownership refusal, owned-resource drift repair, and actual empty-namespace deletion. The same real-cluster run also observes `Recreate`, rejects Agent preparation while an externally scaled gateway has multiple desired replicas, and confirms recovery after the gateway returns to one ready replica. In-cluster authentication through a short-lived test-only client-probe Job remains unverified.

### Milestone 2: Tenant isolation and protected Agent revisions

**Shipped functionality:** The same driver provisions production-hardened tenant policies, ServicePrincipal credential projection, and nonserving Agent revisions under the existing OCC authorization and worker lifecycle.

**Tasks:** Create restricted namespace security labels, ResourceQuota/LimitRange, default-deny and approved NetworkPolicies, distinct gateway/Agent ServiceAccounts, projected audience-bound tokens, hardened Agent Deployments, immutable image configuration, owned drift repair, and focused developer documentation.

**Verification:** The completed k3d run deploys multiple Agents across two tenants; proves denied cross-tenant, Agent-to-Agent, gateway-to-candidate-Agent, Kubernetes API, and metadata endpoint traffic plus approved platform-to-gateway and DNS paths; and inspects distinct ServiceAccounts, projected token audience and subject, hardened Deployments, one steady-state gateway Pod, nonserving candidates, scoped retirement, owned drift recovery, and PostgreSQL worker restart recovery.

## Rollout Plan

1. Add the native Kubernetes client while retaining existing deterministic and local-process development Drivers.
2. Exercise the production driver against an isolated k3d cluster, including least-privilege credentials, enforced tenant isolation, and single-replica `Recreate` gateway behavior.
3. Enable the driver only for an explicitly selected Installation and cluster after required client, RBAC, NetworkPolicy, image, and workload-identity checks pass; shared clusters additionally require an installed and independently verified namespace admission guardrail.
4. Keep production OCC startup, external admission, sandbox verification, Harness release, and traffic activation disabled until their separate prerequisites are implemented.

**Rollback:** Stop dispatch to the selected driver, retain persisted OCC ownership and audit evidence, and reconcile or delete only resources verified to belong to the exact tenant in the singleton Installation's selected cluster. Restore a previously selected driver only through explicit Installation configuration; never silently adopt another cluster or tenant. Database recovery and full production-platform rollback remain outside this design.

## Testing Plan

**Unit:** Exercise the unmodified production constructor and verify explicit authentication, credential, image, resource, network, and projected-token configuration; rejection of injected clients; deterministic bounded namespace naming; and fail-closed revision identity checks. Do not emulate Kubernetes, inject fake API clients, monkeypatch driver methods, or assert implementation-internal call sequences.

**Integration:** Use a disposable k3d cluster, preserve its built-in NetworkPolicy controller, write a dedicated kubeconfig without changing the machine's default context, and import local nonroot fixture images with `k3d image import`. Exercise the unchanged production driver through an explicit kubeconfig containing a scoped ServiceAccount token; verify actual allowed and denied Pod connections, tenant-local controller RBAC denial, foreign-resource ownership refusal, restricted namespace and Pod security, one ready `Recreate` gateway, fail-closed handling of an externally scaled gateway and foreign-driver revisions, projected token audience and subject, reconciliation recovery, scoped retirement, and idempotent tenant deletion. Real in-cluster authentication through a short-lived client-probe Job and admission-policy rejection of foreign namespace creation require additional fixtures and have not been executed.

**End-to-end:** The completed run used the existing authenticated development OCC API and PostgreSQL worker with the unchanged production Kubernetes driver targeting a disposable k3d cluster. It created two platform Namespaces, verified ready single-Pod tenant gateways, deployed three Agents, inspected distinct ServiceAccounts and immutable revision Deployments, preserved nonserving candidates, restarted the worker, and retired a replaced revision. The companion real-cluster integration case verified effective tenant-local RBAC, ownership collisions, projected credentials, actual denied and allowed traffic, restricted namespace security, externally scaled gateway denial and recovery, foreign-driver rejection, and idempotent empty-tenant deletion. Both cases passed with no skips. These runs verify production-driver infrastructure behavior; they do not establish in-cluster driver authentication, shared-cluster admission-policy enforcement, production OCC admission, or active Harness traffic.

**Required-run behavior:** Ordinary test runs may skip cluster integration only when all real-cluster opt-in variables are absent. Partial cluster configuration and a context without the `k3d-` prefix must fail; the authenticated API-and-worker end-to-end case additionally requires an explicitly dedicated PostgreSQL database. Required verification must use Docker, an enforcing k3d cluster, approved fixture images, and required controller permissions; missing prerequisites never justify substituting mocked or process-only execution.

**Manual:** Inspect only the dedicated development kubeconfig/context:

```bash
k3d image import openclaw-enterprise-fixture:local -c claw-ent
kubectl --kubeconfig /tmp/claw-ent-k3d/kubeconfig --context k3d-claw-ent \
  get deployments,services,serviceaccounts,networkpolicies,endpointslices \
  -n <tenant-namespace>
```

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-18 23:14]: Removed fake-client and monkeypatched conformance coverage; retained direct production-constructor checks and verified gateway, tenant security, foreign-driver, and deletion outcomes against a real k3d cluster. (01a016e9-16e0-7b60-8a48-acd48f535366 - c50577b)
- [2026-08-18 23:05]: Required official Kubernetes SDK client/request types, removed generic hand-maintained API surfaces, and isolated injected fake clients to test-only code so production authentication and TLS validation cannot be bypassed. (01a016e9-16e0-7b60-8a48-acd48f535366 - 93bd4b9)
- [2026-08-18 23:00]: Made k3d the sole supported local Kubernetes integration environment, required a dedicated `k3d-*` test context, and verified both end-to-end cases against an actual k3d-provisioned cluster while retaining unverified in-cluster and admission boundaries. (01a016e9-16e0-7b60-8a48-acd48f535366 - 52f44a9)
- [2026-08-18 22:48]: Re-baselined current implementation and real Docker-hosted K3s evidence; distinguished unexecuted k3d, in-cluster Job, and required shared-cluster admission verification; specified single-replica `Recreate` gateway rollout, readiness, and Deployment singleton limits. (01a016e9-16e0-7b60-8a48-acd48f535366 - 5c827c5)
- [2026-08-18 22:41]: Required exactly one gateway Deployment replica and Pod per tenant because OpenClaw gateways do not support concurrent replicas; removed configurable gateway replica counts and scaling verification. (01a016e9-16e0-7b60-8a48-acd48f535366 - 1b057d2)
- [2026-08-18 22:33]: Removed speculative broker-specific egress configuration and verification; retained default-deny policies, DNS, and gateway ingress while deferring custom Agent Pod egress and secret-broker integration. (01a016e9-16e0-7b60-8a48-acd48f535366 - 208745b)
- [2026-08-18 22:26]: Removed speculative image-pull Secret configuration from the Kubernetes driver contract. (01a016e9-16e0-7b60-8a48-acd48f535366 - 4761287)
- [2026-08-18 22:18]: Removed the redundant singleton Installation identifier from Kubernetes driver options and resource ownership; retained exact tenant identity, admission guardrails, and OCC-owned bootstrap, worker, and audit identity. (01a016e9-16e0-7b60-8a48-acd48f535366 - d421e3d)
- [2026-08-18 21:55]: Recorded two verified real-Kubernetes reconciliation requirements: server-side apply from initial creation and cluster-scoped deletion polling after tenant RoleBinding garbage collection. (01a016e9-16e0-7b60-8a48-acd48f535366 - 650468e)
- [2026-08-18 21:07]: Aligned immutable ServicePrincipal ownership with merged main, separated namespace admission from tenant-local RBAC, specified executable policy options, denied candidate Pod traffic, and defined application-image-free in-cluster k3d verification. (01a016e9-16e0-7b60-8a48-acd48f535366 - 765cf45)
- [2026-08-18 20:55]: Reframed the design as one production-capable Kubernetes client Driver tested unchanged against k3d; specified explicit cluster credentials, least-privilege RBAC, tenant NetworkPolicies, hardened workloads, projected identity, and deferred production activation while preserving one gateway per tenant. (01a016e9-16e0-7b60-8a48-acd48f535366 - 765cf45)
- [2026-08-18 17:36]: Synchronized the implementation file plan with Kubernetes conformance tests and configuration documentation; clarified optional routine runs versus mandatory real-cluster end-to-end verification. (01a01766-51b3-7a32-9d24-eb6312e83d78 - 44d7197)
- [2026-08-18 17:23]: Corrected current main behavior, reused existing revision infrastructure, specified exact ownership and readiness, and required kubectl-only real K3s conformance with an isolated Docker fallback. (01a01766-51b3-7a32-9d24-eb6312e83d78 - b09438b)
- [2026-08-18 16:54]: Reduced the deployment design to the local-first Kubernetes Compute Driver, tenant gateways, Agent workloads, and k3d verification. (01a016e9-16e0-7b60-8a48-acd48f535366 - 1fdffdd)
- [2026-08-18 15:21]: Created the source-backed Kubernetes tenant lifecycle, resource inventory, production installation, security, migration, rollout, and local-conformance implementation specification. (01a016e9-16e0-7b60-8a48-acd48f535366 - 1fdffdd)
