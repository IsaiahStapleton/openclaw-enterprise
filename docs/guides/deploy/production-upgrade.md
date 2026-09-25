# Upgrade production images

Use `scripts/upgrade-production-images` to update the OpenClaw Control Plane
(OCC) and redeploy every Agent that is running when the upgrade begins.

V1 restarts the fleet concurrently. Schedule an interruption window and provide
enough cluster capacity for old and replacement Agent revisions to overlap.

The command supports the production Helm and Kubernetes Compute path. It does
not build or publish images, create backups, provision infrastructure, or prove
that a model or external integration works after deployment.

## Before you begin

Prepare:

- controller and runtime images built from one reviewed commit and referenced by
  immutable `@sha256:` digests;
- passing checks and build records for that commit;
- a PostgreSQL and Agent-volume backup when recovery requires data restoration;
- enough capacity to replace all running Agents concurrently;
- the production kubeconfig, Helm values, Installation YAML, OCC service key,
  and optional CA bundle in protected files; and
- an OCC identity with Installation `administer`, exact `read` access to every
  Namespace, Agent, and active Agent revision, and exact `deploy` access to every
  running Agent. Revision read access must also cover the replacement revisions
  created during the upgrade.

Review saved Agent and Configuration drafts. Each deployment snapshots the
current draft, not the Agent's previous active revision.

Run from the checkout containing the installed chart. Make the kubeconfig,
values, Installation, and service-key files owner-only. The evidence directory
must not exist; the command creates it with mode `0700`.

Set the connection and release inputs:

```bash
umask 077
export OCC_URL='https://<internal-occ-host>'
export OCC_SERVICE_KEY_FILE='/secure/occ/operator-service-key.json'
export OCC_CA_BUNDLE='/secure/occ/occ-ca.pem'
export CONTROLLER_IMAGE='<registry>/controller@sha256:<64-hex-digest>'
export RUNTIME_IMAGE='<registry>/runtime@sha256:<64-hex-digest>'
export RELEASE_SOURCE_SHA='<full-40-character-git-sha>'
export UPGRADE_EVIDENCE="/secure/occ/upgrades/$(date -u +%Y%m%dT%H%M%SZ)"
```

Stop other Helm changes, Agent deployments, and draft edits until the upgrade or
recovery is complete. Resolve any queued or running Agent deployment first.

## Bind the Installation once

Skip this step when the live Installation Secret already has the correct
`openclaw.dev/installation-id` annotation.

After initial production bootstrap, read the Installation ID from the retained
bootstrap key and annotate the Secret:

```bash
export OCC_INSTALLATION_ID="$(jq -er '.meta.installationId' "$OCC_BOOTSTRAP_KEY_FILE")"
export OCC_INSTALLATION_SECRET="$(yq -er '.installation.secretName' /secure/occ/values.yaml)"
kubectl --kubeconfig /secure/occ/kubeconfig \
  --context '<reviewed-context>' --namespace openclaw-system \
  annotate secret "$OCC_INSTALLATION_SECRET" \
  openclaw.dev/installation-id="$OCC_INSTALLATION_ID"
```

Do not replace a different existing ID. Investigate why the cluster and
bootstrap record disagree.

## Adopt the inventory API once

Run:

```bash
occ installation deployment-inventory --output json
```

