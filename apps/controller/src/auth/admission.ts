import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { APIError } from "better-auth";

/**
 * Single-controller sign-in admission. Keys are hashed caller values; entries keep a
 * one-minute window in a bounded, recency-ordered table so key churn cannot grow memory.
 */
export interface AdmissionBudget {
  readonly perMinute: number;
  readonly concurrent: number;
}

interface AdmissionEntry {
  windowStart: number;
  admitted: number;
  active: number;
}

const admissionTableCapacity = 4096;
const admissionWindow = 60_000;

export function tooManyRequests(): APIError {
  return APIError.fromStatus("TOO_MANY_REQUESTS", { message: "Try again later." });
}

/** A refused password sign-in; `retryAfterSeconds` becomes the Retry-After header. */
export class SignInRateLimited extends APIError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("TOO_MANY_REQUESTS", { message: "Try again later." });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function admissionEntry(now: number): AdmissionEntry {
  return { windowStart: now, admitted: 0, active: 0 };
}

function rollWindow(entry: AdmissionEntry, now: number): void {
  if (now - entry.windowStart >= admissionWindow) {
    entry.windowStart = now;
    entry.admitted = 0;
  }
}

// Caller keys are hashed; the address header value is capped before hashing.
export function admissionKey(kind: "ip" | "email", value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  const raw = kind === "ip" ? trimmed.slice(0, 64) : trimmed;
  return `${kind}:${createHash("sha256")
    .update(raw.length === 0 ? "unknown" : raw)
    .digest("hex")}`;
}

function admissionTable() {
  // Map order is recency order: touching an entry deletes and re-inserts it.
  const table = new Map<string, AdmissionEntry>();

  function evict(pinned: readonly AdmissionEntry[]): boolean {
    for (const [key, entry] of table) {
      if (entry.active === 0 && !pinned.includes(entry)) {
        table.delete(key);
        return true;
      }
    }
    return false;
  }

  return function touch(
    key: string,
    now: number,
    pinned: readonly AdmissionEntry[],
  ): AdmissionEntry {
    let entry = table.get(key);
    if (entry === undefined) {
      if (table.size >= admissionTableCapacity && !evict(pinned)) {
        throw tooManyRequests();
      }
      entry = admissionEntry(now);
    } else {
      table.delete(key);
      rollWindow(entry, now);
    }
    table.set(key, entry);
    return entry;
  };
}

/**
 * Attempt-counting admission for the guarded (external provider) profile: every admitted
 * request spends one unit of each key's budget, with a reserved recovery lane.
 */
export function keyedAdmission(
  perKey: AdmissionBudget,
  global: { readonly concurrent: number; readonly reserved: number },
  recovery?: AdmissionBudget,
) {
  const touch = admissionTable();
  // The recovery entry lives outside the table, so key churn can never evict it.
  const recoveryEntry = admissionEntry(performance.now());
  let active = 0;

  async function run<T>(entries: readonly AdmissionEntry[], work: () => Promise<T>): Promise<T> {
    for (const entry of entries) {
      entry.admitted += 1;
      entry.active += 1;
    }
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      for (const entry of entries) {
        entry.active -= 1;
      }
    }
  }

  return {
    async admit<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
      const now = performance.now();
      const entries: AdmissionEntry[] = [];
      for (const key of keys) {
        entries.push(touch(key, now, entries));
      }
      // Check every limit before counting anything, so one exhausted key spends no other budget.
      if (
        active >= global.concurrent ||
        entries.some(
          (entry) => entry.admitted >= perKey.perMinute || entry.active >= perKey.concurrent,
        )
      ) {
        throw tooManyRequests();
      }
      return run(entries, work);
    },
    async admitRecovery<T>(work: () => Promise<T>): Promise<T> {
      if (recovery === undefined) {
        throw tooManyRequests();
      }
      rollWindow(recoveryEntry, performance.now());
      if (
        active >= global.concurrent + global.reserved ||
        recoveryEntry.admitted >= recovery.perMinute ||
        recoveryEntry.active >= recovery.concurrent
      ) {
        throw tooManyRequests();
      }
      return run([recoveryEntry], work);
    },
  };
}

/** One password sign-in attempt as admission sees it. */
export interface PasswordSignInAttempt {
  /** Client address after trusted-proxy resolution. */
  readonly clientAddress: string;
  /** Normalized (trimmed, lower-case) email. */
  readonly email: string;
}

/**
 * The admission seam for password sign-in in the password-only profile. The in-memory
 * implementation below can be replaced by a State-owned attempt budget later.
 */
export interface PasswordSignInAdmission {
  admit<T>(attempt: PasswordSignInAttempt, work: () => Promise<T>): Promise<T>;
}

