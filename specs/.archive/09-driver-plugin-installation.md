# Feature Spec: Installation-scoped Driver package extensions

**Date:** 2026-08-21
**Status:** Complete
**Owner:** OCC controller / trusted Installation operator
**Source baseline:** `origin/main@f0020932b28f`.

## Problem and Decision

A trusted Installation operator can select an installed, lockfile-pinned npm
Driver for any supported capability: IAM, Compute, or Configuration. The same
package mechanism works in development and production. Existing first-party
Drivers remain bundled defaults. Trust comes from exact operator-selected
dependencies, immutable deployment, and existing authorization boundaries, not
the runtime environment or a particular Driver class.

The selected contracts are `DriverImplementation`, `IAMDriver`, `ComputeDriver`,
and `ConfigurationDriver` in `packages/contracts/src/index.ts:277`,
`packages/contracts/src/index.ts:282`, `packages/contracts/src/index.ts:309`, and
`packages/contracts/src/index.ts:318`. Existing integration points include
production composition in `apps/controller/src/composition/production.ts:27`,
production admission in `apps/controller/src/admission/internal-bearer.ts:46`,
Fastify in `apps/controller/src/index.ts:440`, and worker policy refresh in
`apps/controller/src/worker.ts:240`.

## Scope

**Changes**

- Allow one explicitly selected, installed npm package for each supported IAM,
  Compute, and Configuration Driver in every environment.
- Load package-owned schemas and implementations through one trusted startup
  path; validate capability, identity, configuration, and structural contracts.
- Construct selected IAM Drivers against fresh persisted authorization state in
  both the API and worker.

**Does not change**

- Installation ownership, Namespace isolation, exact-resource authorization,
  admission, actor revocation, attributed audit, or admitted revisions.
- One immutable controller image shared by API and worker; existing nonroot,
  read-only container restrictions and Installation Secret ownership.
- No marketplace, installation API, tenant installation, automatic discovery,
  new resource or database table, hot reload, public plugin SDK, OAuth, runtime
  compiler, custom package manifest, rollout coordinator, or defaults engine.
- Existing bundled local-test Compute coverage is unrelated and remains intact.

## Contract

### Selection and module exports

Keep `drivers.<capability>.{id,implementation,version,configuration,package}` as
the single selected-Driver authority. `package` is optional for IAM, Compute,
and Configuration in every environment. Omitting it selects the existing
bundled implementation. Each selected capability has its own explicitly
approved package, schema, configuration, and structural Driver contract.

```yaml
drivers:
  iam:
    id: acme-iam
    implementation: acme/iam
    version: 1.0.0
    package: "@acme/enterprise-iam-driver"
    configuration: {}
  compute:
    id: local-test-compute
    implementation: acme/local-test-compute
    version: 1.0.0
    package: "@acme/test-compute-driver"
    configuration:
      provisionPath: "/tmp/local-test"
  configuration:
    id: acme-configuration
    implementation: acme/configuration
    version: 1.2.3
    package: "@acme/enterprise-configuration-driver"
    configuration:
      endpoint: "https://config.acme.example"
```

Reject unknown selection keys, unsafe prototype keys, plaintext secrets,
`secretRef`, reserved external `occ/` implementation names, and package values
that are not exact npm names. Defaults remain explicit operator configuration.
Package-backed Drivers validate against their own exported closed configuration
schema; bundled Kubernetes-only configuration rules do not leak into unrelated
external implementations.

Each package is a strictly exact direct production dependency of
`apps/controller/package.json`, pinned by `pnpm-lock.yaml`; reject semver ranges
and unpinned versions. Normal npm metadata supplies identity, exact version, and
a compiled ESM entry:

```json
{
  "name": "@acme/enterprise-iam-driver",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./dist/index.js" }
}
```

Resolve only selected direct controller dependencies. A trusted internal
`packageRoot` override permits integration tests to install `file:...tgz`
fixtures into an isolated temporary dependency root; neither override nor local
tarball selection is exposed through tenant or operator YAML. Require matching
configured and installed identity/version, compiled exports, package-root
containment, a closed configuration schema, semantic validation, and the exact
selected capability, identity, implementation, and required methods.

```js
export const configurationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};
export function validateConfiguration(configuration) {}
export function createDriver({ id, implementation, configuration, state }) {}
```

Only selected IAM package factories receive `state`, the freshly loaded persisted
IAM policy. The startup result carries a selected-package-bound
`createIAMDriver(persistedNativeIAMState)` factory; API composition and worker
policy refresh call that same selected factory after loading current state.
The worker also supplies its exact selected Configuration Driver and the IAM
Driver created during worker startup through the Compute lifecycle-owner contract.
Bundled IAM uses the existing native constructor with the exact selected
implementation identity.
Require exact Driver identity, `lookupIdentity`, `authorize`, principal lookup,
fresh actor-revocation checks, exact-resource decisions, and attributable audit.
Never substitute `NativeIAMDriver` after selecting an external IAM package.