If it succeeds, continue to [Run the upgrade](#run-the-upgrade). A `404` means
the installed controller predates the complete-inventory API.

For first adoption only, save the current values and change only
`images.controller`. Leave the Installation Secret and runtime images unchanged:

```bash
export CONTROLLER_BOOTSTRAP_EVIDENCE="${UPGRADE_EVIDENCE}-controller-bootstrap"
mkdir -m 700 "$CONTROLLER_BOOTSTRAP_EVIDENCE"
install -m 600 /secure/occ/values.yaml \
  "$CONTROLLER_BOOTSTRAP_EVIDENCE/before-values.yaml"
helm get values oce \
  --kubeconfig /secure/occ/kubeconfig \
  --kube-context '<reviewed-context>' \
  --namespace openclaw-system --output yaml \
  > "$CONTROLLER_BOOTSTRAP_EVIDENCE/before-live-values.yaml"
CONTROLLER_IMAGE="$CONTROLLER_IMAGE" yq -i \
  '.images.controller = strenv(CONTROLLER_IMAGE)' /secure/occ/values.yaml
```

Render, server-side dry-run, and apply that controller-only change:

```bash
helm template oce deploy/helm/openclaw-enterprise \
  --kubeconfig /secure/occ/kubeconfig \
  --kube-context '<reviewed-context>' \
  --namespace openclaw-system \
  --values /secure/occ/values.yaml \
  > "$CONTROLLER_BOOTSTRAP_EVIDENCE/rendered.yaml"
helm upgrade --install oce deploy/helm/openclaw-enterprise \
  --kubeconfig /secure/occ/kubeconfig \
  --kube-context '<reviewed-context>' \
  --namespace openclaw-system \
  --values /secure/occ/values.yaml \
  --dry-run=server --hide-secret \
  > "$CONTROLLER_BOOTSTRAP_EVIDENCE/server-dry-run.txt"
helm upgrade --install oce deploy/helm/openclaw-enterprise \
  --kubeconfig /secure/occ/kubeconfig \
  --kube-context '<reviewed-context>' \
  --namespace openclaw-system \
  --values /secure/occ/values.yaml \
  --wait --timeout 5m \
  > "$CONTROLLER_BOOTSTRAP_EVIDENCE/helm-upgrade.txt"
```

Verify both `openclaw-enterprise-api` and `openclaw-enterprise-worker` use
`$CONTROLLER_IMAGE`, OCC authentication works, and the inventory command now
succeeds. Confirm that no Agent revision changed.

Keep this bootstrap evidence separately. The coordinated command accepts the
already-selected controller digest and performs the runtime update.

## Run the upgrade

Refresh the protected values and Installation files from their live owners, then
run:

```bash
scripts/upgrade-production-images \
  --kubeconfig /secure/occ/kubeconfig \
  --context '<reviewed-context>' \
  --namespace openclaw-system \
  --release oce \
  --values /secure/occ/values.yaml \
  --installation /secure/occ/installation.yaml \
  --controller-image "$CONTROLLER_IMAGE" \
  --runtime-image "$RUNTIME_IMAGE" \
  --source-revision "$RELEASE_SOURCE_SHA" \
  --evidence-dir "$UPGRADE_EVIDENCE" \
  --occ /secure/occ/bin/occ
```

Before mutation, the command verifies:

- the authenticated OCC Installation matches the selected Kubernetes
  Installation;
- protected configuration matches live configuration outside the image fields
  owned by the command;
- the complete inventory is authorized and has no deployment in progress;
- every running Agent has a readable active revision in a ready Namespace; and
- the candidate chart passes rendering and server-side dry run.

It then updates the protected image selections, replaces the Installation
Secret, and runs Helm. A checksum of the Installation document restarts both the
API and worker even when the controller image is unchanged.

After OCC recovers, the command deploys every recorded running Agent, waits for
durable success, confirms each new active revision, and requires its Pods to be
`Running` and `Ready` on the candidate runtime digest. Stopped and deleting
Agents remain untouched. An empty fleet updates the saved runtime selection but
does not prove that the image starts.

Success looks like:

```text
Upgraded controller and runtime images; <count> running Agents selected new revisions.
```

## Verify the release

Keep the evidence directory private. Check:

- `before-live-values.yaml` and `before-live-installation.yaml` against the
  candidate files for the intended image-only change;
- `before-workloads.json` and `after-workloads.json` for PVC and untargeted
  workload continuity;
- `deployments.jsonl` and `status/` for one successful revision per recorded
  Agent; and
- the final Helm status and live API, worker, gateway, and Agent images.

Then follow [Verify production workloads](production-agents.md#verify-production-workloads)
for every execution mode and provider used by the fleet. Require a fresh model
response and check relevant channels, credentials, workspace data, and native UI
access. Script success proves deployment convergence, not application behavior.

## Recover from a partial failure

The workflow is not transactional. If OCC succeeds but an Agent deployment
fails, keep the healthy control plane, preserve the evidence, and inspect the
exact failed deployment. Do not retry an unknown response until revision history
shows whether OCC accepted it; a retry can create another revision.

Prefer a reviewed forward fix. Before rolling images back, verify that the
previous release can read state written by the candidate. Restore the previous
controller and runtime selections, then recompute the checksum before replacing
the Installation Secret:

```bash
export ROLLBACK_INSTALLATION_CHECKSUM="$(
  python3 -c \
    'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' \
    /secure/occ/installation.yaml
)"
ROLLBACK_INSTALLATION_CHECKSUM="$ROLLBACK_INSTALLATION_CHECKSUM" yq -i \
  '.controlPlane.installationChecksum = strenv(ROLLBACK_INSTALLATION_CHECKSUM)' \
  /secure/occ/values.yaml
```

Run Helm, wait for both OCC Deployments, verify the restored configuration, and
deploy the affected running Agents again. Helm rollback alone does not replace
Agent workloads or reverse database migrations and runtime data changes.

Never delete Agents, revisions, PVCs, or the bootstrap volume to force recovery.
If the previous release cannot read the new state, stop and prepare a forward
repair or coordinated data restore.

## Current limits

- No canary, batching, automatic compatibility check, or automatic rollback.
- No upgrade lock; operators must prevent concurrent fleet changes.
- All recorded Agent deployments start concurrently.
- Deployment uses current drafts rather than recreating active revisions.
- One runtime image is used for both gateway and Agent containers.
- Runtime, model, channel, and restore checks remain manual.

See the [coordinated upgrade flow](../../flows/coordinated-production-upgrade.md)
for implementation details and failure boundaries.
