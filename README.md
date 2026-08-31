# OpenClaw Enterprise

This checkout contains the **enterprise-platform foundation**. Its independent
TypeScript workspace provides the minimum platform contracts, control-plane
ownership boundaries, a Docker Compose development stack, an explicitly
admitted internal production API, and an independent PostgreSQL controller
worker. Development Compose starts PostgreSQL, migrations, the OCC API with a
filesystem-backed Configuration Driver, and the worker; the controller
self-bootstraps fresh databases before the worker starts; the bundled
Docker Compute Driver creates one Docker network per Namespace and starts real
OpenClaw/Codex runtime containers.
Operators can select reviewed bundled or installed IAM, Compute, and
Configuration Drivers in development and production. Trusted Kubernetes
startup configuration also selects the bundled Secret Driver for Namespace-owned
Secret storage and explicit gateway environment delivery. The bundled Kubernetes Compute
Driver can provision isolated tenant infrastructure; its production Helm chart
deploys the internal controller and worker and supports embedded OpenClaw
Agents and capability-token-authenticated dedicated Codex Agents.
This release includes only the active workspace; archived applications are not included.

## Start here

- [Quickstart](docs/guides/quickstart.md): start locally, sign in, and make an authenticated request.
- [Deploy](docs/guides/deploy.md): development Docker Compose and production Kubernetes setup.
- [Documentation map](docs/README.md): design, current architecture, feature reference, and code flows.
- [Kubernetes Secret Driver](docs/reference/drivers/kubernetes-secret.md): store
  Namespace-owned Secrets and bind them to selected Agent gateway environments.

Human clients authenticate with Better Auth sessions; non-Agent automation can
use IAM-scoped service API keys. Both require exact-resource IAM authorization.
See the [authentication reference](docs/reference/authentication.md).

## Active workspace

- `apps/controller/`: loopback development and internal-only production Fastify
  OCC APIs for the singleton Installation, isolated Namespaces, native service
  accounts, Namespace-owned Secrets, editable Agents, and immutable AgentRevisions,
  plus a separate PostgreSQL reconciliation worker and explicitly selected
  bundled or installed Drivers. Workers dispatch Namespace operations and
  approved embedded OpenClaw or dedicated Codex Agent revisions.
- [`packages/utils/`](packages/utils/README.md): shared object immutability,
  validation predicates, hashing, error inspection, and HTTP header helpers.
- `packages/contracts/`: executable TypeBox API schemas and route contracts,
  platform ownership models, authorization, audit, and IAM, Compute,
  Configuration, and Secret Driver contracts.
- `packages/occ/`: platform-owned resource lifecycle, transactional in-memory
  and PostgreSQL state, exact ownership repositories, durable controller work,
  explicit Driver selection, and authorization boundaries.
- `packages/iam/`: explicitly provisioned identities, Groups, scoped Roles,
  identity or Group bindings, deny-only Restrictions, and default-deny
  authorization.
- `packages/audit/`: attributable bootstrap, mutation, and authorization-denial
  events with transactional staging and sensitive-detail redaction.
- `tests/conformance/` and `tests/integration/`: executable API behavior,
  authorization, auditing, workspace boundaries, direct controller lifecycle,
  end-to-end HTTP journeys, and opt-in real-cluster Kubernetes infrastructure
  coverage.

The package-manager workspace, TypeScript solution, formatting configuration,
container context, and release archive all exclude `legacy/`. The root workspace
never imports archived source or executes its scripts. GitHub Actions workflows
are intentionally absent because this repository does not permit pushing them.
The development API listens on host `127.0.0.1:${OPENCLAW_DEV_PORT:-3000}`
when started through Compose.

On a clean checkout with Node.js 24 or newer and the pinned pnpm version, use:

```sh
pnpm install --frozen-lockfile
pnpm check:workspace
pnpm format:check
pnpm typecheck
pnpm openapi:check
pnpm test
```

