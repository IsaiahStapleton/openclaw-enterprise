import { cookieHeaderFromSetCookie } from "@openclaw-enterprise/utils";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { AuditEventFactory } from "@openclaw-enterprise/audit";
import type {
  AuditEvent,
  ComputeDriver,
  ConfigurationDriver,
  Installation,
} from "@openclaw-enterprise/contracts";
import {
  createBootstrapAdministratorSeed,
  NativeIAMDriver,
  validateAuthAccountPrincipalSeed,
  validatePersistedNativeIAMState,
  type AuthPrincipalSeed,
  type BootstrapAdministratorSeed,
  type NativeIAMState,
} from "@openclaw-enterprise/iam";
import { OpenClawController, PostgresPlatformState } from "@openclaw-enterprise/occ";
import { createPostgresControllerAuth, type AuthenticatedAccount } from "../auth/index.ts";
import { createDockerDevelopmentComputeDriverFromEnv } from "../drivers/compute/docker/index.ts";
import { createFilesystemDevelopmentConfigurationDriverFromEnv } from "../drivers/configuration/filesystem/index.ts";
import { createFastifyApp } from "../index.ts";
import type {
  InstallationRuntimeDrivers,
  ServiceAccountDriverFactory,
} from "./installation-config.ts";
import {
  bootstrapOutputPath,
  removeAttemptBootstrapFile,
  writeProtectedBootstrapJson,
  type BootstrapOutputFile,
} from "./bootstrap-output.ts";
import { resolveApprovedHarness } from "./production-harness.ts";

export interface DevelopmentConfig {
  readonly mode: "development";
  readonly host: "127.0.0.1" | "::1" | "0.0.0.0";
  readonly installationId: string;
  readonly adminEmail: string;
  readonly adminPassword: string;
  readonly authSecret: string;
  readonly authBaseURL: string;
  readonly trustedDevelopmentBridgeCidr?: string;
}

export interface PostgresDevelopmentConfig extends Omit<DevelopmentConfig, "installationId"> {
  readonly databaseUrl: string;
  readonly poolMax?: number;
  readonly bootstrapInstallationName?: string;
  readonly bootstrapServiceKeyFile?: string;
}

export type PostgresDevelopmentRuntimeOptions =
  | InstallationRuntimeDrivers
  | {
      readonly computeDriver?: ComputeDriver;
      readonly configurationDriver?: ConfigurationDriver;
      readonly auditEventFactory?: AuditEventFactory;
    };

export function createDevelopmentDockerComputeDriver(
  environment: NodeJS.ProcessEnv = process.env,
): ComputeDriver {
  return createDockerDevelopmentComputeDriverFromEnv(environment);
}

export function createDevelopmentIAMState(
  seed: AuthPrincipalSeed | BootstrapAdministratorSeed,
): NativeIAMState {
  const servicePrincipals = "servicePrincipal" in seed ? [seed.servicePrincipal] : [];
  return Object.freeze({
    identities: Object.freeze([seed.principal, ...servicePrincipals]),
    groups: Object.freeze([]),
    memberships: Object.freeze([]),
    roles: Object.freeze([...seed.roles]),
    bindings: Object.freeze([...seed.bindings]),
    restrictions: Object.freeze([]),
  });
}

class DevelopmentBootstrapFailure extends Error {
  readonly statusCode?: number;
  readonly uncertain: boolean;

  constructor(
    message: string,
    options: { readonly statusCode?: number; readonly uncertain?: boolean },
  ) {
    super(message);
    this.name = "DevelopmentBootstrapFailure";
    if (options.statusCode !== undefined) this.statusCode = options.statusCode;
    this.uncertain = options.uncertain ?? false;
  }
}

async function bootstrapDevelopmentInstallation(
  app: ReturnType<typeof createFastifyApp>,
  development: DevelopmentConfig,
  installationName: string,
): Promise<void> {
  await app.ready();
  const origin = development.authBaseURL;
  const host = new URL(origin).host;
  const signIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: {
      host,
      origin,
      "content-type": "application/json",
    },
    payload: JSON.stringify({
      email: development.adminEmail,
      password: development.adminPassword,
    }),
    remoteAddress: "127.0.0.1",
  });
  if (signIn.statusCode < 200 || signIn.statusCode >= 300) {
    throw new DevelopmentBootstrapFailure(
      `Development administrator sign-in failed with HTTP ${signIn.statusCode}.`,
      { statusCode: signIn.statusCode },
    );
  }
  const cookie = cookieHeaderFromSetCookie(signIn.headers["set-cookie"]);
  if (cookie.length === 0) {
    throw new Error("Development administrator sign-in did not return a session cookie.");
  }

  let bootstrap;
  try {
    bootstrap = await app.inject({
      method: "POST",
      url: "/installation/bootstrap",
      headers: {
        host,
        origin,
        cookie,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: installationName }),
      remoteAddress: "127.0.0.1",
    });
  } catch (error) {
    throw new DevelopmentBootstrapFailure(
      error instanceof Error
        ? error.message
        : "Development Installation bootstrap did not return a response.",
      { uncertain: true },
    );
  }
  if (bootstrap.statusCode !== 201) {
    throw new DevelopmentBootstrapFailure(
      `Development Installation bootstrap failed with HTTP ${bootstrap.statusCode}.`,
      { statusCode: bootstrap.statusCode, uncertain: bootstrap.statusCode >= 500 },
    );
  }
}

