# Repository credential tests

Run from the repository root with Node 24, Git, OpenSSL, and prepared workspace dependencies. Tests generate their own bounded local key/TLS fixtures.

```sh
pnpm credentials:build
node --test tests/conformance/repository-credentials-contracts.test.mjs \
  tests/conformance/repository-credentials-github.test.mjs \
  tests/integration/repository-credentials-config.test.mjs \
  tests/integration/repository-credentials-package.test.mjs
```

These checks prove adapter/configuration behavior and detached emitted configuration loading. Common lifecycle and forwarding qualification follow their implementations.
