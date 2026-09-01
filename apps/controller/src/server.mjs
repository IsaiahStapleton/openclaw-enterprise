import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { loadInstallationConfiguration } from "./composition/installation-config.ts";
import { composeProduction } from "./composition/production.ts";

const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]"]);
const developmentBindHosts = new Set(["127.0.0.1", "::1", "0.0.0.0"]);
const DEFAULT_BETTER_AUTH_BASE_URL = "http://127.0.0.1:3000";

function startupFailure(message) {
  process.stderr.write(`${JSON.stringify({ event: "startup-error", error: message })}\n`);
  process.exitCode = 1;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be explicitly configured.`);
  }
  return value;
}

function optionalEnvironment(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be explicitly configured.`);
  }
  return value;
}

function configuration() {
  const mode = process.env.NODE_ENV;
  if (mode !== "development" && mode !== "production")
    throw new Error("NODE_ENV must explicitly select development or production mode.");

  const host = requiredEnvironment("OCC_HOST");
  const trustedDevelopmentBridgeCidr = process.env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR;
  if (
    mode === "development" &&
    (!developmentBindHosts.has(host) ||
      (host === "0.0.0.0" &&
        (trustedDevelopmentBridgeCidr === undefined ||
          trustedDevelopmentBridgeCidr.trim().length === 0)))
  ) {
    throw new Error(
      "Development OCC_HOST must be 127.0.0.1 or ::1, or 0.0.0.0 with OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR.",
    );
  }
  if (
    mode === "production" &&
    (isIP(host) === 0 ||
      host === "0.0.0.0" ||
      host === "::" ||
      host === "::1" ||
      /^127\./.test(host) ||
      /^::ffff:127\./i.test(host))
  )
    throw new Error("Production OCC_HOST must identify one explicit Pod interface address.");

  const rawPort = requiredEnvironment("OCC_PORT");
  if (!/^\d+$/.test(rawPort)) {
    throw new Error("OCC_PORT must be a valid TCP port.");
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("OCC_PORT must be a valid TCP port.");
  }

  const databaseUrl = process.env.OCC_DATABASE_URL;
  if (mode === "production" && databaseUrl === undefined)
    throw new Error("OCC_DATABASE_URL must be explicitly configured in production.");
  if (databaseUrl !== undefined) {
    let parsed;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      throw new Error("OCC_DATABASE_URL must be a valid PostgreSQL connection URL.");
    }
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
      throw new Error("OCC_DATABASE_URL must be a valid PostgreSQL connection URL.");
    }
  }

  const rawPoolMax = process.env.OCC_DATABASE_POOL_MAX;
  const poolMax = rawPoolMax === undefined ? undefined : Number(rawPoolMax);
  if (
    rawPoolMax !== undefined &&
    (!/^\d+$/.test(rawPoolMax) || !Number.isSafeInteger(poolMax) || poolMax < 1)
  ) {
    throw new Error("OCC_DATABASE_POOL_MAX must be a positive integer.");
  }

  const settings = {
    mode,
    host,
    port,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(poolMax === undefined ? {} : { poolMax }),
  };

  const configuredAuthBaseURL =
    mode === "production"
      ? requiredEnvironment("OCC_AUTH_BASE_URL")
      : (process.env.OCC_AUTH_BASE_URL ?? DEFAULT_BETTER_AUTH_BASE_URL);
  let authBaseURL;
  try {
    authBaseURL = new URL(configuredAuthBaseURL).toString().replace(/\/$/, "");
  } catch {
    throw new Error("OCC_AUTH_BASE_URL must be a valid absolute URL.");
  }
  if (mode === "development" && !loopbackHosts.has(new URL(authBaseURL).hostname)) {
    throw new Error("Development OCC_AUTH_BASE_URL must identify a loopback host.");
  }

  if (mode === "production") {
    return Object.freeze({
      ...settings,
      authSecret: requiredEnvironment("OCC_AUTH_SECRET"),
      authBaseURL,
    });
  }

  const authSecret = optionalEnvironment(
    "OCC_AUTH_SECRET",
    "openclaw-development-auth-secret-minimum-32-bytes",
  );
  if (authSecret.length < 32) {
    throw new Error("OCC_AUTH_SECRET must be at least 32 characters.");
  }
  return Object.freeze({
    ...settings,
    authSecret,
    authBaseURL,
    ...(trustedDevelopmentBridgeCidr === undefined ? {} : { trustedDevelopmentBridgeCidr }),
  });
}

async function start() {
  const settings = configuration();
  const drivers = await loadInstallationConfiguration({ mode: settings.mode });
  let serviceAccountDriverFactory;
  const selectedServiceAccountDriver = drivers?.installation.drivers.service_account;
  if (selectedServiceAccountDriver !== undefined) {
    if (settings.databaseUrl === undefined) {
      throw new Error("Provider-managed ServiceAccounts require PostgreSQL persistence.");
    }
    if (
      typeof drivers.computeDriver.storeServiceAccountCredential !== "function" ||
      typeof drivers.computeDriver.deleteServiceAccountCredential !== "function"
    ) {
      throw new Error("The selected Compute Driver cannot manage ServiceAccount credentials.");
    }
    const providerDefinition = drivers.installation.provider.find(
      (provider) => provider.drivers.service_account === selectedServiceAccountDriver.id,
    );
    if (providerDefinition === undefined) {
      throw new Error("The selected ServiceAccount Driver requires an owning Provider.");
    }
    const { configuration } = providerDefinition;
    let adminKey;
    try {
      adminKey = (await readFile(configuration.apiKeyPath, "utf8")).trim();
    } catch {
      throw new Error("The configured ChatGPT admin-key Secret is unavailable.");
    }
    if (adminKey.length === 0) {
      throw new Error("The mounted ChatGPT admin key must be nonempty.");
    }
    const { ChatGPTClient } = await import("./providers/chatgpt.ts");
    const { createChatGPTServiceAccountDriverFactory } =
      await import("./drivers/service-account/chatgpt.ts");
    const provider = {
      id: providerDefinition.id,
      drivers: providerDefinition.drivers,
      client: new ChatGPTClient({
        workspaceId: configuration.workspaceId,
        adminKey,
        ...(configuration.credentialTtlSeconds === undefined
          ? {}
          : { credentialTtlSeconds: configuration.credentialTtlSeconds }),
      }),
    };
    serviceAccountDriverFactory = createChatGPTServiceAccountDriverFactory(
      provider,
      drivers.computeDriver,
    );
  }
  if (settings.mode === "development" && settings.databaseUrl === undefined) {
    throw new Error("OCC_DATABASE_URL must be explicitly configured in development.");
  }
  let app;
  if (settings.mode === "production") {
    if (drivers === undefined) throw new Error("Production Driver configuration is unavailable.");
    app = await composeProduction({
      ...settings,
      drivers,
      ...(serviceAccountDriverFactory === undefined ? {} : { serviceAccountDriverFactory }),
    });
  } else {
    const { composePostgresDevelopment } = await import("./composition/development-postgres.ts");
    app = await composePostgresDevelopment(settings, drivers, serviceAccountDriverFactory);
  }

  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    try {
      await app.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  }

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  try {
    await app.listen({ host: settings.host, port: settings.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({ event: "listening", host: settings.host, port: settings.port })}\n`,
  );
}

try {
  await start();
} catch (error) {
  startupFailure(error instanceof Error ? error.message : "The OCC server could not start.");
}
