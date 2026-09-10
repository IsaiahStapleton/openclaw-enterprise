import type {
  DriverLifecycleContext,
  DriverLifecycleHooks,
  DriverCapability,
} from "@openclaw-enterprise/contracts";
import { DRIVER_CAPABILITIES } from "@openclaw-enterprise/contracts";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../errors.ts";
import type { PostgresClient, PostgresPool } from "./postgres-state.ts";

export type DriverLifecycleHookName = "onInstall" | "onUpdate" | "onUninstall";
export type { DriverLifecycleContext, DriverLifecycleHooks };

export interface DriverLifecycleTarget {
  readonly capability: DriverCapability;
  readonly id: string;
  readonly implementationFamily: string;
  readonly version: string;
  readonly lifecycleHooks?: DriverLifecycleHooks;
}

export interface DriverLifecycleReceipt {
  readonly installationId: string;
  readonly capability: DriverCapability;
  readonly driverId: string;
  readonly implementationFamily: string;
  readonly version: string;
}

export type DriverLifecycleResultKind =
  "installed" | "updated" | "unchanged" | "recorded" | "uninstalled" | "noop";

export interface DriverLifecycleResult {
  readonly kind: DriverLifecycleResultKind;
  readonly capability: DriverCapability;
  readonly driverId: string;
  readonly implementationFamily?: string;
  readonly version?: string;
  readonly previousVersion?: string;
}

export interface DriverLifecycleOptions {
  readonly pool: PostgresPool;
  readonly targets: readonly DriverLifecycleTarget[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly connectionCheckIntervalMs?: number;
}

export interface DriverLifecycleUninstallOptions extends DriverLifecycleOptions {
  readonly capability: DriverCapability;
  readonly driverId: string;
  readonly providerIds?: readonly string[];
}

export class DriverLifecycleTimeoutError extends DependencyUnavailableError {
  constructor() {
    super("The Driver lifecycle hook timed out.");
    this.name = "DriverLifecycleTimeoutError";
  }
}

export class DriverLifecycleConnectionLostError extends DependencyUnavailableError {
  constructor() {
    super("The Driver lifecycle database session was lost.");
    this.name = "DriverLifecycleConnectionLostError";
  }
}

export class DriverLifecycleAbortedError extends DependencyUnavailableError {
  constructor() {
    super("The Driver lifecycle command was aborted.");
    this.name = "DriverLifecycleAbortedError";
  }
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_CONNECTION_CHECK_INTERVAL_MS = 1_000;
const LIFECYCLE_LOCK_NAMESPACE = "openclaw-enterprise:driver-lifecycle";

type EventedPostgresClient = PostgresClient & {
  on?(event: "error", listener: (error: Error) => void): void;
  off?(event: "error", listener: (error: Error) => void): void;
  removeListener?(event: "error", listener: (error: Error) => void): void;
  release(error?: Error): void;
};

function requireLifecycleText(value: string, path: string): string {
  if (
    !isNonEmptyString(value) ||
    value.length > 200 ||
    value !== value.trim() ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new ScopeViolationError(`${path} must be a normalized nonempty string.`);
  }
  return value;
}

function targetKey(capability: DriverCapability, driverId: string): string {
  return `${capability}\u0000${driverId}`;
}

function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DependencyUnavailableError("The Driver lifecycle repository returned invalid data.");
  }
  return value as Record<string, unknown>;
}

function present(value: unknown): boolean {
  return row(value).present === true;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DriverLifecycleAbortedError();
}

function lifecycleHooks(target: DriverLifecycleTarget): DriverLifecycleHooks | undefined {
  const hooks = target.lifecycleHooks;
  if (hooks === undefined) return undefined;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new ScopeViolationError("Driver lifecycleHooks must be an object.");
  }
  for (const name of ["onInstall", "onUpdate", "onUninstall"] as const) {
    if (hooks[name] !== undefined && typeof hooks[name] !== "function") {
      throw new ScopeViolationError(`Driver lifecycle hook ${name} must be a function.`);
    }
  }
  return hooks;
}

