import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { composeProduction } from "../../apps/controller/src/composition/production.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import {
  clientAddressConfiguration,
  githubLoginConfiguration,
} from "../../apps/controller/src/auth/index.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { createInstallationDriverConfiguration } from "./installation-driver-configuration.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.mjs";
import { createTestSecretDriver } from "./secret-driver.mjs";
import {
  privateBootstrapDirectory,
  productionBootstrapEnvironment,
  runBootstrapInstallation,
} from "./bootstrap-installation.mjs";
import { cookieHeaderFromSetCookie } from "./auth-session.mjs";

// Only Compute is passive: no Agent is deployed, so sign-in proofs need no cluster.
// Authentication, State, IAM, audit and Fastify are the production implementations.
function passiveComputeDriver(id) {
  return {
    id,
    capability: "compute",
    implementation: "sign-in-proof-memory-compute",
    async preflight() {},
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async retireRevision() {},
  };
}

/** Runs the chart's initialization Job command and returns the generated administrator password. */
export async function bootstrapProductionInstallation(context, { databaseUrl, email, authSecret }) {
  const directory = await privateBootstrapDirectory(context, "openclaw-sign-in-proof-");
  const environment = productionBootstrapEnvironment({
    databaseUrl,
    directory,
    email,
    authSecret,
    installationName: "Sign-in proof",
  });
  const result = await runBootstrapInstallation(environment);
  if (!result.ok) {
    throw new Error(`Production bootstrap failed:\n${result.stderr || result.stdout}`);
  }
  return (await readFile(environment.OCC_BOOTSTRAP_PASSWORD_FILE, "utf8")).trim();
}

/** Collects structured controller log events, as the API Pod would emit them. */
export function memoryLogger() {
  const events = [];
  return {
    events,
    logger: createOccLogger({
      component: "occ-api-sign-in-proof",
      destination: {
        write(chunk) {
          for (const line of String(chunk).split("\n")) {
            if (line.length > 0) {
              events.push(JSON.parse(line));
            }
          }
          return true;
        },
      },
    }),
  };
}

export const consoleOrigin = "https://console.oce.example.internal";
const gatewayApiKeyPath = "/etc/openclaw/gateway-api-key/key";
const secretRef = (name, key) => ({ secretKeyRef: { name, key } });

/**
 * The API Pod's sign-in environment rendered from deploy/examples/production/values.yaml:
 * no OCC_AUTH_GITHUB_*, no trusted proxy. password-default-chart.test.mjs asserts the
 * chart renders exactly these OCC_AUTH_* and OCC_AGENT_NATIVE_ADMIN_* entries.
 */
export const defaultInstallSettings = Object.freeze({
  OCC_AUTH_SECRET: secretRef("occ-auth", "secret"),
  OCC_AUTH_BASE_URL: consoleOrigin,
  OCC_AGENT_NATIVE_ADMIN_ENABLED: "true",
  OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.example.internal",
  OCC_AUTH_COOKIE_DOMAIN: "oce.example.internal",
  OCC_GATEWAY_API_KEY_PATH: gatewayApiKeyPath,
});

/** The example values plus the GitHub upgrade from production-installation.md step 2. */
export function githubUpgradeValues(recoveryUserId) {
  return {
    "auth.github.enabled": "true",
    "auth.recoveryUserId": recoveryUserId,
    "agentNativeAdmin.enabled": "false",
  };
}

export function githubUpgradeSettings(recoveryUserId) {
  return Object.freeze({
    OCC_AUTH_SECRET: secretRef("occ-auth", "secret"),
    OCC_AUTH_BASE_URL: consoleOrigin,
    OCC_AUTH_GITHUB_CLIENT_ID: secretRef("occ-github-login", "client-id"),
    OCC_AUTH_GITHUB_CLIENT_SECRET: secretRef("occ-github-login", "client-secret"),
    OCC_AUTH_GITHUB_RECOVERY_USER_ID: recoveryUserId,
    OCC_AGENT_NATIVE_ADMIN_ENABLED: "false",
    OCC_GATEWAY_API_KEY_PATH: gatewayApiKeyPath,
  });
}

