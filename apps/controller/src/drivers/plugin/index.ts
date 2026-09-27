import { asRecord, deepFreeze, immutableCopy } from "@openclaw-enterprise/utils";
import {
  type JSONSchema,
  type PluginCatalogEntry,
  type PluginCatalogPage,
  type PluginDriver,
  type PluginDesiredState,
  type PluginPolicyCapabilities,
  type PluginDriverContext,
  type PluginDriverIdentity,
} from "@openclaw-enterprise/contracts";
import {
  NotImplementedError,
  PluginDiscoveryError,
  PluginPolicyValidationError,
  ScopeViolationError,
} from "@openclaw-enterprise/occ";
import {
  openClawCatalogEntries,
  validatePolicies,
  type CodexPluginCatalogReader,
} from "./runtime-translator.ts";
import { NativeCodexPluginCatalogReader } from "./stdio-catalog-reader.ts";
import { discoverHostedPlugins, getHostedPlugin } from "./hosted-catalog.ts";

type ConfigurationRecord = Readonly<Record<string, unknown>>;

interface PluginDriverSelection {
  readonly id?: string;
  readonly implementation?: string;
}

type BundledCatalogEntry = PluginCatalogEntry;

export class PluginValidationError extends ScopeViolationError {}

const OCC_DRIVER_ID = "occ-plugin";
const OCC_IMPLEMENTATION = "occ/openclaw-plugin";
const CODEX_DRIVER_ID = "codex-plugin";
const CODEX_IMPLEMENTATION = "occ/codex-plugin";

const EMPTY_CONFIGURATION_SCHEMA: JSONSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {},
});

const CODEX_CONFIGURATION_SCHEMA: JSONSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {
    catalogSource: { type: "string", enum: ["hosted", "openai-curated"] },
    codexExecutable: { type: "string", minLength: 1 },
    codexHome: { type: "string", minLength: 1 },
    requestTimeoutMs: { type: "integer", minimum: 1, maximum: 60_000 },
  },
});

const CODEX_POLICY_SCHEMA: JSONSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {
    destructiveEnabled: {
      type: "boolean",
      title: "Destructive tools",
      description:
        "Whether destructive tools are enabled by default. Explicit tool enablement overrides this default. Leave toolDefaults.enabled unset when using this setting.",
    },
  },
});

const OCC_CATALOG: readonly BundledCatalogEntry[] = deepFreeze(openClawCatalogEntries());

// The public Linear plugin manifest identifies the marketplace and app-backed plugin.
// Tool inventory and account availability remain unknown until native runtime discovery.
const OPENAI_CURATED_CATALOG: readonly BundledCatalogEntry[] = deepFreeze([
  {
    id: "codex-plugin:linear@openai-curated-remote",
    remoteId: "plugin_asdk_app_69a089a326dc8191b32a3f2553f5be2c",
    name: "Linear",
    description: "Plan and build products",
    websiteUrl: "https://linear.app/",
    privacyPolicyUrl: "https://linear.app/privacy",
    termsOfServiceUrl: "https://linear.app/terms",
    selectableWithoutTools: true,
    tools: null,
  },
]);
const CURATED_SETUP = deepFreeze({
  message:
    "This catalog does not verify workspace access, app connections, or tool availability. Configure the Agent's credentials and app access before deployment.",
  links: [
    { label: "Manage workspace plugins", url: "https://chatgpt.com/admin/plugins?catalog=GLOBAL" },
    {
      label: "OCE plugin setup",
      url: "https://github.com/openclaw/openclaw-enterprise/blob/main/docs/reference/drivers/plugin-bundled.md#selection-and-catalogs",
    },
  ],
});

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PluginValidationError(`${path} must be a nonempty string.`);
  }
  return value;
}

function validateEmptyConfiguration(configuration: unknown, name: string): void {
  const value = asRecord(configuration);
  if (value === undefined) {
    throw new PluginValidationError(`${name} configuration must be one object.`);
  }
  const keys = Object.keys(value);
  if (keys.length > 0) {
    throw new PluginValidationError(`${name} configuration does not accept options.`);
  }
}

