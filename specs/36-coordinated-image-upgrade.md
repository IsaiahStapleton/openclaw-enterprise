# Coordinated production image upgrades

Status: Proposed. This specification selects the first production upgrade
workflow for review; it does not describe behavior available on `main`.

## Outcome

Add one operator command that replaces the OpenClaw Control Plane (OCC)
controller image and the Kubernetes Compute Driver's gateway and Agent images
from one reviewed source revision. After Helm makes the new OCC API and worker
ready, the command submits a deployment for every Agent that was running at the
start of the upgrade. It submits the whole fleet before waiting for individual
deployments, so this first version favors a short, coordinated interruption over
a rolling or canary rollout.

The command is production Kubernetes packaging owned by OCE. Helm remains the
owner of OCC workloads, the Installation startup Secret remains the owner of
Compute Driver configuration, and the existing exact-Agent deployment API
remains the only way to replace Agent workloads. The command does not patch
tenant Deployments, write platform tables, or add an EKS-specific controller
path.

## Selected contract

The repository provides `scripts/upgrade-production-images`. An operator runs
it from a clean checkout that matches the installed chart and supplies:

- an explicit kubeconfig, Kubernetes context, Helm release, and control-plane
  namespace;
- the protected production `values.yaml` and `installation.yaml` inputs;
- a trusted OCC origin, CA bundle, and service-key file;
- one digest-pinned controller image and one digest-pinned runtime image; and
- an empty or new private evidence directory.

The controller and runtime images must be release companions built from the
same reviewed source revision. The script cannot prove source equivalence from
registry digests, so the operator records that revision in the evidence
directory and reviews the image build receipts before invoking it.

The runtime image fills both `drivers.compute.configuration.images.gateway` and
`drivers.compute.configuration.images.agent`. V1 does not support split gateway
and Agent releases.

### Admission and baseline

The script fails before mutation unless all image references use immutable
SHA-256 digests, required files are private regular files, the selected cluster
and Helm release are reachable, and the current API authenticates with the
provided service key. It renders the candidate chart and runs server-side dry
run before applying it.

The operator identity must list every Namespace and Agent in the Installation,
read every selected Agent and its deployment status, and deploy every selected
Agent. Collection filtering cannot silently turn an unauthorized Agent into an
upgrade omission: this first version requires an Installation administrator
whose inventory covers the fleet.

Before changing cluster state, the script saves protected copies of the live
Helm values, Installation startup document, input files, Agent inventory, and
current workload images. The target set contains Agents whose status is
`active`, desired runtime state is `running`, and `activeRevisionId` is present.
It rejects a running Agent without an active revision because another initial
deployment may be in flight. Stopped and deleting Agents remain untouched.

### Coordinated replacement

The script writes the controller digest to the protected Helm values and the
runtime digest to both protected Compute image slots. It then replaces the
Installation startup Secret and runs `helm upgrade --install --wait` with the
candidate values. Helm owns migration, initialization, and replacement of API
and worker Pods. The script requires both OCC Deployments to become available
on the candidate controller digest before continuing.

After OCC authentication recovers, the script sends the existing bodyless
`POST /namespaces/:namespaceId/agents/:agentId/deploy` operation for every
baseline Agent concurrently. Each request still performs exact-resource IAM
authorization and emits its normal attributable deployment audit event. The
script saves each returned revision ID, then polls the existing durable
deployment-status operation until every submitted revision succeeds or one
fails or times out.

The script exits successfully only when all baseline Agents select their
returned revision and their gateway and Harness workloads use the candidate
runtime digest. Untargeted workloads must retain their baseline state.

## Accepted v1 behavior and limits

Each Agent deployment snapshots its current saved Agent and Configuration
draft. An operator must therefore review pending draft changes as part of the
upgrade. The command records the baseline active revision and resulting
revision, but it does not recreate the old snapshot. A future exact-revision
restart operation can remove this coupling without weakening immutable revision
or IAM rules.

This workflow is coordinated, not transactional. A controller may be ready
while some Agent deployments fail. The script stops issuing new mutations after
a detected failure, preserves evidence, and reports every known outcome. It
does not automatically replay an unknown request, roll Helm back, delete a
revision, or restore runtime data. Recovery is an explicit forward fix or a
reviewed image rollback followed by another coordinated deployment.

