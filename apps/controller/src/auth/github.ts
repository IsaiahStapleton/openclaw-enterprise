import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { APIError, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { deleteSessionCookie, setSessionCookie } from "better-auth/cookies";
import { github } from "better-auth/social-providers";
import { authorizationCodeRequest, getOAuth2Tokens } from "better-auth/oauth2";
import type { DBAdapter, DBAdapterInstance } from "better-auth/adapters";
import type {
  PostgresHumanAuthentication,
  HumanAuthenticationProof,
} from "@openclaw-enterprise/occ";

export interface GitHubLoginConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly recoveryUserId: string;
}

export function githubLoginConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): GitHubLoginConfiguration | undefined {
  const clientId = environment.OCC_AUTH_GITHUB_CLIENT_ID;
  const clientSecret = environment.OCC_AUTH_GITHUB_CLIENT_SECRET;
  const recoveryUserId = environment.OCC_AUTH_GITHUB_RECOVERY_USER_ID;
  if (clientId === undefined && clientSecret === undefined && recoveryUserId === undefined) {
    return undefined;
  }
  if (
    typeof clientId !== "string" ||
    clientId.trim().length === 0 ||
    typeof clientSecret !== "string" ||
    clientSecret.trim().length === 0 ||
    typeof recoveryUserId !== "string" ||
    recoveryUserId.trim().length === 0
  ) {
    throw new Error("GitHub sign-in requires client ID, client secret and recovery user ID.");
  }
  return { clientId, clientSecret, recoveryUserId };
}

