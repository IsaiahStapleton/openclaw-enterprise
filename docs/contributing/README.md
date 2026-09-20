# Platform developer guide

Use this guide when you change OpenClaw Enterprise itself: the control plane,
console, CLI, Drivers, or deployment packaging. Start with
[Make your first platform change](first-change.md). To use or administer an
existing installation, see the [User guide](../guides/README.md).

## Find the code and its design

- [Repository layout](../layout.md) maps source directories to their owners and
  explains where to put code, tests, and documentation.
- [Current architecture](../ARCHITECTURE.md) explains how the API, worker,
  PostgreSQL, and Drivers work together today.
- [Platform design and implementation status](../design.md#implementation-status)
  distinguishes approved target behavior from what has shipped. Numbered
  [implementation specs](../../specs/README.md) record design and delivery history.
- [Feature and Driver contracts](../reference/README.md) define resource
  behavior, permissions, and interfaces. Use them when changing a contract or
  adding an implementation.
- For API work, read the [HTTP API reference](../reference/api.md) and
  [controller reference](../reference/controller.md). The [CLI guide](../guides/cli.md)
  shows the commands contributors need to preserve.

## Build, test, and debug

- [Local checks](../testing/local.md) covers lint, formatting, types, focused
  tests, and browser checks. The [testing guide](../testing/README.md) explains
  when integration checks need PostgreSQL, Docker, or Kubernetes; the
  [CI guide](../testing/ci.md) explains what runs on a pull request.
- To trace runtime behavior, start with [platform startup](../flows/platform-startup.md),
  the [controller worker](../flows/controller-worker.md), or the
  [platform console](../flows/platform-console.md).
- [Preview the documentation](../local-preview.md) and use the
  [base Driver documentation template](../base-driver-docs-template.md) when
  changing a Driver contract.

Before opening a pull request, read the [contribution policy](../../CONTRIBUTING.md)
for repository boundaries, verification, review, and private security reporting.
