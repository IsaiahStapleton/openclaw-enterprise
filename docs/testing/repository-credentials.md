# Repository credential tests

Run from the repository root with Node 24, Git, OpenSSL, and prepared workspace dependencies. Tests generate their own bounded local key/TLS fixtures.

```sh
pnpm credentials:build
node --test tests/conformance/repository-credentials-contracts.test.mjs \
  tests/conformance/repository-credentials-custody.test.mjs \
  tests/conformance/repository-credentials-github.test.mjs \
  tests/conformance/repository-credentials-lifecycle.test.mjs \
  tests/conformance/repository-credentials-sessions.test.mjs \
  tests/integration/repository-credentials-config.test.mjs \
  tests/integration/repository-credentials-package.test.mjs
```

Common-owner tests cover custody, immutable admission, controlled-time replacement, closure, and uncertainty. GitHub and the alternate fixture use the same service owners.
