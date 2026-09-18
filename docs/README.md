# OpenClaw Enterprise

Deploy and manage Agents through OpenClaw Control Plane (OCC).
Start locally, install a production control plane, or look up supported behavior.

## Start and deploy

- [Quickstart](guides/quickstart.md): start locally on Docker or Podman, sign in,
  and verify API access.
- [Deploy](guides/deploy.md): choose a deployment and follow its installation steps.
- [Production handoff](guides/deploy/production-handoff.md): assign owners and verify a business workflow, alert response, and recovery readiness.
- [Credential lifecycle](guides/deploy/credential-lifecycle.md): select the supported renewal or revocation path and verify its consumers.
- [Repository credentials](guides/repository-credentials.md): give an Agent approved Git and GitHub CLI access, or use a standalone session.
- [OCC CLI](guides/cli.md): manage OCC resources through domain commands.
- [Concepts](guides/concepts.md): understand Namespaces, Agents, revisions, and credentials.
- [Observability](guides/observability.md): export logs and check Collector health.

## Reference

Use the [feature and Driver index](reference/README.md) for supported behavior,
configuration, and limits. The [HTTP API](reference/api.md) describes request and
response schemas. The [console guide](reference/console.md) covers browser tasks.
Compare bundled implementations in the [ComputeDriver feature matrix](reference/drivers/compute-matrix.md).
Use the [PluginDriver feature matrix](reference/drivers/plugin-matrix.md) to
compare plugin discovery and approval-policy support.
[Agent plugins](reference/agent-plugins.md) and
[PluginDriver](reference/drivers/plugin.md) cover curated plugin selection, startup
validation, and native runtime policy.

## Architecture

Read [current architecture](ARCHITECTURE.md) for implemented components and
ownership. The [platform design](design.md) describes the authoritative target,
including capabilities that have not shipped.

## Understand the code

Start with [Docker or Podman Compose development](flows/docker-compose-development.md),
[platform startup](flows/platform-startup.md), or the
[controller worker](flows/controller-worker.md). The **Understand the code** tab
lists runtime traces for authentication, configuration, Drivers, and Agent execution.
The [Agent repository flow](flows/agent-repository-credentials.md) traces API
admission, durable worker ownership and private Compute delivery; the
[credential service flow](flows/repository-credentials.md) traces token ownership,
forwarding and cleanup.
The [Agent plugin flow](flows/agent-plugins.md) traces desired state through
revision startup and runtime configuration.
The [repository credential configuration flow](flows/repository-credential-configuration.md)
traces protected-file validation and GitHub key ownership.

## Contribute

- [Repository layout and conventions](layout.md): find code owners and choose where changes belong.
- [Testing](testing/README.md): select a suite and prepare its environment.
- [Repository credential testing](testing/repository-credentials.md): verify client routing, session lifecycle, and backend behavior.
- [Local preview](local-preview.md): render and validate documentation.

## Implementation history

The [spec archive](../specs/README.md) preserves proposals and delivery records.
Recorded statuses do not replace current feature reference.
