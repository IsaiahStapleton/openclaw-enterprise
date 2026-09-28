# Maintain sign-in with the API stopped

Use `pnpm auth:maintain` when GitHub sign-in needs a change the online API
cannot make: the recovery administrator is locked out, an account was never
enrolled, sessions must be ended at once, or the Installation must return to
password-only sign-in. The command ships in the controller image and connects
with the migration credential, never the application credential.

The [authentication reference](../../reference/authentication.md#session-and-recovery-controls)
owns the profile's rules; this page is the operator procedure.

## Choose the operation

| Command                                                            | Use it when                                                                                                                                                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                                           | Read the profile (`legacy` or `guarded`), recovery designation, enrolled, disabled, and unenrolled accounts, session counts, GitHub methods, and other connected clients. Changes nothing.         |
| `activate --recovery-user <userId> --writers-stopped`              | Activate GitHub sign-in before the new API starts. Same checks as startup activation: the recovery account needs a password, its Principal, and Installation `administer`.                         |
| `enrol <userId> --writers-stopped`                                 | An account exists but is not enrolled (for example, an older controller created it after activation). Requires the account's Principal and exactly one password; the account's sessions are ended. |
| `reset-recovery-password --password-file <path> --writers-stopped` | The recovery administrator lost the password. Reads the new password (12 to 128 characters; one trailing newline is ignored) and ends the recovery account's sessions.                             |
| `purge-sessions [--user <userId>] --writers-stopped`               | End every session, or one account's sessions. Service keys are not affected.                                                                                                                       |
| `deactivate [--purge-disabled] --writers-stopped`                  | Return to password-only sign-in. See [Deactivate](#deactivate-github-sign-in).                                                                                                                     |

Every change writes an audit event attributed to `maintenance:<database role>`.
The command prints one JSON line and exits with:

| Exit | Meaning                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------- |
| `0`  | Done.                                                                                                            |
| `2`  | Another client is connected to the database. Nothing changed; the output lists the backends.                     |
| `3`  | A precondition refused the operation (`reason` in the output, for example `DISABLED_ACCOUNTS`). Nothing changed. |
| `1`  | Configuration, credential, or database failure.                                                                  |
| `64` | Invalid arguments.                                                                                               |

## Stop every writer

`--writers-stopped` is checked, not trusted. Inside its transaction the command
takes the activation lock and refuses while any other client is connected to
the database, then checks again before committing. Stop the API and the worker,
and close any `psql` or monitoring session on this database:

```bash
kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
  --namespace openclaw-system scale deployment/openclaw-enterprise-api \
  deployment/openclaw-enterprise-worker --replicas=0
kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
  --namespace openclaw-system wait --for=delete pod \
  -l 'app.kubernetes.io/component in (api,worker)' --timeout=5m
```

Close ingress first so users see a maintenance response rather than errors, and
pause anything that would scale the Deployments back up.

## Run the command

Run it from the installed controller image as a one-off Pod. The labels and
service account reuse the initialization Job's database egress policy; the
Secret is the chart's `occ-database` with its `migration-url` key. When
`database.caSecretName` is set, mount that CA as the chart's Job does.

```bash
export CONTROLLER_IMAGE='<registry>/controller@sha256:<64-hex-digest>'
kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
  --namespace openclaw-system run occ-auth-maintain --rm -i --restart=Never \
  --image "$CONTROLLER_IMAGE" \
  --labels 'app.kubernetes.io/name=openclaw-enterprise,app.kubernetes.io/instance=oce,app.kubernetes.io/component=initialization' \
  --overrides '{"spec":{"serviceAccountName":"openclaw-enterprise-initialization","automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":1000,"runAsGroup":1000,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"occ-auth-maintain","image":"'"$CONTROLLER_IMAGE"'","args":["scripts/auth-maintain.mjs","status"],"env":[{"name":"NODE_ENV","value":"production"},{"name":"OCC_MIGRATION_DATABASE_URL","valueFrom":{"secretKeyRef":{"name":"occ-database","key":"migration-url"}}}],"securityContext":{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"capabilities":{"drop":["ALL"]}}}]}}'
```

Replace `"status"` with the operation's arguments, for example
`"deactivate","--writers-stopped"`. The Pod's own connection is excluded from
the check; `kubectl run --rm` removes it afterwards.

For `reset-recovery-password`, put the new password in a Secret, mount it
read-only in the Pod, and pass the mounted path with `--password-file`. Delete
the Secret after verifying sign-in. The password never appears in arguments,
output, or audit.

After a change, run `status`, scale the worker and API back to one replica,
verify sign-in through restricted access, and reopen ingress.

## Deactivate GitHub sign-in

Deactivation returns the Installation to the legacy password profile and
requires the API to be stopped. In one transaction it removes the recovery
designation, enrolment, session bindings, pending GitHub attempts, and every
session. Linked GitHub identities stay in the database but are unused.

The legacy profile ignores account disablement, so `deactivate` refuses while any
account is disabled and lists their IDs. `--purge-disabled` removes those
accounts' passwords instead, so they still cannot sign in.

Before scaling the API back up, remove the GitHub configuration
(`OCC_AUTH_GITHUB_CLIENT_ID`, `OCC_AUTH_GITHUB_CLIENT_SECRET`, and
`OCC_AUTH_GITHUB_RECOVERY_USER_ID`) from its values. With them still set,
startup activates the profile again.
