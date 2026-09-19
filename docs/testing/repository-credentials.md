# Repository credential service tests

Run these tests from the repository root with Node.js 24, Git, OpenSSL, Docker,
and the prepared workspace dependencies. The fixtures generate fresh RSA and
TLS material, start bounded local upstreams, and remove their temporary files,
listeners and containers when the tests finish. They do not load ambient
GitHub credentials.

## Reuse fixtures by ownership

Keep scenario setup explicit and share the part that has a common owner:

- `builders.mjs` creates data with visible overrides. `requestHead` preserves raw
  targets, receipt time and framing so malformed-request tests reach the intended
  boundary.
- `resources.mjs` owns cleanup registration and failure reporting.
  `service-resources.mjs` composes the real key, service and listener owners;
  scenarios keep their distinct clocks, identities and failure triggers.
- The GitHub fixture separates token authority, repository resources and HTTP
  dispatch. The alternate fixture keeps credential identity and renewal state
  together while separating route policy and its upstream.

Name table cases by the rejected input or expected outcome. Keep expected values
independent of the helper being exercised. Extract shared setup when multiple
scenarios need it; keep fault ordering and observable assertions in the test.
Protocol fixtures model the provider boundary, while production owners remain
responsible for custody, authorization and cleanup.

## Check source authority boundaries

Run `node scripts/verify-repository-credentials-boundary.mjs` after changing the
common owners in `apps/controller/src/drivers/repo/credentials/`, the GitHub
backend/client in `apps/controller/src/drivers/repo/github/credentials/`, or the
separate-process assembly in `apps/controller/src/composition/repository-credentials/`. The same check runs through `pnpm check:workspace` in baseline CI. It
parses every credential-service source file using the workspace's pinned
Prettier TypeScript parser. Runtime imports and re-exports must stay within the
scanned source or use reviewed external modules and named members. Erased
`import type` and `export type` declarations remain available; inline type
specifiers can preserve a runtime module load. The two raw HTTPS sender helpers have explicit
consumer lists; the listener, private-file, signing, and client-command owners
have separate I/O allowances. New network packages, raw global network or loader
access, and new process-output owners fail the check.

The credential-service maintainers own the allowlists in the
[source guard](../../scripts/verify-repository-credentials-boundary.mjs). A new
privileged member, owner, sender consumer, or external dependency requires
explicit security review in the same change. Explain the required authority,
its caller and scope, why an existing owner cannot provide it, and the negative
test that protects the new boundary. Do not add a wildcard allowance to silence
a failure. The [guard regression test](../../tests/conformance/repository-credentials-source-boundary.test.mjs)
adds forbidden capabilities to a disposable copy of the real source tree.

This is an accidental-regression guard for reviewed source. It does not perform
whole-program dataflow analysis, prove that allowed owners handle secrets
correctly, or sandbox malicious code. It does not replace capability design,
runtime isolation, or the controlled and live tests below.

## Run controlled tests

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

Build the final artifacts and run the detached package check first:

```sh
pnpm credentials:build
node --test tests/integration/repository-credentials-package.test.mjs
```

The builder starts from the controller's emitted code and writes separate
`.build/repository-credentials/service` and `.build/repository-credentials/client`
closures. The service includes `repository-credentials.js` and
`composition/repository-credentials/check-config.js`; the client includes
`drivers/repo/github/credentials/client/{launch,operator,git-helper}.js` and their
runtime dependencies. Detached loading must work without workspace source or
runtime `node_modules`.
The detached check starts the emitted service, admits and closes a session over
its Unix socket, and invokes the emitted launcher and Git helper. The context
case rebuilds both Docker inputs and rejects source files, compiler artifacts
and linked inputs.

Build the service and client images using the
[operator guide](../guides/repository-credentials.md#container-images). Then
combine those artifacts in an owned test-only image. Use the same local Docker
builder for all three builds so it resolves the delivered input images:

```sh
docker build --builder default --load --pull=false \
  --build-arg SERVICE_IMAGE=repository-credentials:local \
  --build-arg CLIENT_IMAGE=repository-credentials-client:local \
  -f tests/fixtures/repository-credentials/Dockerfile.qualification \
  -t repository-credentials-qualification:test .
REPOSITORY_CREDENTIALS_TEST_IMAGE=repository-credentials-qualification:test \
  node --test tests/integration/repository-credentials-container.test.mjs
```

Record the source commit/tree, working-tree changes, both input image IDs and the
qualification image ID with results:

```sh
docker image inspect --format '{{.Id}} {{json .Config.Entrypoint}}' \
  repository-credentials:local repository-credentials-client:local \
  repository-credentials-qualification:test
```

The first case imports `/app/dist`, exercises the emitted production service and
client entrypoints, and uses the same long-session acceptance sequence. The
second runs alternate-backend conformance through those emitted common owners,
including renewal, private authentication, and streamed callback drainage. The
qualification image is a test driver; it is not a separate supported deployment.
Without an explicit image selector, these cases report a skip. Source test
success alone does not establish this artifact result.

The service, upstream fixtures and clients run together inside that test driver.
Passing it proves emitted-artifact composition and forwarding. The Compose case
renders `deploy/examples/repository-credentials/compose.yaml` and checks declared
mount separation; it does not start those services.

## Verify separate running containers

Select both delivered images to run the distinct isolation case:

```sh
REPOSITORY_CREDENTIALS_SERVICE_IMAGE=repository-credentials:local \
REPOSITORY_CREDENTIALS_CLIENT_IMAGE=repository-credentials-client:local \
  node --test tests/integration/repository-credentials-isolation.test.mjs
```

The harness resolves the selectors to different immutable image IDs, starts
separate service and client containers, and inspects running mounts, processes,
client files and sanitized outputs. The client receives the selected session,
public trust and workspace; service inputs, the private control socket and
sibling sessions remain outside its mounts. Actual Git and pinned `gh` use the
service against a controlled provider. This proves the tested ordinary-container
custody boundary, without a network-confinement or live-GitHub claim.

Omitting both selectors skips this case; selecting only one fails. Selected
images, Docker and other required prerequisites must be available. Record the
exact images, case results and cleanup outcome separately from the combined
qualification image and rendered Compose check.

## Record each evidence boundary

| Check                         | Evidence it can establish                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Source tests and source guard | Behavior of real owners against named protocol fixtures; reviewed import/I/O boundaries.                      |
| Detached package check        | Emitted entrypoints and runtime dependency closure without source fallback.                                   |
| Combined qualification image  | Emitted service/client composition, controlled hour-13 push/API operations and alternate-backend conformance. |
| Rendered Compose              | Declared paths and mount separation.                                                                          |
| Separate running containers   | Delivered image identity and observed client/service custody for the exercised commands.                      |
| Authorized live smoke         | Real provider behavior and cleanup for the selected repository, grant and client version.                     |

Retain selectors, versions, source/artifact/image identities, pass/fail/skip counts
and cleanup results. Missing selectors leave evidence unavailable; they do not
qualify the corresponding boundary. Historical installed or live results stay
bound to their original artifacts. After changes, record justified equivalence
for each affected assertion or rerun its owning check. These packaging checks do
not establish OCC/worker/Compute integration, an installed ordinary-Agent model
contribution, a real-time thirteen-hour soak or release readiness.

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