export interface PasswordFailureAdmissionOptions {
  /** Failures (plus in-flight attempts) per client address per minute. */
  readonly perAddress: number;
  /** Failures (plus in-flight attempts) per email per minute. */
  readonly perEmail: number;
  /** Failures (plus in-flight attempts) per Installation administrator email per minute. */
  readonly reserved: number;
  /** Concurrent reserved-lane checks, per address and overall. */
  readonly reservedConcurrent: { readonly perAddress: number; readonly total: number };
  /** Every non-success outcome after the shared lane refuses takes at least this long. */
  readonly refusalFloorMs: number;
  /** True when the email belongs to an account that administers the Installation. */
  readonly isReserved: (email: string) => Promise<boolean>;
  /** Failures that spend budget: credential rejections, not dependency errors. */
  readonly countsAsFailure: (error: unknown) => boolean;
}

export const passwordFailureBudget = {
  perAddress: 20,
  perEmail: 10,
  reserved: 10,
  reservedConcurrent: { perAddress: 2, total: 32 },
  refusalFloorMs: 1000,
} as const;

/**
 * Failure-counting password admission with a reserved lane for Installation administrators.
 *
 * The shared lane keys on client address and email; only failures spend its budget, so
 * repeated successful sign-ins are never limited. In-flight attempts count against it too,
 * so concurrent guesses cannot overrun it before their failures land.
 *
 * Once the shared lane refuses, the attempt goes to the reserved lane: the email is looked
 * up and, only if it administers the Installation, checked against a separate per-email
 * budget that the shared lane cannot spend. Every non-success outcome there is `429` with
 * the shared lane's Retry-After, padded to a fixed floor, so an administrator's wrong
 * password, an ordinary account and an unknown email look the same. Only a correct
 * administrator password gets through.
 */
export function passwordFailureAdmission(
  options: PasswordFailureAdmissionOptions,
): PasswordSignInAdmission {
  const touchShared = admissionTable();
  const touchReserved = admissionTable();
  let reservedActive = 0;

  function exhausted(entry: AdmissionEntry, limit: number): boolean {
    return entry.admitted + entry.active >= limit;
  }

  function retryAfter(entries: readonly AdmissionEntry[], now: number): number {
    const reset = Math.max(...entries.map((entry) => entry.windowStart + admissionWindow));
    return Math.max(1, Math.ceil((reset - now) / 1000));
  }

  async function run<T>(
    entries: readonly AdmissionEntry[],
    work: () => Promise<T>,
    onFailure: (error: unknown) => never,
  ): Promise<T> {
    for (const entry of entries) {
      entry.active += 1;
    }
    try {
      return await work();
    } catch (error) {
      if (options.countsAsFailure(error)) {
        for (const entry of entries) {
          entry.admitted += 1;
        }
      }
      return onFailure(error);
    } finally {
      for (const entry of entries) {
        entry.active -= 1;
      }
    }
  }

  async function reservedLane<T>(
    attempt: PasswordSignInAttempt,
    address: AdmissionEntry,
    retryAfterSeconds: number,
    work: () => Promise<T>,
  ): Promise<T> {
    const refused = new SignInRateLimited(retryAfterSeconds);
    // Concurrency is refused before any lookup, so it reveals load, never an account.
    if (
      reservedActive >= options.reservedConcurrent.total ||
      address.active >= options.reservedConcurrent.perAddress
    ) {
      throw refused;
    }
    const floor = delay(options.refusalFloorMs, undefined, { ref: false });
    reservedActive += 1;
    address.active += 1;
    try {
      const reserved = await options.isReserved(attempt.email).catch(() => false);
      if (!reserved) {
        throw refused;
      }
      const entry = touchReserved(admissionKey("email", attempt.email), performance.now(), []);
      if (exhausted(entry, options.reserved)) {
        throw refused;
      }
      return await run([entry], work, () => {
        throw refused;
      });
    } catch (error) {
      await floor;
      throw error;
    } finally {
      reservedActive -= 1;
      address.active -= 1;
    }
  }

  return {
    async admit<T>(attempt: PasswordSignInAttempt, work: () => Promise<T>): Promise<T> {
      const now = performance.now();
      const address = touchShared(admissionKey("ip", attempt.clientAddress), now, []);
      const email = touchShared(admissionKey("email", attempt.email), now, [address]);
      const blocking = [
        ...(exhausted(address, options.perAddress) ? [address] : []),
        ...(exhausted(email, options.perEmail) ? [email] : []),
      ];
      if (blocking.length > 0) {
        return reservedLane(attempt, address, retryAfter(blocking, now), work);
      }
      return run([address, email], work, (error) => {
        throw error;
      });
    },
  };
}
