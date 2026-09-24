# Upgrade production controller and runtime images

Use the coordinated upgrade command to replace the OpenClaw Control Plane
(OCC) controller image and the Kubernetes Compute runtime image, then deploy a
new revision for every Agent that was running when the command began. This first
version restarts the fleet together. Use it only during an approved interruption
window with enough capacity for overlapping Agent revisions.

The command supports the production Helm and Kubernetes Compute path. It is not
an Amazon EKS-specific workflow. It does not provision infrastructure, build or
publish images, take backups, or verify a model response after the restart.
When the baseline contains no running Agents, it still updates the controller
and persisted runtime image selections and reports that zero Agent revisions
were deployed. That outcome does not prove the runtime image starts correctly.

## Prepare the release and recovery inputs

Complete the following before invoking the command:

1. Build the controller and runtime images from one reviewed source commit.
   Require passing checks for that exact commit and immutable registry digests.
   Keep the build receipts and full source SHA.
2. Review compatibility across OCC, gateway, Harness, configured plugins, and
   model providers. The command cannot infer compatibility from image names.
3. Back up PostgreSQL and Agent volumes when your recovery plan requires data
   restoration. PVC identifiers and file hashes prove continuity; they are not
   backups.
4. Review every saved Agent and Configuration draft. Coordinated deployment
   snapshots the current drafts, not each Agent's prior active revision.
5. Provision capacity for the old and candidate Agent revisions to overlap.
   The command submits the complete baseline fleet before waiting for any
   individual deployment.
6. Establish the same protected API access used for normal production Agent
   operations. The service identity must have Installation `administer`, exact
   `read` access to every Namespace and Agent, exact `deploy` access to every
   eligible running Agent, and exact-revision read access. The
   `occ installation deployment-inventory` operation fails instead of returning
   a partial fleet when any required authorization is missing.

Run from the checkout containing the reviewed chart. Keep the protected Helm
values, Installation YAML, kubeconfig, and service key in owner-only files. The
optional public CA bundle must be a regular file, not a symbolic link. The
evidence directory must not exist yet; the command creates
it with mode `0700` and stores inventory and rollout results there. Refresh the
protected Helm values and Installation YAML from their live owners before the
upgrade. The command rejects any live/protected difference outside the
controller and runtime image fields before it mutates the cluster. The live
Installation startup Secret must carry the `openclaw.dev/installation-id`
annotation created during production installation.

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

Confirm no other operator is changing the Helm release, Installation startup
Secret, protected inputs, or Agent drafts. Resolve any initial Agent deployment
that is still running. The command rejects queued or claimed deployment work and
a running Agent without an active revision instead of guessing whether either
belongs in the baseline.

### Bootstrap the inventory API once

Skip this section when
`occ installation deployment-inventory --output json` already succeeds. If the
current controller returns `404`, it predates the complete-inventory operation
and cannot safely admit a fleet upgrade.

For first adoption, save the current protected values and Helm evidence. Change
only `images.controller` in the protected Helm values to `$CONTROLLER_IMAGE`.
Leave the Installation startup Secret and both runtime image selections
unchanged:

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
  --values /secure/occ/values.yaml --wait --timeout 5m \
  > "$CONTROLLER_BOOTSTRAP_EVIDENCE/helm-upgrade.txt"
```

Verify the API and worker use the candidate controller digest. Then verify OCC
authentication and the complete inventory:

```bash
occ installation deployment-inventory --output json \
  > "$CONTROLLER_BOOTSTRAP_EVIDENCE/deployment-inventory.json"
