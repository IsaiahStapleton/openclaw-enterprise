# Development style

Read this before developing or changing code. These rules complement the
[platform design](design.md) and the [repository instructions](../AGENTS.md).

## Build platform capabilities

We are developing a platform. Every new capability must belong to a platform
primitive, rather than exist as a one-off implementation. First identify the
existing primitive that owns the capability. Extend that primitive when its
contract is insufficient, or introduce a new primitive when none fits, within
the approved architecture and milestone scope.

Implement the owning primitive's contract and connect the capability to its
platform lifecycle and composition. A standalone helper or a class named after
a primitive does not establish that integration. Internal helpers may support
the implementation, but must not substitute for the platform capability.

For example, GitHub App token issuance should belong to an appropriate platform
primitive. If implemented as a Provider, it must conform to the
[Provider contract](reference/providers.md) and participate in Provider
composition; exposing only token minting and revocation methods is insufficient.
This is the design concern illustrated by
[PR #136](https://github.com/openclaw/openclaw-enterprise/pull/136).

## Require integration tests; reject low-value tests

**Do not add low-value tests.** We place low value on unit tests in general.
Prefer tests that prove new functionality works through real platform boundaries
and produces observable results.

**New functionality requires integration tests. Omitting them requires an
explicit human override.** Record the approved scope and reason in the PR.
Missing infrastructure, passing unit tests, or an agent's judgment cannot grant
that override.

Integration tests must exercise the supported implementation path and relevant
dependencies, including consequential failure behavior. Mocks that replace the
behavior being proved do not satisfy this requirement. Follow the repository's
[testing skills](../AGENTS.md#developer-skills) for test selection and proof.

Avoid tests that merely restate implementation details, assert mock behavior,
check framework guarantees, or duplicate existing coverage without protecting
an additional behavior. Add a unit test only when it protects a meaningful
behavior economically; it does not replace required integration coverage.

## Export public modules through a top-level index

**Do not use `package.json` to export random modules.** Prefer explicit, curated
exports from the package's top-level `index.ts`. Keep implementation files
separate and expose their intended public API through that entry point.

Use `export type` for public types. Keep helpers private unless consumers need
them. The package export map should route consumers to the public entry point,
not mirror internal files with ad hoc subpath exports. Any separate entry point
must represent a deliberate platform or runtime boundary, not a shortcut for
accessing an internal module.
