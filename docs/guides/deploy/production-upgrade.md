# Upgrade production images

Use `scripts/upgrade-production-images` to release the OpenClaw Control Plane
(OCC), Agent runtimes, or both. Select only the image you intend to change:

- `--controller-image` updates the OCC API and worker without requesting Agent
  deployments. A restarted repository broker can interrupt existing revisions.
- `--runtime-image` keeps the current controller image, updates the gateway and
  Agent runtime image, and deploys a new revision for every running Agent.
- Supplying both performs the two changes together.

Every release stops the OCC API and worker during migration and rollout. Runtime
upgrades also restart the fleet concurrently. Schedule an interruption window
and provide enough capacity for old and replacement revisions to overlap.
Before either kind of release, complete the
[upgrade migration checklist](upgrade-checklist.md) so persisted control-plane,
Driver, runtime, and cluster-owned state has an explicit disposition.

To release reviewed settings with an image, pass separate candidate values
and Installation files as described below. The baseline files must match live
state, including image fields. The command rejects unexpected drift rather than
incorporating it into a release.

The command supports the production Helm and Kubernetes Compute path. It does
not build images, create backups, provision infrastructure, or prove model and
external integration behavior.

## Prepare the release

Prepare:

- each selected image as an immutable `@sha256:` digest with passing checks and
  a reviewed source commit;
- the production kubeconfig, Helm values, Installation YAML, OCC service key,
  and optional CA bundle in protected files;
- a PostgreSQL backup before a controller release whose migrations may require
  data restoration; and
- Agent-volume backups before a runtime release whose recovery may require
  restoring runtime data.

The OCC identity needs Installation `read`. A runtime upgrade additionally needs
Installation `administer`, exact `read` access to every Namespace, Agent, and
active Agent revision, plus exact `deploy` access to every running Agent.
Revision read access must also cover the replacement revisions.

Review saved Agent and Configuration drafts before a runtime upgrade. Each
deployment snapshots the current draft, not the previous active revision.

If the worker has an enabled repository broker, its replacement also restarts
the broker and loses in-memory sessions. Before either image release, identify
running Agents with delivered repository sessions, plan their interruption, and
review their current drafts and exact-resource deploy grants. Prepare authorized
replacement revisions for affected Agents; stop if recovery cannot be performed
safely. A controller-only release does not request those deployments for you.

Stop other Helm changes until the command completes. Disable autoscalers and
other automation that can restart or scale the OCC Deployments. Stop any other
process that writes to the OCC database, including independent API, worker, or
maintenance processes. Confirm nodes are reachable and do not force-delete OCC
Pods: a missing Pod alone cannot prove a partitioned process stopped. The helper
stops the selected Helm release's API and worker and waits for their Pods to
terminate; it cannot stop or detect other database writers. For a runtime upgrade,
also stop Agent deployments and draft edits, and resolve queued or running Agent
deployments first. Keep these restrictions in place through recovery.

Set the shared inputs:

```bash
umask 077
export OCC_URL='https://<internal-occ-host>'
export OCC_SERVICE_KEY_FILE='/secure/occ/operator-service-key.json'
export OCC_CA_BUNDLE='/secure/occ/occ-ca.pem'
export RELEASE_SOURCE_SHA='<full-40-character-git-sha>'
export UPGRADE_EVIDENCE="/secure/occ/upgrades/$(date -u +%Y%m%dT%H%M%SZ)"
```

The evidence directory must not exist. The command creates it with mode `0700`.

### Include reviewed settings

Keep `--values` and `--installation` as the current live baseline. For desired
configuration changes, make separate owner-only copies and review the complete
diff against that baseline:

```bash
cp /secure/occ/values.yaml /secure/occ/candidate-values.yaml
cp /secure/occ/installation.yaml /secure/occ/candidate-installation.yaml
chmod 600 /secure/occ/candidate-values.yaml /secure/occ/candidate-installation.yaml
```