Real-runtime integration coverage uses Docker Compose or Kubernetes with
explicitly selected OpenClaw and Codex images and an existing model credential.
See the [test environment settings](docs/reference/settings.md#docker-compose-development-test-environment)
to enable these suites. Once selected, missing images, model credentials, or
provider responses fail instead of substituting fixture-only coverage.

Installing dependencies automatically installs a repository-managed pre-push
hook that runs the installed Prettier executable directly on active source and
root files. Authored documentation additionally requires the explicit
`pnpm format:check` command. The hook uses Git's native hooks directory,
preserves any organization-managed `core.hooksPath`, and refuses to replace an
existing unmanaged pre-push hook. Run `pnpm hooks:install` to reinstall it
explicitly.

After the pinned workspace dependencies are installed, the conformance and
integration suites also run directly with Node's built-in test runner and
native TypeScript support:

```sh
node --test tests/conformance/*.test.mjs tests/integration/*.test.mjs
```

## Testing

Choose the test type that directly owns the behavior being changed:

- **Generated API freshness** (`pnpm openapi:check`) verifies that the checked-in
  OpenAPI document and Markdown API reference match the current API.
- **Conformance tests** (`tests/conformance/`) verify platform-wide ownership,
  tenant isolation, exact-resource authorization, auditing, and repository
  invariants. Add one when a rule must hold across implementations or security
  boundaries.
- **Integration tests** (`tests/integration/`) exercise realistic controller,
  worker, IAM, persistence, or runtime interactions. Prefer these for resource
  lifecycles, authentication, reconciliation, process startup, and regressions
  that span multiple components.
- **Docker Compose development integration tests** run the full local stack,
  Docker Engine, real OpenClaw/Codex images, and an existing model credential.
  Add or extend one when the supported development runtime changes.
- **Real-runtime integration tests** run the actual pinned Codex and OpenClaw
  executables. Add or extend one when host-process runtime provisioning,
  gateway behavior, harness startup, or process isolation changes.
- **PostgreSQL integration tests** (`pnpm test:postgres`) use a real disposable
  database. Add one when correctness depends on migrations, database
  constraints, transactions, durable claims, recovery, or concurrent workers.
- **Kubernetes integration tests**
  (`tests/integration/kubernetes-compute-real.test.mjs`) exercise the native
  Kubernetes client against an explicitly selected disposable local cluster.
  They verify namespace, workload, RBAC, NetworkPolicy, and optional
  PostgreSQL-backed lifecycle behavior with an HTTP fixture; they do not prove
  a real gateway-to-Agent model turn.
- **Real Kubernetes runtime tests**
  (`tests/integration/harness-topology-k3d-real.test.mjs`) use approved real
  OpenClaw and Codex images, an isolated database, and an existing model
  credential to prove dedicated and embedded gateway-to-model turns. Follow the canonical
  [integration-test instructions](AGENTS.md#running-integration-tests).

Add only tests that protect meaningful product behavior, security boundaries,
persisted invariants, or a specific regression. Prefer integration tests using
real components over mocks; when an integration test already proves a behavior,
do not duplicate it with a mocked test. Extend the existing integration case
instead. Use a mock only when the real dependency cannot reasonably exercise a
necessary failure or boundary, and explain why that substitution is needed.

Test each invariant at its authoritative boundary: persisted constraints in
PostgreSQL, authorization against the acting identity and exact resource, and
runtime behavior against actual executables. Avoid tests of framework
guarantees, incidental implementation details, or repeated equivalent cases.
When an expected outcome is not obvious, add a brief comment explaining the
business rule or security boundary.

## Generated API reference

The [generated API reference](docs/reference/api.md) documents every OCC
operation, request and response field, session-cookie and service-key
authentication requirements, and exact resource permission. Its source is the checked-in
[OpenAPI 3.1 contract](packages/contracts/openapi/occ-api.openapi.json); neither
artifact is served through a controller endpoint.

After changing controller routes or schemas, regenerate both artifacts and
verify that they remain current:

```sh
pnpm openapi:generate
pnpm openapi:check
```

To check the Markdown reference directly against the existing OpenAPI contract
without loading controller dependencies, run:

```sh
node scripts/generate-occ-api-reference.mjs --check
```

## Local files

Keep local `.env` files and root or nested `node_modules/` directories local
and ignored. Do not include credentials or dependency trees in release artifacts.

## Platform design

The [platform design](docs/design.md) defines the authoritative architecture and
target direction. [Current architecture](docs/ARCHITECTURE.md) describes the
implemented system. [Feature reference](docs/reference/README.md) defines the
supported contracts at this repository version; implementation proposals under
[specs/](specs/README.md) record individual changes and their history.

## License

The active workspace is licensed under the [MIT License](LICENSE).
Third-party components retain their own licenses.
