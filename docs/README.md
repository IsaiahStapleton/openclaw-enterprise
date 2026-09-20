# OpenClaw Enterprise

OpenClaw Enterprise (OCE) uses the OpenClaw Control Plane (OCC) to deploy and
manage Agents. Choose a guide based on what you want to do.

## User guide

<a id="start-and-deploy"></a>

The [User guide](guides/README.md) is for people using or administering the
platform, including through the CLI or API.

- Already have access? [Deploy your first Agent](guides/first-agent.md) or
  [open the console](reference/console.md).
- Evaluating locally? [Try the control plane](guides/quickstart.md).
  Docker and Podman can start it; use
  [local Kubernetes](guides/deploy/local-kubernetes-development.md) to deploy an Agent.
- Installing or administering the platform? Start with
  [deployment](guides/deploy.md), [access control](reference/authorization.md),
  or [observability](guides/observability.md).

<a id="reference"></a>

Use the [feature reference](reference/README.md), [OCC CLI](guides/cli.md), and
[HTTP API](reference/api.md) for supported behavior, configuration, and limits.

## Platform developer guide

<a id="contribute"></a>

The [Platform developer guide](contributing/README.md) is for people changing
OCC, its CLI, Drivers, or this repository. Start with
[Make your first platform change](contributing/first-change.md),
[repository layout](layout.md), or [testing and CI](testing/README.md).

<a id="architecture"></a>

Read [current architecture](ARCHITECTURE.md) for what runs today. The
[platform design](design.md) describes the target, including capabilities that
have not shipped.

<a id="understand-the-code"></a>

To trace the implementation, see [platform startup](flows/platform-startup.md)
or [the controller worker](flows/controller-worker.md).

<a id="implementation-history"></a>

The [spec archive](../specs/README.md) preserves proposals and delivery records;
use the current feature reference to check what is supported.