Compute acceptance is structural: require `ensureNamespace`, `deleteNamespace`,
`prepareRevision`, and `retireRevision`; validate optional lifecycle hooks and
run an optional behavioral `preflight` before activation when supplied. Keep
immutable-image, projected-service-account-token, approved runtime, and existing
Kubernetes preflight checks for bundled Kubernetes Compute configuration only.
External Compute owns its schema and never bypasses admission, authorization,
scope, or audit. Environment and class identity are not trust proxies.

`loadInstallationConfiguration` remains the sole public asynchronous startup
entry point and returns the selected Installation, Compute Driver,
Configuration Driver, and state-aware IAM factory. Pass validated modules
directly to private construction. Preserve OCC registration collision checks
and fail closed on missing packages, invalid exports, identity mismatches,
invalid policy state, and incompatible capability contracts. Introduce no
global module registry, duplicate selection authority, or staged-activation
framework.

Installed package code has full controller access to credentials, cluster
identity, and tenant operations. Integrity checks and schemas do not sandbox
it or establish publisher provenance; only the trusted operator controlling
reviewed dependencies, image publication, and the Installation Secret approves
selection.

### Installation, deployment, and removal

Install each reviewed public, scoped, or private Driver as an exact production
dependency:

```bash
pnpm --filter @openclaw-enterprise/controller \
  add '@acme/enterprise-iam-driver@1.0.0' \
  --save-exact --ignore-scripts
```

For private registries, supply operator-owned npmrc credentials only through
`NPM_CONFIG_USERCONFIG` and the existing ephemeral BuildKit dependency-stage
secret (`Dockerfile:15`). `.dockerignore` already excludes `.npmrc` and
`**/.npmrc` (`.dockerignore:10`). Production dependencies install with
`pnpm install --frozen-lockfile --prod --ignore-scripts`. Never put tokens in
source, build arguments, image layers, lockfiles, Helm, startup YAML, logs, or
runtime pods. Drivers ship compiled JavaScript; package lifecycle scripts never
run.

Deploy the same immutable image to API and worker. Changing package selection or
configuration requires a restart; adding, updating, or removing a package also
requires a reviewed dependency, lockfile, and rebuilt image. Roll back the
previous image and matching configuration. No persistent installation state,
deployment coordinator, or runtime package installer is introduced.

## Implementation

1. In `apps/controller/src/composition/installation-config.ts`, allow optional
   packages for all three capabilities in every mode, load only exact direct
   selected dependencies, validate package-owned schemas and structural
   contracts, and return a package-bound state-aware `createIAMDriver` beside
   the selected Compute and Configuration Drivers. Preserve bundled
   Kubernetes-specific immutable-image and projected-token checks without
   applying them to external Compute schemas.
2. In `apps/controller/src/composition/production.ts`, construct the selected
   IAM Driver from persisted policy, retain real
   `InternalBearerAdmissionVerifier`, principal lookup, exact selection,
   authorization, audit, and registration, and accept structural Compute and
   Configuration Drivers. Run optional behavioral Compute preflight; preserve
   existing bundled Kubernetes preflight. Never gate selection on `instanceof`
   or environment.
3. In `apps/controller/src/worker.ts` and its startup wiring, accept the selected
   structural Compute Driver and invoke the same selected
   `createIAMDriver(currentPersistedState)` for fresh policy checks. Preserve
   selected Configuration and startup IAM lifecycle owners through the Compute
   lifecycle-owner contract, failing closed when Compute cannot accept one.
   Preserve
   actor revocation, exact-resource restrictions, authorization denial,
   attributable audit, and worker failure behavior.
4. Preserve existing immutable-image packaging, disabled lifecycle scripts,
   ephemeral npmrc secret handling, npmrc build-context exclusion, and shared
   API/worker image. Document installation, trust, restart, and rollback in
   `docs/drivers/`; update directly relevant guides.
5. Add separately authored IAM, Compute, and Configuration integration fixtures
   under `tests/fixtures/`, pack and actually install them only into an isolated
   temporary dependency root, and exercise them through
   `tests/integration/`. Never change checkout `package.json`, `pnpm-lock.yaml`,
   or `node_modules`. Preserve the unrelated existing bundled
   `apps/controller/src/drivers/compute/local-test/index.ts` and its direct-import
   tests unchanged.

## Verification

