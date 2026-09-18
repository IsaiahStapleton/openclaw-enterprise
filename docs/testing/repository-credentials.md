# Repository credential tests

Run from the repository root with Node 24, Git, OpenSSL, and prepared workspace dependencies. Tests generate their own bounded local key/TLS fixtures.

## Check source authority boundaries

Run `node scripts/verify-repository-credentials-boundary.mjs` after changing the
service. The same check runs through `pnpm check:workspace` in baseline CI. It
parses every credential-service source file using the workspace's pinned
Prettier TypeScript parser. Runtime imports and re-exports must stay within the
scanned source or use reviewed external modules and named members. Erased
`import type` and `export type` declarations remain available; inline type
specifiers can preserve a runtime module load. The GitHub provider's raw HTTPS sender has an explicit
consumer list; the protected-file, signing, and configuration-check owners
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
node --test tests/conformance/repository-credentials-contracts.test.mjs \
  tests/conformance/repository-credentials-github.test.mjs \
  tests/integration/repository-credentials-config.test.mjs \
  tests/integration/repository-credentials-package.test.mjs
```

These checks prove adapter/configuration behavior and detached emitted configuration loading. Common lifecycle and forwarding qualification follow their implementations.
