---
created: "2026-09-18"
updated: "2026-09-21"
last_updated_session: "authoring-run/fba2d7fa-6603-465e-a7c8-df0375ad202d"
---

# Agent repository credential flow

## Overview

An authorized Agent creation or update selects approved repository references.
Deployment freezes those grants into a revision; durable worker reconciliation
opens bounded sessions and hands private client files to Compute. The embedded
OpenClaw Agent then runs ordinary Git and selected GitHub CLI commands. This
flow ends at command dispatch to the credential service or revision cleanup;
the [service flow](repository-credentials.md) owns token acquisition, forwarding
and provider retirement.

The bundled path uses Kubernetes Compute-owned embedded OpenClaw, `api_key`
Harness authentication and no Sandbox Driver. This trace describes current
source. Installed-runtime, model-turn and live-provider evidence are separate
checks in the [testing guide](../testing/repository-credentials.md).

## Entry Points

- `apps/controller/src/index.ts:createFastifyApp` registers Agent creation,
  update and deployment routes. Existing exact Agent/configuration IAM checks
  apply before repository selection is persisted.
- `packages/occ/src/index.ts:OpenClawController.deployAgent` admits an immutable
  revision and queues work under its original actor.
- `apps/controller/src/worker.ts:ControllerWorker.prepareRevision` prepares
  repository sessions before invoking the selected Compute Driver.

The Installation selects a repository Driver and Provider, all three control
processes use the same immutable registry, and the Namespace is ready. Agents
without repository bindings bypass this capability.

## Flow

```mermaid
graph TD
  API["<b>Agent API</b><br/>Authorize and save refs"] --> Revision["<b>Deploy revision</b><br/>Freeze grants and deadline"]
  Revision --> Worker["<b>Claimed worker</b><br/>Recheck actor and policy"]
  Worker -->|Denied or expired| Close["<b>Cleanup ownership</b><br/>Close exact attempts"]
  Worker --> Attempt["<b>Persist opening</b><br/>Before control request"]
  Attempt --> Service["<b>Private control</b><br/>Check bound registry grant"]
  Service -->|Created once| New["<b>New material</b><br/>Record ID before delivery"]
  Service -->|Existing open session| Retained["<b>Retained material</b><br/>No bearer recovery"]
  Service -->|Lost response| Recover["<b>Recover only</b><br/>Find or fence, then close"]
  Recover -->|Authorized replacement| Attempt
  New --> Compute["<b>Compute delivery</b><br/>Validate complete set"]
  Retained --> Compute
  Compute -->|Missing retained files| Repair["<b>Repair exact subset</b><br/>Close and replace once"]
  Repair --> Compute
  Compute --> Pod["<b>Private generation</b><br/>Init files, replace Pod"]
  Pod --> Command["<b>Git or gh command</b><br/>Pin target and session"]
  Command --> Gateway["<b>HTTPS gateway</b><br/>Exact repository/profile"]
  Pod -->|Durable maintenance| Worker
  Pod -->|Stop or retire| Close
  Close -->|Unavailable or pending| Queue["<b>Durable cleanup</b><br/>Retry without new admission"]
  Queue --> Close
  Close -->|Disposed or absent| Done["<b>Cleanup settled</b><br/>Owned material removed"]

  classDef state fill:#EDF2F7,stroke:#879AB0,color:#25364A,stroke-width:1px
  classDef operation fill:#EBF3F0,stroke:#7F9D93,color:#2B4038,stroke-width:1px
  classDef condition fill:#F7F1E5,stroke:#B3A078,color:#514532,stroke-width:1px
  class API,Revision,Attempt,Queue state
  class Worker,Service,New,Retained,Compute,Pod,Command,Gateway,Close,Done operation
  class Recover,Repair condition
```

## Execution Trace

### 1. Resolve Namespace policy during Agent admission

`packages/occ/src/index.ts:OpenClawController.repositoryBindingSelections`
uses `resolveRepositoryBindings` after existing authorization. The public input
contains distinct opaque references and optional profiles, not provider tokens
or caller-selected grant identities. The concrete
`apps/controller/src/drivers/repo/github/driver.ts:GitHubRepoDriver.resolve`
uses local registry policy and defaults an omitted profile to `git-write`.
It performs no control-socket or GitHub call.

`apps/controller/src/drivers/repo/github/credentials/registry.ts:resolveGitHubRepositoryBinding`
requires the exact Namespace/reference/profile combination. Its fingerprint
binds provider/App/installation/repository identity, duration policy and the
Namespace's complete profile policy. The same registry supports several
repositories under one App installation, with one grant per selected binding.
OCC stores normalized selections on the Agent; an update's omitted array
preserves them and an empty array clears future selection.

### 2. Freeze a deployable revision

`packages/occ/src/index.ts:OpenClawController.admitRepositoryCredentials`
resolves the draft again, asks Compute to validate the supported topology, and
freezes Driver identity, exact grants and an absolute deadline. With duration
`86400`, the deadline is 24 hours after admission. Renewals and recovery cannot
move it. The public `clientRevision` serializer in
`apps/controller/src/index.ts` returns only Driver identity, references, profiles
and deadline from that snapshot.