function validatedTargets(
  targets: readonly DriverLifecycleTarget[],
): readonly DriverLifecycleTarget[] {
  const seen = new Set<string>();
  return Object.freeze(
    targets.map((target) => {
      if (!DRIVER_CAPABILITIES.includes(target.capability)) {
        throw new ScopeViolationError("Driver lifecycle target has an unsupported capability.");
      }
      const normalized = Object.freeze({
        capability: target.capability,
        id: requireLifecycleText(target.id, "Driver ID"),
        implementationFamily: requireLifecycleText(
          target.implementationFamily,
          "Driver implementation family",
        ),
        version: requireLifecycleText(target.version, "Driver version"),
        ...(target.lifecycleHooks === undefined ? {} : { lifecycleHooks: target.lifecycleHooks }),
      });
      lifecycleHooks(normalized);
      const key = targetKey(normalized.capability, normalized.id);
      if (seen.has(key)) {
        throw new ScopeViolationError("Driver lifecycle selection contains duplicate Drivers.");
      }
      seen.add(key);
      return normalized;
    }),
  );
}

function receiptFromRow(row: Record<string, unknown>): DriverLifecycleReceipt {
  const capability = row.capability;
  if (!DRIVER_CAPABILITIES.includes(capability as DriverCapability)) {
    throw new DependencyUnavailableError("Persisted Driver lifecycle receipt is invalid.");
  }
  return immutableCopy({
    installationId: String(row.installation_id),
    capability: capability as DriverCapability,
    driverId: String(row.driver_id),
    implementationFamily: String(row.implementation_family),
    version: String(row.version),
  });
}

async function dedicatedLifecycleSession<T>(
  pool: PostgresPool,
  work: (client: PostgresClient, installationId: string) => Promise<T>,
): Promise<T> {
  let client: PostgresClient;
  try {
    client = await pool.connect();
  } catch {
    throw new DependencyUnavailableError("The Driver lifecycle database session is unavailable.");
  }
  let lockAcquired = false;
  let lockKey: string | undefined;
  let releaseError: Error | undefined;
  const evented = client as EventedPostgresClient;
  const connectionFailed = () => {
    releaseError = new DriverLifecycleConnectionLostError();
  };
  evented.on?.("error", connectionFailed);
  try {
    await client.query("SET application_name = 'openclaw-driver-lifecycle'");
    const installation = await client.query("SELECT id FROM occ.installation ORDER BY id LIMIT 2");
    const installationRow = installation.rows.length === 1 ? row(installation.rows[0]) : undefined;
    if (installationRow === undefined || typeof installationRow.id !== "string") {
      throw new ScopeViolationError("The server-owned Installation has not been initialized.");
    }
    const installationId = installationRow.id;
    lockKey = `${LIFECYCLE_LOCK_NAMESPACE}:${installationId}`;
    const lock = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [lockKey],
    );
    if (row(lock.rows[0]).acquired !== true) {
      throw new ResourceConflictError("Another Driver lifecycle command is already running.");
    }
    lockAcquired = true;
    const result = await work(client, installationId);
    if (releaseError !== undefined) throw releaseError;
    return result;
  } catch (error) {
    if (error instanceof DriverLifecycleConnectionLostError) releaseError = error;
    throw error;
  } finally {
    if (lockAcquired && lockKey !== undefined) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      } catch {
        releaseError = new DriverLifecycleConnectionLostError();
        // Closing the dedicated connection releases the session lock.
      }
    }
    try {
      await client.query("SET application_name TO DEFAULT");
    } catch {
      releaseError = new DriverLifecycleConnectionLostError();
    }
    evented.off?.("error", connectionFailed);
    if (evented.off === undefined) evented.removeListener?.("error", connectionFailed);
    evented.release(releaseError);
    if (releaseError !== undefined) throw releaseError;
  }
}

async function receiptsForInstallation(
  client: PostgresClient,
  installationId: string,
): Promise<Map<string, DriverLifecycleReceipt>> {
  const result = await client.query(
    `SELECT installation_id, capability, driver_id, implementation_family, version
     FROM occ.driver_lifecycle_receipts
     WHERE installation_id = $1
     ORDER BY capability, driver_id`,
    [installationId],
  );
  return new Map(
    result.rows.map((row) => {
      const receipt = receiptFromRow(row as Record<string, unknown>);
      return [targetKey(receipt.capability, receipt.driverId), receipt];
    }),
  );
}

