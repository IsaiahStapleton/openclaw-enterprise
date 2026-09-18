# Repository credential service tests

Run these tests from the repository root with Node.js 24, Git, OpenSSL, Docker,
and the prepared workspace dependencies. The fixtures generate fresh RSA and
TLS material, start bounded local upstreams, and remove their temporary files,
listeners and containers when the tests finish. They do not load ambient
GitHub credentials.

```sh
node --test tests/conformance/repository-credentials-backend-conformance.test.mjs
node --test tests/integration/repository-credentials-git.test.mjs
node --test tests/integration/repository-credentials-gh.test.mjs
node --test tests/integration/repository-credentials-long-session.test.mjs
```

The client integration files create a disposable `node:24-bookworm` fixture container,
mount the source read-only and mount `/usr/bin/gh` read-only after checking its
version is exactly **2.100.0**. Override the prepared binary with
`REPOSITORY_CREDENTIALS_GH_BINARY` and the prepared Node image with
`REPOSITORY_CREDENTIALS_NODE_IMAGE`. These tests require the prerequisites and
fail if they are unavailable. They never install dependencies.

The container resolves `credentials.example.test` to its own loopback address.
Its network is disabled; every controlled service shares that loopback namespace.
The generated certificate includes that DNS SAN; clients verify it using the
generated public CA. The gateway listens on HTTPS port 443 and `gh` retains
`GH_HOST=github.com`. The generated production client configuration and launcher
own authentication, clean environment setup and the Git helper. No insecure
TLS switch or localhost `GH_HOST` substitute is used.

## What the controlled tests prove

The Git upstream runs the actual `git-http-backend` against a disposable bare
repository. The `git-write` case proves clone, fetch, branch checkout and push,
with assertions on remote refs. The `git-read` case proves the read operations,
rejects push and API requests before token acquisition or upstream access, and
checks that a denied push leaves remote refs unchanged. API and combined
workflow coverage selects `git-full`.
A fault case drops the response after receive-pack finishes and checks that the
service sends the push once while the remote ref records the accepted commit.

The API upstream verifies RSA signatures, App identity, current JWT time,
repository selection and complete permission maps. It maintains independent
PR, issue and comment state. The pinned CLI runs REST creation/read/update,
paginated comments and issues using native repository-ID links and opaque issue
cursors, individual comment operations and native GraphQL PR
creation. It checks bodyless deletion and unchanged human text. Unknown routes
and lost mutation responses exercise denial and no-replay behavior.

The alternate adapter uses a nonnumeric repository ID, nested repository path,
different native authentication and permissions, short access expiry, and a
separately bounded private renewal secret. The production service supplies
custody, original attempts, leases, settlement, expiry and finalization.
The HTTP case uses the same production listener and sender as GitHub.
Passing this test does not claim support for another production provider.

The long-session test clones once, advances trusted wall and monotonic clocks
past hour thirteen, then pushes and performs the API workflows through the same
running service and unchanged client files. The upstream checks that expired
token A receives no later authentication attempts, including rejected attempts
at the Git and API boundaries, and token B has a fresh JWT with the same
repository and profile. It then checks local closure and provider retirement
separately. There is no long sleep and no Agent-facing clock control.

The control integration suite loses an admission response through an actual Unix
socket relay, then reconciles public status with the original admission ID.
It also destroys the listener socket during construction to distinguish known
nondelivery from ambiguous response loss. Owner regressions cover delayed
settlement, frozen or adjusted wall clocks, short configured safety margins,
and cleanup retaining credential material after authentication becomes ineligible.

## Qualify emitted artifacts

Build the service and client images using the
[operator guide](../guides/repository-credentials.md). Then combine the emitted
service closure with the delivered client toolchain in an owned test-only image:

```sh
docker build \
  --build-arg SERVICE_IMAGE=repository-credentials:local \
  --build-arg CLIENT_IMAGE=repository-credentials-client:local \
  -f tests/fixtures/repository-credentials/Dockerfile.qualification \
  -t repository-credentials-qualification:test .
REPOSITORY_CREDENTIALS_TEST_IMAGE=repository-credentials-qualification:test \
  node --test tests/integration/repository-credentials-container.test.mjs
```

Record both input image identities and the qualification image ID with results.
The qualification image combines the separately staged service and client
closures under `/app/dist`. Its loader selects that emitted root explicitly
with `REPOSITORY_CREDENTIALS_EMITTED_ROOT`; missing emitted modules fail without
falling back to checkout source. The first case exercises the emitted production
service and client entrypoints and uses the same long-session acceptance sequence. The
second runs alternate-backend conformance through those emitted common owners,
including renewal, private authentication, and streamed callback drainage. The
qualification image is a test driver; it is not a separate supported deployment.
Without an explicit image selector, these cases report a skip. Source test
success alone does not establish this artifact result.

The service, upstream fixtures and clients run together inside that test driver.
Passing it proves emitted-artifact composition and forwarding, not credential
isolation of a separate Agent container. The third case checks the rendered
Compose mount configuration only. Runtime isolation requires separate delivered
service and client containers, with only the session files, public trust and
workspace mounted into the client, plus inspection of the running client surfaces.
Select the existing isolation case with both delivered image identities:

```sh
REPOSITORY_CREDENTIALS_SERVICE_IMAGE=repository-credentials:local \
REPOSITORY_CREDENTIALS_CLIENT_IMAGE=repository-credentials-client:local \
  node --test tests/integration/repository-credentials-isolation.test.mjs
```

Without either selector, the isolation case skips; supplying only one fails.
Keep its result separate from the combined fixture, Compose configuration
checks and live-provider qualification.

## Run an authorized live smoke

Prepare a running gateway on valid DNS/TLS port 443, its private operator socket,
and a disposable repository explicitly authorized for temporary branch, PR,
issue and comment writes. Use the exact pinned client. Select only this file:

```sh
REPOSITORY_CREDENTIALS_LIVE=1 \
REPOSITORY_CREDENTIALS_LIVE_AUTHORIZED=1 \
REPOSITORY_CREDENTIALS_LIVE_CONTROL_SOCKET=/run/credential-service/control.sock \
REPOSITORY_CREDENTIALS_LIVE_CA=/run/credential-service/public-ca.pem \
  node --test tests/integration/repository-credentials-live.test.mjs
```

The smoke admits a five-minute `git-full` session through the real control API.
It clones and pushes unique temporary branches, exercises REST and native PR
creation plus issue/comments. Before each create, it registers reconciliation
using a unique run marker and, for PRs, the unique head branch. Cleanup inspects
at most five pages of 100 resources through existing routes in the admitted
repository; it closes or deletes only a single matching owned resource. A lost
creation response never causes creation to be replayed. Missing, ambiguous or
truncated identity inspection fails cleanup and reports the run marker for
operator reconciliation.

Work commands have a 90-second overall budget and terminate their owned process
groups on timeout, output overflow or cancellation. Resource cleanup has a
separate 60-second budget. Session cleanup always runs afterward, validates the
close acknowledgement, and polls status for disposal under a 10-second polling
budget; each control request also has its production five-second deadline.
Local `CLOSED` status is distinct from `DISPOSED`: active uses, pending or
uncertain credentials, and auxiliary obligations must all resolve. Cleanup
failures fail the test and require operator review of the disposable repository. Keep provider keys and installation tokens on the
service side; the test client receives only the gateway bearer.

Without the live selector the case explicitly reports unavailable live-provider
evidence. If selected, missing authorization, socket, CA, routing or credentials
fails. Controlled upstream success proves service behavior against those
protocol fixtures; it does not establish live GitHub compatibility or a real
thirteen-hour provider soak.