`apps/controller/src/composition/repository-credentials/platform.ts:composeRepoDriver`
constructs `GitHubRepoDriver` for capability `repo` around a Provider-owned Unix
client, validated registry and public CA. Installation and Provider membership
must select the same opaque Driver ID. The existing
`AgentRevision.repositoryCredentials` and persisted
`admitted_spec.repository_credentials` fields are unchanged. The API and worker do not load the token engine or private App
key. The [production startup flow](production-startup.md) owns composition and
sidecar launch; the service validates its own protected inputs before listening.

### 3. Record ownership before opening a session

`apps/controller/src/worker/repository-credentials.ts:RepositoryCredentialLifecycle.prepare`
rechecks the original actor, ready Namespace, running Agent, exact revision,
selected Driver, unchanged grant and deadline. Each fresh attempt commits its
request identity in State under the live work claim and Namespace/Agent locks
before dispatch. `RepositoryCredentialLifecycle.open` then calls the Driver
outside the transaction. State stores recovery identifiers and phases, never
bearers or client files.

`apps/controller/src/providers/repository-credentials/control-client.ts:UnixRepositoryCredentialControlClient`
sends the bound request over the private socket. The service independently
resolves and compares the grant through
`apps/controller/src/drivers/repo/github/credentials/registry-factory.ts:createGitHubRegistryDriverFactory`.
The configured client validates the complete private response, including cleanup
counts and terminal-state consistency. `DISPOSED` permits historical revoked and
expired counts, but no active uses, active/pending/uncertain credentials or pending
auxiliary work. The Driver explicitly constructs a fresh four-field status and
three-field binding for created-open, recovered-open, status and close. Validation
still precedes projection; narrowing the public object cannot hide malformed
private state.

Only a created control response contains the bearer. The concrete Driver encodes
transient files with
`apps/controller/src/drivers/repo/github/credentials/client/config.ts:encodeRepositoryCredentialSessionFiles`
and returns session status plus that closed file map. The worker records the
session ID before passing files solely through
`ComputeRevisionContext.repositoryCredentials`.

A confirmed open session produces a `retained` binding without new files. An
unfinished opening attempt uses `recoverOnly` to find or fence the original
admission, closes any recovered session, then permits a fresh authorized attempt.
`apps/controller/src/drivers/repo/credentials/control.ts:createControlAdmission`
never reissues a bearer and records a cancellation fence for a missing fresh ID.
Transport failure or overload cannot establish absence.

### 4. Deliver and retain one complete runtime generation

`apps/controller/src/drivers/compute/kubernetes/repository-material.ts:repositoryMaterialSpec`
checks the complete `new | retained` binding set against the revision and derives
a generation from sorted reference/session pairs.
`apps/controller/src/drivers/compute/kubernetes/repository-material-store.ts:RepositoryMaterialStore.prepare`
validates exact ownership and file contents before creating immutable
Agent/revision/session-owned Secrets. It reports the precise missing retained
subset. The worker's `RepositoryCredentialLifecycle.repair` closes and replaces
only that subset, then retries Compute once; it does not pretend status recovery
recovered credential bytes.

`apps/controller/src/drivers/compute/kubernetes/repository-material.ts:repositoryMaterialDeployment`
mounts Secret projections only in the init container. The init entrypoint in
`apps/controller/src/drivers/compute/kubernetes/repository-material-init.ts:REPOSITORY_MATERIAL_INIT_ENTRYPOINT`
validates a complete projection, then writes mode-0700 directories and mode-0600
files into memory-backed storage. The serving container mounts the resulting
private directory read-only. Its manifest contains public routing metadata and
session identifiers; separate files contain gateway bearers.

`apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.activateRevision`
compares material generations as well as revision identity. A changed generation
replaces the actual embedded gateway Pod, even for the same revision. The runtime
uses stock Git and the image-owned `gh` router. Before publishing a complete
generation, the init entrypoint calls
`apps/controller/src/drivers/repo/github/credentials/client/native-git.ts:prepareNativeGitConfiguration`
with the staging and final paths. It writes the private aggregate `gitconfig`
without reading bearer contents. The runtime image adds the fixed
`/run/oce/repository-credentials/gitconfig` include to system Git configuration,
preserving normal HOME/global configuration and routing for `gh` child Git.
`repositoryNativeConfiguration` keeps the `gh` router first in native
`tools.exec.pathPrepend`, preserving other paths and per-agent exec settings.
The Harness's model environment remains intact. App keys, JWTs, installation
tokens and the control socket never enter this material set.

### 5. Authenticate native Git and route GitHub CLI commands