function validateCodexConfiguration(configuration: unknown): {
  catalogSource: "hosted" | "openai-curated";
  reader: ConstructorParameters<typeof NativeCodexPluginCatalogReader>[0] | undefined;
} {
  const value = asRecord(configuration);
  if (value === undefined) {
    throw new PluginValidationError("Codex Plugin Driver configuration must be one object.");
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!["catalogSource", "codexExecutable", "codexHome", "requestTimeoutMs"].includes(key)) {
      throw new PluginValidationError(`Codex Plugin Driver configuration.${key} is unsupported.`);
    }
  }
  const catalogSource = value.catalogSource === undefined ? "hosted" : value.catalogSource;
  if (catalogSource !== "hosted" && catalogSource !== "openai-curated") {
    throw new PluginValidationError("catalogSource must be hosted or openai-curated.");
  }
  if (
    value.codexExecutable === undefined &&
    value.codexHome === undefined &&
    value.requestTimeoutMs === undefined
  ) {
    return { catalogSource, reader: undefined };
  }
  const codexExecutable = requiredString(value.codexExecutable, "codexExecutable");
  const codexHome = requiredString(value.codexHome, "codexHome");
  const requestTimeoutMs = value.requestTimeoutMs;
  if (
    requestTimeoutMs !== undefined &&
    (!Number.isSafeInteger(requestTimeoutMs) ||
      (requestTimeoutMs as number) < 1 ||
      (requestTimeoutMs as number) > 60_000)
  ) {
    throw new PluginValidationError("requestTimeoutMs must be between 1 and 60000.");
  }
  return {
    catalogSource,
    reader: {
      codexExecutable,
      codexHome,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs: requestTimeoutMs as number }),
    },
  };
}

function sameDriver(left: PluginDriverIdentity, right: PluginDriverIdentity): boolean {
  return left.id === right.id && left.implementation === right.implementation;
}

function ensureHarness(context: PluginDriverContext, mode: "embedded" | "dedicated"): void {
  if (context.harness.mode !== mode) {
    throw notImplemented(
      "plugin-harness-mismatch",
      "The selected Plugin Driver does not match the Harness.",
    );
  }
}

function notImplemented(operation: string, message: string): NotImplementedError {
  return new NotImplementedError(operation, message);
}

class BundledPluginDriverBase {
  readonly capability = "plugin" as const;
  readonly id: string;
  readonly implementation: string;

  protected constructor(selection: PluginDriverSelection, defaults: PluginDriverIdentity) {
    this.id = requiredString(selection.id ?? defaults.id, "Plugin Driver ID");
    this.implementation = selection.implementation ?? defaults.implementation;
    if (!sameDriver(this, defaults)) {
      throw new PluginValidationError("Unsupported bundled Plugin Driver identity.");
    }
  }

  protected validate(kind: "codex" | "openclaw", selections: PluginDesiredState): void {
    try {
      validatePolicies(kind, selections);
    } catch (error) {
      const field =
        error instanceof Error && "policyField" in error ? error.policyField : undefined;
      throw new PluginPolicyValidationError(
        field === "toolDefaults.reviewer" || field === "tools[id].reviewer" ? field : undefined,
      );
    }
  }

  protected catalog(catalog: readonly BundledCatalogEntry[]): readonly PluginCatalogEntry[] {
    return immutableCopy(catalog) as readonly PluginCatalogEntry[];
  }
}

export class OCCPluginDriver extends BundledPluginDriverBase implements PluginDriver {
  static readonly configurationSchema = EMPTY_CONFIGURATION_SCHEMA;
  readonly policyCapabilities: PluginPolicyCapabilities = deepFreeze({
    toolDefaults: { enabled: true, approval: ["native", "approve"], reviewer: [] },
    tools: { enabled: true, approval: ["native", "approve"], reviewer: [] },
    driverPolicySchema: EMPTY_CONFIGURATION_SCHEMA,
  });

  validatePolicies(selections: PluginDesiredState): void {
    this.validate("openclaw", selections);
  }

  static validateConfiguration(configuration: unknown): void {
    validateEmptyConfiguration(configuration, "OpenClaw Plugin Driver");
  }

