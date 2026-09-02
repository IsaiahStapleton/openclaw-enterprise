# OpenClaw Enterprise

<img src="docs/assets/lobster-mech-transparent.png" alt="Comic-style lobster in a mech suit" width="200" />

The open [control plane](docs/guides/concepts.md#control-plane-and-tenancy) for
deploying and managing [Agents](docs/guides/concepts.md#agents-and-revisions).

## Getting Started

Requires Docker Engine with Docker Compose, Bash, `curl`, and Python 3. Start
the local stack and run with:

```bash
./scripts/dev-up
```

The helper uses Docker Compose, prepares the default quickstart runtime image
when needed, and prints the loopback OCC URL, Installation ID, and private
[service-key](docs/guides/concepts.md#identity-and-access) file path. Open the
printed API URL with `/console/` to sign in and browse accessible Agents,
Providers, and Namespaces. To deploy an Agent and attach the OpenClaw terminal
UI to a real model-backed [runtime](docs/guides/concepts.md#gateways-and-harnesses),
continue to [development docs](docs/guides/deploy.md#development-end-to-end-tui).
A model credential is required to run Agent model turns, but not to start the
stack.

The local worker has Docker host access through the Docker socket. Use the
[quickstart](docs/guides/quickstart.md) for the first local API request, the
[deployment guide](docs/guides/deploy.md) for host requirements and production
Kubernetes setup, and the [runtime image recipe](deploy/runtime/README.md) for
image versions and build options.

## Develop

Requires Node.js 24 or newer and the pnpm version pinned in
[`package.json`](package.json).

```sh
pnpm install --frozen-lockfile
pnpm check:workspace
pnpm format:check
pnpm typecheck
pnpm openapi:check
pnpm test
```

PostgreSQL, Docker, and Kubernetes integration suites require additional setup;
see [Testing](docs/testing.md) for suite coverage, credentials, setup, and commands.

## Code layout

| Path                                          | Responsibility                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/controller/`                            | HTTP API, read-only console, worker, and [Drivers](docs/guides/concepts.md#drivers-and-providers). |
| `packages/contracts/`                         | Resource models, Driver interfaces, and API schemas.                                               |
| `packages/occ/`                               | Resource lifecycle, persistence, and work queue.                                                   |
| `packages/iam/`                               | Identities, roles, and resource authorization.                                                     |
| `packages/audit/`                             | Audit events and sensitive-value sanitization.                                                     |
| [`packages/utils/`](packages/utils/README.md) | Shared validation, hashing, and object helpers.                                                    |
| `tests/`                                      | Conformance and integration tests.                                                                 |

## Documentation

- [Concepts](docs/guides/concepts.md): tenancy, revisions, execution, [configuration and Secrets](docs/guides/concepts.md#configuration-and-secrets), and access.
- [Documentation map](docs/README.md): guides, references, and runtime flows.
- [Platform design](docs/design.md) and [current architecture](docs/ARCHITECTURE.md): target design and implemented components.
- [Feature reference](docs/reference/README.md): supported behavior and Driver contracts.
- [Platform console](docs/reference/console.md): login, read-only collections, and Namespace selection.
- [Providers](docs/reference/providers.md): authenticated clients, related Drivers, and optional Agent association.
- [Agent workspace files](docs/reference/agents.md#workspace-files): read and replace four native Agent workspace files through private Kubernetes routes managed by Compute, Envoy Gateway, and cert-manager.
- [HTTP API](docs/reference/api.md): routes, request and response schemas, authentication, and permissions.
- [Spec archive](specs/README.md): proposals and implementation history, with recorded statuses.

## License

[MIT](LICENSE). Third-party components retain their own licenses.
