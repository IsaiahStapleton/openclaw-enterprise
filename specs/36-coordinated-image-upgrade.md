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

After initial bootstrap, the operator records the retrieved Installation ID on
the live Installation startup Secret as
`openclaw.dev/installation-id`. This marker binds later OCC API operations to
the selected Kubernetes context and namespace.

The controller and runtime images must be release companions built from the
same reviewed source revision. The script cannot prove source equivalence from
registry digests, so the operator records that revision in the evidence
directory and reviews the image build receipts before invoking it.

The runtime image fills both `drivers.compute.configuration.images.gateway` and
`drivers.compute.configuration.images.agent`. V1 does not support split gateway
and Agent releases.

### First-adoption controller bootstrap

An Installation whose current controller predates the complete-inventory
operation cannot safely run the coordinated command: filtered collection reads
cannot substitute for the missing server contract. The operator first performs
a reviewed controller-only Helm upgrade to the candidate controller digest while
leaving the Installation startup Secret and both runtime image selections
unchanged. This bootstrap replaces only the OCC API and worker and must preserve
its own before-state evidence. The operator verifies the new controller digest,
OCC authentication, and `occ installation deployment-inventory`, then runs the
coordinated command with the same controller digest and its companion runtime
digest.

This is a one-time adoption prerequisite, not a fallback inside the coordinated
command. The command never interprets a missing inventory operation as an empty
or complete fleet. Later upgrades begin directly with coordinated admission.

### Admission and baseline

The script fails before mutation unless all image references use immutable
SHA-256 digests, required files are private regular files, the selected cluster
and Helm release are reachable, and the current API authenticates with the
provided service key. It renders the candidate chart and runs server-side dry
run before applying it.

Before the coordinated command's first Secret or Helm mutation, it obtains a
complete Installation inventory through a new OCC read-only operation. OCC requires
exact-Installation `administer`, reads all Namespaces and their Agents from one
consistent State snapshot, and checks exact-resource `read` for every Namespace
and Agent through the selected IAM Driver. For every Agent selected for the
baseline, it also checks exact-Agent `deploy`. It returns the snapshot only when
every check succeeds. A denial fails the operation without returning a partial
inventory or disclosing hidden resource identities.

The response identifies the server-owned Installation and contains the
Namespace and Agent identities, Agent lifecycle state, desired runtime state,
active revision, and whether deployment work is nonterminal. The command rejects
an unavailable inventory operation, a different Installation, or a failed or
partial response before mutation. Filtered collection operations, administrator
role names, Kubernetes workload counts, and operator assertions cannot prove
completeness. The inventory operation authorizes no deployment; every later
Agent mutation repeats exact-resource authorization.

The authenticated OCC Installation ID must equal the live startup Secret's
Installation marker. The protected Helm values and Installation document must
also equal their live owners after removing only the controller and runtime
image fields changed by this command. A missing or mismatched identity marker or
any other stale protected setting fails before rendering or mutation.

Before changing cluster state, the script saves protected copies of the live
Helm values, Installation startup document, input files, Agent inventory, and
current workload images. The target set contains Agents whose status is
`active`, desired runtime state is `running`, and `activeRevisionId` is present.
It rejects a running Agent without an active revision and any Agent with
nonterminal deployment work. These states indicate an initial or replacement
deployment may still be in flight. Stopped and deleting Agents remain untouched.
An Installation with no running Agents has an empty target set; it still updates
the control plane and persisted runtime selections without claiming runtime Pod
or model proof.

### Coordinated replacement

The script writes the controller digest to the protected Helm values and the
runtime digest to both protected Compute image slots. The controller digest may
already be selected after first-adoption bootstrap, but at least one runtime
slot must change. It then replaces the Installation startup Secret and runs
`helm upgrade --install --wait` with the candidate values. Helm owns migration,
initialization, and replacement of API and worker Pods. The script requires both
OCC Deployments to become available on the candidate controller digest before
continuing. Secret replacement preserves the Installation identity marker.

After OCC authentication recovers, the script sends the existing bodyless
`POST /namespaces/:namespaceId/agents/:agentId/deploy` operation for every
baseline Agent concurrently. Each request still performs exact-resource IAM
authorization and emits its normal attributable deployment audit event. The
script saves each returned revision ID, then polls the existing durable
deployment-status operation until every submitted revision succeeds or one
fails or times out.

The script exits successfully only when all baseline Agents select their
returned revision, every selected revision Pod is `Running` and `Ready`, and its
gateway and Harness workloads use the candidate runtime digest. Untargeted
workloads must retain their baseline state.

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

The inventory is consistent at admission but does not provide exclusive access
throughout the upgrade. Operators must prevent concurrent fleet changes and
other upgrade runs until completion or recovery. If observed Agent state
diverges from the baseline outside the command's recorded deployments, the
command stops further mutations and reports partial failure.

## Implementation and documentation

1. Add the authorized, fail-closed Installation inventory operation. State owns
   inventory completeness, and the selected IAM Driver owns permission checks.
2. Add the fail-closed upgrade script and keep protected evidence out of the
   repository. Reuse the exact-Agent deployment and status operations; do not
   add an upgrade mutation endpoint or Kubernetes special case to platform core.
3. Add an operator guide under `docs/guides/deploy/` with the first-adoption
   controller bootstrap, prerequisites, invocation, completion evidence,
   partial-failure recovery, and rollback boundaries. Link it from the deployment
   overview and production installation guide. Production installation records
   the generated Installation ID on the startup Secret for later target binding.
4. Update the production startup and Agent deployment flows to show the
   coordinated handoff from Helm readiness to exact-Agent deployment fan-out.
5. Extend the existing real production Kubernetes integration so one test
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

The proof first replaces only the old controller while retaining the old runtime
and Agent revisions, then exercises the coordinated command. It separately
denies the administrator `read` on one Namespace, `read` on one Agent, and
`deploy` on one selected Agent. Those denial cases and existing nonterminal
Agent deployment work must fail before any coordinated startup Secret, Helm
release, or Agent workload changes. An unavailable complete-inventory operation
must stop with the first-adoption prerequisite; it never authorizes coordinated
mutation.

The proof also supplies a mismatched Kubernetes Installation marker and stale
protected non-image settings; both must fail before mutation. It observes that
durable deployment success does not complete the command until the replacement
Pods become ready. A separate empty-fleet case proves controller and persisted
runtime selection without claiming runtime startup.

Owning current documentation after implementation:
[production installation](../docs/guides/deploy/production-installation.md),
[production Agents](../docs/guides/deploy/production-agents.md),
[Agent deployment](../docs/reference/agents/deployment.md), and
[production startup](../docs/flows/production-startup.md).
