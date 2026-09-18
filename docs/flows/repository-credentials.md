---
created: "2026-09-17"
updated: "2026-09-18"
last_updated_session: "authoring-run/7e9ee7cd-e36a-4de7-8f67-29f3b03bd94d"
---

# Repository credential service flow

## Overview

A trusted operator or controller worker admits a bounded session over a private
Unix socket. The
client uses its gateway bearer to send Git or selected GitHub API requests over
HTTPS. One process owns credential acquisition, use and cleanup. This flow ends
at upstream response delivery or categorized failure, and then local session
closure with separately tracked cleanup. It describes source composition;
container and live-provider qualification have separate evidence.
The process remains separate from the controller API and worker. The
[Agent repository flow](agent-repository-credentials.md) owns ordinary Agent
admission, durable session records, Compute material delivery and cleanup. This
page owns the shared in-process credential engine used by both callers.

## Entry Points

- `apps/controller/src/repository-credentials.ts:main` loads trusted configuration and composes the service and listeners.
- `apps/controller/src/drivers/repository-credentials/client/operator.ts:callControl` carries operator admission/status/close requests over the private Unix socket.
- `apps/controller/src/drivers/repository-credentials/server.ts:startListeners` accepts HTTPS client traffic after protected startup succeeds.

Standalone configuration selects one repository; registry configuration selects
one App installation with multiple approved repositories and Namespace/profile
policies. Each session remains bound to exactly one repository. The operator
owns the control socket directory and protected files. Clients receive only
private session files and public connection/trust configuration.

## Flow

```mermaid
graph TD
  Operator["Worker or operator<br/>opens session"] --> Admission["Service freezes grant<br/>and creates bearer"]
  Admission -->|Construction failed| ConstructionCleanup["Seal renewal access<br/>drain unpublished custody"]
  Operator -->|Repeat admission ID| Recovery["Return public status<br/>close and reopen explicitly"]
  Admission --> Files["Deliver private material<br/>through CLI or Compute"]
  Files --> Client["Git or pinned gh<br/>calls gateway"]
  Client --> Route["Validate auth, profile route<br/>and request capacity"]
  Route -->|Denied| Denial["Bounded local failure"]
  Route -->|Admitted| Credential["Reuse valid credential<br/>or acquire and capture"]
  Credential -->|Uncertain issue| Blocked["Block minting<br/>retain cleanup obligation"]
  Credential -->|Usable| Gate["Synchronous dispatch<br/>rechecks lease and deadline"]
  Gate --> Upstream["Bounded upstream exchange"]
  Upstream --> Result["Response or uncertainty<br/>without write replay"]
  Operator -->|Close| Closed["Deny local use<br/>cancel exchanges"]
  Closed --> Cleanup["Join original settlement<br/>retire and finalize"]
  Cleanup -->|Resolved| Disposed["Session disposed"]
  Cleanup -->|Unresolved| Pending["Bounded pending records"]
```

## Execution Trace

### 1. Load protected startup inputs

`apps/controller/src/composition/repository-credentials/check-config.ts:checkConfiguration` and
`apps/controller/src/repository-credentials.ts:main` share the protected configuration
loader at `apps/controller/src/composition/repository-credentials/config.ts:loadConfiguration`.
`apps/controller/src/drivers/repository-credentials/configuration.ts:validateServiceConfig`
validates gateway settings, session policy and service limits. The standalone
check emits a safe summary without importing the session or listener owners.
Normal startup constructs the system clock and explicitly selects the GitHub
factory. `apps/controller/src/composition/repository-credentials/service.ts:runService`
then composes the common service and listeners without starting the controller
API or worker.
`apps/controller/src/providers/repository-credentials/github/factory.ts:createGitHubDriverFactory`
resolves grants, parses client authentication and composes session-bound drivers.
The App signing key belongs to the process, independently of each session's
installation tokens. Shared grant, client configuration and session DTOs live in
`packages/contracts/src/repository-credentials.ts` and leave through its package's
type-only exports. The private backend protocol and nominal custody handles live
in `apps/controller/src/drivers/repository-credentials/backend-contracts.ts`.
Service, control and transport collaborators remain private to the credential
engine. The public platform Driver is the thin session-control and local policy
owner traced in the [Agent flow](agent-repository-credentials.md).