  constructor(configuration: ConfigurationRecord = {}, selection: PluginDriverSelection = {}) {
    OCCPluginDriver.validateConfiguration(configuration);
    super(selection, { id: OCC_DRIVER_ID, implementation: OCC_IMPLEMENTATION });
  }

  async listCatalog(context: PluginDriverContext): Promise<readonly PluginCatalogEntry[]> {
    ensureHarness(context, "embedded");
    return this.catalog(OCC_CATALOG);
  }
}

export class CodexPluginDriver extends BundledPluginDriverBase implements PluginDriver {
  static readonly configurationSchema = CODEX_CONFIGURATION_SCHEMA;
  // TODO: gate prompt on enforceable session constraints before this draft ships.
  // A permissive native session can bypass app-level review despite translation.
  readonly policyCapabilities: PluginPolicyCapabilities = deepFreeze({
    toolDefaults: {
      enabled: true,
      approval: ["native", "prompt", "approve"],
      reviewer: ["human", "auto"],
    },
    tools: { enabled: true, approval: ["native", "prompt", "approve"], reviewer: [] },
    driverPolicySchema: CODEX_POLICY_SCHEMA,
  });

  validatePolicies(selections: PluginDesiredState): void {
    this.validate("codex", selections);
  }
  private readonly catalogReader: CodexPluginCatalogReader | undefined;
  private readonly catalogSource: "hosted" | "openai-curated";
  readonly discoveryCredential: "required" | "none";

  static validateConfiguration(configuration: unknown): void {
    validateCodexConfiguration(configuration);
  }

  async discoverCatalog(
    input: { readonly accessToken?: string; readonly cursor?: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogPage> {
    if (this.catalogSource === "openai-curated") {
      if (input.cursor !== undefined) {
        throw new PluginDiscoveryError("invalid_response");
      }
      return {
        plugins: this.catalog(OPENAI_CURATED_CATALOG),
        nextCursor: null,
        setup: CURATED_SETUP,
      };
    }
    if (input.accessToken === undefined) {
      throw new PluginDiscoveryError("credentials_rejected");
    }
    return discoverHostedPlugins(
      {
        accessToken: input.accessToken,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      },
      signal,
    );
  }

  async getCatalogPlugin(
    input: { readonly accessToken?: string; readonly pluginId: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogEntry> {
    if (this.catalogSource === "openai-curated") {
      const entry = OPENAI_CURATED_CATALOG.find((plugin) => plugin.remoteId === input.pluginId);
      if (!entry) {
        throw new PluginDiscoveryError("invalid_response");
      }
      return this.catalog([entry])[0]!;
    }
    if (input.accessToken === undefined) {
      throw new PluginDiscoveryError("credentials_rejected");
    }
    return getHostedPlugin({ accessToken: input.accessToken, pluginId: input.pluginId }, signal);
  }

  constructor(
    configuration: ConfigurationRecord = {},
    selection: PluginDriverSelection = {},
    catalogReader?: CodexPluginCatalogReader,
  ) {
    const discovery = validateCodexConfiguration(configuration);
    super(selection, { id: CODEX_DRIVER_ID, implementation: CODEX_IMPLEMENTATION });
    this.catalogSource = discovery.catalogSource;
    this.discoveryCredential = discovery.catalogSource === "openai-curated" ? "none" : "required";
    this.catalogReader =
      catalogReader ??
      (discovery.reader === undefined
        ? undefined
        : new NativeCodexPluginCatalogReader(discovery.reader));
  }

  async listCatalog(context: PluginDriverContext): Promise<readonly PluginCatalogEntry[]> {
    ensureHarness(context, "dedicated");
    if (this.catalogSource === "openai-curated") {
      return this.catalog(OPENAI_CURATED_CATALOG);
    }
    if (this.catalogReader === undefined) {
      throw notImplemented(
        "codex-plugin-catalog-discovery",
        "Codex plugin catalog discovery requires configured codexExecutable and codexHome.",
      );
    }
    return this.catalog(await this.catalogReader.listCatalog(context.signal));
  }
}
