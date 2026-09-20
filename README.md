# OpenClaw Enterprise

<img src="docs/assets/lobster-mech-transparent.png" alt="Comic-style lobster in a mech suit" width="200" />

OpenClaw Enterprise (OCE) includes the [OpenClaw Control Plane (OCC)](docs/guides/concepts.md#control-plane)
for deploying and managing [Agents](docs/guides/concepts.md#agents-and-revisions).
Start with the [User guide](docs/guides/README.md) to use or administer the platform,
or the [Platform developer guide](docs/contributing/README.md) to change its source.

## Getting Started

Requires either Docker Engine with Docker Compose, or Podman with
`podman-compose` and `yq` v4. Bash, Python 3, and the Go version selected by
[`go.mod`](go.mod) are also required, along with Node.js 24 or newer and the pnpm
version pinned in [`package.json`](package.json). Build the checkout-local OCC
CLI and start the local stack with:

```bash
pnpm cli:build
./scripts/dev-up
```

The helper selects a usable Docker Engine or falls back to Podman; no `docker`
alias is required. It prints the loopback OCC URL, Installation ID, and private
[service-key](docs/guides/concepts.md#identity-and-access) file path. Open the
printed URL with `/console/` to sign in, browse accessible resources, and create
Agent drafts. You do not need a model credential to start the control plane.

The default Docker and Podman stack can start the control plane, verify API
access, and manage Namespaces and drafts. It **cannot deploy an Agent or run a
model turn** because its Compute Driver rejects the required Harness
authentication. To run an Agent, use [local Kubernetes](docs/guides/deploy/local-kubernetes-development.md)
or an existing Kubernetes installation and follow [Deploy your first Agent](docs/guides/first-agent.md).
You need a model credential for that workflow.

The local worker has access to the selected engine's Docker-compatible API
socket. Use the
[quickstart](docs/guides/quickstart.md) for the first local API request, the
[deployment guide](docs/guides/deploy.md) for host requirements and production
Kubernetes setup, and the [runtime image recipe](deploy/runtime/README.md) for
image versions and build options.

## Develop

Follow [Make your first platform change](docs/contributing/first-change.md) for
setup, a small source edit, and focused verification. You need Node.js 24 or
newer, the pnpm version pinned in [`package.json`](package.json), and the Go
version selected by [`go.mod`](go.mod).

Use the [local checks](docs/testing/local.md) for the current formatting, lint,
type, CLI, and API commands; follow the [contribution policy](CONTRIBUTING.md)
before opening a PR. [Testing](docs/testing/README.md) explains additional
PostgreSQL, Docker/Podman, and Kubernetes setup; [CI coverage](docs/testing/ci.md#github-actions)
distinguishes PR-safe checks from protected integrations.

## Code layout

| Path                                          | Responsibility                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/controller/`                            | HTTP API, browser console, worker, and [Drivers](docs/guides/concepts.md#drivers-and-providers). |
| `packages/contracts/`                         | Resource models, Driver interfaces, and API schemas.                                             |
| `packages/occ/`                               | Resource lifecycle, persistence, and work queue.                                                 |
| `packages/iam/`                               | Identities, roles, and resource authorization.                                                   |
| `packages/audit/`                             | Audit events and sensitive-value sanitization.                                                   |
| `cmd/occ/`                                    | Go entry point for the OCC domain CLI.                                                           |
| `internal/occcli/`                            | OCC resource commands and human or structured output.                                            |
| `internal/occclient/`                         | Internal Go client that owns OCC transport and authentication.                                   |
| [`packages/utils/`](packages/utils/README.md) | Shared validation, hashing, and object helpers.                                                  |
| `tests/`                                      | Conformance and integration tests.                                                               |

## Documentation

Run `npm run docs:install` once, then `npm run docs:dev` to preview the docs at <http://127.0.0.1:4173>.
Use `npm run docs:build` for the full static build. See the
[local preview instructions](docs/local-preview.md) for setup and checks.

- [Documentation map](docs/README.md): choose the User guide or Platform developer guide.
- [Concepts](docs/guides/concepts.md): Namespaces, revisions, configuration, and access.
- [Feature reference](docs/reference/README.md) and [HTTP API](docs/reference/api.md): supported behavior and interfaces.
- [Current architecture](docs/ARCHITECTURE.md) and [platform design](docs/design.md): implemented components and the target design.

## License

[MIT](LICENSE). Third-party components retain their own licenses.
