# Record the pre-upgrade baseline

Record the starting state of a production installation before you run the
[production image upgrade](production-upgrade.md). The
[upgrade checklist](upgrade-checklist.md#record-the-starting-state) lists what to
record; this page gives commands for the Helm, Kubernetes, OCC and PostgreSQL
items. The upgrade helper keeps its own evidence of the release it changes. This
baseline is what you compare against after the upgrade and use if you must
restore.

## Set the inputs

Use the protected files and OCC connection from the
[upgrade preparation](production-upgrade.md#prepare-the-release), the OCC CLI you
will pass to the helper, and the `occ_migrator` database URL, which owns the
`occ` and `drizzle` schemas. Keep every output private: the dump contains all
control-plane data.

```bash
set -euo pipefail
umask 077
export BASELINE="/secure/occ/upgrades/baseline-$(date -u +%Y%m%dT%H%M%SZ)"
export OCC_MIGRATION_DATABASE_URL='postgresql://occ_migrator:<password>@<postgres-host>:5432/<database>'
mkdir "$BASELINE"
k() { kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' "$@"; }
h() { helm --kubeconfig /secure/occ/kubeconfig --kube-context '<reviewed-context>' \
  --namespace openclaw-system "$@"; }
occ() { /secure/occ/bin/occ --output json "$@"; }
```

## Record the release and its configuration

The helper refuses to run when the protected files differ from live state, so
compare them now:

```bash
h history oce >"$BASELINE/helm-history.txt"
h get values oce --output yaml >"$BASELINE/live-values.yaml"
diff <(yq -o=json . /secure/occ/values.yaml | jq -S .) <(yq -o=json . "$BASELINE/live-values.yaml" | jq -S .)
OCC_INSTALLATION_SECRET="$(yq -er '.installation.secretName // "occ-installation-startup"' /secure/occ/values.yaml)"
OCC_INSTALLATION_KEY="$(yq -er '.installation.key // "installation.yaml"' /secure/occ/values.yaml)"
k -n openclaw-system get secret "$OCC_INSTALLATION_SECRET" -o json |
  jq -j --arg key "$OCC_INSTALLATION_KEY" '.data[$key] | @base64d' >"$BASELINE/live-installation.yaml"
diff /secure/occ/installation.yaml "$BASELINE/live-installation.yaml"
```

Both `diff` commands must print nothing. Resolve any difference before the
upgrade.

## Record images and Kubernetes state

```bash
k get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{range .status.containerStatuses[*]} {.name}={.imageID}{end}{"\n"}{end}' \
  >"$BASELINE/pod-images.txt"
k get namespaces --show-labels >"$BASELINE/namespaces.txt"
k get rolebindings -A -o wide >"$BASELINE/rolebindings.txt"
k get networkpolicies -A -o yaml >"$BASELINE/networkpolicies.yaml"
k get services -A -o wide >"$BASELINE/services.txt"
k get httproutes -A -o yaml >"$BASELINE/httproutes.yaml" # with private Agent routing
k get pvc -A -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,UID:.metadata.uid,VOLUME:.spec.volumeName,MODES:.spec.accessModes' \
  >"$BASELINE/pvcs.txt"
```

`pod-images.txt` records the digest each container actually runs, which the
configured image reference alone does not prove. The PVC UIDs must be unchanged
after the upgrade: a new UID means the volume and its Agent data were replaced.

## Record the OCC inventory

```bash
occ installation get >"$BASELINE/installation.json"
occ installation deployment-inventory >"$BASELINE/deployment-inventory.json"
occ namespace list >"$BASELINE/namespaces.json"
```

The deployment inventory lists every Namespace, Agent, desired state and active
revision. A release whose controller predates `deployment-inventory` cannot
answer it; record `occ agent list` for each Namespace instead.

## Record the database

```bash
psql "$OCC_MIGRATION_DATABASE_URL" -At \
  -c 'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id' \
  >"$BASELINE/migrations.txt"
pg_dump --format=custom --file "$BASELINE/openclaw_enterprise.pgdump" "$OCC_MIGRATION_DATABASE_URL"
pg_restore --list "$BASELINE/openclaw_enterprise.pgdump" >/dev/null
```

`migrations.txt` holds the migration receipts. `pg_restore --list` proves the
dump is readable, not that it restores; follow your database's backup and
restore procedure when the release has migrations that may need data restored.
Use a `pg_dump` at least as new as the server.

## Record Agent data

For each Agent whose data you must keep, record a file hash and the file count
in its workspace. This example uses a dedicated Codex Agent's Harness Pod, with
`TENANT_NAMESPACE` and `AGENT_ID` from the
[production Agent guide](production-agents.md):

```bash
HARNESS_POD=$(k -n "$TENANT_NAMESPACE" get pods \
  -l "openclaw.dev/agent=$AGENT_ID,openclaw.dev/workload-role=agent" \
  -o jsonpath='{.items[0].metadata.name}')
k -n "$TENANT_NAMESPACE" exec "$HARNESS_POD" -c agent -- \
  sh -c 'sha256sum /home/node/workspace/AGENTS.md; ls /home/node/workspace | wc -l' \
  >>"$BASELINE/workspace-$AGENT_ID.txt"
```

For an embedded Agent, use its gateway Pod, container `gateway`, and its
workspace path. If
the dedicated Codex seccomp profile is in use, also record its file hash on
every eligible node, as the [Codex sandbox procedure](codex-sandbox.md) shows.

## Compare after the upgrade

Rerun the same commands into a new directory and compare. Expect new image
digests, Helm revisions and, after a runtime release, new active revision IDs.
Investigate any other change, in particular a changed PVC UID, a missing
migration receipt, a changed NetworkPolicy or RoleBinding, or a different
workspace hash.

The checklist's authentication, credential, repository and CredentialSource
items have no single command; record them as that page describes.
