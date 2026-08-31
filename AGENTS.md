# OpenClaw Enterprise repository instructions

## Active workspace boundary

`legacy/` is excluded from this release. Do not
edit, execute, import, build, deploy, or start its application, reconciler,
migrations, tests, package-manager scripts, Docker images, or Helm chart unless
a later task explicitly requests a narrowly scoped historical investigation.

Approved milestones permit the active TypeScript/pnpm workspace, its selected
controller and Driver implementations, reviewed PostgreSQL persistence, and
production Kubernetes packaging described in the current implementation specs.
Keep the workspace independent of archived code and do not introduce platform
resources or deployment behavior outside those approved milestones.
Do not add GitHub Actions workflows: organization push restrictions prohibit
workflow changes in this repository.

The development API must bind only to loopback, reject nondevelopment
configuration, admit only explicitly provisioned development identities,
authorize every exact resource operation through the selected IAM Driver, and
emit attributable audit evidence for bootstrap, successful mutations, and
authorization denials.

Preserve Git history, registered worktrees, ignored local `.env` files, and
existing root or nested `node_modules/` directories. Keep `legacy/` excluded
from Docker contexts and Git release archives.

The authoritative architecture is the repository's
[platform design](docs/design.md).
Do not create a competing architecture specification in this checkout.

## User-facing documentation

Use the [documentation map](docs/README.md) and keep these ownership boundaries:

- Root `README.md`, `docs/README.md`, `docs/design.md`, and `docs/ARCHITECTURE.md`
  own orientation, navigation, authoritative target design, and current architecture.
- `docs/reference/` owns living specifications for supported features and Driver
  contracts. State development, production, and verification-only limits explicitly;
  do not promote a proposed capability into current reference before implementation.
- `docs/flows/` explains runtime execution through the current source. Link to
  reference for normative behavior and to guides for operator procedures.
- Keep `docs/guides/` limited to `quickstart.md` and `deploy.md` for now. The
  deployment guide covers both development and production; do not add detailed
  per-feature or per-Driver user guides.
- Top-level `specs/` records implementation proposals, milestones, and delivery
  history. Completed specifications do not override current feature reference.

When introducing a new component, add or update its user-facing documentation
under `docs/` in the same change. Explain what the component does, how to run or
configure it, its supported boundaries, and how to verify or troubleshoot it.
Link the new guide from relevant existing documentation and update adjacent
pages that would otherwise describe outdated behavior.
Do not add migration documentation, migration-specific rollout instructions,
or per-migration database preparation guidance unless explicitly requested.

## Deferred implementation

Add a concise `TODO` immediately beside code that exists temporarily because a
feature is unimplemented or work is deferred. Explain what is missing and name
the milestone, capability, or removal condition that will replace it. Remove
the comment when that work is implemented. Do not label permanent security
boundaries or intentional architecture as temporary.

## Implementation specifications

Write OpenClaw Enterprise implementation and milestone specifications under the
repository's top-level `specs/` directory (`openclaw-enterprise/specs/`). These
implementation specs must follow the authoritative platform design; they do
not replace it.

Implementation specifications are point-in-time records. When a later spec
changes or supersedes an implementation described by an earlier spec, document
the change in the later spec and the affected current documentation. Do not
retroactively update the earlier spec to match the later implementation;
preserve its original design decisions and implementation details.

Use stable feature names in `docs/reference/` and retain existing numbered
implementation-spec paths under `specs/`. A behavior-changing implementation PR
updates its affected reference, guides, and flows together. Record completion
and the owning current reference when a specification ships.
Keep Manual Notes unchanged. Link maintenance after document moves is permitted
outside preserved sections; do not treat recorded spec statuses as release evidence.

## Production and compatibility boundary

This platform has no production consumers yet. Use one canonical current-state
implementation; do not preserve older development helpers, persisted formats,
fixture shapes, migration shims, or silent fallbacks solely for backward
compatibility. Fail explicitly on unsupported state instead.

## Validation boundary

Prefer enforcing persisted-data invariants in database constraints. Do not
repeat database-enforced validation in application logic; an in-memory storage
adapter may mirror a constraint when it substitutes for the database.

## Test integrity

Tests must verify real, supported application behavior. A test that merely
confirms behavior invented by its own mock, monkeypatch, fixture, or hand-written
adapter is invalid and must be rewritten or deleted.

- Use actual API routes, request methods, server-owned resource scope, response
  envelopes, authorization rules, and lifecycle transitions. Never invent
  endpoints, caller-selected singleton Installation IDs, nonexistent response
  shapes, or resource states the production system cannot reach.
- Assert observable outcomes from the real component under test. Do not patch a
  method and assert its patched return value, inspect hand-written SQL strings
  instead of executing persistence behavior, or recreate application logic in a
  fixture and present the fixture's decisions as product verification.
