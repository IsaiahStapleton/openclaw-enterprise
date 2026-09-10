# Feature Spec: Driver installation lifecycle hooks

**Date:** 2026-09-09  
**Status:** Implemented locally; focused verification passed  
**Owner:** OCC controller and deployment tooling  
**Source baseline:** `ee53c7b562ab0d593a3bfb8ecfd6e700ee98a716` (`origin/main`).

## Problem and Decision

Let an Enterprise Driver initialize, upgrade and remove its installation-wide setup through three optional hooks: `onInstall`, `onUpdate` and `onUninstall`. An operator-run command calls them during deployment and records successful versions. Process restarts do not trigger hooks.

Before this change, [package loading](../docs/reference/drivers/selection.md) happens at startup; existing [Compute hooks](../packages/contracts/src/index.ts#L477-L486) concern Namespaces and AgentRevisions. Neither provided this installation-wide lifecycle.

## Scope

“Plugin” means a configured Enterprise Driver, including bundled Drivers. Preserve existing capability selection and trusted-package boundaries. Exclude hot reload, runtime package installation, upstream Gateway plugins, automatic resource migration and a general script/workflow engine.

## Contract

Add optional `Driver.lifecycleHooks` with this interface:

```ts
type DriverLifecycleContext = Readonly<{
  installationId: string;
  capability: DriverCapability;
  driverId: string;
  version: string;
  previousVersion?: string; // onUpdate only
  signal: AbortSignal;
}>;
interface DriverLifecycleHooks {
  onInstall?(context: DriverLifecycleContext): Promise<void>;
  onUpdate?(context: DriverLifecycleContext): Promise<void>;
  onUninstall?(context: DriverLifecycleContext): Promise<void>;
}
```

One database row per `(installationId, capability, driverId)` stores the implementation family and last successful version. Version comes from loader/selection metadata: the exact npm package version for external Drivers, an explicit descriptor version for bundled Drivers. Record selected Drivers even without hooks; adding hooks in a later version is still an update.

| Requested change | Action after successful callback |
| --- | --- |
| Selected instance has no row | Incoming `onInstall`; insert row. |
| Same identity/family, different version | Incoming `onUpdate` with both versions; update row. Downgrades count. |
| Same version, including configuration-only changes | No callback. |
| Explicit uninstall of a recorded instance | Outgoing `onUninstall`; delete row. |
| Uninstall without a row | No-op. A later reinstall calls `onInstall`. |

Missing hooks are successful no-ops. Changing package/implementation family requires uninstall then install. Setup changes require a new Driver version or its normal idempotent configuration reconciliation; configuration edits alone never trigger lifecycle hooks.

### Execution and failure

Provide `node scripts/driver-lifecycle.mjs apply` and `node scripts/driver-lifecycle.mjs uninstall --capability <capability> --id <id>`. Read selected instances from `OCC_CONFIG_PATH` and state through `OCC_DATABASE_URL`. Validate selection before callbacks; apply processes it in existing selection order. Omission from YAML never implicitly uninstalls a Driver.

Hooks execute as awaited JavaScript in the controller-side command process. The constructed Driver owns configuration, dependencies and explicitly mounted credentials; context is immutable and introduces no credentials API. Hooks may invoke packaged scripts, bounded by the same cancellation/deadline. Imports and constructors must not perform lifecycle effects. Never persist or log raw secrets.

Hold an Installation-scoped PostgreSQL session advisory lock on one dedicated connection throughout comparison, callbacks and receipt writes. Contention returns nonzero. Connection loss aborts the invocation; it cannot reconnect to commit a previous effect. Only write/delete a receipt after its hook succeeds.

Each command makes one attempt with a five-minute timeout. Errors return nonzero and leave the failing receipt unchanged; earlier successes remain. Abort owned subprocesses. Operators retain the same image/configuration and retry or repair partial effects before another change. Hooks must be idempotent or inspect external state: a crash after an external effect can repeat a callback. There is no exactly-once guarantee or automatic rollback.

### Deployment and uninstall

Run apply after migrations and singleton bootstrap, before exposing the new API/worker selection. For incompatible changes, operators stop/drain existing processes first; the database lock does not quiesce runtimes. No runtime inventory gates are added. Use ordered [Helm hook Jobs](../deploy/helm/openclaw-enterprise/templates/jobs.yaml): initialization at weight -10, then lifecycle at weight -5, including upgrades. Compose uses the same migration → bootstrap → lifecycle → API/worker order. Supply selected YAML, scoped credentials and required egress; isolate hooks from migration/bootstrap secrets and never use parallel regular containers for these phases.

Uninstall uses the retained outgoing image, configuration and credentials, verified against the receipt, before package removal or incompatible migrations. Block before calling the hook when platform resources, retained revisions, cleanup work or Provider bindings still depend on the Driver. Compute/Configuration ownership lacking a Driver ID requires capability-wide checks. [Agent/revision storage](../packages/occ/src/state/platform-state.ts#L61-L105) has no generic decommission/retirement marker; inactive revisions do not prove cleanup. Required-capability replacements still need supported migration. Hooks remove only their own setup; success is required before discarding outgoing artifacts.

Historical installation cannot be inferred. On first rollout, an operator runs `apply --record-existing` from the exact outgoing image/configuration with this command included, before applying the desired release. Only an empty receipt table permits it. It records actual loaded package/bundled versions without hooks or user-supplied version overrides. Never automatically seed from new desired configuration; subsequently added Drivers must receive `onInstall`.

Example: selecting v1 calls `onInstall`; restarting calls nothing; deploying v2 calls v2's `onUpdate(previousVersion: "v1")`; explicit uninstall calls retained v2's `onUninstall`, then removes its receipt.

## Implementation

Implemented in the local working tree:

1. Extended [contracts](../packages/contracts/src/index.ts#L398-L403) and [selection metadata/loading](../apps/controller/src/composition/installation-config.ts) with optional hooks and authoritative versions.
2. Added the receipt table, dedicated-session locking and conservative resource-reference checks under `packages/occ/src/state/`.
3. Implemented `scripts/driver-lifecycle.mjs` with apply, explicit outgoing uninstall and the one-time record-existing option.
4. Packaged the command and ordered deployment phase; updated the [Driver reference](../docs/reference/drivers/selection.md), [loading flow](../docs/flows/driver-plugin-loading.md) and [deployment guide](../docs/guides/deploy.md).

## Verification

| Outcome | Evidence required during implementation |
| --- | --- |
| Correct lifecycle | Packaged fixtures prove install, update/downgrade, uninstall/reinstall, missing hooks and unchanged/config-only no-ops. |
| Reliable receipts | Real PostgreSQL races, connection loss, timeout and crash-after-effect prove serialization, unchanged failed receipts and safe repeated callbacks. |
| Safe uninstall | Realistic resources/revisions/bindings block hooks; wrong outgoing versions fail; successful cleanup deletes the receipt. |
| Existing installations | Exact outgoing selection seeds without callbacks; repeat seeding fails; later additions/updates dispatch correctly, including formerly hook-free Drivers. |
| Deployment ordering | Disposable Compose/Helm proof covers ordered phases, scoped credentials, incompatible-change draining and retained outgoing code. |
| Trusted inputs | Invalid package/hook/identity fails before execution; no tenant lifecycle API or raw-secret persistence/logging. |


### Local verification (2026-09-09)

- Passed: 14 real PostgreSQL lifecycle cases; 18 package/startup cases; 10 dev-up cases; 28 CI runner/preparation cases; workspace boundary and CI ownership audit.
- Disposable Compose proved migration → bootstrap → apply ordering, credential isolation, and API startup blocked by failed apply. Helm rendering and invalid egress checks passed; live Helm installation was not run.
- Passed packaged CLI end-to-end proof in 306.6 seconds: install/update/downgrade, uninstall/reinstall, record-existing, failed-update receipts, crash replay, pending-work refusal, interruption and real five-minute timeout with subprocess cleanup.
- TypeScript checked with the existing 6.0.3 compiler. Tests reused existing image dependencies; the exact pinned dependency build and full suite remain unverified. These are local working-tree results, not release evidence.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-09-09 17:02]: Proposed Installation-scoped onInstall, onUpdate and onUninstall with durable state, ordered deployment, outgoing-code retention and focused verification. (01a08890-87c8-7293-bd75-d7fc58e52cf2 - ee53c7b562ab0d593a3bfb8ecfd6e700ee98a716)
- [2026-09-09 17:10]: Simplified to three hooks, version receipts and one deployment command; removed configuration snapshots, pending workflows and runtime inventory gates. (01a088a6-721b-7f52-b86f-82f05270b41a - ee53c7b562ab0d593a3bfb8ecfd6e700ee98a716)

- [2026-09-09 17:54]: Implemented optional hooks, version receipts, operator CLI and ordered Compose/Helm phases; recorded focused PostgreSQL/CLI/deployment verification and remaining pinned-build/live-Helm limits. (01a08890-87c8-7293-bd75-d7fc58e52cf2 - ee53c7b562ab0d593a3bfb8ecfd6e700ee98a716)