Stock Git resolves commands, remotes, push URLs, worktrees and local settings.
The aggregate configuration rewrites canonical HTTPS hosts to their admitted
gateway origin. Its scoped helper reads the effective credential host and path,
validates the pinned generation and binding deadline, then supplies the selected
gateway bearer. `OCE_REPOSITORY_REF` can disambiguate admitted bindings for one
repository; it cannot change the connection destination. Git keeps normal local
identity, hooks and aliases. Native overrides and additional credential helpers
remain possible; there is no whole-command preflight or egress confinement.
See the [routing limits](../reference/repository-credentials.md#client-routing-and-limits).

`apps/controller/src/drivers/repo/github/credentials/client/router.ts:routeRepositoryClient`
routes only supported `gh` commands. It selects from explicit targets or effective
Git remotes and pins the generation, reference and session for Git children.
Its API environment selects private `gh` configuration while preserving normal HOME.
Concurrent commands do not mutate shared repository-selection state.

The [service exchange flow](repository-credentials.md#4-reserve-acquire-and-dispatch)
then enforces the bearer, immutable repository/profile, capacity and deadlines.
It acquires fresh installation tokens on demand under the same grant, allowing
continuous use within the revision deadline without a long-lived GitHub token.

### 6. Maintain, recover and retire ownership

`apps/controller/src/worker.ts:ControllerWorker.completeActivatedRevision`
commits completion and the next maintenance work together, preserving the
original actor. Repository-bearing revisions use the selected Driver's
30-second maintenance interval, or a shorter Compute interval. Worker restart
resumes durable queued work; it does not invent actors through a startup scan.
An unavailable session after service restart is invalidated and replaced through
the same authorized material path, within the frozen deadline.

`apps/controller/src/worker.ts:ControllerWorker.finalizeActiveRevision`
can atomically fail one bounded observation and enqueue its successor while the
same active revision remains authorized. Stop, policy drift, expiry and revoked
authority cannot use that continuation to reopen sessions.

`packages/occ/src/state/postgres-work-queue.ts:PostgresWorkQueue.enqueueRepositoryCleanup`
and terminal queue transitions persist exact revision-owned obligations. Terminal
revision work records the `terminal-runtime` purpose with its terminal transition,
even when sessions are settled or no admission attempt exists.
`RepositoryCredentialLifecycle.closeRevision` records session-only cleanup with
the attempts it marks closing.

`ControllerWorker.processRepositoryCleanup` consumes validated owner-bound work
without policy resolution, new admission or material delivery, including after
the original actor loses ordinary permissions. Terminal-runtime work fences live
attempts, closes their sessions and calls the selected Compute Driver's
`stopRevision` for that exact revision even while session cleanup remains pending.
A Compute mismatch or stop failure keeps retirement retryable beyond the
foreground attempt limit. Completion requires settled sessions and successful
runtime retirement. Session-only repair or rotation cleanup never stops the
healthy workload. `CLOSED` denies local use but remains pending until disposal
or authoritative absence.

Compute retirement waits for owned Pods to stop before removing their material.
It preserves Secrets referenced by actual Pods and current Deployments, and
limits deletion to exact ownership with UID preconditions. Stop removes only
the stopped revision's route and preserves a newer gateway Deployment and its
shared resources. Route deletion and the stopped revision's Deployment deletion
also require the observed resourceVersion. Under the single-worker topology,
Deployment deletion precedes shared cleanup, which remains retryable after a
partial failure. Service restart can settle missing local-session records but
cannot prove remote token revocation.

## Debugging and Verification

Run `occ agent get AGENT_ID --output json` in the selected Namespace and compare
`activeRevisionId` with the admitted revision. Inspect worker events for
`REPOSITORY_BINDING_CHANGED`, `REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED`,
`REPOSITORY_CLEANUP_PENDING` or `REPOSITORY_CLEANUP_COMPLETE`. Check registry
identity and deadline before treating these as transient failures.

For client errors, `repository-not-admitted` identifies an unselected target;
`name-one-repository-target` or `name-one-repository-ref` requires explicit
selection. Check private material metadata and Pod generation without printing
bearers or Secret data. A ready Pod or a successful local command does not prove
live GitHub writes. Use the [test guide](../testing/repository-credentials.md) for
State/worker, real-client, installed/runtime and live-provider checks.

## Related docs

- [Repository credential reference](../reference/repository-credentials.md)
- [Install repository access](../guides/repository-credentials/installation.md)
- [Create and use a repository Agent](../guides/repository-credentials.md)
- [Controller worker lifecycle](controller-worker.md)
- [Credential service execution](repository-credentials.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-21 05:32: Reconcile accompanying platform credential documentation with current source history and native Git boundaries. (authoring-run/fba2d7fa-6603-465e-a7c8-df0375ad202d - a051a2406eec7cafde2e0dd5e2ec63dba6ce1581)

- 2026-09-19 23:54: Reconcile RepoDriver ownership, private status projection, and separate emitted service/client paths. (public authoring-run/73c80a5e-4d0c-4e72-b989-0cf9963c6593 - e5b5a5489f078d08272523476bdbcd0b9162c946)

- 2026-09-18 04:55: Trace the accompanying native exec PATH projection for repository material, including per-agent overrides. (e3012a8cee0c5ea60bc02943ebed88a1c88eb0d2)
- 2026-09-18 03:04: Trace the accompanying Agent admission, durable session lifecycle, Kubernetes material generation and concurrent client integration. (8500b2da103063b4503b62e5529f3910513e84a9)