Edit only the intended settings in these copies, such as the
[Slack directory proxy](../integrations/slack.md#configure-both-slack-proxies)
and [curated PluginDriver](../../reference/drivers/plugin-bundled.md#selection-and-catalogs).
Review compatibility with the selected images and existing Agent drafts and
credentials before the maintenance window. Rendering and the Helm dry run do
not validate the Installation's Driver configuration or prove external access.
The command does not change IAM, authentication, Installation identity, database,
bootstrap, native administration, or repository broker settings through these
candidate files. Select controller and runtime images with their image flags;
do not edit those image fields or the managed Installation checksum in the copies.

Add either or both flags to any upgrade command below:

```text
--candidate-values /secure/occ/candidate-values.yaml
--candidate-installation /secure/occ/candidate-installation.yaml
```

The helper saves the reviewed inputs in its private evidence, applies the image
selections and preserved broker endpoint, and writes the final candidate to the
baseline paths during the upgrade. An Installation change also updates its
Secret and restarts OCC with the new checksum. A controller-only release still
does not deploy Agents; plan any Agent changes separately. Keep candidate files
unchanged and available at the same paths for recovery.

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

## Upgrade the control plane

Set the controller image and run the command without `--runtime-image`:

```bash
export CONTROLLER_IMAGE='<registry>/controller@sha256:<64-hex-digest>'

scripts/upgrade-production-images \
  --kubeconfig /secure/occ/kubeconfig \
  --context '<reviewed-context>' \
  --namespace openclaw-system \
  --release oce \
  --values /secure/occ/values.yaml \
  --installation /secure/occ/installation.yaml \
  --controller-image "$CONTROLLER_IMAGE" \
  --source-revision "$RELEASE_SOURCE_SHA" \
  --evidence-dir "$UPGRADE_EVIDENCE" \
  --occ /secure/occ/bin/occ
```

The command verifies the selected cluster and OCC Installation and checks that
protected files match live state. When repository credentials are enabled, it
reads the running worker's broker origin and carries its Service name and exact
hostname into the candidate values. It rejects a mismatch with explicit Helm
settings. Keep the protected values equal to live values; do not add the hostname
manually before running the helper. It then renders the chart and performs a
server-side dry run.

The command applies reviewed candidate settings, changes `images.controller`,
persists the preserved broker endpoint when enabled, scales the API and worker to zero, and waits for their Pods to
terminate. It then runs Helm, waits for the API and worker, verifies their image,
and confirms OCC authentication recovers. Helm restores the candidate
Deployments after its initialization hooks succeed.

Helm runs the candidate controller's database migration init container with the
migration role, then runs bootstrap. The API and worker do not roll out unless
both hooks succeed. The command does not request fleet inventory or Agent
deployment authority. After a broker restart, a lost session already delivered to
an Agent fails its revision and queues runtime retirement. Inspect retained
cleanup obligations and explicitly deploy an authorized replacement revision
for each affected Agent. The replacement snapshots the current draft; it does
not settle old cleanup or replay repository operations. Follow the
[broker recovery procedure](../repository-credentials/installation.md#install-and-verify).

For the first release that introduces `occ installation deployment-inventory`,
verify that operation after the controller upgrade before attempting a runtime
upgrade.

Success looks like:

```text
Upgraded controller image; no Agent deployments were requested.
```

This result confirms the helper's rollout, not recovery of repository-bound
Agents. Verify those Agents and their required repository operations separately.

## Upgrade Agent runtimes

Set the runtime image and run the command without `--controller-image`:

```bash
export RUNTIME_IMAGE='<registry>/runtime@sha256:<64-hex-digest>'

scripts/upgrade-production-images \
  --kubeconfig /secure/occ/kubeconfig \
  --context '<reviewed-context>' \
  --namespace openclaw-system \
  --release oce \
  --values /secure/occ/values.yaml \
  --installation /secure/occ/installation.yaml \
  --runtime-image "$RUNTIME_IMAGE" \
  --source-revision "$RELEASE_SOURCE_SHA" \
  --evidence-dir "$UPGRADE_EVIDENCE" \
  --occ /secure/occ/bin/occ
```

Before mutation, the command requires a complete authorized inventory with no
deployment in progress. Every running Agent must have a readable active revision
in a ready Namespace.

The command writes the runtime digest to both Kubernetes Compute image fields,
updates the Installation Secret after quiescing OCC, and runs Helm with the
current controller image.
The Installation checksum restarts the API and worker so they load the new
configuration; their software version does not change.

After OCC recovers, the command deploys every recorded running Agent, waits for
durable success, confirms each new active revision, and requires its Pods to be
`Running` and `Ready` on the requested runtime digest. Stopped and deleting
Agents remain untouched. An empty fleet updates the saved runtime selection but
does not prove that the image starts.

OpenClaw runs startup-safe migrations and plugin convergence before each gateway
becomes ready. This workflow replaces immutable images instead of running
`openclaw update`, so the command then runs
`openclaw doctor --lint --json --severity-min error` inside every replacement
gateway. Doctor is read-only here; a reported error fails the upgrade and is
saved under `status/*.doctor.*`. The command never runs `doctor --fix` across
the fleet.

Success looks like:

```text
Upgraded runtime image; controller image remained unchanged and <count> running Agents selected new revisions.
```

To intentionally release both images together, pass both image options. The
command applies the controller and runtime changes in one Helm release before
deploying the recorded fleet.

## Verify the release

Keep the evidence directory private. For every release, inspect the before/live
configuration, rendered chart, server dry run, Helm status, and final API and
worker images.

For a controller-only release, confirm unaffected gateways remain ready and
verify any repository-bound Agents that required replacement revisions. For a runtime release, inspect
`deployments.jsonl`, `status/*.doctor.json`, and the before/after workload
inventories. Then follow
[Verify production workloads](production-agents.md#verify-production-workloads)
for every execution mode and provider used by the fleet. Require a fresh model
response and check relevant channels, credentials, workspace data, and native UI
access. Doctor lint proves that OpenClaw found no error-level diagnostic; it does
not prove those application paths.

## Recover from a partial failure

Keep the original private evidence directory and the maintenance restrictions.
Do not start a fresh upgrade to recover an interrupted one: its frozen Agent
inventory and dispatch records are needed to avoid duplicate deployments. If
preparation did not finish, the helper stopped before mutation; use a new
evidence directory after resolving the failure. Otherwise, repeat the original
command with the same arguments, protected file paths, kubeconfig contents,
OCC URL, script, and chart, adding `--resume`. Include the original candidate
flags and keep their files semantically unchanged. The helper uses the recorded
candidate, reads the live Secret and Helm release, accepts only the recorded
baseline or candidate, and continues the recorded fleet. It rejects unrelated drift. The evidence includes
Secret contents and must remain private.

If a killed process leaves `.upgrade-lock`, first establish that no helper or
its child commands are still running, then remove that empty directory and
resume. This lock covers only processes sharing this evidence directory; it
cannot stop other operators or automation.

A Helm failure or disconnected response does not prove that the migration
rolled back. Read the current Helm status and history, inspect the initialization
Job and its Pods and logs, and inspect the retained database. The saved
`current-helm-status.json` is the last read and can predate the failed request.
A `pending-*` Helm release must be resolved separately before the helper can
continue. Do not start the old API or worker against a migrated database. If the
candidate Helm revision is deployed, the helper reads it back and continues
without rerunning Helm. Otherwise, wait
until the initialization Job and its Pods are terminal, then run the **candidate controller
image** with `node scripts/migrate-production.mjs --check` against the same
retained database, using its dedicated migrator credential and required database
CA in an authorized environment. Keep its exit-zero `migration.checked` output in
private evidence. Follow [migration history](../../reference/settings/operations.md#migration-history)
to interpret unsupported or uncertain state. Only after this check and review of
the Job outcome, repeat the command with `--resume --migration-history-checked`.
That flag records your attestation; it does not run the database check. The
helper keeps or returns OCC to zero replicas before retrying the candidate Helm
release. Prefer a reviewed forward fix; neither Helm rollback nor the helper
reverses committed migrations.

For an unknown Agent dispatch, the helper saves an Agent readback and stops
without replaying it. Inspect the exact Agent's authorized revision history,
deployment status, and audit records, and allow any in-flight request to finish.
An unchanged active revision alone does not prove rejection, and a filtered
revision list does not prove absence. If you can identify the accepted revision,
record a private `dispatch/<same-prefix-as-intent>.json` containing its `id`;
the helper checks that exact deployment's status on resume. If evidence proves
the request was not accepted, deploy that Agent once with the ordinary OCC CLI
and save its successful JSON response under that name. Preserve the `.intent`,
error, and readback evidence. If the result is still uncertain, stop and
investigate rather than submitting another request. For a known failed revision,
inspect its failure and explicitly deploy an authorized replacement before
recording that replacement's response; preserve the original response separately.
Each deployment snapshots current drafts.

For an accepted revision, set `OCC_NAMESPACE` and `OCC_AGENT` to the exact
Agent IDs, `DISPATCH_PREFIX` to the matching evidence path without `.intent` or
`.json`, and `REVISION_ID` to the independently confirmed revision. Verify the exact Agent and deployment before recording it:

```bash
if occ --output json --namespace "$OCC_NAMESPACE" agent deployment-status "$OCC_AGENT" "$REVISION_ID" > "$DISPATCH_PREFIX.confirmed-status.json" &&
  jq -e --arg namespace "$OCC_NAMESPACE" --arg agent "$OCC_AGENT" --arg revision "$REVISION_ID" \
    '.namespaceId == $namespace and .agentId == $agent and .deploymentId == $revision' "$DISPATCH_PREFIX.confirmed-status.json" &&
  test ! -e "$DISPATCH_PREFIX.json" &&
  jq -n --arg id "$REVISION_ID" '{id: $id}' > "$DISPATCH_PREFIX.json.tmp"; then
  mv "$DISPATCH_PREFIX.json.tmp" "$DISPATCH_PREFIX.json"
else
  printf '%s\n' 'Deployment could not be confirmed; do not resume.' >&2
fi
```

Keep the shell's `umask 077`. If the status read is denied or does not identify
the confirmed deployment, do not create the response file. The helper rechecks
its status on resume; it does not verify how you identified an accepted request.

Before selecting an older controller or runtime image, verify it can read all
state written by the candidate and restore compatible data if required. Never
delete Agents, revisions, PVCs, or the bootstrap volume to force recovery.

## Current limits

- No canary, batching, automatic compatibility check, automatic rollback, or
  cluster-wide upgrade lock.
- Runtime upgrades start all recorded Agent deployments concurrently.
- Agent deployments use current drafts rather than recreating active revisions.
- One runtime image is used for both gateway and Agent containers.
- Model, channel, provider, native-access, and restore checks remain manual.

See the [production image upgrade flow](../../flows/coordinated-production-upgrade.md)
for implementation details and failure boundaries.