| Required outcome                                                    | Automated acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Three externally installed capabilities load in production mode.    | Pack three separately authored scoped IAM, Compute, and Configuration fixture packages; install their compiled tarballs using real pnpm in an isolated temporary controller dependency root; execute `pnpm install --offline --frozen-lockfile --prod --ignore-scripts`; and load all three through the actual selected package mechanism in production mode. Exercise one bundled default as a separate control.                                                                                                                                                                          |
| Production admission, packaged IAM, and Compute operate end to end. | Compose the real `InternalBearerAdmissionVerifier`, Fastify app, OCC, and selected packaged IAM/Compute/Configuration Drivers using honest in-memory platform state. Submit authenticated allowed and denied real API requests with `app.inject`; assert packaged IAM principal lookup, exact authorization, denial, and audit. Create a Namespace with `POST /namespaces`, invoke real `OCC.handleNamespaceLifecycle`, and assert the installed Compute package itself creates `/tmp/local-test`. No direct fixture imports, injected fake Driver objects, or monkeypatched provisioning. |
| Worker honors installed Driver contracts and current policy.        | Exercise production-mode worker structural acceptance of the selected packaged Compute Driver and package-bound IAM factory; verify state-aware IAM construction preserves fresh-policy identity and actor-revocation/authorization behavior at the supported integration boundary. Do not claim PostgreSQL-backed worker execution without a real database.                                                                                                                                                                                                                               |
| Invalid package selections fail closed.                             | Reject missing packages, non-direct or non-exact dependencies, identity/version mismatches, invalid schema/configuration, missing capability methods, mismatched returned Driver identity, unresolvable principals, and invalid persisted IAM policy without falling back to bundled Drivers.                                                                                                                                                                                                                                                                                              |
| Packaging and authority remain intact.                              | Execute the isolated offline frozen production install with lifecycle scripts disabled; verify directly from source the Dockerfile ephemeral npmrc secret mount, `.dockerignore` npmrc exclusion, and same Helm image for API and worker. Preserve unauthorized/cross-Namespace denial. No container image is built or inspected.                                                                                                                                                                                                                                                          |

The production-mode in-memory composition proves real production admission,
Fastify routing, OCC authorization, selected package execution, and Driver
effects. It does not prove PostgreSQL persistence, a live production worker,
a Kubernetes cluster, private-registry authentication, provider credentials,
container-image construction, or an Agent turn without those real dependencies.

## Open Decisions

- Whether Enterprise should later publish a stable typed SDK; structural
  package modules suffice for this feature.
- Whether specific operators want stronger package provenance or sandboxing;
  those are separate supply-chain capabilities and are not provided here.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-21 13:51]: Defined source-backed bundled and external Installation Driver package contracts, immutable packaging, private registry isolation, and real integration acceptance. (01a02610-d4a9-7d02-ad7a-462ff1970399 - a11911c)
- [2026-08-21 15:54]: Simplified selection to standard npm metadata and existing Driver exports, removed custom manifests/defaults and rollout coordination, and reduced acceptance to real operational outcomes. (01a02688-4734-7472-b9b4-f35e74be7908 - f002093)
- [2026-08-21 15:59]: Clarified selected-package scope and made private npmrc build-context exclusion an implementation requirement. (01a02610-d4a9-7d02-ad7a-462ff1970399 - f002093)
- [2026-08-21 15:59]: Removed metadata trailing whitespace flagged by Markdown diff checks. (01a02610-d4a9-7d02-ad7a-462ff1970399 - f002093)
- [2026-08-21 16:03]: Applied approved simplification pass, tightened exact source references, and preserved the single selected package plus existing Driver validation design. (01a02610-d4a9-7d02-ad7a-462ff1970399 - f002093)
- [2026-08-21 16:09]: Approved development-only external Compute selection and required an actually installed TestComputeDriver to provision `/tmp/local-test` through the real OCC lifecycle while preserving Kubernetes-only production Compute and native IAM. (01a02696-5ae9-7d63-94a9-7ff990fba97b - b3324a3)
- [2026-08-21 16:13]: Required trusted isolated integration package roots, preserved existing bundled local-test coverage, and prohibited checkout dependency mutations or bundled fixture substitutes. (01a02696-5ae9-7d63-94a9-7ff990fba97b - b3324a3)
- [2026-08-21 16:26]: Required exact production dependency pins, limited local tarballs to trusted isolated test roots, and aligned npmrc and offline-install verification claims with implemented source rather than unperformed container inspection. (01a02696-5ae9-7d63-94a9-7ff990fba97b - 4fe8091)
- [2026-08-21 17:28]: Consolidated selected Driver loading and construction into one asynchronous startup boundary with explicitly passed validated modules, preserving fail-closed factory checks and real installation proof. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - d17a87541cbebc8e333bd00bd90c42e734d91a80)
- [2026-08-21 17:57]: Applied explicit product correction enabling operator-selected IAM, Compute, and Configuration Driver packages in every environment, including production; specified state-aware selected IAM, structural Compute, and honest three-package production-mode integration proof. (01a02696-5ae9-7d63-94a9-7ff990fba97b - a45b01d)
- [2026-08-21 20:12]: Completed the implementation, exact IAM identity and worker lifecycle-owner fixes, installed three-package production-mode proof, verification, and PR handoff. (01a02696-5ae9-7d63-94a9-7ff990fba97b)
