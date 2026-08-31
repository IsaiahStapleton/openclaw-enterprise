# OpenClaw Enterprise documentation

Choose a document by the question you need to answer. Current feature contracts,
code execution, operating procedures, and implementation history have separate
owners; readers do not need to reconstruct current behavior from old proposals.

## Start and deploy

- [Quickstart](guides/quickstart.md): start a local Installation, sign in, and
  make an authenticated request.
- [Deploy](guides/deploy.md): development Docker Compose and production
  Kubernetes prerequisites, startup, verification, and cleanup.

These are the only user guides maintained for now. Detailed per-feature and
per-Driver tutorials are deferred; their supported behavior belongs in reference.

## Foundational documents

- [Repository README](../README.md): project purpose, workspace, and contributor checks.
- [Platform design](design.md): authoritative architectural principles,
  resource ownership, target direction, and deferred capabilities. A target
  capability is not a claim that it is implemented.
- [Current architecture](ARCHITECTURE.md): implemented components, boundaries,
  storage, and relationships. Follow its links for feature contracts and code traces.

## Current feature reference

[Reference index](reference/README.md) owns the supported feature specifications
at this repository version. These are living documents, not RFCs or delivery plans.

- [Namespaces](reference/namespaces.md), [Agents](reference/agents.md), and
  [Configuration](reference/configuration.md): ownership, operations, and immutable snapshots.
- [Kubernetes Secret Driver](reference/drivers/kubernetes-secret.md): Namespace-owned
  Secret storage, metadata-only responses, environment bindings, and redeploy
  behavior.
- [Authentication](reference/authentication.md),
  [Authorization](reference/authorization.md), and
  [Service accounts](reference/service-accounts.md): identity, permissions, and credential boundaries.
- [Harness execution](reference/harness-execution.md) and
  [Controller reconciliation](reference/controller.md): supported execution,
  admission, lifecycle, durable work, and recovery.
- [Security controls](reference/security.md), [settings](reference/settings.md),
  and [generated API reference](reference/api.md): exact deployment constraints,
  configuration inputs, and wire contracts.
- [Driver contracts and implementations](reference/README.md#drivers):
  capability obligations, trusted selection, and implementation-specific settings.

## Understand the code

Flow docs follow a concrete entrypoint through the current source. They explain
how the implementation realizes a contract; they do not define an alternative
feature contract or replace deployment instructions.

- [Development startup](flows/development-startup.md),
  [Docker Compose development](flows/docker-compose-development.md),
  [production startup](flows/production-startup.md), and
  [shared platform startup](flows/platform-startup.md).
- [Controller worker](flows/controller-worker.md),
  [Harness execution topology](flows/harness-execution-topology.md), and
  [dedicated Harness shared workspace](flows/dedicated-harness-shared-workspace-drive.md).
- [Configuration and Agent revision](flows/configuration-driver.md),
  [Secret storage and gateway delivery](flows/secret-storage-and-delivery.md),
  [Driver loading](flows/driver-plugin-loading.md), and
  [Compute lifecycle hooks](flows/compute-driver-lifecycle-hooks.md).
- [Local password authentication](flows/local-password-authentication.md),
  [service API keys](flows/service-api-keys.md),
  [native credential delivery](flows/native-service-account-credential-delivery.md),
  and [Driver-issued credentials](flows/service-account-driver-credential-delivery.md).
- [Existing Kubernetes namespace placement](flows/kubernetes-existing-namespace-placement.md).

## Implementation specifications

[Implementation-spec index](../specs/README.md) links change proposals,
milestones, recorded statuses, and the reference pages that own current behavior.
All existing specifications are in the [spec archive](../specs/README.md#archived-specifications),
preserving their decisions, recorded statuses, verification limits, and
implementation history. Archive placement does not mark unfinished work complete.
There is no separate RFC directory or process.

## Maintaining the split

| Document           | Update it when                                                   |
| ------------------ | ---------------------------------------------------------------- |
| `design.md`        | An architectural principle or target decision changes.           |
| `ARCHITECTURE.md`  | Implemented components or their relationships change.            |
| `reference/`       | Supported behavior, guarantees, limits, or configuration change. |
| `flows/`           | The execution path or source ownership changes.                  |
| `guides/`          | A startup or deployment procedure changes.                       |
| Top-level `specs/` | A proposed change is being developed or its outcome is recorded. |

An implementation PR updates affected current docs alongside the code. Reference
pages describe the merged source at their Git revision and explicitly distinguish
development, production, and verification-only behavior. Released snapshots come
from the corresponding release or tag; the default branch may be newer than an
operator's deployment. If code violates an accepted guarantee, record the defect
or known deviation rather than silently changing the guarantee.

Each rule has one authoritative home. Guides may illustrate it, flows may explain
its enforcement, and implementation specs may link its history. Preserve Manual
Notes and user-owned edits, and keep historical specification content intact when
updating links after a move. Contributor verification remains in
[AGENTS.md](../AGENTS.md#running-integration-tests).
