# Repository credential tests

Run from the repository root with Node 24, Git, OpenSSL, and prepared workspace dependencies. Tests generate their own bounded local key/TLS fixtures.

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
