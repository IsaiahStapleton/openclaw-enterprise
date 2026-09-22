# Repository credential tests

Run from the repository root with Node 24, Git, OpenSSL, and prepared workspace dependencies. Tests generate their own bounded local key/TLS fixtures.

## Check source authority boundaries

Run `node scripts/verify-repository-credentials-boundary.mjs` after changing the
service. The same check runs through `pnpm check:workspace` in baseline CI. It
parses the common credential engine, GitHub backend, and credential composition
roots under `apps/controller/src/` using the workspace's pinned Prettier
TypeScript parser. Runtime imports and re-exports must stay within the scanned
source or use reviewed external modules and named members. Erased
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
  tests/conformance/repository-credentials-custody.test.mjs \
  tests/conformance/repository-credentials-github.test.mjs \
  tests/conformance/repository-credentials-lifecycle.test.mjs \
  tests/conformance/repository-credentials-sessions.test.mjs \
  tests/integration/repository-credentials-config.test.mjs \
  tests/integration/repository-credentials-package.test.mjs
```

Common-owner tests cover custody, immutable admission, controlled-time replacement,
closure, and uncertainty. GitHub and the alternate fixture use the same service
owners through the private backend contract. Configuration cases exercise the
actual protected-file loader and generated RSA/TLS inputs. The package case
checks the emitted configuration command outside its source checkout.

## Proof boundaries

These checks exercise the callable core and local configuration artifact. The
controlled clock advances beyond hour thirteen while retaining the original
session and bearer; that is not a thirteen-hour wall-clock soak. Fixture provider
responses and keys do not establish live GitHub permissions or behavior.

This cut has no delivered HTTPS/control listener, Git/gh client bundle, container,
or platform consumer. Their connected checks belong with those implementations.
A source move, successful build, or detached configuration check does not prove
installed process separation, runtime credential custody, or a live Agent
contribution. Evidence for another source or artifact must identify that version;
it does not automatically qualify a changed build.
