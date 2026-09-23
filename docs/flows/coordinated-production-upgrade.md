---
created: 2026-09-23
updated: "2026-09-23"
last_updated_session: "authoring-run/d29bdbc5-2a6a-46fa-a8e5-6ad78ea2e486"
---

# Coordinated production image upgrade flow

## Overview

An operator runs `scripts/upgrade-production-images` to replace the matched
controller and runtime image pair for a production Kubernetes Installation.
The script establishes a running-Agent baseline, lets Helm replace the OCC API
and worker, then submits exact-Agent deployments concurrently and waits for all
new revisions. The flow ends after image and deployment convergence; model,
channel, and data-recovery proof remain operator checks.

## Entry Points

- Trigger: Run `scripts/upgrade-production-images` with explicit protected
  inputs, image digests, source SHA, cluster selection, and evidence directory.
- Required state: A healthy production Helm release, complete administrator
  inventory, private API access, reviewed release companions, and no concurrent
  upgrade or Agent draft edits.
- Source: `scripts/upgrade-production-images`,
  `deploy/helm/openclaw-enterprise/templates/deployments.yaml`, and
  `packages/occ/src/index.ts:OpenClawController.deployAgent`.

## Flow

```mermaid
graph TD
    A["Operator supplies matched immutable images and protected inputs"] --> B["Script authenticates and records live Helm, Installation, workload, and Agent baseline"]
    B --> C{"Every running Agent has an active revision?"}
    C -->|No| D["Stop before mutation and report the in-flight Agent"]
    C -->|Yes| E["Render candidate chart and run Helm server-side dry run"]
    E --> F["Update protected inputs and Installation startup Secret"]
    F --> G["Helm replaces initialization, API, and worker on the controller digest"]
    G --> H{"API and worker ready and authenticated?"}
    H -->|No| I["Preserve evidence and stop before Agent fan-out"]
    H -->|Yes| J["Submit exact-Agent deployments for the complete baseline concurrently"]
    J --> K["Worker admits, prepares, and activates each immutable revision on the runtime digest"]
    K --> L{"Every durable deployment succeeded?"}
    L -->|No| M["Preserve partial results for forward repair or reviewed rollback"]
    L -->|Yes| N["Confirm selected revisions and runtime Pod images"]
    N --> O["Operator performs model, channel, workspace, and data checks"]
```

## Execution Trace

### 1. Admit inputs and freeze the baseline

`scripts/upgrade-production-images:121`

The script requires owner-only kubeconfig, values, Installation, service-key,
and optional CA files. It rejects mutable image tags, abbreviated source SHAs,
an existing evidence path, unavailable dependencies, and a fleet with no
running Agent. It saves live and protected inputs before mutation.

The OCC list operations return only authorized resources. The supported
operator therefore has complete Installation inventory. The target set freezes
Agents that are active, desire `running`, and have an active revision. A running
Agent without an active revision blocks the upgrade because initial deployment
may still be in flight.

### 2. Render the matched image candidate

`scripts/upgrade-production-images:166`

The script writes the controller digest to candidate Helm values and one runtime
digest to both Kubernetes Compute image slots. `helm template` and Kubernetes
server-side dry run check the chart against the selected cluster before
mutation. These checks establish structural rendering only; they do not prove
image contents, startup, compatibility, or model behavior.

### 3. Replace OCC through Helm

`deploy/helm/openclaw-enterprise/templates/deployments.yaml:20`

The script copies the admitted candidates to the protected operator inputs,
replaces the Installation startup Secret, and invokes the canonical Helm chart.
Helm runs its initialization hook and replaces API and worker Pods because both
use `images.controller`. The script waits for rollout and verifies both named
containers use the candidate digest before retrying authenticated Installation
access. A failure here stops before Agent deployment fan-out.

### 4. Fan out exact-Agent deployment

`internal/occcli/cli.go:application.agentCommand`

The script starts every `occ agent deploy` request before waiting for any
request process. OCC handles each as an independent exact-Agent mutation:
`OpenClawController.deployAgent` authorizes the Agent and referenced resources,
reads the current draft, freezes a new immutable revision, records attributable
work, and returns its revision ID. Failed or unknown responses remain separate;
the script never converts the group into one unauditable bulk mutation.

### 5. Fan in on durable results

`internal/occclient/client.go:Client.GetAgentDeployment`

The `occ agent deployment-status` command reads the existing durable deployment
resource. The script polls all returned revision IDs until each succeeds, one
fails, or the shared timeout expires. It then verifies every Agent selected its
returned revision and that revision-labeled gateway and Agent containers use
the runtime digest. It preserves before/after workload inventories and every
response under the private evidence directory.

### 6. Hand off runtime acceptance

`docs/guides/deploy/production-upgrade.md:96`

Script success proves Helm convergence, durable OCC deployment completion,
active-revision selection, and observed container image references. The
operator next proves fresh model responses, provider/channel behavior,
credential boundaries, workspace continuity, native UI access, and any required
restore capability. Those checks are intentionally outside automatic upgrade
success.

## Debugging and Verification

- Inspect `server-dry-run.txt` for chart or admission failures before mutation.
- Inspect `helm-upgrade.txt`, initialization Job logs, and API/worker rollout
  status when OCC does not recover.
- Inspect `dispatch/*.error`, revision history, and `status/*.json` before
  deciding whether a failed or unknown Agent request can be retried.
- Compare `before-workloads.json` and `after-workloads.json` for PVC identity and
  untargeted workload changes.
- Run the credentialed production Kubernetes integration with distinct old and
  candidate image pairs for end-to-end proof. Source checks and mocked commands
  do not establish a real upgrade.

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

- 2026-09-23 12:32: Trace matched image replacement and concurrent exact-Agent deployment through durable status convergence. (authoring-run/d29bdbc5-2a6a-46fa-a8e5-6ad78ea2e486 - 78cf9fd25f08e91158617fbd0ae3e42a22e54361)