export async function composePostgresDevelopment(
  config: PostgresDevelopmentConfig,
  options: PostgresDevelopmentRuntimeOptions = {},
  serviceAccountDriverFactory?: ServiceAccountDriverFactory,
) {
  const drivers = "installation" in options ? options : undefined;
  const auditEventFactory = "auditEventFactory" in options ? options.auditEventFactory : undefined;
  const driverId = drivers?.installation.drivers.iam.id ?? "native-iam";
  const serviceAccountSelection = drivers?.installation.drivers.service_account;
  if ((serviceAccountSelection === undefined) !== (serviceAccountDriverFactory === undefined)) {
    throw new Error(
      "The selected ServiceAccount Driver requires API-only PostgreSQL initialization.",
    );
  }

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ...(config.poolMax === undefined ? {} : { max: config.poolMax }),
  });
  let poolClosed = false;

  try {
    const state = new PostgresPlatformState(pool);
    const persistedInstallation = await state.loadInstallation();
    const installationId = persistedInstallation?.id ?? `ins_${randomUUID()}`;
    const development: DevelopmentConfig = { ...config, installationId };
    const auth = await createPostgresControllerAuth({
      mode: development.mode,
      installationId,
      secret: development.authSecret,
      baseURL: development.authBaseURL,
      pool,
      secureCookies: false,
    });
    const computeDriver = options.computeDriver ?? createDevelopmentDockerComputeDriver();
    const sandboxDriver = drivers?.sandboxDriver;
    const configurationDriver =
      options.configurationDriver ??
      ("installation" in options
        ? options.configurationDriver
        : createFilesystemDevelopmentConfigurationDriverFromEnv());
    let initialIAMState: NativeIAMState | undefined;
    let bootstrapAccount: AuthenticatedAccount | undefined;
    let bootstrapServiceKey: Awaited<ReturnType<typeof auth.createServiceKey>> | undefined;
    let bootstrapServiceKeyOutput: BootstrapOutputFile | undefined;
    let bootstrapServiceKeyFile: string | undefined;
    if (persistedInstallation === undefined) {
      if (config.bootstrapInstallationName === undefined) {
        const account = await auth.createAccount({
          email: development.adminEmail,
          password: development.adminPassword,
          name: "OpenClaw Administrator",
        });
        bootstrapAccount = account;
        initialIAMState = createDevelopmentIAMState(auth.principalSeed(account));
      } else {
        bootstrapServiceKeyFile = bootstrapOutputPath(
          config.bootstrapServiceKeyFile ?? "",
          "OCC_BOOTSTRAP_SERVICE_KEY_FILE",
        );
        try {
          const account = await auth.createAccount({
            email: development.adminEmail,
            password: development.adminPassword,
            name: "OpenClaw Administrator",
          });
          bootstrapAccount = account;
          const seed = createBootstrapAdministratorSeed(installationId, auth.issuer, account);
          bootstrapServiceKey = await auth.createServiceKey({
            principal: seed.servicePrincipal,
            name: "bootstrap-admin",
          });
          bootstrapServiceKeyOutput = await writeProtectedBootstrapJson(bootstrapServiceKeyFile, {
            data: bootstrapServiceKey,
            meta: { installationId },
          });
          initialIAMState = createDevelopmentIAMState(seed);
        } catch (error) {
          if (bootstrapServiceKey !== undefined) {
            await auth.revokeServiceKey(bootstrapServiceKey).catch(() => {});
          }
          if (bootstrapAccount !== undefined) {
            await auth.deleteAccount(bootstrapAccount).catch(() => {});
          }
          await removeAttemptBootstrapFile(bootstrapServiceKeyOutput);
          throw error;
        }
      }
      state.setBootstrapNativeIAM(initialIAMState);
    }
    const iamState =
      persistedInstallation === undefined
        ? initialIAMState!
        : await state.loadNativeIAMState(installationId);

    validatePersistedNativeIAMState(iamState);
    const iamDriver =
      drivers === undefined
        ? new NativeIAMDriver(state, { id: driverId, implementation: "native" })
        : drivers.createIAMDriver(state);

    const bootstrapPrincipal = iamState.identities.find(
      (identity) => identity.kind === "principal",
    );
    if (bootstrapPrincipal === undefined || bootstrapPrincipal.kind !== "principal") {
      throw new Error("The configured development administrator is absent from native IAM policy.");
    }
    const principal = await iamDriver.lookupIdentity({
      issuer: bootstrapPrincipal.issuer,
      subject: bootstrapPrincipal.subject,
    });
    if (!principal || principal.kind !== "principal" || principal.id !== bootstrapPrincipal.id)
      throw new Error("The configured development Principal is absent from persisted IAM policy.");
    const provisionAuthAccount = async (seed: AuthPrincipalSeed, auditEvent: AuditEvent) => {
      const current = await state.loadNativeIAMState(installationId);
      validateAuthAccountPrincipalSeed(seed, current, installationId);
      await state.appendNativeIAMPrincipal(seed, auditEvent);
    };

    let controller: OpenClawController | undefined;
    if (persistedInstallation !== undefined) {
      controller = new OpenClawController(persistedInstallation, {
        state,
        recordOperations: true,
      });
      controller.registerDriver(iamDriver);
      const selected = controller.selectDriver("iam", driverId);
      if (selected !== iamDriver || selected.capability !== "iam" || selected.id !== driverId) {
        throw new Error("The server-owned IAM Driver was not selected correctly.");
      }
      controller.registerDriver(computeDriver);
      controller.selectDriver("compute", computeDriver.id);
      if (sandboxDriver !== undefined) {
        controller.registerDriver(sandboxDriver);
        if (controller.selectDriver("sandbox", sandboxDriver.id) !== sandboxDriver) {
          throw new Error("The configured Sandbox Driver was not selected correctly.");
        }
      }
      if (configurationDriver !== undefined) {
        controller.registerDriver(configurationDriver);
        if (
          controller.selectDriver("configuration", configurationDriver.id) !== configurationDriver
        ) {
          throw new Error("The selected Configuration Driver was not selected correctly.");
        }
      }
      if (drivers?.secretDriver !== undefined) {
        controller.registerDriver(drivers.secretDriver);
        if (controller.selectDriver("secret", drivers.secretDriver.id) !== drivers.secretDriver) {
          throw new Error("The selected Secret Driver was not selected correctly.");
        }
      }
      serviceAccountDriverFactory?.(controller, state);
    }

    const app = createFastifyApp({
      ...(controller === undefined
        ? {
            createController(installation: Installation) {
              const controller = new OpenClawController(installation, {
                state,
                recordOperations: true,
              });
              if (drivers?.secretDriver !== undefined) {
                controller.registerDriver(drivers.secretDriver);
                controller.selectDriver("secret", drivers.secretDriver.id);
              }
              serviceAccountDriverFactory?.(controller, state);
              return controller;
            },
          }
        : { controller }),
      iamDriver,
      computeDriver,
      ...(configurationDriver === undefined ? {} : { configurationDriver }),
      ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
      resolveHarness: resolveApprovedHarness,
      auditSink: state.auditSink,
      auth,
      provisionAuthAccount,
      ...(auditEventFactory === undefined ? {} : { auditEventFactory }),
      development: {
        enabled: true,
        installationId,
        ...(development.trustedDevelopmentBridgeCidr === undefined
          ? {}
          : { trustedCidrs: [development.trustedDevelopmentBridgeCidr] }),
      },
      maxBodyBytes: 64 * 1024,
    });
    app.get("/healthz", async () => ({ status: "ok" }));
    app.get("/readyz", async () => {
      await pool.query("SELECT 1");
      return { status: "ready" };
    });
    app.addHook("onClose", async () => {
      poolClosed = true;
      await state.close();
    });
    if (persistedInstallation === undefined && config.bootstrapInstallationName !== undefined) {
      try {
        await bootstrapDevelopmentInstallation(app, development, config.bootstrapInstallationName);
      } catch (error) {
        try {
          const uncertain = error instanceof DevelopmentBootstrapFailure ? error.uncertain : true;
          if (!uncertain && bootstrapServiceKey !== undefined) {
            await auth.revokeServiceKey(bootstrapServiceKey);
          }
          if (!uncertain && bootstrapAccount !== undefined) {
            await auth.deleteAccount(bootstrapAccount);
          }
          if (!uncertain) await removeAttemptBootstrapFile(bootstrapServiceKeyOutput);
        } finally {
          await app.close();
        }
        throw error;
      }
    }
    return app;
  } catch (error) {
    if (!poolClosed) await pool.end();
    throw error;
  }
}
