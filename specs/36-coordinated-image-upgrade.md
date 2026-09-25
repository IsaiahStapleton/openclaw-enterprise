# Coordinated production image upgrades

Status: Proposed. This specification selects the first production upgrade
workflow for review; it does not describe behavior available on `main`.

## Outcome

Add one operator command that upgrades the OpenClaw Control Plane (OCC) and all
running Agent runtimes from a matched pair of immutable images.

The command:

1. verifies the target Installation and records the running fleet;
2. updates the OCC API and worker through Helm;
3. deploys a new revision for every Agent that was running when the upgrade
   began; and
4. waits for the new revisions and Pods to become ready.

V1 updates the fleet concurrently during an approved interruption window. It
does not provide a canary or rolling deployment.

Helm remains responsible for OCC workloads. The Installation startup Secret
remains responsible for Kubernetes Compute configuration. Agent workloads are
replaced only through the existing Agent deployment API, with its normal IAM and
audit behavior. The command does not patch tenant Deployments, write directly to
platform tables, or add an Amazon EKS-specific path.

## Operator contract

The repository provides `scripts/upgrade-production-images`. The operator runs
it from the checkout containing the installed chart and supplies:

- the kubeconfig, context, namespace, and Helm release;
- protected `values.yaml`, `installation.yaml`, and OCC service-key files;
- the trusted OCC URL and optional CA bundle;
- digest-pinned controller and runtime images built from one reviewed commit;
- that commit's full SHA; and
- a new private evidence directory.

The runtime image is used for both the gateway and Agent containers. Separate
gateway and Agent releases are out of scope for V1.

After production bootstrap, the operator annotates the live Installation Secret
with the Installation ID as `openclaw.dev/installation-id`. Every later upgrade
requires that ID to match the authenticated OCC Installation. This prevents a
valid OCC credential and a valid kubeconfig from targeting different
Installations.

Registry digests do not prove that two images came from the same source. Release
approval must establish that relationship from build records; the command stores
the supplied source SHA as evidence.

### First upgrade from an older release

Older controllers do not expose the complete deployment inventory required for
safe fleet selection. For first adoption only, the operator upgrades the API and
worker to the candidate controller image while leaving the Installation Secret
and Agent runtime images unchanged.

The operator then verifies:

- the API and worker use the candidate controller digest;
- OCC authentication succeeds; and
- `occ installation deployment-inventory` returns a complete inventory.

The coordinated command then uses that same controller digest with its companion
runtime digest. This bootstrap is explicit and keeps its own evidence. A missing
inventory operation never becomes an empty fleet or an automatic fallback.

## Admission and fleet selection

Before changing the cluster, the command must reject:

- mutable image references or an abbreviated source SHA;
- missing, symbolic-link, unreadable, or non-private protected files;
- an unreachable cluster, Helm release, or OCC endpoint;
- an OCC Installation ID that differs from the live Secret marker;
- protected Helm or Installation inputs that differ from live state outside the
  image fields owned by the command;
- incomplete or unauthorized inventory;
- queued or running Agent deployment work;
- a running Agent without an active revision; and
- a running Agent in a Namespace that is not ready.

The inventory operation requires Installation `administer`, exact `read` access
to every Namespace, Agent, and selected active revision, and exact `deploy`
access to every eligible running Agent. Any denial fails the complete request
instead of omitting resources. The operator's revision read grant must also cover
the new revisions created during the upgrade so status polling can continue. The
later deployment requests repeat their normal exact-resource authorization.

The command records Agents that are active, request the `running` state, have an
active revision, and belong to a ready Namespace. Stopped and deleting Agents
are not redeployed. An empty target set is valid: the command may update OCC and
the saved runtime selection, but it cannot claim that the runtime image starts.

The command saves the live and protected configuration, fleet inventory, and
workload state before mutation. It also renders the candidate chart and performs
a server-side Helm dry run.

## Upgrade sequence

1. Write the controller digest to the protected Helm values and the runtime
   digest to both protected Kubernetes Compute image fields.
2. Hash the candidate Installation document and put that checksum on the API and
   worker Pod templates. A runtime configuration change therefore restarts both
   OCC processes even when first adoption already selected the controller image.
3. Replace the Installation Secret while preserving its Installation ID marker.
4. Run `helm upgrade --install --wait`. Helm owns initialization, database
   migration, and the API and worker rollout.
5. Verify both OCC Deployments use the candidate controller digest and wait for
   authenticated OCC access to recover.
6. Submit an ordinary deployment request for every recorded running Agent before
   waiting for individual results.
7. Wait for every durable deployment to succeed. Confirm that each Agent selects
   the returned revision and that its revision Pods are `Running`, `Ready`, and
   use the candidate runtime digest. Embedded Agents require one gateway
   workload; dedicated Agents require both gateway and Agent workloads.

The command succeeds only after the complete recorded fleet converges. It does
not claim that a model, channel, provider, or external integration works; the
operator verifies those behaviors afterward.

## Failure and recovery

The upgrade is coordinated, not transactional. OCC may be healthy while one or
more Agent deployments fail. The command preserves every known result and does
not replay an Agent request whose outcome is unknown, because a second accepted
request creates another immutable revision.

Prefer a forward fix. Before an image rollback, verify that the previous release
can read state written by the candidate. Restore the previous image selections,
recompute the Installation checksum, replace the Secret, roll out both OCC
Deployments, and deploy the affected running Agents again. Helm rollback alone
does not replace Agent workloads or reverse database migrations and runtime data
changes.

The operator must back up PostgreSQL and Agent volumes when recovery requires
data restoration. PVC names and file hashes show continuity; they are not
backups.

## V1 limits

- All recorded Agent deployments start concurrently. The operator must provide
  capacity for old and candidate revisions to overlap.
- Deployments snapshot current Agent and Configuration drafts, not the previous
  active revision. Operators must review pending drafts before upgrading.
- There is no canary, batch size, automatic compatibility check, automatic
  rollback, or upgrade lock.
- Operators must prevent concurrent Helm changes, Agent deployments, and draft
  edits until the upgrade or recovery is complete.
- The workflow supports the production Helm and Kubernetes Compute path. It does
  not provision infrastructure, build images, publish images, or take backups.

## Implementation

1. Add a fail-closed Installation deployment inventory owned by platform State
   and authorized through the selected IAM Driver.
2. Add the operator script without introducing a new upgrade mutation API or a
   Kubernetes special case in platform core.
3. Add the operator guide, CLI reference, and source-backed runtime flow.
4. Put the Installation checksum on both OCC Pod templates.
5. Extend the production Kubernetes integration to exercise first adoption, two
   running Agents, one stopped Agent, the coordinated upgrade, and a fresh model
   response.

## Verification

Dependency-independent tests cover argument validation, protected inputs,
candidate rendering, an empty fleet, and readiness polling. They complement but
do not replace the real deployment proof.

The required integration uses a disposable k3d cluster, PostgreSQL, two matched
image pairs, and an authorized model credential. It installs the baseline through
Helm, proves a model response, performs first adoption, runs the coordinated
command, and proves another response from a replacement revision. It also
confirms that the stopped Agent is unchanged.

Pre-mutation cases must cover incomplete authorization, nonterminal deployment
work, a mismatched Installation marker, and stale protected configuration. A
durable deployment result must not complete the command until its Pods are ready.

Owning current documentation after implementation:
[production installation](../docs/guides/deploy/production-installation.md),
[production Agents](../docs/guides/deploy/production-agents.md),
[Agent deployment](../docs/reference/agents/deployment.md), and
[production startup](../docs/flows/production-startup.md).
