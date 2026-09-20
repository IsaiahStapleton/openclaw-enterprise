# Feature reference

Use these references to check what OpenClaw Enterprise supports at this
repository version: permissions, configuration, interfaces, failure behavior,
and limits. For step-by-step work, start with the [User guide](../guides/README.md),
[Deploy your first Agent](../guides/first-agent.md), or the
[installation guide](../guides/deploy.md).

## Features

| Reference                                            | Use it to look up                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Platform console](console.md)                       | Sign-in, Agent drafts and deployment, supported channels, and Namespace selection. |
| [Namespaces](namespaces.md)                          | Tenant identity, placement, readiness, and deletion.                               |
| [Agents](agents.md)                                  | Agent identity, drafts, immutable revisions, and workspace files.                  |
| [Gateway routing with Envoy](gateway-routing.md)     | Private Agent endpoints, service keys, TLS, and network enforcement.               |
| [Configuration](configuration.md)                    | Native documents, generations, references, and snapshots.                          |
| [Secrets in configuration](configuration/secrets.md) | How to bind Secrets and what requires a redeploy.                                  |
| [Authentication](authentication.md)                  | Supported caller credentials, sessions, bootstrap, and account provisioning.       |
| [Authorization](authorization.md)                    | Principals, groups, roles, bindings, restrictions, and exact-resource decisions.   |
| [Providers](providers.md)                            | Provider configuration, supported clients, and Agent associations.                 |
| [Service accounts](service-accounts.md)              | Credential references, issuance, and revocation.                                   |
| [Agent plugins](agent-plugins.md)                    | Agent-owned selections and plugin startup.                                         |
| [Harness execution](harness-execution.md)            | Execution modes and supported runtime configurations.                              |
| [Security](security.md)                              | Kubernetes workload and credential boundaries and their limits.                    |
| [Settings](settings.md)                              | Supported operator settings and environment variables.                             |
| [HTTP API](api.md)                                   | Generated routes, request and response schemas, and declared permissions.          |

For day-to-day operations, see [observability](../guides/observability.md).
For automation, see the [OCC CLI](../guides/cli.md) alongside the HTTP API.

## Drivers

To choose or configure an implementation, start with
[Driver selection](drivers/selection.md), the
[Compute feature matrix](drivers/compute-matrix.md), or the
[Plugin feature matrix](drivers/plugin-matrix.md). Implementation references
cover settings, supported behavior, and limits:

- [Docker Compute](drivers/docker-compute.md),
  [Kubernetes Compute](drivers/kubernetes-compute.md), and
  [SSH Compute](drivers/ssh-compute.md).
- [OpenShell Sandbox](drivers/openshell-sandbox.md),
  [Kubernetes Secret](drivers/kubernetes-secret.md), and
  [bundled Plugin Drivers](drivers/plugin-bundled.md).

If you are changing an implementation, the capability contracts define what it
and its callers must support: [Compute](drivers/compute.md),
[Sandbox](drivers/sandbox.md), [Configuration](drivers/configuration.md),
[IAM](drivers/iam.md), [Secret](drivers/secret.md),
[ServiceAccount](drivers/service-account.md), and [Plugin](drivers/plugin.md).
The [Driver documentation inventory](../driver-docs-inventory.md) and
[base Driver template](../base-driver-docs-template.md) explain how to maintain them.

## Platform internals

The [Platform developer guide](../contributing/README.md) explains where to
start when changing the product. Read [current architecture](../ARCHITECTURE.md)
for implemented components; the [platform design](../design.md) also covers
target behavior that has not shipped.

Use [controller reconciliation](controller.md),
[platform repositories](platform-repositories.md), and
[programmatic settings](settings/programmatic.md) for source-level contracts.
[Runtime flows](../contributing/README.md#build-test-and-debug) trace execution,
and [contributor testing](../testing/README.md) covers fixtures and test setup.
Follow the [API generation checks](../testing/local.md#repository-and-tooling-configuration)
when updating routes or schemas. Update a feature reference in the same PR that
changes its supported behavior; keep proposals and delivery history in the
[implementation specs](../../specs/README.md).
