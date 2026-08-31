import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createPostgresControllerAuth } from "../apps/controller/src/auth/index.ts";
import { OpenClawController, PostgresPlatformState } from "../packages/occ/src/index.ts";

const requireControllerDependency = createRequire(
  new URL("../apps/controller/package.json", import.meta.url),
);
const pg = requireControllerDependency("pg");

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be explicitly configured.`);
  }
  return value;
}

function normalizeEmail(raw) {
  const email = raw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("OCC_BOOTSTRAP_ADMIN_EMAIL must contain a valid administrator email.");
  }
  return email;
}

function authBaseURL(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("OCC_AUTH_BASE_URL must contain an absolute URL.");
  }
  if (
    parsed.protocol !== "https:" &&
    parsed.hostname !== "127.0.0.1" &&
    parsed.hostname !== "localhost"
  ) {
    throw new Error("OCC_AUTH_BASE_URL must be HTTPS except for loopback development tests.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function passwordOutputPath(raw) {
  if (!isAbsolute(raw)) {
    throw new Error("OCC_BOOTSTRAP_PASSWORD_FILE must identify an absolute output path.");
  }
  return raw;
}

function randomPassword() {
  return randomBytes(32).toString("base64url");
}

async function createAuth(pool, config, installationId) {
  return createPostgresControllerAuth({
    mode: "production",
    installationId,
    baseURL: config.baseURL,
    secret: config.secret,
    pool,
    secureCookies: !config.baseURL.startsWith("http://"),
  });
}

async function findCredentialUser(controllerAuth, email) {
  const context = await controllerAuth.auth.$context;
  return context.internalAdapter.findUserByEmail(email, { includeAccounts: true });
}

async function createCredentialUser(controllerAuth, email, password) {
  const existing = await findCredentialUser(controllerAuth, email);
  if (existing !== null) {
    throw new Error("The configured bootstrap administrator email already exists.");
  }
  const user = await controllerAuth.createAccount({
    email,
    password,
    name: "OpenClaw Administrator",
  });
  return Object.freeze({ id: user.id, email: user.email, name: user.name });
}

async function deleteCredentialUser(controllerAuth, userId) {
  try {
    await controllerAuth.deleteAccount({ id: userId });
  } catch {
    // The bootstrap failure path still reports the original error below.
  }
}

async function openProtectedPasswordFile(path) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  await handle.chmod(0o600);
  return handle;
}

const authConfig = {
  secret: required("OCC_AUTH_SECRET"),
  baseURL: authBaseURL(required("OCC_AUTH_BASE_URL")),
};
if (authConfig.secret.length < 32) {
  throw new Error("OCC_AUTH_SECRET must be at least 32 characters.");
}
const adminEmail = normalizeEmail(required("OCC_BOOTSTRAP_ADMIN_EMAIL"));
const passwordPath = passwordOutputPath(required("OCC_BOOTSTRAP_PASSWORD_FILE"));

function authorizationFor(controllerAuth, userId) {
  const seed = controllerAuth.principalSeed({ id: userId });
  return {
    identities: [seed.principal],
    groups: [],
    memberships: [],
    roles: seed.roles,
    bindings: seed.bindings,
    restrictions: [],
  };
}

function includesPermission(role, action, resourceKind) {
  return role.permissions.some(
    (permission) => permission.action === action && permission.resourceKind === resourceKind,
  );
}

function administratorPrincipal(state, issuer, userId) {
  const principal = state.identities.find(
    (identity) =>
      identity.kind === "principal" && identity.issuer === issuer && identity.subject === userId,
  );
  if (principal === undefined || principal.kind !== "principal") return undefined;
  const administratorRoles = new Set(
    state.roles
      .filter(
        (role) =>
          includesPermission(role, "administer", "installation") &&
          includesPermission(role, "read", "installation"),
      )
      .map((role) => role.id),
  );
  return state.bindings.some(
    (binding) =>
      binding.subjectKind === "identity" &&
      binding.subjectId === principal.id &&
      administratorRoles.has(binding.roleId),
  )
    ? principal
    : undefined;
}

const pool = new pg.Pool({ connectionString: required("OCC_DATABASE_URL") });
try {
  const state = new PostgresPlatformState(pool);
  const existing = await state.loadInstallation();
  if (existing !== undefined) {
    const auth = await createAuth(pool, authConfig, existing.id);
    const user = await findCredentialUser(auth, adminEmail);
    if (user === null) {
      throw new Error(
        "The existing Installation does not contain the configured administrator account.",
      );
    }
    const persisted = await state.loadNativeIAMState(existing.id);
    const principal = administratorPrincipal(persisted, auth.issuer, user.user.id);
    if (principal === undefined) {
      throw new Error(
        "The existing Installation does not contain the exact configured administrator Principal.",
      );
    }
    process.stdout.write(`${JSON.stringify({ event: "installation.already-bootstrapped" })}\n`);
  } else {
    let auth;
    let user;
    let passwordHandle;
    let passwordFileCreated = false;
    const password = randomPassword();
    try {
      passwordHandle = await openProtectedPasswordFile(passwordPath);
      passwordFileCreated = true;
      const installation = {
        id: `ins_${randomUUID()}`,
        name: required("OCC_BOOTSTRAP_INSTALLATION_NAME"),
        createdAt: new Date().toISOString(),
      };
      auth = await createAuth(pool, authConfig, installation.id);
      user = await createCredentialUser(auth, adminEmail, password);
      await passwordHandle.writeFile(`${password}\n`, { encoding: "utf8" });
      await passwordHandle.sync();
      await passwordHandle.close();
      passwordHandle = undefined;

      const authorization = authorizationFor(auth, user.id);
      const principal = authorization.identities[0];
      state.setBootstrapNativeIAM(authorization);
      const controller = new OpenClawController(installation, { state, recordOperations: true });
      await controller.transact(async (unit) => {
        await unit.audit.append({
          id: `aud_${randomUUID()}`,
          installationId: installation.id,
          occurredAt: new Date().toISOString(),
          kind: "bootstrap",
          actorId: principal.id,
          source: "occ",
          action: "administer",
          resource: { kind: "installation", id: installation.id },
          outcome: "success",
          details: { kind: "bootstrap", source: "production-installation-job" },
        });
      });
    } catch (error) {
      if (passwordHandle !== undefined) {
        try {
          await passwordHandle.close();
        } catch {
          // The original bootstrap error is reported below.
        }
      }
      if (auth !== undefined && user !== undefined) await deleteCredentialUser(auth, user.id);
      if (passwordFileCreated) {
        try {
          await unlink(passwordPath);
        } catch {
          // The original bootstrap error is reported below.
        }
      }
      throw error;
    }
    process.stdout.write(`${JSON.stringify({ event: "installation.bootstrapped" })}\n`);
  }
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      event: "installation.bootstrap-failed",
      error: error instanceof Error ? error.message : "Installation bootstrap failed.",
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
