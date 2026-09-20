# OpenClaw Enterprise

OpenClaw Enterprise (OCE) uses the OpenClaw Control Plane (OCC) to deploy and manage Agents. Start by setting up a local installation, then deploy an Agent you name and send it a model request.

<a id="user-guide"></a>
<a id="start-and-deploy"></a>

## Getting started

1. [Set up the platform locally](guides/quickstart.md) with Kubernetes.
2. [Deploy your first Agent](guides/first-agent.md) and verify its model response. You need an OpenAI API key for this step.

If you are still learning the product, start with [Concepts](guides/concepts.md). For a shared environment, read the [production installation guide](guides/deploy.md).

<a id="reference"></a>

## Explore the docs

| Section                                       | Use it to                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| [Topics](guides/topics/README.md)             | Understand Agents, access and security, plugins, and configuration.      |
| [Integrations](guides/integrations/README.md) | Choose and configure Drivers, Providers, and channels.                   |
| [Operate](guides/operate/README.md)           | Install and run the platform, manage credentials, and diagnose failures. |
| [Reference](reference/README.md)              | Look up OCC CLI commands and HTTP API operations.                        |
| [Contribute](contributing/README.md)          | Set up a development environment and change the platform or its docs.    |

<a id="platform-developer-guide"></a>
<a id="contribute"></a>
<a id="architecture"></a>
<a id="understand-the-code"></a>
<a id="implementation-history"></a>

Contributors can start with the [repository layout](layout.md), [current architecture](ARCHITECTURE.md), or [runtime flows](contributing/runtime-flows.md). The [platform design](design.md) and [spec archive](../specs/README.md) also cover proposals; use the current documentation to check what is supported.
