# OCC metrics

Enable metrics separately on each OpenClaw Control Plane (OCC) API and worker
process. Each serves `GET /metrics` on a private listener. Use the
[development walkthrough](../testing/metrics.md) for Prometheus and Grafana,
or [production scraping](../guides/observability/metrics.md) for Kubernetes.

## Configuration and access

| Setting               | Contract                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `OCC_METRICS_ENABLED` | `true` or `false`; defaults to `false`.                                                    |
| `OCC_METRICS_HOST`    | Required when enabled: `127.0.0.1` or `::1` in development; explicit Pod IP in production. |
| `OCC_METRICS_PORT`    | Required when enabled: integer 1–65535, distinct from the API port.                        |

Supplying host or port while disabled fails startup. An invalid configuration or
failed bind fails startup. Listener shutdown follows process shutdown. Metrics
are independent of log level and the logging Collector's port 8888.

The listener serves no sessions or resource operations and does not invoke IAM.
Network isolation protects the aggregate operational data. Exposition uses
Prometheus text, `Cache-Control: no-store`, and the client content type. Other
paths return 404; other methods on `/metrics` return 405. Connections are limited
to 16, with five-second socket/request handling limits. No public ingress.

## Application families

All families have `service="api|worker"`. No tenant, Agent, request, revision,
actor, credential, Driver-instance, payload, raw URL, or user-defined labels.

| Family                                        | Type      | Additional labels                 | Meaning                                                                                |
| --------------------------------------------- | --------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| `occ_http_requests_total`                     | Counter   | `route`, `method`, `status_class` | Completed API-process responses, including auth, console, denied and failing requests. |
| `occ_http_request_duration_seconds`           | Histogram | `route`, `method`                 | Request-hook to response-completion seconds.                                           |
| `occ_reconciliation_attempts_total`           | Counter   | `work_kind`, `outcome`            | Finished passes processing claimed work.                                               |
| `occ_reconciliation_attempt_duration_seconds` | Histogram | `work_kind`                       | Processing seconds, including Driver calls and finalization.                           |
| `occ_work_pending`                            | Gauge     | None                              | Shared PostgreSQL count of queued/claimed work, including delayed retries.             |
| `occ_agents`                                  | Gauge     | `deployment_state`                | Persisted Agent inventory: `draft` without `activeRevisionId`, `active` with it.       |

HTTP excludes health probes, metrics scrapes, and disconnected requests without
a completed response. `route` is the registered template or `unmatched`; wildcard
routes stay templates. Methods are `GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|OTHER`;
status classes are `1xx|2xx|3xx|4xx|5xx|other`. Status classes cannot distinguish
401/403 from other 4xx failures. These are not model-turn or WebSocket durations.

Work kinds are `namespace_ensure|namespace_delete|agent_revision|agent_stop`. Outcomes are
`success|pending|retry|permanent|claim_lost|error`. Pending convergence, retries,
maintenance, and superseded work may generate multiple passes per deployment.
Durations exclude queue wait and time between passes. Idle polling and stale
recovery without a claimed processing pass are excluded. Process death can lose
observations; these counters are not durable audit evidence.

HTTP histogram boundaries in seconds: `0.005, 0.01, 0.025, 0.05, 0.1, 0.25,
0.5, 1, 2.5, 5, 10`. Work boundaries: `0.01, 0.1, 0.5, 1, 5, 15, 30, 60,
120, 300, 900`. Both add `+Inf`, count, and sum.

## Shared snapshots and outages

Each worker scrape collects both gauges in one read-only PostgreSQL statement
against the singleton Installation. Both Agent categories exist even at zero;
redeploying an active Agent counts it once. Selection does not prove runtime
health. Stopping an Agent clears its active pointer, so it returns to the
`draft` category; this label includes stopped Agents, not only never-deployed
ones. Collection never polls Compute or updates resource state.

Worker startup supplies a separate read-only application-role pool with maximum
one connection, a 500 ms connection deadline, and 1500 ms query/statement
deadlines. Concurrent scrapes share collection. Failed collections destroy the
affected connection and return 503 without partial exposition or a stale-value
fallback. Reconciliation uses its own pool and continues. API scrapes do not
query the database.

## Process families and series budget

The pinned `@prometheus-io/client@0.16.1` supplies defaults. OCC retains only:

- `occ_process_cpu_user_seconds_total`, `occ_process_cpu_system_seconds_total`,
  `occ_process_cpu_seconds_total`, `occ_process_start_time_seconds`,
  `occ_process_resident_memory_bytes`.
- `occ_nodejs_heap_size_total_bytes`, `occ_nodejs_heap_size_used_bytes`,
  `occ_nodejs_external_memory_bytes`.
- `occ_nodejs_eventloop_lag_seconds` and
  `occ_nodejs_eventloop_lag_{min,max,mean,stddev,p50,p90,p99}_seconds`.
- `occ_nodejs_version_info` with bounded `version`, `major`, `minor`, `patch`
  metadata; `occ_nodejs_gc_duration_seconds` with
  `kind="major|minor|incremental|weakcb"` and boundaries
  `0.001, 0.01, 0.1, 1, 2, 5` seconds plus `+Inf`, count, and sum.

Unsupported platform measurements may be absent. No handle/resource breakdowns,
heap-space labels, custom labels, configurable buckets, or exemplars. Client
upgrades must explicitly review this list; new defaults are filtered out.

For `R` observed registered route/method pairs, HTTP has at most `20R` series
(six statuses plus fourteen histogram series). Unmatched methods add at most
eight pairs. Worker application metrics have at most 83 series (24 outcomes,
56 histogram series, three gauges). Process collectors add at most 53 series
per process. Do not preallocate the route/status Cartesian product.

## Replica aggregation

Prometheus scrapes every Pod directly and assigns instance/deployment labels.
Sum `rate()` of counters; sum histogram buckets before `histogram_quantile()`.
Use `max` for duplicated shared gauges, filtering targets by `up == 1` and
retaining deployment identity. Independent snapshot times can temporarily
overestimate decreasing values; missing/failed targets mean unknown, not zero.
Memory can be summed for fleet use or maximized for the largest process.
Inspect event-loop percentiles per process; do not average them.

See [production queries and discovery](../guides/observability/metrics.md).
The [metrics testing page](../testing/metrics.md) owns fixtures and proof limits.