Registry startup selects
`apps/controller/src/providers/repository-credentials/github/registry-factory.ts:createGitHubRegistryDriverFactory`
from the same canonical authority loaded by API and worker. Kubernetes startup
first uses `apps/controller/src/composition/repository-credentials/projected-inputs.ts:prepareProjectedInputs`
to snapshot projected inputs into protected private files. The App key and TLS
private key remain service-only. `startListeners` can reclaim only an owned,
private, refused stale Unix socket after checking that its identity is unchanged;
a live or ambiguously owned socket fails startup.

### 2. Admit and publish a client session

`apps/controller/src/drivers/repository-credentials/control.ts:handleControl` validates the local
request method, target, content type and bounded body before invoking the common
service. `apps/controller/src/drivers/repository-credentials/service.ts:createCredentialService`
checks duration, allowed profile and capacity, then freezes the resolved binding.
The common service treats profile names as opaque configured values. The GitHub
factory resolves `git-read`, `git-write` and `git-full` to the exact permission
maps in the [reference](../reference/repository-credentials.md#configuration),
including the profile in the grant identity. Protected startup validation rejects
unknown names, including `read-write`; the example default remains `git-write`.
Bearer lookup retains a digest. Only the original admission response contains
the bearer.

`apps/controller/src/drivers/repository-credentials/server.ts:startListeners` owns and disposes the
bounded correlation registry from
`apps/controller/src/drivers/repository-credentials/control.ts:createControlAdmission`. Before
opening a session, it binds the admission ID to the complete effective request.
Platform requests include Namespace, repository reference, normalized profile,
expected grant and absolute deadline. Registry mode requires that bound form and
independently resolves its fingerprint before creating authority. A
`recoverOnly` lookup returns status or absence without creation; a fresh missing
ID is fenced against a delayed first request until its admission window closes.
Known nondelivery before response transmission closes the new session. Ambiguous
response loss permits public-status reconciliation with the same ID; it does
not recover the bearer or replay provider operations. Correlation remains while
a closed session owns unresolved cleanup, even after its deadline; reclamation
requires disposal or absence.

If the factory throws or returns an invalid binding, the service closes
construction admission before starting
`apps/controller/src/drivers/repository-credentials/custody.ts:disposeAllRenewal`.
Every retained handle is sealed before any callback is awaited. The service
retains this unpublished custody until callbacks settle and byte disposal
completes; failed construction continues occupying bounded session capacity.

`apps/controller/src/drivers/repository-credentials/client/config.ts:writeClientConfiguration`
creates a private staging directory and private files, synchronizes writes, and
renames it into the requested new session directory. Normal CLI output contains
the session status and file location. A failed file write after admission causes
the CLI to attempt closure and report the session ID for operator follow-up.

### 3. Authenticate the selected client

`apps/controller/src/drivers/repository-credentials/client/launch.ts:launchClient` owns the temporary
home, subprocess, signal forwarding and cleanup. Cleanup retries transient removal
failures up to three times. An unresolved removal emits the temporary directory
path separately and preserves the child exit status or original launch error.
It composes
`apps/controller/src/drivers/repository-credentials/client/environment.ts:createClientEnvironment`
for the isolated environment and
`apps/controller/src/drivers/repository-credentials/client/commands.ts:prepareClientCommand` for
command validation and arguments. Git receives an exact destination helper and
command-level prompt/redirect/auth configuration. Before launch, Git reads its
effective configuration using the same repository-selection options; the launcher
resets inherited URL-specific HTTP protections at matching specificity and
rejects user-agent values containing carriage returns or newlines before starting
the client, including values from included configuration. Ordinary user-agent
values remain intact. It also rejects custom trust, client certificates, cookies
and DNS overrides. It rejects HTTP(S) userinfo in remote fetch/push URLs and
`insteadOf`/`pushInsteadOf` destinations, as well as direct network-command URLs,
before Git can transmit URL credentials in place of the session helper. The same
surfaces reject explicit remote-helper syntax. Clone options are validated before
inspection; config/template/submodule options, inherited `init.templateDir` and conditional
includes refuse because they introduce state or transports after preflight. Compose
mounts only the selected session at `/session`, keeping sibling sessions outside
the container. The helper reads the gateway
bearer only after matching HTTPS host and repository path. API execution checks
`gh` 2.100.0 and retains canonical GitHub identity while selecting the configured
gateway API host. Absolute API destinations and unqualified commands refuse.

### 4. Reserve, acquire and dispatch

`apps/controller/src/drivers/repository-credentials/server.ts:startListeners` owns listeners and
sockets. Its `apps/controller/src/drivers/repository-credentials/transport/agent.ts:createAgentHandler`
checks generic framing and delegates authentication to the bound factory. A valid
Git route with no credentials receives the local Basic challenge. Authenticated
requests reserve common exchange capacity before body forwarding. The GitHub
driver plans admitted routes through
`apps/controller/src/providers/repository-credentials/github/routes.ts:createRoutePolicy`, using
`apps/controller/src/providers/repository-credentials/github/routes/classification.ts:classifyRoute`
for target, method, profile and query classification. This provider-owned decision admits upload-pack discovery and execution for all
three profiles, but rejects receive-pack discovery and execution for `git-read`.
It admits REST and GraphQL only for `git-full`: selected repository metadata,
PRs, issues and issue comments, plus `GET /meta` and `POST /graphql`, subject to
the existing method, query, framing and media-type checks. Both Git-only profiles
reject API reads as well as writes before upstream dispatch. GraphQL bodies are
forwarded under the exact installation-token grant; this route check does not
perform per-field GraphQL authorization. Renaming the API-capable profile does
not broaden the route or request schema.

`apps/controller/src/drivers/repository-credentials/service.ts:createCredentialService` reserves the
exchange and delegates execution to
`apps/controller/src/drivers/repository-credentials/lifecycle/exchange.ts:executeExchange`, which
coordinates acquisition and owner-bound use. The lifecycle may reuse sufficient
remaining validity or acquire replacement material under common custody.
Concurrent misses share one acquisition in
`apps/controller/src/drivers/repository-credentials/lifecycle.ts:createLifecycle`. When its last
waiter leaves, the lifecycle cancels the original attempt. While that attempt's
settlement remains pending, requests needing acquisition return `not-dispatched`
without attaching new waiters or starting another acquisition. The original
owner retains capture, settlement and cleanup obligations until they resolve.
Custody captures the original monotonic timestamp and a cleanup deadline from
the declared lifetime. After settlement, the lifecycle anchors the acquired
use lifetime to that same capture timestamp, capped by the cleanup deadline.
Acceptance, cached reuse, dispatch and authentication use this earlier deadline;
cleanup retains its separate expiry and callback-drainage requirements. Later
wall-clock changes cannot shorten custody or restart the use lifetime.

`apps/controller/src/providers/repository-credentials/github/driver.ts:createGitHubDriver`
composes acquisition and capture through
`apps/controller/src/providers/repository-credentials/github/driver/acquisition.ts:createCredentialAcquisition`,
authentication and retirement through
`apps/controller/src/providers/repository-credentials/github/driver/access.ts:createCredentialAccess`,
and session-bound plans, credentials and original outcomes through
`apps/controller/src/providers/repository-credentials/github/driver/state.ts:createGitHubDriverState`.
Its bounded credential transport,
`apps/controller/src/providers/repository-credentials/github/provider-transport.ts:createProviderTransport`,
uses `apps/controller/src/providers/repository-credentials/github/provider-transport/request.ts:sendProviderRequest`
to dispatch and join the actual request close event. An original
dispatch gate rechecks admission synchronously after authentication preparation,
registers cancellation and opens the exchange without an intervening await.
The sender independently checks the fixed upstream origin. Credential bytes stay
inside private adapter/sender callbacks.

### 5. Deliver an outcome and release ownership

`apps/controller/src/drivers/repository-credentials/transport/response-headers.ts:responseHeaders`
checks upstream header bounds and framing. The GitHub route plan carries the
policy from `apps/controller/src/providers/repository-credentials/github/response.ts:createResponsePolicy`
for provider response headers, pagination and explicitly followed resource fields.
It composes URL validation and pagination rewriting from
`apps/controller/src/providers/repository-credentials/github/response-urls.ts:createUrlRewriter`
and `rewritePaginationLinks`, and resource-field rewriting from
`apps/controller/src/providers/repository-credentials/github/response-resources.ts:createResourceRewriter`.
The URL owner maps response links using the configured GitHub repository ID
to the admitted `/repos/owner/repository` path before checking the route and
resource purpose. A different repository ID remains refused. Issue-list
pagination accepts bounded `after` and `before` cursors; rewritten links retain
the gateway origin, so subsequent client requests pass through the same session
and profile checks.
Informational nested labels, milestones, repository metadata and human content
remain unchanged. Transport applies
`apps/controller/src/drivers/repository-credentials/transport/response-headers.ts:safeResponseHeaders`
before writing response headers to the client.

`apps/controller/src/drivers/repository-credentials/lifecycle/exchange.ts:executeExchange` joins
tracked I/O before releasing credential use and returning exchange capacity to
the service owner. Transport returns completed, not-dispatched or
possibly-dispatched outcomes. The Agent handler ignores the normal response
`close` event after `writableFinished`; a premature close cancels the exchange,
whose I/O is joined before its lease and capacity are released. A possibly dispatched
mutation has no automatic replay. Provider settlement and cleanup retain their
original ownership even when an outward request ends earlier.

### 6. Close locally and finish cleanup

`apps/controller/src/drivers/repository-credentials/service.ts:createCredentialService` closes the
session before cancelling its exchanges and advancing lifecycle cleanup. A
session becomes disposed only after exchanges, original actions, captures,
renewal state and auxiliary finalization are resolved. If the provider queue is
full before cleanup dispatch, `apps/controller/src/drivers/repository-credentials/lifecycle.ts`
keeps retirement/finalization unattempted and registers one capacity waiter per
session through `apps/controller/src/drivers/repository-credentials/provider-queue.ts`. Available
capacity wakes cleanup; queue rejection alone does not mark an action uncertain.

`apps/controller/src/composition/repository-credentials/service.ts:runService` stops admission on shutdown, asks
the service to close sessions, and bounds cleanup by an independent process
timer. A grace expiry reports unresolved status and exits; it does not manufacture
revocation. The process closes the shared App key after shutdown disposition.

Failed construction custody also participates in shutdown drainage. Its
pending obligation contributes to `pendingAuxiliary` without inventing a
published or disposed session; disposal wakes the shutdown waiters.

## Debugging and Verification

Run `pnpm credentials:build` and `pnpm credentials:check-config CONFIG_FILE` for
the independent emitted startup path. Run the client configuration and package
integration tests for private files, actual Git helper behavior and detached
runtime loading. Inspect session status after close: a closed session can still
have pending or uncertain cleanup.

A helper failure reports a fixed category without credentials. Diagnose the
configured HTTPS host/path and private file ownership first. API failures also
require checking that the session uses `git-full`, then the pinned CLI, canonical
host, gateway DNS/SAN and port 443.
The [test guide](../testing/repository-credentials.md) owns controlled upstream,
long-session, alternate-adapter, packaged and authorized live-provider checks.
A structural flow check does not establish any of those runtime results.

## Related docs

- [Ordinary Agent admission and runtime delivery](agent-repository-credentials.md)
- [Supported behavior and configuration](../reference/repository-credentials.md)
- [Operator procedures](../guides/repository-credentials.md)
- [Qualification and test setup](../testing/repository-credentials.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-18 03:04: Describe accompanying bound registry admission, recovery-only fencing and Kubernetes startup; link the platform-owned Agent lifecycle. (authoring-run/7e9ee7cd-e36a-4de7-8f67-29f3b03bd94d - 8500b2da103063b4503b62e5529f3910513e84a9)

- 2026-09-18 02:21: Update source ownership and emitted delivery pointers for the accompanying controller/contracts refactor; preserve the separate credential process and current lifecycle. (authoring-run/491fae6a-a220-4c92-880e-f438a7bb6480 - cce878092910f39770aa27baa64c6d710f9651f8)

- 2026-09-18 01:59: Document accompanying admission reconciliation, failed-construction drainage and separate use/cleanup deadlines. (01a0b098-e407-7d42-bc53-9bce979ac912 - 87e5c418d7a6c45688ce3be87c204660b431c703)

- 2026-09-17 23:47: Refresh configuration, route classification, driver composition and provider request source pointers from the accompanying adapter extraction. (authoring-run/17d63f83-3b86-4bfa-950d-89c50a927b0d - 251bf5662df1fd61e132ca57a36008409add1996)

- 2026-09-17 23:40: Refresh contract and response-policy source owners after extraction; preserve the existing lifecycle. (authoring-run/6c0de761-bba9-4070-9920-e7d6a83620dd - 3f0ce26cf864a8909c52104c1c6b6092ca21c857)

- 2026-09-17 22:22: Document accompanying git-read, default git-write and git-full profile changes and provider-owned route authorization. (01a0b0e4-839a-71b3-9ec1-3b1000b5d06a - c4ecf32727aef09a6b4caeec16870bf391f7a505)

- 2026-09-17 22:10: Refuse new waiters after acquisition cancellation while retaining original settlement and cleanup ownership. (authoring-run/d1f4d5a2-f493-43f0-8b8f-5471e61bb690 - 2f8435756d0e82f0cc5205b009f5f1e0df692808)

- 2026-09-17 21:39: Reject late clone configuration and helper-qualified URLs; preserve child outcomes when temporary-home cleanup fails. (authoring-run/2b8be1d2-818e-45ff-940f-ac9b9ab1997f - 2f8435756d0e82f0cc5205b009f5f1e0df692808)

- 2026-09-17 21:19: Reject Git URL userinfo before remote and direct network operations. (authoring-run/56442091-a0e5-47e2-a786-8b84d7c9fc9e - 2f8435756d0e82f0cc5205b009f5f1e0df692808)

- 2026-09-17 20:59: Reject inherited user-agent header injection before client launch. (authoring-run/6d7795bc-d3fd-4e6e-ae64-92943e8146b7 - 2f8435756d0e82f0cc5205b009f5f1e0df692808)

- 2026-09-17 20:40: Enforce repository HTTP settings and selected-session mounts; clarify response completion, URL preservation and cleanup capacity wakeups. (authoring-run/3c3b1dae-322e-4d11-8e7b-de1404dde505 - 2f8435756d0e82f0cc5205b009f5f1e0df692808)

- 2026-09-17 20:17: Correct source ownership after adapter and transport refactors. (authoring-run/1350f319-5493-4d4d-8d78-4622f8567d79 - 2f8435756d0e82f0cc5205b009f5f1e0df692808)

- 2026-09-17 20:12: Clarify client composition and exchange ownership source pointers. (authoring-run/18d52c2b-5de9-44a1-99b7-8c2e7f750620 - 2f8435756d0e82f0cc5205b009f5f1e0df692808)

- 2026-09-17 19:55: Document accompanying standalone service and client implementation. (authoring-run/5bd80749-b95a-4543-a055-0b77329a00ec - 2f8435756d0e82f0cc5205b009f5f1e0df692808)