```

Do not continue if this operation fails. Preserve the controller-only bootstrap
evidence separately, then run the coordinated command below with the same
controller digest and its companion runtime digest. The command accepts an
already-selected controller digest; at least one runtime image slot must still
change. This prerequisite does not modify the Installation startup Secret or
redeploy Agents.

## Run the coordinated upgrade

Invoke the command with explicit cluster and input ownership:

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

Before mutation, the command saves the complete deployment inventory returned by
OCC under `inventory/deployment-inventory.json`. It checks the Installation ID,
rejects nonterminal Agent deployment work, and selects every active Agent that
desires `running`, has an active revision, and belongs to a ready Namespace.
It also compares canonical protected inputs with the live Helm release and
Installation Secret after removing only the image fields that this command
owns. The authenticated OCC Installation ID must equal the live Secret's
`openclaw.dev/installation-id` annotation. Any mismatch fails before rendering
or mutation, preventing one cluster from being upgraded while another OCC
Installation receives the Agent deployments.

The command performs these mutations only after that inventory, candidate
rendering, and Helm server-side dry run succeed:

1. It writes the candidate controller digest into the protected Helm values and
   the runtime digest into both Kubernetes Compute image slots. Original bytes
   remain in the private evidence directory.
2. It replaces `occ-installation-startup` from the protected Installation file.
3. It runs `helm upgrade --install --wait`. The changed controller digest
   replaces the API and worker; Helm initialization owns migration and bootstrap
   checks.
4. After both Deployments use the candidate controller and OCC authentication
   recovers, it concurrently submits the bodyless deployment operation for all
   baseline running Agents.
5. It waits for every returned revision's durable deployment status, confirms
   each Agent selected that revision, and waits for the revision Pods to report
   `Running` and `Ready`. Their gateway and Agent containers must use the
   candidate runtime digest.

Stopped and deleting Agents remain untouched. The command succeeds only after
every baseline running Agent reaches the new revision. It does not send a model
request, post a channel message, or prove external provider behavior.

## Verify the release

Retain the evidence directory privately. Review at least:

- `before-live-values.yaml`, `before-live-installation.yaml`, and the candidate
  inputs for the intended image-only change;
- `before-workloads.json` and `after-workloads.json` for persistent volume and
  untargeted workload continuity;
- `deployments.jsonl` and `status/` for one successful new revision per baseline
  Agent; and
- the final Helm status plus live API and worker images.

Then run the [production workload verification](production-agents.md#verify-production-workloads)
for every execution mode and model/provider represented by the fleet. Require a
fresh harmless model response and the relevant channel, credential-delivery,
workspace, and native UI checks. Script success is deployment evidence, not a
model or data-restore proof.

## Recover from partial failure

The workflow is coordinated but not transactional. If Helm succeeds and one or
more Agent deployments fail, keep the healthy control plane on the candidate
release, preserve all evidence, and diagnose the exact failed deployment. Do
not resubmit an unknown deployment response until revision history establishes
whether OCC admitted it; another accepted request creates another revision.

Prefer a reviewed forward fix. For image rollback, first verify that the prior
controller and runtime can read state written by the candidate. Restore the
saved image selections to the protected inputs, replace the Installation Secret,
run the same Helm upgrade, and explicitly deploy the affected running Agents
again. Restoring only Helm values does not replace tenant workloads. Helm
rollback does not undo database migrations or runtime data changes.

Never delete Agents, revisions, PVCs, or the bootstrap volume to make recovery
appear successful. If the prior release cannot read the new state, stop and
prepare a forward repair or coordinated data restore.

## Current limits

- V1 has no canary, batch size, automatic compatibility check, or automatic
  rollback.
- The first release needs the one-time controller-only inventory API bootstrap
  above. Later releases begin directly with the coordinated command.
- All baseline Agent requests are submitted concurrently. Large fleets must
  prove cluster, database, and worker capacity before using this version.
- Deployment uses current drafts. Exact active-revision restart is not yet a
  supported operation.
- The command requires one runtime image for gateway and Agent containers.
- Real completion still requires the manual runtime and model checks above.

See the [coordinated upgrade flow](../../flows/coordinated-production-upgrade.md)
for source ownership and failure boundaries.
