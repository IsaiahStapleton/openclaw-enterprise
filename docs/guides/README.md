# User guide

Use OpenClaw Enterprise to create, deploy, and manage Agents. This guide is for
people using an existing installation and the operators who administer one. It
also covers using the console, command-line interface (CLI), and HTTP API. If
you are changing the platform source, use the [Platform developer guide](../contributing/README.md).

## Get started

- **You are setting up locally:** start with the [Quickstart](quickstart.md).
  Its default Docker or Podman setup lets you sign in and check API access, but
  cannot deploy Agents. To run an Agent locally, complete the
  [Kubernetes setup](deploy/local-kubernetes-development.md), then
  [deploy your first Agent](first-agent.md).
- **You are installing the platform for your organization:** start with the
  [deployment guide](deploy.md) for Kubernetes or Amazon EKS.
- **Your organization already runs OpenClaw Enterprise:** skip setup. Ask your
  installation operator for the console URL, a provisioned account, and access
  to a Namespace. Then [deploy your first Agent](first-agent.md). The walkthrough
  explains how to tell an accepted deployment from a running Agent.

New to Namespaces, Agents, or revisions? Read [Concepts](concepts.md) first.

## Work with Agents

- Use the [console](../reference/console.md) to work with Agents, draft
  configuration, supported channels, and workspace files.
- Learn how [deployments and revisions](../reference/agents/deployment.md) and
  [Agent plugins](../reference/agent-plugins.md) work.
- Use the [OCC CLI](cli.md) or the [HTTP API](../reference/api.md) for automation.
- For sign-in or permission problems, see
  [authentication](../reference/authentication.md) and
  [authorization](../reference/authorization.md). If you do not have the
  required access, contact your installation operator.

## Administer an installation

Start with [access control](../reference/authorization.md),
[credential renewal and revocation](deploy/credential-lifecycle.md),
[observability](observability.md), and
[production handoff and recovery](deploy/production-handoff.md).
The [feature reference](../reference/README.md) lists supported behavior and
limits, including console, API, settings, and Driver configuration.
