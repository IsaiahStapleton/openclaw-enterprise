---
created: 2026-09-23
updated: "2026-09-28"
last_updated_session: "authoring-run/ef0e4dd2-3f52-48b4-a742-60dfbb85864a"
---

# Production image upgrade flow

## Overview

`scripts/upgrade-production-images` updates the OpenClaw Control Plane (OCC),
Agent runtimes, or both. The controller-only command ends after the OCC API and
worker recover; it does not request Agent deployments. A runtime release deploys
a new revision for every Agent that was running when the command began and ends
after the selected Pods are ready and each replacement gateway passes read-only
Doctor lint. Model and external integration checks remain operator tasks.

## Entry Points

- Trigger: an operator runs `scripts/upgrade-production-images` with one or both
  image options and explicit cluster, release, source, and protected-file inputs.
- Required state: a healthy production Helm release and matching OCC and
  Kubernetes Installation identity. Runtime releases additionally require a
  complete authorized fleet inventory with no deployment in progress.
- Source: `scripts/upgrade-production-images`,
  `packages/occ/src/index.ts:OpenClawController.getInstallationDeploymentInventory`,
  and `packages/occ/src/index.ts:OpenClawController.deployAgent`.

## Flow

```mermaid
graph TD
    A["Validate inputs and freeze fleet"] --> B["Render candidate and save recovery record"]
    B --> C["Read live Secret and Helm state"]
    C --> D{"Candidate Helm release deployed?"}
    D -->|No| E["Stop API and worker Pods"]
    E --> F["Update Secret and run Helm migration"]
    F --> G{"Helm completes?"}
    G -->|No| H["Inspect migration and release before retry"]
    H --> C
    G -->|Yes| I["Verify OCC rollout"]
    D -->|Yes| I
    I --> J{"Runtime release?"}
    J -->|No| K["Hand off application checks"]
    J -->|Yes| L["Deploy recorded Agents"]
    L --> M{"Dispatch response known?"}
    M -->|No| N["Read Agent and stop for reconciliation"]
    N --> L
    M -->|Yes| O["Check revisions, Pods, and Doctor"]
    O --> K
```

## Execution Trace

### 1. Prepare and freeze the target

`scripts/upgrade-production-images:213`

The script verifies the protected files, cluster, deployed Helm release, and
matching OCC and Secret Installation IDs. It compares protected and live
configuration outside the selected image fields. A runtime release also reads
complete authorized inventory and records every running Agent's baseline
revision. Nonterminal deployment work, a missing active revision, or an unready
Namespace stops preparation. Stopped and deleting Agents are excluded.

