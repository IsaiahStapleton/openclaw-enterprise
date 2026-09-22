# Repository credential tests

Run from the repository root with Node 24, Git, OpenSSL, and prepared workspace
dependencies. Tests generate local key/TLS fixtures and use controlled provider
peers. Select Docker and pinned-gh inputs separately for the real-client cases
below; these tests require no live GitHub credentials.

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
service. The same check runs through `pnpm check:workspace` in baseline CI. It
parses the configured common, GitHub, client, composition, and dedicated-entrypoint
source roots using the workspace's pinned Prettier TypeScript parser. Those roots
must exist; a missing owner must not silently reduce the scan. Runtime imports
and re-exports must stay within the scanned source or use reviewed external modules and named members. Erased
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
runtime isolation, or the controlled tests below and separate live-provider qualification.

## Run controlled tests

Build the workspace and assemble the separate service/client closures, then run
the common-owner and local transport cases:

```sh
pnpm credentials:build
node --test tests/conformance/repository-credentials-contracts.test.mjs \
  tests/conformance/repository-credentials-custody.test.mjs \
  tests/conformance/repository-credentials-github.test.mjs \
  tests/conformance/repository-credentials-lifecycle.test.mjs \
  tests/conformance/repository-credentials-ownership-boundaries.test.mjs \
  tests/conformance/repository-credentials-sessions.test.mjs \
  tests/integration/repository-credentials-client-config.test.mjs \
  tests/integration/repository-credentials-router.test.mjs \
  tests/integration/repository-credentials-config.test.mjs \
  tests/integration/repository-credentials-control.test.mjs \
  tests/integration/repository-credentials-http.test.mjs \
  tests/integration/repository-credentials-package.test.mjs \
  tests/integration/repository-credentials-server-timeout.test.mjs \
  tests/integration/repository-credentials-shutdown.test.mjs \
  tests/integration/repository-credentials-transport-bounds.test.mjs
```

Common-owner tests cover custody, immutable admission, controlled-time replacement,
closure, and uncertainty. Local transport cases cover admission correlation,
separate listener capacity, TLS/header timing, framing, cancellation, streaming,
and finite shutdown. The client-file cases exercise the real private-file and
native configuration and credential-protocol owners.

The builder takes emitted modules from `apps/controller/dist` and stages service
and client artifacts under `.build/repository-credentials/`. The service contains
`dist/repository-credentials.js` and the check-config entrypoint. The client
currently seeds `launch.js`, `operator.js`, and `git-helper.js` under
`dist/drivers/repo/github/credentials/client/`; the native preparer is reachable
through `launch.js`. The source also has the gh-only `router.ts` entrypoint.
Packaging work in [PR #224](https://github.com/openclaw/openclaw-enterprise/pull/224)
must seed and qualify that router in the detached client closure before claiming
packaged gh routing.
The package test starts the detached service, admits and closes a session over
its Unix socket, and runs the emitted launcher and Git helper. Both artifacts
run without workspace source or runtime `node_modules`; missing modules fail
without a source fallback. No provider issuance is needed for that local test.

Client configuration cases run the generated include through actual Git
credential protocol and HTTPS requests. They cover optional suffix/case spelling,
exact host/port/username, private files, malformed or oversized protocol input,
CA conflicts and staged preparation. Router cases cover duplicate bindings,
explicit and stale pins, `.git` name overlap and generation replacement. Native
local hooks, aliases, moves, removals and worktrees remain usable independently
of helper selection. These assertions replace the former command-wide preflight,
ambient-configuration suppression and Git-shim traversal assumptions.

The real Git journey commits a move and removal before pushing and compares
upstream refs. Read-only deletion, closed-session denial and lost-response push
cases retain their observed request/ref assertions; uncertain writes must have
exactly one mutation dispatch. Multi-repository registry execution requires the
separate platform fixture composition and is not inferred from synthetic public
manifest selection cases.

### Real Git and pinned gh

Prepare Docker, a Node 24/Git/OpenSSL fixture image selected by immutable image ID
in `REPOSITORY_CREDENTIALS_NODE_IMAGE`, and the exact executable path in
`REPOSITORY_CREDENTIALS_GH_BINARY`. Check that the executable reports **gh 2.100.0**.
Then run:

```sh
node --test tests/conformance/repository-credentials-backend-conformance.test.mjs \
  tests/integration/repository-credentials-git.test.mjs \
  tests/integration/repository-credentials-native-paths.test.mjs \
  tests/integration/repository-credentials-gh.test.mjs
```

The fixtures run with external networking disabled, a valid gateway DNS SAN,
verified TLS, and canonical `GH_HOST=github.com`. They exercise the production
listener with stock Git loading generated configuration and pinned gh using its
private gateway configuration. The gh-router case records native child Git
through its private HOME configuration; the image system include remains a
separate platform qualification. The alternate backend
uses the same common owners while varying repository identity, authentication,
credential lifetime, and renewal behavior. It establishes conformance, not support
for another production provider.

The native-path cases clone, fetch new content and push through canonical GitHub
URLs with mixed owner/repository case, with and without `.git`. They observe
canonical upstream paths and accepted refs/content through the real classifier,
HTTPS sender and `git-http-backend`. Cold discovery challenges issue no token;
cold read-only receive-pack and representative raw-path/API denials contact no
upstream. Count the five container child cases separately from their host wrapper.
These cases do not add literal-`.git` repository or multi-repository registry
runtime proof; the existing helper ambiguity/pin cases remain their own evidence.

The `repository-credentials-container` CI lane prepares a source toolchain image,
records its ID, and extracts its checked gh binary. Its required inputs and test
files are listed in the [suite map](../../scripts/ci/test-suites.json). Missing
selected prerequisites, failures, skips, or cleanup errors do not establish a
passing selected lane. See [CI result accounting](ci.md).

## Record the evidence boundary

Record the exact source commit/tree, commands, client version, selected image
IDs, pass/fail/skip counts, and cleanup result. Distinguish these observations:

| Check                                       | What it establishes                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Common-owner and controlled source fixtures | Admission, custody, transport, and client behavior against controlled peers.                          |
| Detached emitted artifacts                  | Startup and module closure without source or runtime dependencies from the workspace.                 |
| Separate running service/client containers  | Delivered process and filesystem separation when the actual mounts and client surfaces are inspected. |
| Authorized live-provider execution          | Real GitHub App scope and operations for the recorded source, artifacts, and configuration.           |

The commands above cover controlled source tests and detached-artifact checks.
Separate-container and live-provider qualification need their own setup and
results. A green source lane does not establish installed custody, ordinary-Agent
platform integration, or release readiness. Earlier runtime results apply to
their recorded artifacts; changed artifacts need justified equivalence or the
smallest affected rerun. Never repeat an uncertain provider mutation merely to
obtain a clean test result.
