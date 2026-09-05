# Report: Architecture and security audit

**Last updated:** 2026-09-01\
**Status:** Complete audit; findings unresolved\
**Authoring agent session:** [01a05f75-a97e-70c0-bfe4-e14b74e6ba3d](codex://threads/01a05f75-a97e-70c0-bfe4-e14b74e6ba3d)

## Context

This is an audit of **upstream commit `5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c`**, fetched on September 1, 2026, from `https://github.com/openclaw/openclaw-enterprise.git`. Source links below are pinned to that commit.

The canonical checkout is `/Users/kevinlin/code/openclaw-enterprise`; the project-local link resolves there. Its current branch, `dev/kevinlin/deploy-guide-tui-rewrite`, is at `264d6d2f58cd97504c2b8b58d607d002cd62cc5e`, with **2 commits ahead and 15 behind** fetched main. Updating it would require reconciling unrelated history. No merge, rebase, reset, stash, checkout, or worktree creation was performed. This is a **fetched-main audit**, not an audit of the updated working branch.

The pre-existing changes to `specs/README.md`, `specs/19-github-actions-test-coverage.md`, and `specs/reports/openclaw-testing-infrastructure.md` were preserved. The uncommitted CI proposal/report were not treated as implementation evidence. This report is the only repository file added.

Review scope covered implemented code, current design/reference/flow documentation, relevant implementation specs, deployment defaults, and repository organization. Ordinary unfinished capabilities were excluded unless the existing implementation creates a concrete structural or security risk. One initial review pass used five scoped reviewers for authentication/IAM, state/reconciliation, runtime isolation, provider/credential ownership, and deployment/docs. A targeted challenge/validation pass included parent classification and an independent skeptical reviewer. Major findings remain unresolved; no fixer pass ran because this task is audit-only.

## Assessment and priorities

The strongest defects are at integration boundaries: the HTTP wrapper bypasses a library security control, activation can leave contradictory durable/runtime state after recovery stops, and Docker retry reconstructs only one side of an authentication relationship. No confirmed cross-Namespace authorization bypass, credential disclosure, or container escape was established in the inspected paths.

| Priority | Finding | Classification | Confidence |
| --- | --- | --- | --- |
| P1 | Password sign-in bypasses the configured rate limiter | Confirmed security-control integration defect | High, source-confirmed |
| P1 | Failed Kubernetes activation can leave a permanently false active revision | Confirmed lifecycle/persistence defect | High, source-confirmed |
| P2 | Docker retry can give gateway and Codex different transport tokens | Confirmed development-runtime defect | High; diagnostic below |
| P2 | Production setup assigns an unprepared kubeconfig path | Confirmed operator-documentation defect | High |
| P3 | Architecture limitations incorrectly exclude service-principal API authentication | Confirmed documentation drift | High |

P1 means resolve before relying on the platform for a shared multi-user pilot; it does not mean an internet-reachable exploit was demonstrated. P2 affects a supported operational path. P3 is a bounded documentation correction.

## Confirmed findings

### 1. Password sign-in bypasses the configured rate limiter

**Evidence.** The HTTP route delegates directly to the auth wrapper ([apps/controller/src/index.ts:1793](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/index.ts#L1793-L1820)). The wrapper calls `api.signInEmail(...)` ([apps/controller/src/auth/index.ts:457](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/auth/index.ts#L457-L469)), although auth construction enables `rateLimit` ([apps/controller/src/auth/index.ts:378](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/auth/index.ts#L378-L386)). The dependency is pinned to Better Auth 1.6.11 ([apps/controller/package.json:18](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/package.json#L18-L34)).

In that exact upstream version, the server API is built separately from the HTTP router; rate limiting runs in the router's request/response callbacks. Direct `auth.api` invocation does not traverse those callbacks. See [Better Auth 1.6.11 API/router source](https://github.com/better-auth/better-auth/blob/v1.6.11/packages/better-auth/src/api/index.ts#L267-L331), [handler construction](https://github.com/better-auth/better-auth/blob/v1.6.11/packages/better-auth/src/auth/base.ts#L79-L84), and its [documented server-API rate-limit boundary](https://better-auth.com/docs/1.6/concepts/rate-limit). A scoped source search found no compensating controller sign-in limiter.

**Scenario and impact.** A client able to reach the controller can repeatedly submit invalid email/password attempts without this configured throttling, enabling password guessing and authentication-resource pressure. In the intended production deployment, the actor is an approved internal client or compromised allowed Pod: the chart uses a private Service and selector-restricted ingress ([deploy/helm/openclaw-enterprise/templates/service.yaml:1](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/deploy/helm/openclaw-enterprise/templates/service.yaml#L1-L16); [deploy/helm/openclaw-enterprise/templates/networkpolicies.yaml:15](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/deploy/helm/openclaw-enterprise/templates/networkpolicies.yaml#L15-L35)). This is not a demonstrated authentication or IAM bypass, and valid credentials remain necessary.

**Direction.** Put an explicit limiter at the public Fastify sign-in boundary, or adapt the request through the Better Auth HTTP handler while preserving the supported response contract. Use a trusted connecting-client identity and account-aware controls; do not trust caller-supplied forwarded IPs. Add an HTTP regression that repeated failed sign-ins reach `429` through the actual public route.

**Verification.** Independently traced the Enterprise route/wrapper and the exact pinned library source; inspected existing auth-security tests and searched for rate-limit/429 coverage. No sign-in flood test was run because Better Auth/Fastify dependencies are absent locally. The security-control omission is source-confirmed; exploit throughput is unmeasured.

### 2. Terminal activation failure leaves the database and Kubernetes disagreeing

**Evidence.** The worker commits the candidate `activeRevisionId` ([apps/controller/src/worker.ts:940](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/worker.ts#L940-L965)) before post-commit runtime activation ([apps/controller/src/worker.ts:977](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/worker.ts#L977-L993)). That ordering is intentional and is not itself this finding. For dedicated Kubernetes, the Agent Service selector changes only at the end of activation ([apps/controller/src/drivers/compute/kubernetes/index.ts:1383](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/drivers/compute/kubernetes/index.ts#L1383-L1400)); candidate preparation preserves an existing predecessor Service ([apps/controller/src/drivers/compute/kubernetes/index.ts:1163](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/drivers/compute/kubernetes/index.ts#L1163-L1172)).

If activation fails, the catch path retries finalization with only a pending outcome, without the candidate/predecessor context. After the convergence deadline, it marks the operation permanently failed without compensating the active pointer ([apps/controller/src/worker.ts:933](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/worker.ts#L933-L938); [apps/controller/src/worker.ts:966](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/worker.ts#L966-L993)). A retry can also terminate on revoked authorization before entering already-active recovery ([apps/controller/src/worker.ts:608](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/worker.ts#L608-L612); [apps/controller/src/worker.ts:632](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/worker.ts#L632-L674)). Kubernetes does not opt into periodic maintenance; maintenance scheduling also requires successful completion ([apps/controller/src/worker.ts:279](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/worker.ts#L279-L282); [apps/controller/src/worker.ts:1027](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/worker.ts#L1027-L1071)).

**Scenario and impact.** Start with revision r1 serving. Prepare r2, commit r2 as active, then fail activation before the selector write—for example, Kubernetes access fails at the beginning of activation. Keep the failure until the convergence deadline, or revoke the original deployer's authorization before retry. The operation becomes terminal while OCC still reports r2 active and r1 remains selected. On a first deployment, the pointer can instead name a revision with no serving route. Restoring the dependency alone does not reschedule the terminal operation. This violates the documented deployed-state and failure contract ([docs/design.md:603](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/docs/design.md#L603-L616); [docs/reference/controller.md:238](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/docs/reference/controller.md#L238-L242)).

This is a persistence/lifecycle correctness and availability defect. Stale serving may matter for a required configuration or policy replacement, but these sources do not prove privilege escalation.

**Direction.** Preserve explicit activation-finalization state, including predecessor/candidate identity, across retry and terminal decisions. Before permanently abandoning post-CAS activation, conditionally restore the verified predecessor or clear/deactivate serving state and report the Agent unready. Recovery must distinguish “active and finalized” from “CAS committed, route not published.” Simply routing before the database CAS would violate the nonserving-candidate boundary.

**Verification.** Two domain reviewers independently found the split; parent and skeptical review checked timeout, authorization-denial, existing-route, and maintenance paths. A direct worker import was also attempted in the isolated snapshot but stopped at the missing `typebox` dependency; no substitute dependency was fabricated. Existing tests deliberately prove successful after-commit ordering ([tests/integration/compute-singleton-worker.test.mjs:447](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/tests/integration/compute-singleton-worker.test.mjs#L447-L495)) and before-commit failure ([tests/integration/compute-singleton-worker.test.mjs:393](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/tests/integration/compute-singleton-worker.test.mjs#L393-L443)); they do not cover terminal failure after the CAS. Real PostgreSQL/Kubernetes failure injection was not run. Add both deadline and revoked-actor regression cases using the actual worker and persistent state.

### 3. Docker retry can break gateway-to-Codex authentication

**Evidence.** Dedicated `prepareRevision` generates a fresh token every attempt ([apps/controller/src/drivers/compute/docker/index.ts:293](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/drivers/compute/docker/index.ts#L293-L305)). A healthy existing Codex container is reused without changing its original token ([apps/controller/src/drivers/compute/docker/index.ts:448](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/drivers/compute/docker/index.ts#L448-L464)), but a missing/replaced gateway receives the newly generated token ([apps/controller/src/drivers/compute/docker/index.ts:401](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/drivers/compute/docker/index.ts#L401-L417)).

**Scenario and impact.** A worker process dies after Codex becomes healthy but before the gateway is created. The retried operation reuses Codex, creates the gateway with a different token, and can complete container-level readiness even though authenticated gateway-to-Codex traffic fails. Gateway-only loss during a pending operation has the same split. This affects the supported Docker development path; the Kubernetes path uses stable Secret-backed transport tokens.

Codex enforces the token digest, while its readiness probe authenticates with its own local token ([apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts:86](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts#L86-L114)). The gateway check is its own `/readyz`, which does not by itself prove this transport pair agrees.

**Direction.** Keep transport credential identity stable for the exact revision, or reconcile both endpoints together when replacing it. Do not derive a credential from public identifiers alone. Add a real Docker regression for retained healthy Codex plus gateway recreation, and prove authenticated transport after retry.

**Verification.** Two independent source reviews agreed. A temporary diagnostic executed the real Docker driver with only its Docker API transport seam simulated. It used the existing dedicated native Configuration helper and approved Harness descriptor, killed the first process after Codex was recorded healthy but before gateway creation, and retried with a fresh driver. Observed: `ready=true`, one Agent creation, one gateway creation, and different token fingerprints. This proves the generated credential mismatch with retained external state; it does not establish live Docker health or model behavior. Existing integration assertions check token presence without equality or partial-recovery coverage ([tests/integration/docker-compute-real.test.mjs:1038](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/tests/integration/docker-compute-real.test.mjs#L1038-L1046)). No real Docker or model turn was run.

### 4. Production setup never prepares its assigned kubeconfig file

The production block assigns `KUBECONFIG_FILE="$OCC_INPUT_DIRECTORY/kubeconfig"`, copies three YAML inputs, then chmods a kubeconfig it never creates ([docs/guides/deploy.md:61](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/docs/guides/deploy.md#L61-L75)). The prerequisite asks for an explicit context but does not tell a production operator to copy the corresponding kubeconfig to this newly assigned path.

Following the default steps with an existing kubeconfig elsewhere fails at chmod and later Kubernetes calls. The optional k3d path does create the file ([docs/guides/deploy.md:235](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/docs/guides/deploy.md#L235-L244)); the defect is the ordinary production path. Add an explicit copy/export step or accept and validate an existing `KUBECONFIG_FILE`. Source-checked; no cluster setup was attempted. The separate YAML-input and `/secure/occ` secret directories are explicitly documented and are not reported as a defect.

### 5. Current architecture understates supported service authentication

The current limitations say there is no “Service-principal API authentication” ([docs/ARCHITECTURE.md:232](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/docs/ARCHITECTURE.md#L232-L244)). Service API keys already authenticate non-Agent IAM ServicePrincipals ([docs/reference/authentication.md:159](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/docs/reference/authentication.md#L159-L183); [apps/controller/src/auth/index.ts:270](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/apps/controller/src/auth/index.ts#L270-L284)).

This conflates supported automation credentials with deferred workload-bound token verification, obscuring a security-relevant capability boundary. State that service API-key authentication exists and name the deferred workload token exchange/verification separately. Verified against routes, verifier, and current reference; no new runtime test was needed.

## Open Questions

- **Bootstrap-helper network isolation: bounded hardening question.** The pre-Helm preparation Pod lacks the release-instance label selected by the chart's default-deny policy ([scripts/prepare-bootstrap-volume:124](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/scripts/prepare-bootstrap-volume#L124-L192); [deploy/helm/openclaw-enterprise/templates/networkpolicies.yaml:1](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/deploy/helm/openclaw-enterprise/templates/networkpolicies.yaml#L1-L10)). Thus chart policies do not establish its isolation; a namespace policy must already cover it. The Pod has no service-account token, uses an empty PVC, receives no bootstrap credentials, and is not privileged: it runs UID 0 with only CHOWN/FOWNER restored. No practical compromise path was demonstrated. Decide whether the helper owns a temporary deny policy or the guide requires namespace-level coverage before execution.
- **Session transport policy:** sign-in/sign-out/session routes lack the controller's forwarded-header rejection. This alone did not establish a credential theft or authorization bypass; it was rejected as a standalone major finding. If hardening those routes, use a pre-auth transport check, not an identity-required admission hook that would prevent sign-in. The limiter issue above is independently substantive.

## Coverage, safeguards, and limitations

| Area | Evidence inspected and conclusion |
| --- | --- |
| Trust boundaries, authentication, authorization | Fastify routes, admission verifier, Better Auth integration, IAM bindings/restrictions, API schemas and auth tests. Exact-resource authorization remains separate from authentication; no concrete cross-Namespace IAM bypass found. |
| Namespace isolation and runtime | Kubernetes/Docker ownership checks, placement, projected identity, network/RBAC manifests, readiness, revision/gateway lifecycle, Sandbox/OpenShell contracts and fixtures. Docker retry defect found; no tested container escape or live network-enforcement claim. |
| Secrets, service accounts, providers, Drivers | Installation selection and plugin composition, private provider bindings, account issuance/deletion, Secret/Configuration storage and delivery, worker revalidation, API-only provider-admin mounting. No confirmed provider-binding or credential-ownership bypass found. |
| Persistence and concurrency | OCC state and SQL constraints, queue claim/lease fencing, worker retries, revision CAS and recovery tests. Claim-token fencing and same-Agent queue serialization are present; terminal activation compensation is missing. |
| Deployment, documentation, layout | Helm/Compose/defaults/bootstrap scripts, current architecture/reference/flows, documentation ownership, active workspace boundary. Two actionable doc errors and one bounded network hardening question identified. No maintainability finding was based on file size or abstraction count alone. |

Explicitly deferred public OAG/federation, SecretBroker, brokered model credentials, restricted model-egress proxy, automatic credential rotation, and stock OpenShell compatibility were not counted as new defects. Current references disclose env-delivery/restart semantics, temporary public TCP/443 model egress, and the worker's effective namespace-level trust. Older specs and project notes were used as context, not as proof that current code implements or violates an obsolete design.

### Verification performed

An isolated **non-Git** diagnostic directory was populated from `git archive 5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c`; it is not another checkout or worktree. No ambient credentials, kubeconfig, or live provider configuration were passed to test processes. Node 24.16.0 ran:

- `node scripts/verify-workspace-boundary.mjs`: passed; one application, five packages, 104 scanned sources.
- `utils.test.mjs`, `bootstrap-output.test.mjs`, `production-healthcheck.test.mjs`: **10 passed, 0 failed, 0 skipped**.
- `audit.test.mjs`, `compute-lifecycle-hooks.test.mjs`: **21 passed, 0 failed, 0 skipped**. A small loader mapped workspace package names to their exact exported source files; no library behavior was stubbed for these tests.
- Docker retry transport diagnostic: **mismatch reproduced**, with the production Driver logic and fake daemon state retained across process death. [Diagnostic script](/private/tmp/enterprise-audit-a1hg863_/docker-token-retry-diagnostic.mjs), [result](/private/tmp/enterprise-audit-a1hg863_/docker-token-retry-result.json), and [stdout](/private/tmp/enterprise-audit-a1hg863_/docker-token-retry-stdout.log) are temporary local evidence, not repository tests.

These tests establish only their named boundaries. Full Fastify/Better Auth, PostgreSQL, Kubernetes, Helm, Docker-runtime, OpenShell, provider, and model-turn suites were not run. The canonical checkout has no `node_modules`; no dependencies were installed. The audit did not change deployed systems, call credentialed external provider operations, or run a dependency-CVE scan. It is a scoped source audit with limited local execution, not a claim of complete production enforcement.

### Simplicity Audit

- [x] Identified the implemented request, persistence, and runtime paths and the security/ownership boundaries they must retain.
- [x] Traced authoritative owners for auth decisions, provider bindings, credentials, active revision state, and runtime routing.
- [x] Compared development, production, bootstrap, request handling, and persistence paths.
- [x] Required a concrete consumer or failure mode for each disputed abstraction; did not elevate style preferences.
- [x] Checked routes, storage/queue constraints, and the pinned library's public/server API distinction.
- [x] Distinguished current authored reference from generated API material, historical specs, and uncommitted proposals.
- [x] Proposed targeted correction at the owning boundary rather than new general frameworks.
- [ ] No post-fix diff exists: this was audit-only and no source fixes were authorized or applied.

### Test Audit and dispositions

No repository tests were added, changed, or deleted. The inspected auth-security, provider-ownership, lifecycle, packaging, and real-runtime suites should be **kept** for their distinct boundaries. The report identifies missing regression cases for findings 1–3; it does not propose deleting meaningful existing security coverage.

- [x] Mapped cited tests to actual routes, ownership, lifecycle states, and observable behavior.
- [x] Separated dependency-free execution, transport simulation, source inspection, and infrastructure-backed proof.
- [x] Preserved the distinction between render/fixture checks and actual runtime enforcement.
- [ ] Full infrastructure/application suites could not be executed here; their assertions were inspected where relevant.
- [ ] Missing sign-in throttling and terminal/partial-recovery regressions remain unresolved.
- [ ] No remediation or post-fix regression verification was performed.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-01 17:32 PDT: Audited fetched upstream `5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c`; recorded prioritized findings, skeptical validation, exact sources, and verification limits. Session `01a05f75-a97e-70c0-bfe4-e14b74e6ba3d`; working checkout HEAD `264d6d2f58cd97504c2b8b58d607d002cd62cc5e`.