For repository-enabled releases, the script validates the running worker's
broker origin against its Service settings and preserves the hostname in the
candidate values. Restarting that broker loses delivered sessions; follow the
[broker recovery procedure](../guides/repository-credentials/installation.md#install-and-verify).

The script renders the chart and performs a server-side Helm dry run. It saves
candidate inputs, inventory, target identity, and parameter hashes in the
private evidence directory before marking preparation complete. A per-directory
lock prevents two helpers from using that record at once. The operator must
freeze other writers, autoscalers, Helm changes, and runtime draft edits as
specified in the [production guide](../guides/deploy/production-upgrade.md).

### 2. Reconcile a prior attempt

`scripts/upgrade-production-images:421`

On every attempt the script rereads Helm status and values and the Installation
Secret. Only the recorded baseline or candidate values are accepted; the
Secret's UID, Installation annotation, and other data must match the baseline.
Resume also binds the original kubeconfig contents, inputs, OCC URL, script,
and chart. Unexpected drift or an in-progress Helm release stops the command.

If a previously started Helm release is deployed at a newer revision with the
candidate values, the script continues without repeating Helm. Otherwise it
requires the operator's migration-history check and refuses a retry while an
initialization Pod remains active. A failed or disconnected migration may have
committed; the check and Job inspection are operator-owned and are not a
rollback. The guide describes the required attestation and recovery.

### 3. Quiesce writers and run the candidate release

`scripts/upgrade-production-images:483`

Before changing the Secret or invoking Helm, the script scales the selected API
and worker Deployments to zero, waits until their Pods disappear, and confirms
both desired replica counts remain zero. This covers the selected Helm release;
it does not detect independent database writers, autoscalers, or partitioned
nodes. The operator must stop those writers and keep nodes reachable.

The protected files are atomically replaced with the saved candidate. For a
runtime release, the script reads the Secret before updating its Installation
key, preserving other data and metadata with a resource-version precondition.
If the candidate is already present after a lost response, it does not write it
again. The candidate Installation checksum is included in both OCC Pod
templates.

A durable marker precedes `helm upgrade`. The candidate migrator and bootstrap
run in the Helm initialization hook before API and worker rollout. If Helm
fails, resumption reads its current status and migration state before a retry;
it does not start the old image to undo a committed schema change.

### 4. Verify control-plane recovery

`scripts/upgrade-production-images:539`

The script waits for both OCC Deployments, checks their controller image and
replica count, and checks the Installation checksum for a runtime release. It
retries authenticated OCC access and verifies the same Installation ID. A
controller-only release then ends without requesting Agent deployments.

### 5. Deploy and verify the recorded fleet

`scripts/upgrade-production-images:568`

Before sending each ordinary exact-Agent deployment request, the script records
an intent. Successful responses are saved atomically. On resume, existing
responses are reused; an intent without a response triggers an Agent readback
and stops for operator reconciliation. The helper does not infer rejection from
an unchanged active revision or replay an unknown request. An operator can
record a verified accepted response and resume.

The script polls each returned deployment through its authorized status
operation, confirms active revision selection, and waits for all revision Pods
to be `Running` and `Ready` on the candidate runtime digest. Embedded execution
requires one runtime container; dedicated execution requires both gateway and
Agent containers. Each replacement gateway then runs read-only
`openclaw doctor --lint --json --severity-min error`. Failures retain dispatch,
status, Pod, and Doctor evidence for inspection.

### 6. Hand off application verification

`docs/guides/deploy/production-upgrade.md:Verify the release`

Successful script completion proves the selected Helm rollout and OCC access.
For a runtime release it also proves the recorded deployments and Pods reached
the checked states and Doctor reported no error. The operator next verifies
model responses, providers, channels, credentials, workspace continuity, native
access, and required restore behavior.

## Debugging and Verification

- Inspect `server-dry-run.txt` for chart or admission failures before mutation.
- For OCC rollout failures, inspect `helm-upgrade.txt`, initialization Job logs,
  and API and worker rollout status.
- For runtime failures, inspect `dispatch/*.error`, revision history, and
  `status/*.json` before retrying anything. Doctor failures are recorded in
  `status/*.doctor.json` and `status/*.doctor.error`.
- Compare `before-workloads.json` and `after-workloads.json` for unexpected
  workload changes. The controller-only helper requests no Agent deployments;
  separately check repository-bound revisions affected by broker restart.
  Runtime proof should show the intended replacements.
- Use the credentialed production Kubernetes integration with distinct baseline
  and candidate images for end-to-end proof. Mocked commands prove only script
  control flow.

## Related docs

- [Production upgrade guide](../guides/deploy/production-upgrade.md)
- [Production installation](../guides/deploy/production-installation.md)
- [Production Agent verification](../guides/deploy/production-agents.md)
- [Agent deployment reference](../reference/agents/deployment.md)
- [Production startup flow](production-startup.md)
- [Controller worker flow](controller-worker.md)
- [Authoritative platform design](../design.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-28 07:02: Record quiesced migrations and resumable release and dispatch recovery. (authoring-run/ef0e4dd2-3f52-48b4-a742-60dfbb85864a - e06ff9625e72ff5ab3483a504a2f02a69a370cbb)

- 2026-09-26 22:28: Preserve the selected repository broker hostname before image upgrades. (authoring-run/1495f489-e298-44e9-b75d-6a49445d35e3 - 7caf53332219db12fed62180c3c6d270baa8ea63)

- 2026-09-25 13:40: Document Helm migration ordering and add post-readiness OpenClaw Doctor lint for replacement gateways. (authoring-run/d35fd05b-5bbd-4f21-a747-820c2df23b2c - 077e26ba0c0babe033569105e3a7e89abf06f40d)
- 2026-09-25 12:29: Split controller and runtime releases while retaining an optional combined path. (authoring-run/ab700e2e-1baf-400c-ab18-0aa9a351f351 - 5e747ac1722f757d7949746e9ff9982142c8536b)
- 2026-09-24 21:21: Separate operator instructions from the runtime trace; require revision-read admission, HTTPS, bounded Kubernetes reads, and the complete execution-mode workload set. (authoring-run/613d1e94-a661-4781-bae5-e28613aa3cf9 - c799988036f43ce1bb828373233f03cc77bb0ea9)
- 2026-09-24: Record cluster/OCC identity binding, live/protected input equivalence, the supported empty-fleet path, and runtime Pod readiness discovered by the production rehearsal.
- 2026-09-24 13:43: Trace fail-closed inventory admission, nonterminal deployment rejection, and the one-time controller-only bootstrap for older OCC versions. (authoring-run/0fc7c19b-0e15-498c-8328-e436bc702f37 - a7a609d5867398dd0dfd3bb77cfebf91b2cad116)
- 2026-09-23 12:32: Trace matched image replacement and concurrent exact-Agent deployment through durable status convergence. (authoring-run/d29bdbc5-2a6a-46fa-a8e5-6ad78ea2e486 - 78cf9fd25f08e91158617fbd0ae3e42a22e54361)
