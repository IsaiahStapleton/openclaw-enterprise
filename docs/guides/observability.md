# Configure platform observability

Configure operational log levels, export reviewed logs to your backend, and
check the collection pipeline. This guide is for operators of OpenClaw Control
Center (OCC) and its managed gateway and Codex workloads. Run commands from the
repository root.

| Signal                                     | Available path                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Operational logs                           | Local container output; optional OpenTelemetry Collector export over OTLP/HTTP to your log backend. |
| Collector metrics                          | Prometheus endpoint on port `8888` for the collection pipeline itself.                              |
| Audit records                              | Separate PostgreSQL-backed audit persistence; this Collector does not export audit records.         |
| Application metrics and distributed traces | This configuration does not install an application metrics or trace pipeline.                       |

The Collector exports fixed operational event names and reviewed scalar fields.
It excludes arbitrary runtime message text, prompts, responses, and Codex
protocol stdout. Enabling `debug` does not widen that export policy. See the
[security boundary](../reference/security.md#operational-log-collection-boundary).

## Requirements

- A working [development stack](deploy.md#development), or the protected YAML
  inputs and namespace from [production setup](deploy.md#configure-the-installation).
- An OTLP/HTTP Logs receiver you operate, including its full `/v1/logs` endpoint,
  authentication requirements, and trusted TLS certificate chain. The bundled
  Collector does not include a storage backend or log viewer.
- For Docker: Docker Compose and an endpoint reachable from the Collector
  container. The Docker Engine must also reach the Fluent Forward receiver.
- For Kubernetes: Helm, `kubectl`, `yq` v4, an explicit kubeconfig/context,
  enforcing NetworkPolicies, and permission to install the Collector DaemonSet,
  its Pod-read ClusterRole, and dedicated Secrets.

## Steps

### 1. Choose the log level

Set the shared level in the startup YAML:

```yaml
logging:
  level: info
```

Use `debug`, `info`, `warn`, or `error`; omission defaults to `info`. For the
Docker logging override, edit [`deploy/logging/occ.yaml`](../../deploy/logging/occ.yaml).
For production, edit the protected Installation YAML and update its mounted
startup Secret through your deployment process. This is separate from Helm's
`logging.collector` values.

Restart the API and worker after a level change; migration and bootstrap read
it on their next execution. Existing AgentRevisions retain their admitted level.
Deploy an Agent again to apply the new level to its gateway or Codex runtime.
The [settings reference](../reference/configuration.md#installation-startup-configuration)
owns the accepted startup configuration.

### 2. Configure the exporter

Use [`deploy/logging/exporter.yaml`](../../deploy/logging/exporter.yaml) as the
native Collector exporter configuration. It reads `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
and configures a finite queue and retry window. Use HTTPS with verified server
identity for real backends; plain HTTP is only for a local test receiver.

If your backend requires authentication or a custom CA, prepare a protected copy
of `exporter.yaml` with the backend's native Collector header/TLS configuration.
Keep credentials in Collector-only Secrets or protected mounted files. If you
reference additional environment variables, explicitly supply them to the
Collector: the Docker override forwards only the endpoint by default, while
Helm loads its dedicated exporter environment Secret. Additional file mounts require deployment configuration too; the bundled Helm
template projects only its three named configuration files and has no extra-mount
value. Do not reference an unmounted CA file.

Keep the exporter named `otlp_http`, or update the receiver pipeline's exporter
reference too. Preserve the shared filtering policy and bounded queue/retry
settings. Do not put exporter credentials in Installation YAML, Agent
Configurations, SecretBindings, lifecycle hooks, or runtime images.

### 3. Enable collection for your deployment

#### Docker Compose

Start your receiver first. For a local receiver reachable through Docker's host
alias, run:

```bash
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT='http://host.docker.internal:4318/v1/logs'
./scripts/dev-up -- -f compose.yaml -f compose.logging.yaml
```

Use a same-network DNS name if the receiver is another container. If you prepared
a custom exporter file, add a private Compose override mounting it at
`/etc/otel/exporter.yaml` in the `collector` service and pass that override last.

The override routes OCC and newly created managed runtime containers through
Docker's nonblocking `fluentd` driver. It publishes Fluent Forward on loopback
port `24224` and Collector metrics on loopback port `8888`. Redeploy existing
Agents to recreate their containers with the logging route. Verify Engine
reachability when Docker runs in a VM; container DNS alone does not prove it.

If you change the Fluent Forward port, set both `OTEL_COLLECTOR_PORT` and
`OCC_DOCKER_LOGGING_ADDRESS` to matching values. `OTEL_COLLECTOR_METRICS_PORT`
changes only the host metrics port. The [Docker settings table](../reference/settings.md#local-compose-and-postgresql-configuration)
owns defaults and environment precedence.

#### Kubernetes and Helm

Use the production guide's `KUBECONFIG_FILE`, `CONTEXT`, and
`OCC_INPUT_DIRECTORY`, with the control-plane namespace `openclaw-system` already
created. Keep the complete production `values.yaml`; the logging block alone
is insufficient to install OCC.

If an existing cluster Collector already reads the OCC and tenant CRI files,
use it only after applying the same [native receiver](../../deploy/logging/kubernetes.yaml)
and [shared policy](../../deploy/logging/collector.yaml): trusted metadata,
privacy, filtering, egress, and bounded state. Use one collection route per
stream. Otherwise, enable the bundled Collector below.

Create its two dedicated Secrets before installing or upgrading the chart:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-otel-collector-config \
  --from-file=collector.yaml=deploy/logging/collector.yaml \
  --from-file=kubernetes.yaml=deploy/logging/kubernetes.yaml \
  --from-file=exporter.yaml=deploy/logging/exporter.yaml
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-otel-collector-exporter \
  --from-literal=OTEL_EXPORTER_OTLP_LOGS_ENDPOINT='https://otel.example.internal/v1/logs'
```

Replace the example endpoint. If you prepared an authenticated exporter, use
that protected file in `--from-file=exporter.yaml=...` and add any referenced
credential variables from protected files to the exporter Secret. These are
first-time creation commands; update existing Secrets through your normal
Secret-management workflow.

Set the exact approved exporter or proxy IPv4 address and port in the protected
values copy; `203.0.113.10/32` below is a placeholder:

```bash
yq -i '.logging.collector.enabled = true |
  .logging.collector.exporter.cidr = "203.0.113.10/32" |
  .logging.collector.exporter.port = 443' \
  "$OCC_INPUT_DIRECTORY/values.yaml"
```

Keep the default digest-pinned Collector image or select an approved immutable
image. If you changed the Secret names, also set
`logging.collector.configSecretName` and `logging.collector.envSecretName`.
Do not reuse application Secrets. The [Helm settings reference](../reference/settings.md#production-operational-logging-collection)
owns resource limits and state sizing.

For a first installation, finish the production guide's
[bootstrap PVC preparation](deploy.md#prepare-the-fresh-bootstrap-output-pvc)
before its Helm install. For an existing installation, apply your reviewed
values through the same Helm upgrade procedure. The Collector reads
`/var/log/pods` read-only and needs `get/list/watch` on Pods across workload
namespaces. Namespace and node names come from Pod fields; it does not need
Namespace, Node, Secret, or `pods/log` API access. Its node filter limits queries,
but is not an RBAC security boundary.

Restart the Collector DaemonSet after changing either Collector Secret so the
process reads the new configuration and environment:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  rollout restart daemonset/openclaw-enterprise-collector
```

## Tests

### Check delivery to the backend

1. With `logging.level: info` or `debug`, run the authenticated API check for
   your deployment: [Docker development](deploy.md#verify-development) or
   [Kubernetes production](deploy.md#authenticate-to-the-production-api).
2. Find a new `service.name=occ-api`, `event.name=http.completed` record in your
   backend. Confirm its status, timestamp, and request ID match the request.
3. For runtime coverage, deploy an Agent and exercise its gateway or Codex
   app-server. Check the corresponding `openclaw-gateway` or `codex-app-server`
   records and `openclaw.agent.id` / `openclaw.revision.id` resource attributes.

A healthy Collector or visible local stdout alone does not prove remote
receipt. Runtime records appear only for admitted event classes; successful API
collection does not prove a model turn or every runtime integration.

### Check Collector metrics

For Docker, inspect Collector errors and its Prometheus endpoint:

```bash
docker compose -f compose.yaml -f compose.logging.yaml logs --tail=100 collector
curl --fail "http://127.0.0.1:${OTEL_COLLECTOR_METRICS_PORT:-8888}/metrics"
```

For Kubernetes, check rollout and errors, then forward one Collector Pod's
metrics port to your machine (this checks only that node):

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  rollout status daemonset/openclaw-enterprise-collector --timeout=120s
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  logs -l app.kubernetes.io/component=collector --tail=100
COLLECTOR_POD=$(kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n openclaw-system get pods -l app.kubernetes.io/component=collector \
  -o jsonpath='{.items[0].metadata.name}')
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  port-forward "pod/$COLLECTOR_POD" 8888:8888
```

In another terminal, run `curl --fail http://127.0.0.1:8888/metrics`. Inspect
receiver acceptance/refusal, exporter success/failure, queue utilization, and
process memory. `otelcol_exporter_queue_size` should not grow indefinitely;
compare it with `otelcol_exporter_queue_capacity`. An increasing
`otelcol_processor_filter_logs_filtered` can reflect expected privacy filtering.

For ongoing monitoring, arrange private scraping for every Collector instance.
The chart does not provision dashboards, a metrics Service, or scrape discovery.
Its default-deny ingress policy also requires an operator-owned, narrowly scoped
allow rule for your scraper.

## Production readiness

- Keep runtime native OTLP export disabled and preserve Collector filtering.
  Local container logs and remotely exported records have different privacy
  boundaries; restrict access to both.
- Keep exporter traffic within the approved `/32` and port, with DNS and
  Kubernetes API access configured by the chart. Use an approved fixed proxy
  when your backend cannot be represented by that egress policy. NetworkPolicies
  are additive: the current shared dependency policy also permits Collector
  traffic to the configured database destination; the dedicated Collector
  policy does not remove that access.
- Alert on failed exports, refused records, queue saturation, and Collector
  restarts. Verify retention and access controls in your selected backend.
- Treat delivery as best-effort. Docker keeps exporter queues in the
  `occ_otelcol_data` volume and bounded runtime log caches; its push-based
  Fluent Forward receiver has no file offsets. Kubernetes keeps file offsets
  and exporter queues in `/var/lib/otelcol` on bounded `emptyDir` storage,
  which survives container restart but is lost
  on Pod or node replacement. An outage can lose operational logs without
  blocking OCC work or replacing durable audit persistence.

## Troubleshooting

| Symptom                                                  | Check and recovery                                                                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| OCC will not start after changing the level              | Use only the supported `logging.level` values; unknown logging keys fail startup.                                                             |
| Runtime level did not change                             | Restart OCC with the new startup YAML, then deploy a new AgentRevision.                                                                       |
| No Docker records reach the Collector                    | Check the Engine-reachable Fluent Forward address and matching published port; recreate existing runtime containers through Agent deployment. |
| Kubernetes Collector is pending or cannot read files     | Check image pull access, Secret names, Pod security admission, and node CRI file permissions.                                                 |
| Metadata is missing or Kubernetes requests are forbidden | Check the Collector ServiceAccount binding and Pod-read ClusterRole; retain the shipped Pod association and extraction rules.                 |
| Collector receives records but the backend does not      | Check endpoint path, TLS trust, credentials, exporter errors, allowed egress address/port, and whether records pass the operational filter.   |
| Expected records disappear at `warn` or `error`          | The source level suppresses lower-severity events; use `info` for the delivery check.                                                         |

## Related

- [Deploy the platform](deploy.md).
- [Settings and supported inputs](../reference/settings.md).
- [Common operational logging flow](../flows/common-logging.md).
- [Operational logging security boundary](../reference/security.md#operational-log-collection-boundary).
- [Integration test setup](../testing.md).
