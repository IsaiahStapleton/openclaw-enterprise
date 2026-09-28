import { readFile } from "node:fs/promises";
import { NativeIAMDriver } from "../packages/iam/src/index.ts";
import {
  createPostgresPool,
  HumanAuthenticationMaintenanceRefusedError,
  PostgresHumanAuthentication,
  PostgresHumanAuthenticationMaintenance,
  PostgresPlatformState,
  ScopeViolationError,
  WritersNotStoppedError,
} from "../packages/occ/src/index.ts";
import {
  activateRecoveryAccount,
  betterAuthIssuer,
  hashLocalPassword,
} from "../apps/controller/src/auth/index.ts";
import { createOccLogger, emitOccLogEvent } from "../apps/controller/src/logging.ts";
import { loadOperationalLoggingConfiguration } from "../apps/controller/src/composition/installation-config.ts";
import {
  AuthMaintainUsageError,
  parseAuthMaintainArguments,
} from "./lib/auth-maintain-arguments.mjs";

const EXIT_FAILED = 1;
const EXIT_WRITERS_RUNNING = 2;
const EXIT_REFUSED = 3;
const EXIT_USAGE = 64;
const NATIVE_IAM_DRIVER = { id: "native-iam", implementation: "native" };

function output(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

async function readPassword(path) {
  const contents = await readFile(path, "utf8");
  // Secret files conventionally end with one newline; it is not part of the password.
  return contents.replace(/\r?\n$/, "");
}

async function run(options, maintenance, state, installationId) {
  const issuer = betterAuthIssuer(installationId);
  switch (options.command) {
    case "status":
      return maintenance.status();
    case "activate": {
      // Fail fast before waiting on the activation lock; the hooks repeat the check
      // after the lock and again before commit, and audit the designation.
      await maintenance.requireWritersStopped();
      // Controller startup only activates with the bundled native IAM Driver, whose
      // decisions carry its own id; the documented recovery authority is native IAM.
      const iamDriver = new NativeIAMDriver(state, NATIVE_IAM_DRIVER);
      try {
        await activateRecoveryAccount(
          new PostgresHumanAuthentication(state, installationId, issuer),
          iamDriver,
          installationId,
          options.recoveryUserId,
          maintenance.activationHooks(),
        );
      } catch (error) {
        if (error instanceof ScopeViolationError) {
          throw new HumanAuthenticationMaintenanceRefusedError("ACTIVATION_REFUSED", error.message);
        }
        throw error;
      }
      const status = await maintenance.status();
      return {
        designation: status.designation,
        enrolled: status.enrolled,
        unenrolled: status.unenrolled,
      };
    }
    case "enrol":
      return maintenance.enrol(options.userId);
    case "reset-recovery-password":
      return maintenance.resetRecoveryPassword(
        await hashLocalPassword(await readPassword(options.passwordFile)),
      );
    case "purge-sessions":
      return maintenance.purgeSessions(options.userId);
    case "deactivate":
      return maintenance.deactivate({ purgeDisabled: options.purgeDisabled === true });
    default:
      throw new AuthMaintainUsageError(`Unknown command: ${options.command}.`);
  }
}

let pool;
let options;
let logger = createOccLogger({
  component: "occ-auth-maintain",
  level: "info",
  destination: "stderr",
});

try {
  options = parseAuthMaintainArguments(process.argv.slice(2));
  const logging = await loadOperationalLoggingConfiguration({
    mode: process.env.NODE_ENV === "development" ? "development" : "production",
  });
  logger = createOccLogger({
    component: "occ-auth-maintain",
    level: logging.level,
    destination: "stderr",
  });
  const databaseUrl = process.env.OCC_MIGRATION_DATABASE_URL;
  if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
    throw new Error("OCC_MIGRATION_DATABASE_URL must contain the dedicated migrator credential.");
  }
  // One connection: every check and change runs on the backend excluded from the writer scan.
  pool = await createPostgresPool(databaseUrl, { max: 1 });
  const state = new PostgresPlatformState(pool);
  const installation = await state.loadInstallation();
  if (installation === undefined) {
    throw new Error("The database has no Installation.");
  }
  const maintenance = new PostgresHumanAuthenticationMaintenance(
    state,
    installation.id,
    betterAuthIssuer(installation.id),
  );
  await maintenance.assertSchemaOwner();
  const result = await run(options, maintenance, state, installation.id);
  output(`auth-maintain.${options.command}`, result);
  emitOccLogEvent(logger, {
    event: `auth-maintain.${options.command}`,
    installationId: installation.id,
  });
} catch (error) {
  if (error instanceof AuthMaintainUsageError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = EXIT_USAGE;
  } else if (error instanceof WritersNotStoppedError) {
    output("auth-maintain.writers-running", { backends: error.backends });
    process.stderr.write(`${error.message}\n`);
    process.exitCode = EXIT_WRITERS_RUNNING;
  } else if (error instanceof HumanAuthenticationMaintenanceRefusedError) {
    output("auth-maintain.refused", { reason: error.reason, ...error.details });
    process.stderr.write(`${error.message}\n`);
    process.exitCode = EXIT_REFUSED;
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    emitOccLogEvent(logger, {
      event: "auth-maintain.failed",
      code: "AUTH_MAINTENANCE_FAILED",
      ...(options === undefined ? {} : { command: options.command }),
    });
    process.exitCode = EXIT_FAILED;
  }
} finally {
  await pool?.end();
}
