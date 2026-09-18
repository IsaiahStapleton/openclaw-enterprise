# Repository credential tests

Run from the repository root with Node 24, Git, OpenSSL, and prepared workspace dependencies. Tests generate their own bounded local key/TLS fixtures.

## Check source authority boundaries

Run `node scripts/verify-repository-credentials-boundary.mjs` after changing the
service. The same check runs through `pnpm check:workspace` in baseline CI. It
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
runtime isolation, or the controlled tests below and separate live-provider qualification.

## Run controlled tests

```sh
pnpm credentials:build
node --test tests/conformance/repository-credentials-backend-conformance.test.mjs \
  tests/conformance/repository-credentials-contracts.test.mjs \
  tests/conformance/repository-credentials-custody.test.mjs \
  tests/conformance/repository-credentials-github.test.mjs \
  tests/conformance/repository-credentials-lifecycle.test.mjs \
  tests/conformance/repository-credentials-ownership-boundaries.test.mjs \
  tests/conformance/repository-credentials-sessions.test.mjs \
  tests/integration/repository-credentials-client-config.test.mjs \
  tests/integration/repository-credentials-config.test.mjs \
  tests/integration/repository-credentials-control.test.mjs \
  tests/integration/repository-credentials-gh.test.mjs \
  tests/integration/repository-credentials-git.test.mjs \
  tests/integration/repository-credentials-http.test.mjs \
  tests/integration/repository-credentials-package.test.mjs \
  tests/integration/repository-credentials-shutdown.test.mjs \
  tests/integration/repository-credentials-transport-bounds.test.mjs
```

Common-owner tests cover custody, immutable admission, controlled-time replacement, closure, and uncertainty. GitHub and the alternate fixture use the same service owners.

Real Git and pinned gh 2.100.0 use the production TLS listener and client launcher. Prepare Docker, a Node/Git fixture image in `REPOSITORY_CREDENTIALS_NODE_IMAGE`, and the exact binary in `REPOSITORY_CREDENTIALS_GH_BINARY`. Fixtures run with networking disabled, a valid gateway DNS SAN, and canonical GH_HOST. CI prepares a source toolchain image and extracts its checked binary. Source fixtures prove routing and remote fixture state; delivered-artifact, separate-container isolation, and live-provider qualification remain separate delivery gates.