The operator must provision capacity for overlapping Agent revisions. V1 has no
batch size, canary, maintenance window, automatic database snapshot, workspace
backup, or compatibility oracle. It preserves existing PVCs and database state
but does not treat identifiers or hashes as backups.

## Implementation and documentation

1. Add the fail-closed upgrade script and keep protected evidence out of the
   repository. Reuse the OCC HTTP contract; do not add an upgrade endpoint or
   Kubernetes special case to platform core.
2. Add an operator guide under `docs/guides/deploy/` with prerequisites,
   invocation, completion evidence, partial-failure recovery, and rollback
   boundaries. Link it from the deployment overview and production installation
   guide.
3. Update the production startup and Agent deployment flows to show the
   coordinated handoff from Helm readiness to exact-Agent deployment fan-out.
4. Extend the existing real production Kubernetes integration so one test
   installs the old image pair, creates multiple running Agents plus a stopped
   Agent, executes the upgrade command with a second pair, and verifies OCC
   readiness, concurrent new revisions, preserved storage, runtime digests, a
   fresh model turn, and the stopped Agent's unchanged revision.

## Verification

Dependency-independent checks cover argument validation, digest admission,
protected-file handling, candidate rendering, and unknown-result reporting.
They do not claim Kubernetes or runtime proof.

The required production proof uses a disposable loopback k3d cluster, a
dedicated PostgreSQL database, real digest-pinned old and candidate controller
and runtime images, and an authorized model credential. The test must exercise
the command through Helm and the OCC API; command stubs or hand-written Agent
state do not satisfy it. Record unavailable image pairs, credentials, or cluster
capacity as verification gaps rather than substituting a fake rollout.

Owning current documentation after implementation:
[production installation](../docs/guides/deploy/production-installation.md),
[production Agents](../docs/guides/deploy/production-agents.md),
[Agent deployment](../docs/reference/agents/deployment.md), and
[production startup](../docs/flows/production-startup.md).

## Amendment: prove complete inventory before mutation

The administrator requirement above is necessary but insufficient: current
Namespace and Agent lists omit resources denied by the selected IAM Driver,
including matching Restrictions on administrator identities. Successful list
responses cannot prove that the baseline contains the entire fleet. This
amendment strengthens admission; the original rollout and recovery choices
remain proposed.

Before the first Secret or Helm mutation, the command must obtain a complete
Installation inventory through a proposed OCC read-only operation. OCC requires
exact-Installation `administer`, reads all Namespaces and their Agents from one
consistent State snapshot, and checks exact-resource `read` for every Namespace
and Agent through the selected IAM Driver. It returns the snapshot only if every
check succeeds. Any denial fails the whole operation without returning a partial
inventory or disclosing hidden resource identities. The response identifies the
server-owned Installation and contains Namespace and Agent identities plus the
Agent lifecycle state, desired runtime state, and active revision used to select
the baseline. State owns completeness; IAM owns permission decisions.

The command must use this authorized snapshot as its baseline. It must reject
an unavailable complete-inventory operation, a different Installation, or a
partial or failed response before mutation. Filtered lists, administrator role
names, Kubernetes workload counts, and operator assertions are not substitutes.
Current HTTP collection operations do not provide this contract. Implementing
and qualifying the read-only operation is a prerequisite for enabling the
upgrade command; it does not authorize deployment or bypass the existing
exact-Agent mutation APIs.

The snapshot proves inventory at admission, not exclusive access throughout the
upgrade. Operators must prevent concurrent fleet changes and other upgrade runs
until completion or recovery. If observed Agent state diverges from the baseline
outside this command's recorded deployments, stop further mutations and report
partial failure; do not claim that untargeted workloads were preserved.

Extend the required production proof with an administrator denied `read` on one
Namespace and, separately, one Agent. Both cases must fail before any startup
Secret, Helm release, or Agent workload changes. An unavailable inventory
operation must fail at the same boundary. Keep these checks in the implementation
PR; this specification supplies no runtime qualification.