function githubProviderInstance(config: GitHubLoginConfiguration): string {
  return `github:${digest(config.clientId)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function secret(): string {
  return randomBytes(32).toString("base64url");
}
function rejected(): APIError {
  return APIError.fromStatus("UNAUTHORIZED", { message: "Authentication was not accepted." });
}

const tokenEndpoint = "https://github.com/login/oauth/access_token";
const profileEndpoint = "https://api.github.com/user";
const providerResponseLimit = 64 * 1024;

// The two fixed provider requests share a deadline, including streaming body reads.
async function providerJSON(
  endpoint: typeof tokenEndpoint | typeof profileEndpoint,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, { ...init, signal, redirect: "error" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw rejected();
  }
  const reader = response.body.getReader();
  try {
    if (Number(response.headers.get("content-length")) > providerResponseLimit) {
      await reader.cancel();
      throw rejected();
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > providerResponseLimit) {
        await reader.cancel();
        throw rejected();
      }
      chunks.push(value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw rejected();
    }
    return data as Record<string, unknown>;
  } finally {
    reader.releaseLock();
  }
}

async function exchangeGithubSubject(
  config: GitHubLoginConfiguration,
  code: string,
  codeVerifier: string,
  redirectURI: string,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  timer.unref();
  try {
    const request = await authorizationCodeRequest({
      code,
      codeVerifier,
      redirectURI,
      options: { clientId: config.clientId, clientSecret: config.clientSecret },
      tokenEndpoint,
    });
    const data = await providerJSON(
      tokenEndpoint,
      { method: "POST", ...request },
      controller.signal,
    );
    if ("error" in data) {
      throw rejected();
    }
    const tokens = getOAuth2Tokens(data);
    if (typeof tokens.accessToken !== "string" || !tokens.accessToken) {
      throw rejected();
    }
    const profile = await providerJSON(
      profileEndpoint,
      {
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          "User-Agent": "OpenClaw-Enterprise",
          accept: "application/vnd.github+json",
        },
      },
      controller.signal,
    );
    controller.signal.throwIfAborted();
    const subject = githubSubject(profile.id);
    if (!subject) {
      throw rejected();
    }
    return subject;
  } catch {
    // Never expose provider response bodies, token values or request credentials.
    return undefined;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function cookieLifetime(createdAt: Date, expiresAt: Date, startedAt: number): number {
  // Subtract the entire call's elapsed time, conservatively covering the DB round trip.
  // Neither a controller clock adjustment nor DB/controller clock skew extends the cookie.
  const remaining = Math.floor(
    (expiresAt.getTime() - createdAt.getTime() - (performance.now() - startedAt)) / 1000,
  );
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw rejected();
  }
  return remaining;
}

interface AdmissionBudget {
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

function tooManyRequests(): APIError {
  return APIError.fromStatus("TOO_MANY_REQUESTS", { message: "Try again later." });
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
function admissionKey(kind: "ip" | "email", value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  const raw = kind === "ip" ? trimmed.slice(0, 64) : trimmed;
  return `${kind}:${digest(raw.length === 0 ? "unknown" : raw)}`;
}

function keyedAdmission(
  perKey: AdmissionBudget,
  global: { readonly concurrent: number; readonly reserved: number },
  recovery?: AdmissionBudget,
) {
  // Map order is recency order: touching an entry deletes and re-inserts it.
  const table = new Map<string, AdmissionEntry>();
  // The recovery entry lives outside the table, so key churn can never evict it.
  const recoveryEntry = admissionEntry(performance.now());
  let active = 0;

  function evict(pinned: readonly AdmissionEntry[]): boolean {
    for (const [key, entry] of table) {
      if (entry.active === 0 && !pinned.includes(entry)) {
        table.delete(key);
        return true;
      }
    }
    return false;
  }

  function touch(key: string, now: number, pinned: readonly AdmissionEntry[]): AdmissionEntry {
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
  }

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

function githubSubject(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) ? value : undefined;
}

export function createHumanLogin(
  state: PostgresHumanAuthentication,
  config: GitHubLoginConfiguration,
  baseURL: string,
) {
  const proofScope = new AsyncLocalStorage<{ proof?: HumanAuthenticationProof }>();
  const providerId = githubProviderInstance(config);
  const attemptProviderId = `${providerId}:${digest(config.clientSecret)}`;
  const callbackURL = new URL("/api/auth/providers/github/callback", baseURL).href;
  const secure = new URL(baseURL).protocol === "https:";
  const bindingCookie = secure ? "__Host-occ_login_attempt" : "occ_login_attempt";
  const cookieAttributes = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
  const provider = github({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    disableDefaultScope: true,
  });

  async function rejectExternalIdentity(): Promise<never> {
    await state.recordDenied("EXTERNAL_IDENTITY_REJECTED");
    throw rejected();
  }

  function database(original: DBAdapterInstance): DBAdapterInstance {
    return (options) => {
      const adapter = original(options);
      const guarded: DBAdapter = {
        ...adapter,
        async create<T extends Record<string, unknown>, R = T>(input: {
          model: string;
          data: Omit<T, "id">;
          select?: string[] | undefined;
          forceAllowId?: boolean | undefined;
        }): Promise<R> {
          if (input.model !== "session") {
            return adapter.create<T, R>(input);
          }
          const scope = proofScope.getStore();
          const proof = scope?.proof;
          if (!scope || !proof) {
            throw rejected();
          }
          delete scope.proof;
          const data = input.data as Record<string, unknown>;
          if (data.userId !== proof.userId || typeof data.token !== "string") {
            throw rejected();
          }
          const session = {
            id: typeof data.id === "string" ? data.id : randomUUID(),
            userId: proof.userId,
            token: data.token,
            ipAddress: typeof data.ipAddress === "string" ? data.ipAddress : null,
            userAgent: typeof data.userAgent === "string" ? data.userAgent : null,
          };
          // The original State unit owns this commit, including the login audit.
          return (await state.issueSession(proof, session)) as R;
        },
        async findOne<T>(input: Parameters<DBAdapter["findOne"]>[0]): Promise<T | null> {
          if (input.model !== "session") {
            return adapter.findOne<T>(input);
          }
          const token = input.where.find((where) => where.field === "token")?.value;
          if (typeof token !== "string" || input.where.length !== 1) {
            return null;
          }
          return ((await state.currentSession(token)) ?? null) as T | null;
        },
        async update(input) {
          if (input.model === "session") {
            throw rejected();
          }
          return adapter.update(input);
        },
        async updateMany(input) {
          if (input.model === "session") {
            throw rejected();
          }
          return adapter.updateMany(input);
        },
        async delete(input) {
          if (input.model === "session") {
            throw rejected();
          }
          return adapter.delete(input);
        },
        async deleteMany(input) {
          if (input.model === "session") {
            throw rejected();
          }
          return adapter.deleteMany(input);
        },
        async transaction() {
          // Curated login uses State transactions; library transactions must not bypass its gate.
          throw APIError.fromStatus("SERVICE_UNAVAILABLE", {
            message: "Unsupported auth transaction.",
          });
        },
      };
      return guarded;
    };
  }

  // Single-controller admission keeps a bounded table of hashed client-address and email keys,
  // each with a one-minute budget and an active-request cap, under concurrency-only global lanes.
  // The recovery account keeps a reserved password lane during provider outage or login floods.
  const admitPassword = keyedAdmission(
    { perMinute: 10, concurrent: 2 },
    { concurrent: 4, reserved: 1 },
    { perMinute: 20, concurrent: 2 },
  );
  const admitGithub = keyedAdmission(
    { perMinute: 30, concurrent: 4 },
    { concurrent: 8, reserved: 0 },
  );
  let recoveryEmail: string | undefined;
  function designateRecovery(email: string): void {
    recoveryEmail = email.trim().toLowerCase();
  }
  const plugin = {
    id: "oce-human-login",
    endpoints: {
      ocePassword: createAuthEndpoint("/oce/password", { method: "POST" }, async (ctx) => {
        const body = ctx.body as { email?: unknown; password?: unknown } | undefined;
        if (
          typeof body?.email !== "string" ||
          body.email.length > 254 ||
          typeof body.password !== "string"
        ) {
          throw rejected();
        }
        const email = body.email.trim().toLowerCase();
        const password = body.password;
        const work = async () => {
          if (password.length < 12 || password.length > 128) {
            throw rejected();
          }
          const snapshot = await state.snapshotPassword(email);
          if (!snapshot?.proof.passwordHash) {
            await ctx.context.password.hash(password);
            await state.recordDenied("INVALID_CREDENTIALS");
            throw rejected();
          }
          if (
            !(await ctx.context.password.verify({
              password,
              hash: snapshot.proof.passwordHash,
            }))
          ) {
            await state.recordDenied("INVALID_CREDENTIALS");
            throw rejected();
          }
          const startedAt = performance.now();
          const session = await proofScope.run({ proof: snapshot.proof }, () =>
            ctx.context.internalAdapter.createSession(snapshot.user.id, false),
          );
          if (!session) {
            throw rejected();
          }
          const maxAge = cookieLifetime(session.createdAt, session.expiresAt, startedAt);
          await setSessionCookie(ctx, { session, user: snapshot.user }, false, {
            maxAge,
          });
          return ctx.json({ authenticated: true });
        };
        return recoveryEmail !== undefined && email === recoveryEmail
          ? admitPassword.admitRecovery(work)
          : admitPassword.admit(
              [
                admissionKey("ip", ctx.headers?.get("x-occ-client-ip")),
                admissionKey("email", email),
              ],
              work,
            );
      }),
      oceSignOut: createAuthEndpoint(
        "/oce/sign-out",
        { method: "POST", requireHeaders: true },
        async (ctx) => {
          const token = await ctx.getSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            ctx.context.secret,
          );
          if (token) {
            await state.revokeSession(token);
          }
          deleteSessionCookie(ctx);
          return ctx.json({ success: true });
        },
      ),
      oceGithubStart: createAuthEndpoint(
        "/oce/providers/github/start",
        { method: "POST" },
        async (ctx) =>
          admitGithub.admit([admissionKey("ip", ctx.headers?.get("x-occ-client-ip"))], async () => {
            const attemptState = secret();
            const browser = secret();
            const codeVerifier = secret();
            const startedAt = performance.now();
            const attempt = await state.createAttempt({
              stateHash: digest(attemptState),
              browserHash: digest(browser),
              providerId: attemptProviderId,
              callbackURL,
              codeVerifier,
            });
            const url = await provider.createAuthorizationURL({
              state: attemptState,
              codeVerifier,
              redirectURI: callbackURL,
            });
            const maxAge = cookieLifetime(attempt.createdAt, attempt.expiresAt, startedAt);
            ctx.setCookie(bindingCookie, browser, {
              ...cookieAttributes,
              maxAge,
            });
            return ctx.json({ url: url.href });
          }),
      ),
      oceGithubCallback: createAuthEndpoint(
        "/oce/providers/github/callback",
        { method: "GET", requireRequest: true },
        async (ctx) =>
          admitGithub.admit([admissionKey("ip", ctx.headers?.get("x-occ-client-ip"))], async () => {
            const parameters = new URL(ctx.request!.url).searchParams;
            const stateValue = parameters.get("state");
            const code = parameters.get("code");
            const error = parameters.get("error");
            const browser = ctx.getCookie(bindingCookie);
            if (
              parameters.getAll("state").length !== 1 ||
              parameters.getAll("code").length > 1 ||
              parameters.getAll("error").length > 1 ||
              !stateValue ||
              !/^[A-Za-z0-9_-]{43}$/.test(stateValue) ||
              !browser ||
              !/^[A-Za-z0-9_-]{43}$/.test(browser) ||
              (!error && (!code || code.length > 1024)) ||
              (error && (error.length > 200 || code))
            ) {
              return rejectExternalIdentity();
            }
            const attempt = await state.consumeAttempt({
              stateHash: digest(stateValue),
              browserHash: digest(browser),
              providerId: attemptProviderId,
              callbackURL,
            });
            if (!attempt || error) {
              return rejectExternalIdentity();
            }
            ctx.setCookie(bindingCookie, "", { ...cookieAttributes, maxAge: 0 });
            const subject = await exchangeGithubSubject(
              config,
              code!,
              attempt.codeVerifier,
              callbackURL,
            );
            if (!subject) {
              return rejectExternalIdentity();
            }
            const snapshot = await state.snapshotExternal(providerId, subject, attempt.createdAt);
            if (!snapshot) {
              return rejectExternalIdentity();
            }
            const startedAt = performance.now();
            const session = await proofScope.run({ proof: snapshot.proof }, () =>
              ctx.context.internalAdapter.createSession(snapshot.user.id, false),
            );
            if (!session) {
              throw rejected();
            }
            const maxAge = cookieLifetime(session.createdAt, session.expiresAt, startedAt);
            await setSessionCookie(ctx, { session, user: snapshot.user }, false, {
              maxAge,
            });
            return ctx.json({ authenticated: true });
          }),
      ),
    },
  } satisfies BetterAuthPlugin;
  return { plugin, database, providerId, designateRecovery };
}
