# Troubleshoot the platform

Use this page when the Kubernetes installation, control plane, or several Agents
are affected. For a problem with one Agent, start with
[Agent troubleshooting](../topics/agent-troubleshoot.md). For a
failure before local Kubernetes starts, use [Local Setup](../quickstart.md).

Run production commands from an operator shell with Helm and `kubectl`, read
access to the `openclaw-system` namespace, and `KUBECONFIG_FILE` and `CONTEXT`
set to the affected cluster. The examples use the default release `oce`; replace
it if you installed with another name.

## The Helm installation did not complete

Start with the release and the initialization Job:

```bash
HELM_RELEASE=oce
helm status "$HELM_RELEASE" --namespace openclaw-system \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  get jobs,pods,pvc
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  describe job "$HELM_RELEASE-initialization"
```

If the Job started, inspect the failing container:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  logs "job/$HELM_RELEASE-initialization" -c migration
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  logs "job/$HELM_RELEASE-initialization" -c bootstrap
```

Migration runs before bootstrap; an unstarted bootstrap container has no logs.
For image, scheduling, or volume errors, use the Pod events reported by
`kubectl describe pod <pod-name>` with the same context and namespace. Fix the
specific image, scheduling, or storage error. For a bootstrap failure, follow
[bootstrap recovery](../../reference/authentication/service-api-keys.md#recover-an-incomplete-bootstrap)
before retrying; do not delete the database or credential volume to force a
rerun. The recovery check is a successful authenticated `occ installation get`,
not only a completed Job.

## The control plane is unavailable or Namespaces do not become ready

Check the API and worker separately:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  get deployment openclaw-enterprise-api openclaw-enterprise-worker
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  logs deployment/openclaw-enterprise-api --tail=100
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  logs deployment/openclaw-enterprise-worker --tail=100
```

If a Deployment has no available replicas, inspect its Pods and their events.
If the API is available but a newly created Namespace stays unready, check the
worker logs and the [tenant RoleBindings](../deploy/production-agents.md#grant-tenant-rolebindings).
After fixing the cause, repeat `occ installation get` and confirm the Namespace
reports `ready` before creating an Agent there. A healthy control plane does
not prove an Agent has deployed or can run a model.

## An Agent's Gateway or Harness Pod stays unready

Run `kubectl describe pod <pod-name>` in the Agent's tenant namespace. Each
`Readiness probe failed:` event names the step that is not ready, such as
`plugin runtime phase is starting` or `Gateway /readyz unavailable: ECONNREFUSED`.
When the startup wrapper holds a failed check, the event adds it, for example
`; startup check model-probe failed with AUTHENTICATION_FAILED`. See
[Harness authentication](../../reference/harness-execution.md#harness-authentication)
for the probe codes.

## Authentication fails after installation

Use the intended credential: `occ installation get` uses the protected service
key; the browser console uses a human administrator sign-in. Check `OCC_URL`
against the installation's approved HTTPS origin and confirm
`OCC_SERVICE_KEY_FILE` points to the intended key. For a missing or exposed key,
follow [service-key recovery](../../reference/authentication/service-api-keys.md#recover-a-lost-or-exposed-service-key).
Repeat the failed operation after recovery; do not copy tokens or key-file
contents into an incident report.

## Agent workspace files are unavailable

A `503 DEPENDENCY_UNAVAILABLE` can mean routing is not configured or the
proxy or gateway is unavailable. Start with the Gateway, certificate, security
policy, and tenant `HTTPRoute` in [workspace-routing verification](../deploy/workspace-routing.md#verify-routing-and-file-access).
After fixing the failed resource, repeat the original OCC file request. A
`404 NOT_FOUND` on an otherwise working route means that specific file is
missing; do not create or overwrite it just to clear the console message.

For missing exported logs, use [observability troubleshooting](../observability.md#troubleshooting).
When escalating, record the release, cluster context, affected Namespace IDs,
failure timestamps, exact error code, and relevant redacted events. Keep service
keys and raw Secret values out of the report.