- Seed only realistic ownership and lifecycle states. A ready tenant with
  admitted revisions is not a provisioning tenant; test fixtures must preserve
  the same invariants and boundaries as the application.
- State exactly what an integration test exercises. A lightweight HTTP adapter
  is not the production Fastify app; a manually aborted signal is not a lost
  database lease; a mocked Kubernetes client is not live SDK or cluster proof.
- When required dependencies, credentials, or infrastructure are unavailable,
  skip the affected integration explicitly or report the verification gap.
  Never replace missing infrastructure with a self-fulfilling fake and claim
  the original integration passed.
- When a test outcome is not obvious, add a concise comment explaining the
  expected behavior, business invariant, or security boundary.
- In integration tests, add concise comments before non-obvious setup,
  verification, or state transitions to explain the scenario being simulated,
  the outcome being proved, and its business or security significance. Explain
  intent and invariants; do not narrate obvious syntax.

## Running integration tests

Run all integration tests with `pnpm test:integration`, or target one case with
`node --test tests/integration/<name>.test.mjs`. Real-runtime coverage uses the
Docker Compose or Kubernetes integrations with explicitly selected runtime
images and existing authorized model credentials. Follow the
[testing guide](docs/testing.md) and
[test environment settings](docs/reference/settings.md#docker-compose-development-test-environment)
for each selected suite. Never substitute a fake runtime or skip a requested
runtime integration.

For PostgreSQL integration, start the reviewed local database, migrate it with
the migrator role, and run tests with the less-privileged application role.
Before enabling production bootstrap coverage, separately prepare its empty
disposable database using the
[PostgreSQL test database instructions](docs/reference/settings.md#postgresql-test-environment):

```sh
pnpm db:up
export OCC_MIGRATION_DATABASE_URL=postgresql://occ_migrator:occ-migrator-local@127.0.0.1:55432/openclaw_enterprise
pnpm db:migrate
unset OCC_MIGRATION_DATABASE_URL
export OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_enterprise
export OCC_PSQL_TEST_DATABASE_URL="$OCC_TEST_DATABASE_URL"
export OCC_PRODUCTION_WIREUP_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_production_bootstrap
pnpm test:postgres
```

The production-bootstrap database must be separately migrated, disposable, and
free of an existing Installation. `OCC_PSQL_TEST_DATABASE_URL` enables the real
production queue cases; `OCC_PRODUCTION_WIREUP_DATABASE_URL` enables the
production bootstrap case. Omitting either variable skips its associated proof.

Run Kubernetes integration only against an explicitly selected, disposable k3d
cluster with enforcing NetworkPolicies. Preserve the default kubeconfig, the
active context, and every unrelated cluster:

```sh
mkdir -m 700 -p /tmp/oce-k3d
k3d cluster create oce \
  --api-port 127.0.0.1:6443 \
  --kubeconfig-update-default=false \
  --kubeconfig-switch-context=false
k3d kubeconfig get oce > /tmp/oce-k3d/kubeconfig
chmod 600 /tmp/oce-k3d/kubeconfig

export OCC_TEST_KUBERNETES_KUBECONFIG=/tmp/oce-k3d/kubeconfig
export OCC_TEST_KUBERNETES_CONTEXT=k3d-oce
export OCC_TEST_KUBERNETES_IMAGE=oce-fixture:local
docker build --pull=false -t "$OCC_TEST_KUBERNETES_IMAGE" tests/fixtures/kubernetes
k3d image import "$OCC_TEST_KUBERNETES_IMAGE" -c oce
node --test tests/integration/kubernetes-compute-real.test.mjs
```

The PostgreSQL-backed API-and-worker Kubernetes case additionally requires a
dedicated `openclaw_k8s_*` database; it rejects the ordinary development
database. Prepare the disposable database with the administrator, grant schema
ownership only to the migration role, and run the controller with the limited
application role:

```sh
pnpm db:up
docker compose -f compose.postgres.yaml exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c 'CREATE DATABASE openclaw_k8s_local'
docker compose -f compose.postgres.yaml exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openclaw_k8s_local \
  -c 'GRANT CREATE ON DATABASE openclaw_k8s_local TO occ_migrator; CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;'

export OCC_MIGRATION_DATABASE_URL=postgresql://occ_migrator:occ-migrator-local@127.0.0.1:55432/openclaw_k8s_local
pnpm db:migrate
unset OCC_MIGRATION_DATABASE_URL
export OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_k8s_local
node --test tests/integration/kubernetes-compute-real.test.mjs
```

All three real-cluster fixture cases must pass without skips. Partial Kubernetes setup,
unenforced NetworkPolicies, missing fixtures, insufficient permissions, or an
unavailable explicitly requested cluster must fail rather than substituting a
fake. The suite provisions its own scoped controller ServiceAccount and
tenant-local RBAC; it does not install or verify shared-cluster admission
guardrails. Remove only the disposable cluster after testing:
`k3d cluster delete oce`.

The Kubernetes fixture proves real API, RBAC, workload, reconciliation, and
NetworkPolicy behavior, but it is only an HTTP fixture: it does not prove a
real OpenClaw gateway, authenticated Codex WebSocket, or model turn. To verify
genuine development Kubernetes execution, use the same dedicated cluster,
import approved digest-pinned real gateway and Codex images, and provide an
existing model credential without printing it:

```sh
export OCC_TEST_HARNESS_K3D_REAL=1
k3d image import '<local-gateway-image-tag>' '<local-codex-agent-image-tag>' -c oce
export OCC_TEST_KUBERNETES_GATEWAY_IMAGE='<gateway-image>@sha256:<digest>'
export OCC_TEST_KUBERNETES_AGENT_IMAGE='<codex-agent-image>@sha256:<digest>'
test -n "${OPENAI_API_KEY:-}"
export OPENAI_API_KEY
export OCC_TEST_OPENAI_MODEL=gpt-5.1
export OCC_TEST_SLACK_LIVE=0
node --test tests/integration/harness-topology-k3d-real.test.mjs
```

`OCC_TEST_KUBERNETES_KUBECONFIG` and `OCC_TEST_KUBERNETES_CONTEXT` must still
explicitly select the disposable loopback `k3d` cluster. Set
`OCC_TEST_OPENAI_MODEL` to an authorized custom-tool-capable model, such as
`gpt-5.1`, when running dedicated Codex coverage; the source default is
`gpt-4.1`. Import
the local image tags, then configure their corresponding digest references; k3d
does not import images by digest. Also register each immutable reference inside
the k3s container with
`docker exec k3d-oce-server-0 ctr -n k8s.io images tag <imported-image> <image@sha256:digest>`;
otherwise Kubernetes attempts a remote pull and reports `ImagePullBackOff`.
Optional
`OCC_TEST_KUBERNETES_OPENCLAW_VERSION` and `OCC_TEST_KUBERNETES_CODEX_VERSION`
assert the actual image versions; Codex defaults to `0.147.0`. The ordinary
real-runtime suite has three cases: `dedicated` Codex, `embedded` OpenClaw with
a persisted provider credential, and `embedded` OpenClaw with the Secret API.
Each case must produce real provider-backed model responses. Embedded OpenClaw
uses one combined gateway/Agent Pod; dedicated Codex uses separate gateway and
authenticated app-server Pods. All cases require
operator-owned Agent-specific transport/model Secrets, exact projected
workload identity, bounded Pod-local writable runtime state, and enforced
default-deny networking. The model key appears only in the combined embedded
Pod or the dedicated Codex Pod, never in a separate gateway, controller,
fixture, log, or shell history. Production supports both topologies through
the same explicit `runtime` configuration; missing exact Agent-owned
credentials fail closed.
Dedicated native configuration must register only its selected `codex/<model>`
under `models.providers.codex`, with `api: "openai-responses"` and a fail-closed
`baseUrl: "http://127.0.0.1:9"`; authenticated WebSocket execution remains in
the Codex Agent, which alone receives the model credential.

`OCC_TEST_SLACK_LIVE=1` selects the separate live Slack case and suppresses the
ordinary three real-runtime cases. That case posts real Slack messages and waits
for a gateway-authored reply; follow
[the Slack testing guide](docs/testing.md#slack) before selecting it.

A separate genuine production installation additionally requires the real
Helm-installed controller and PostgreSQL, tenant-local RoleBindings, a model
turn before and after immutable revision cutover, and verified allowed/denied
NetworkPolicy connections. Configure Kubernetes API egress for its actual
translated `/32` endpoint and port. Never claim that fixture-only coverage
establishes real-runtime outcomes.

## TypeScript style and verification

- Use `ts-pattern` for tagged unions and branches that would otherwise become
  nested ternaries. Prefer `match(value).with(...).exhaustive()` so every case
  is explicit and checked by TypeScript.
- Keep ordinary two-way conditions as a simple ternary or `if`; do not wrap
  them in `match` just to use the library.
- Format active workspace changes with `pnpm format:fix` and verify them with
  `pnpm format:check` when an installed dependency graph matches the current
  manifests. These checks include authored `docs/**/*.md`; the generated
  `docs/reference/api.md` is excluded and verified by `pnpm openapi:check`.
  Never reconcile or install dependencies as a side effect of agent
  verification; use dependency-independent Node tests if manifests changed.
- Check root workspace isolation with `pnpm check:workspace`. Never execute
  archived package scripts.
- Never run `npm run precommit`.
