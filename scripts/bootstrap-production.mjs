import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createPostgresControllerAuth } from "../apps/controller/src/auth/index.ts";
import {
  bootstrapOutputPath,
  removeAttemptBootstrapFile,
  writeProtectedBootstrapFile,
  writeProtectedBootstrapJson,
} from "../apps/controller/src/composition/bootstrap-output.ts";
import { createBootstrapAdministratorSeed } from "../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../packages/occ/src/index.ts";
import { PostgresCommitOutcomeUnknownError } from "../packages/occ/src/state/postgres-state.ts";

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
  return bootstrapOutputPath(raw, "OCC_BOOTSTRAP_PASSWORD_FILE");
}

function serviceKeyOutputPath(raw, passwordPath) {
  const path = bootstrapOutputPath(raw, "OCC_BOOTSTRAP_SERVICE_KEY_FILE");
  if (path === passwordPath || dirname(path) !== dirname(passwordPath)) {
    throw new Error(
      "OCC_BOOTSTRAP_SERVICE_KEY_FILE must be a distinct sibling of OCC_BOOTSTRAP_PASSWORD_FILE.",
    );
  }
  return path;
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
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Bootstrap administrator cleanup failed.";
  }
}

async function revokeServiceKey(controllerAuth, key) {
  try {
    await controllerAuth.revokeServiceKey(key);
    return undefined;
  } catch {
    return "Bootstrap service key cleanup failed.";
  }
}

function cleanupFailure(kind, id, error) {
  return {
    kind,
    id,
    error,
  };
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
let bootstrapFailureDetails;

function authorizationFor(controllerAuth, installationId, userId) {
  const seed = createBootstrapAdministratorSeed(installationId, controllerAuth.issuer, {
    id: userId,
  });
  return {
    state: {
      identities: [seed.principal, seed.servicePrincipal],
      groups: [],
      memberships: [],
      roles: seed.roles,
      bindings: seed.bindings,
      restrictions: [],
    },
    servicePrincipal: seed.servicePrincipal,
    principal: seed.principal,
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
    const serviceKeyPath = serviceKeyOutputPath(
      required("OCC_BOOTSTRAP_SERVICE_KEY_FILE"),
      passwordPath,
    );
    let auth;
    let user;
    let serviceKey;
    let passwordOutput;
    let serviceKeyOutput;
    let attempt;
    const cleanupFailures = [];
    const password = randomPassword();
    try {
      const installation = {
        id: `ins_${randomUUID()}`,
        name: required("OCC_BOOTSTRAP_INSTALLATION_NAME"),
        createdAt: new Date().toISOString(),
      };
      auth = await createAuth(pool, authConfig, installation.id);
      user = await createCredentialUser(auth, adminEmail, password);
      const authorization = authorizationFor(auth, installation.id, user.id);
      serviceKey = await auth.createServiceKey({
        principal: authorization.servicePrincipal,
        name: "bootstrap-admin",
      });
      attempt = {
        installationId: installation.id,
        principalId: authorization.principal.id,
        servicePrincipalId: authorization.servicePrincipal.id,
        serviceKeyId: serviceKey.id,
        serviceKeyExpiresAt: serviceKey.expiresAt,
        passwordFile: passwordPath,
        serviceKeyFile: serviceKeyPath,
      };
      passwordOutput = await writeProtectedBootstrapFile(passwordPath, `${password}\n`);
      serviceKeyOutput = await writeProtectedBootstrapJson(serviceKeyPath, {
        data: serviceKey,
        meta: { installationId: installation.id },
      });
      state.setBootstrapNativeIAM(authorization.state);
      const controller = new OpenClawController(installation, { state, recordOperations: true });
      await controller.transact(async (unit) => {
        await unit.audit.append({
          id: `aud_${randomUUID()}`,
          installationId: installation.id,
          occurredAt: new Date().toISOString(),
          kind: "bootstrap",
          actorId: authorization.principal.id,
          source: "occ",
          action: "administer",
          resource: { kind: "installation", id: installation.id },
          outcome: "success",
          details: {
            kind: "bootstrap",
            source: "production-installation-job",
            servicePrincipalId: authorization.servicePrincipal.id,
            serviceKeyId: serviceKey.id,
          },
        });
      });
    } catch (error) {
      const uncertain = error instanceof PostgresCommitOutcomeUnknownError;
      if (!uncertain) {
        if (auth !== undefined && serviceKey !== undefined) {
          const failure = await revokeServiceKey(auth, serviceKey);
          if (failure !== undefined) {
            cleanupFailures.push(cleanupFailure("service_key", serviceKey.id, failure));
          }
        }
        if (auth !== undefined && user !== undefined) {
          const failure = await deleteCredentialUser(auth, user.id);
          if (failure !== undefined) {
            cleanupFailures.push(cleanupFailure("auth_account", user.id, failure));
          }
        }
        for (const file of [passwordOutput, serviceKeyOutput]) {
          const failure = await removeAttemptBootstrapFile(file);
          if (failure !== undefined) cleanupFailures.push(failure);
        }
      }
      bootstrapFailureDetails = { uncertain, attempt, cleanupFailures };
      throw error;
    }
    process.stdout.write(`${JSON.stringify({ event: "installation.bootstrapped", ...attempt })}\n`);
  }
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      event: bootstrapFailureDetails?.uncertain
        ? "installation.bootstrap-outcome-uncertain"
        : "installation.bootstrap-failed",
      error: error instanceof Error ? error.message : "Installation bootstrap failed.",
      ...(bootstrapFailureDetails?.attempt === undefined
        ? {}
        : { attempt: bootstrapFailureDetails.attempt }),
      ...((bootstrapFailureDetails?.cleanupFailures?.length ?? 0) === 0
        ? {}
        : { cleanupFailures: bootstrapFailureDetails.cleanupFailures }),
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