function resolveSettings(settings, secrets) {
  const environment = {};
  for (const [name, value] of Object.entries(settings)) {
    if (typeof value === "string") {
      environment[name] = value;
    } else {
      const { name: secret, key } = value.secretKeyRef;
      environment[name] = secrets[`${secret}/${key}`];
      if (environment[name] === undefined) {
        throw new Error(`Missing fixture Secret ${secret}/${key}.`);
      }
    }
  }
  return environment;
}

/**
 * Composes the production API from rendered API Pod settings, parsing the sign-in and
 * native-admin names the way apps/controller/src/server.mjs does.
 */
export async function composeProductionSignIn(context, { databaseUrl, settings, secrets, logger }) {
  const environment = resolveSettings(settings, secrets);
  // The chart mounts the gateway service key Secret at this path; use a private file.
  const keyDirectory = await privateBootstrapDirectory(context, "openclaw-gateway-key-");
  const keyFile = join(keyDirectory, "key");
  if (environment.OCC_GATEWAY_API_KEY_PATH === gatewayApiKeyPath) {
    await writeFile(keyFile, "occ_sign_in_proof_gateway_key", { mode: 0o600 });
  }
  const configuration = createInstallationDriverConfiguration();
  configuration.drivers.compute.id = "compute-sign-in-proof";
  const runtime = await loadInstallationConfiguration({
    mode: "production",
    environment: {},
    startupConfiguration: { configuration, logging: { level: "info" } },
  });
  const { installation } = runtime;
  const github = githubLoginConfiguration(environment);
  const clientAddress = clientAddressConfiguration(environment);
  const nativeAdminEnabled = environment.OCC_AGENT_NATIVE_ADMIN_ENABLED === "true";
  return composeProduction({
    mode: "production",
    host: "127.0.0.1",
    databaseUrl,
    authSecret: environment.OCC_AUTH_SECRET,
    authBaseURL: environment.OCC_AUTH_BASE_URL,
    ...(environment.OCC_GATEWAY_API_KEY_PATH === undefined ? {} : { gatewayApiKeyPath: keyFile }),
    ...(github === undefined ? {} : { github }),
    ...(clientAddress === undefined ? {} : { clientAddress }),
    ...(nativeAdminEnabled
      ? {
          nativeAdmin: {
            enabled: true,
            domain: environment.OCC_AGENT_NATIVE_ADMIN_DOMAIN,
            sharedCookieDomain: environment.OCC_AUTH_COOKIE_DOMAIN,
          },
        }
      : {}),
    ...(logger === undefined ? {} : { logger }),
    drivers: {
      installation,
      defaultPresets: runtime.defaultPresets,
      computeDriver: passiveComputeDriver(installation.drivers.compute.id),
      configurationDriver: createTestConfigurationDriver({
        id: installation.drivers.configuration.id,
      }),
      secretDriver: createTestSecretDriver({ id: installation.drivers.secret.id }),
      createIAMDriver: (state) =>
        new NativeIAMDriver(state, {
          id: installation.drivers.iam.id,
          implementation: installation.drivers.iam.implementation,
        }),
    },
  });
}

/** Password sign-in through the public route, from one client address. */
export function passwordSignIn(app, origin, { email, password }, remoteAddress = "192.0.2.10") {
  return app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    remoteAddress,
    headers: { origin },
    payload: { email, password },
  });
}

export async function signedInHeaders(app, origin, account, remoteAddress) {
  const response = await passwordSignIn(app, origin, account, remoteAddress);
  if (response.statusCode !== 200) {
    throw new Error(`Password sign-in failed with ${response.statusCode}: ${response.body}`);
  }
  return { cookie: cookieHeaderFromSetCookie(response.headers["set-cookie"]), origin };
}

export async function currentSession(app, cookie) {
  return (await app.inject({ url: "/api/auth/session", headers: { cookie } })).json().data;
}