async function writeReceipt(
  client: PostgresClient,
  installationId: string,
  target: DriverLifecycleTarget,
): Promise<DriverLifecycleReceipt> {
  const result = await client.query(
    `INSERT INTO occ.driver_lifecycle_receipts
       (installation_id, capability, driver_id, implementation_family, version, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (installation_id, capability, driver_id)
     DO UPDATE SET version = EXCLUDED.version, updated_at = EXCLUDED.updated_at
     RETURNING installation_id, capability, driver_id, implementation_family, version`,
    [installationId, target.capability, target.id, target.implementationFamily, target.version],
  );
  return receiptFromRow(row(result.rows[0]));
}

async function deleteReceipt(
  client: PostgresClient,
  installationId: string,
  capability: DriverCapability,
  driverId: string,
): Promise<void> {
  await client.query(
    `DELETE FROM occ.driver_lifecycle_receipts
     WHERE installation_id = $1 AND capability = $2 AND driver_id = $3`,
    [installationId, capability, driverId],
  );
}

function startConnectionMonitor(
  client: PostgresClient,
  controller: AbortController,
  intervalMs: number,
): { readonly failure: Promise<never>; stop(): Promise<void> } {
  let stopped = false;
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let fail: (error: Error) => void = () => {};
  const evented = client as EventedPostgresClient;
  const failure = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  const failConnection = () => {
    const error = new DriverLifecycleConnectionLostError();
    controller.abort(error);
    fail(error);
  };
  evented.on?.("error", failConnection);
  const check = () => {
    if (stopped || running !== undefined) return;
    running = client
      .query("SELECT 1")
      .then(() => undefined)
      .catch(failConnection)
      .finally(() => {
        running = undefined;
      });
  };
  timer = setInterval(check, intervalMs);
  return {
    failure,
    async stop() {
      stopped = true;
      if (evented.off !== undefined) evented.off("error", failConnection);
      else evented.removeListener?.("error", failConnection);
      if (timer !== undefined) clearInterval(timer);
      if (running !== undefined) {
        await Promise.race([
          running.catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
    },
  };
}

async function runHook(
  client: PostgresClient,
  installationId: string,
  target: DriverLifecycleTarget,
  hookName: DriverLifecycleHookName,
  previousVersion: string | undefined,
  timeoutMs: number,
  connectionCheckIntervalMs: number,
  commandSignal: AbortSignal | undefined,
): Promise<void> {
  const hooks = lifecycleHooks(target);
  const hook = hooks?.[hookName];
  if (hook === undefined || hooks === undefined) return;
  throwIfAborted(commandSignal);
  const controller = new AbortController();
  let rejectAbort: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    const error = new DriverLifecycleAbortedError();
    controller.abort(error);
    rejectAbort(error);
  };
  commandSignal?.addEventListener("abort", abort, { once: true });
  const monitor = startConnectionMonitor(client, controller, connectionCheckIntervalMs);
  const context = Object.freeze({
    installationId,
    capability: target.capability,
    driverId: target.id,
    version: target.version,
    ...(previousVersion === undefined ? {} : { previousVersion }),
    signal: controller.signal,
  });
  let timeout: NodeJS.Timeout | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new DriverLifecycleTimeoutError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const hookFailure = Promise.resolve()
    .then(() => hook.call(hooks, context))
    .catch((error) => {
      if (
        error instanceof DriverLifecycleTimeoutError ||
        error instanceof DriverLifecycleConnectionLostError ||
        error instanceof DriverLifecycleAbortedError
      ) {
        throw error;
      }
      throw new DependencyUnavailableError("The Driver lifecycle hook failed.");
    });
  hookFailure.catch(() => undefined);
  try {
    await Promise.race([hookFailure, timeoutFailure, monitor.failure, aborted]);
  } finally {
    commandSignal?.removeEventListener("abort", abort);
    if (timeout !== undefined) clearTimeout(timeout);
    controller.abort();
    await monitor.stop();
  }
}

interface PlannedApply {
  readonly target: DriverLifecycleTarget;
  readonly receipt?: DriverLifecycleReceipt;
  readonly kind: "installed" | "updated" | "unchanged";
}

function planApply(
  targets: readonly DriverLifecycleTarget[],
  receipts: Map<string, DriverLifecycleReceipt>,
): readonly PlannedApply[] {
  return Object.freeze(
    targets.map((target) => {
      const receipt = receipts.get(targetKey(target.capability, target.id));
      if (receipt === undefined) return { target, kind: "installed" as const };
      if (receipt.implementationFamily !== target.implementationFamily) {
        throw new ScopeViolationError(
          "A Driver implementation family change requires uninstall followed by install.",
        );
      }
      if (receipt.version === target.version)
        return { target, receipt, kind: "unchanged" as const };
      return { target, receipt, kind: "updated" as const };
    }),
  );
}

export async function applyDriverLifecycle(
  options: DriverLifecycleOptions,
): Promise<readonly DriverLifecycleResult[]> {
  const targets = validatedTargets(options.targets);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connectionCheckIntervalMs =
    options.connectionCheckIntervalMs ?? DEFAULT_CONNECTION_CHECK_INTERVAL_MS;
  return dedicatedLifecycleSession(options.pool, async (client, installationId) => {
    throwIfAborted(options.signal);
    const receipts = await receiptsForInstallation(client, installationId);
    const planned = planApply(targets, receipts);
    const results: DriverLifecycleResult[] = [];
    for (const step of planned) {
      throwIfAborted(options.signal);
      if (step.kind === "installed") {
        await runHook(
          client,
          installationId,
          step.target,
          "onInstall",
          undefined,
          timeoutMs,
          connectionCheckIntervalMs,
          options.signal,
        );
        throwIfAborted(options.signal);
        await writeReceipt(client, installationId, step.target);
      } else if (step.kind === "updated") {
        await runHook(
          client,
          installationId,
          step.target,
          "onUpdate",
          step.receipt!.version,
          timeoutMs,
          connectionCheckIntervalMs,
          options.signal,
        );
        throwIfAborted(options.signal);
        await writeReceipt(client, installationId, step.target);
      }
      results.push(
        immutableCopy({
          kind: step.kind,
          capability: step.target.capability,
          driverId: step.target.id,
          implementationFamily: step.target.implementationFamily,
          version: step.target.version,
          ...(step.kind === "updated" ? { previousVersion: step.receipt!.version } : {}),
        }),
      );
    }
    return Object.freeze(results);
  });
}

export async function recordExistingDriverLifecycle(
  options: DriverLifecycleOptions,
): Promise<readonly DriverLifecycleResult[]> {
  const targets = validatedTargets(options.targets);
  return dedicatedLifecycleSession(options.pool, async (client, installationId) => {
    throwIfAborted(options.signal);
    await client.query("BEGIN");
    try {
      const count = await client.query(
        "SELECT count(*)::integer AS count FROM occ.driver_lifecycle_receipts",
      );
      if (row(count.rows[0]).count !== 0) {
        throw new ResourceConflictError(
          "Existing Driver lifecycle receipts have already been recorded.",
        );
      }
      const results: DriverLifecycleResult[] = [];
      for (const target of targets) {
        throwIfAborted(options.signal);
        const receipt = await writeReceipt(client, installationId, target);
        results.push(
          immutableCopy({
            kind: "recorded",
            capability: target.capability,
            driverId: target.id,
            implementationFamily: receipt.implementationFamily,
            version: receipt.version,
          }),
        );
      }
      throwIfAborted(options.signal);
      await client.query("COMMIT");
      return Object.freeze(results);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        throw new DriverLifecycleConnectionLostError();
      }
      throw error;
    }
  });
}

async function driverInUse(
  client: PostgresClient,
  capability: DriverCapability,
  driverId: string,
  providerIds: readonly string[],
): Promise<boolean> {
  if (capability === "compute") {
    const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM occ.namespaces WHERE deleted_at IS NULL)
          OR EXISTS (SELECT 1 FROM occ.agents)
          OR EXISTS (SELECT 1 FROM occ.agent_revisions WHERE admitted_spec #>> '{compute,id}' = $1)
          OR EXISTS (SELECT 1 FROM occ.controller_work WHERE state <> 'succeeded') AS present`,
      [driverId],
    );
    return present(result.rows[0]);
  }
  if (capability === "configuration") {
    const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM occ.configurations)
          OR EXISTS (SELECT 1 FROM occ.agents)
          OR EXISTS (SELECT 1 FROM occ.agent_revisions)
          OR EXISTS (SELECT 1 FROM occ.controller_work WHERE state <> 'succeeded') AS present`,
    );
    return present(result.rows[0]);
  }
  if (capability === "secret") {
    const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM occ.secrets WHERE driver_id = $1)
          OR EXISTS (SELECT 1 FROM occ.agent_revisions WHERE admitted_spec->>'secret_driver_id' = $1)
          OR EXISTS (SELECT 1 FROM occ.controller_work WHERE state <> 'succeeded') AS present`,
      [driverId],
    );
    return present(result.rows[0]);
  }
  if (capability === "sandbox") {
    const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM occ.namespaces WHERE deleted_at IS NULL)
          OR EXISTS (SELECT 1 FROM occ.agent_revisions WHERE admitted_spec->>'sandbox_driver_id' = $1)
          OR EXISTS (SELECT 1 FROM occ.controller_work WHERE state <> 'succeeded') AS present`,
      [driverId],
    );
    return present(result.rows[0]);
  }
  if (capability === "service_account") {
    const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM occ.service_accounts)
          OR EXISTS (SELECT 1 FROM occ.service_account_driver_bindings WHERE driver_id = $1)
          OR EXISTS (SELECT 1 FROM occ.agents WHERE provider_id = ANY($2::text[]))
          OR EXISTS (SELECT 1 FROM occ.agent_revisions WHERE provider_id = ANY($2::text[]))
          OR EXISTS (SELECT 1 FROM occ.controller_work WHERE state <> 'succeeded') AS present`,
      [driverId, providerIds],
    );
    return present(result.rows[0]);
  }
  const result = await client.query(
    `SELECT EXISTS (SELECT 1 FROM occ.iam_identities)
        OR EXISTS (SELECT 1 FROM occ.iam_roles)
        OR EXISTS (SELECT 1 FROM occ.iam_groups)
        OR EXISTS (SELECT 1 FROM occ.iam_group_memberships)
        OR EXISTS (SELECT 1 FROM occ.iam_access_bindings)
        OR EXISTS (SELECT 1 FROM occ.iam_restrictions) AS present`,
  );
  return present(result.rows[0]);
}

export async function uninstallDriverLifecycle(
  options: DriverLifecycleUninstallOptions,
): Promise<readonly DriverLifecycleResult[]> {
  const targets = validatedTargets(options.targets);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connectionCheckIntervalMs =
    options.connectionCheckIntervalMs ?? DEFAULT_CONNECTION_CHECK_INTERVAL_MS;
  return dedicatedLifecycleSession(options.pool, async (client, installationId) => {
    throwIfAborted(options.signal);
    const receipts = await receiptsForInstallation(client, installationId);
    const receipt = receipts.get(targetKey(options.capability, options.driverId));
    if (receipt === undefined) {
      const results: DriverLifecycleResult[] = [
        immutableCopy({
          kind: "noop",
          capability: options.capability,
          driverId: options.driverId,
        }),
      ];
      return Object.freeze(results);
    }
    const target = targets.find(
      (candidate) =>
        candidate.capability === options.capability && candidate.id === options.driverId,
    );
    if (target === undefined) {
      throw new ScopeViolationError("The outgoing Driver must be selected before uninstall.");
    }
    if (
      receipt.implementationFamily !== target.implementationFamily ||
      receipt.version !== target.version
    ) {
      throw new ScopeViolationError("The outgoing Driver no longer matches its lifecycle receipt.");
    }
    if (
      await driverInUse(client, options.capability, options.driverId, options.providerIds ?? [])
    ) {
      throw new ResourceConflictError("The outgoing Driver is still referenced by platform state.");
    }
    await runHook(
      client,
      installationId,
      target,
      "onUninstall",
      undefined,
      timeoutMs,
      connectionCheckIntervalMs,
      options.signal,
    );
    throwIfAborted(options.signal);
    await deleteReceipt(client, installationId, options.capability, options.driverId);
    const results: DriverLifecycleResult[] = [
      immutableCopy({
        kind: "uninstalled",
        capability: options.capability,
        driverId: options.driverId,
        implementationFamily: target.implementationFamily,
        version: target.version,
      }),
    ];
    return Object.freeze(results);
  });
}
