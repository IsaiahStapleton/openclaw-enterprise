import { Type } from "typebox";
import { Check } from "typebox/value";
import { isAllowedSecretBindingDestination } from "./secret-bindings.ts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  CreateAgentBody,
  ConfigurationValues,
  JsonValue,
  SecretBindings as SecretBindingsSchema,
} from "./api/common.ts";
import {
  PluginDesiredStateSchema,
  PluginDesiredSelectionSchema,
  PluginToolPolicySchema,
} from "./api/resources.ts";
import {
  PresetValidationError,
  presetTemplateDefaults,
  unresolvedPresetVariableTypes,
  validatePresetTemplate,
} from "./preset-variables.mjs";
import type {
  HarnessAuthBinding,
  HarnessExecutionMode,
  PluginDesiredState,
  SecretBindings,
} from "./index.ts";

export type PresetVariable =
  | { readonly type: "string"; readonly description?: string; readonly default?: string }
  | { readonly type: "number"; readonly description?: string; readonly default?: number }
  | { readonly type: "boolean"; readonly description?: string; readonly default?: boolean };

export interface PresetLaunchSettings {
  readonly agent?: {
    readonly name?: string;
    readonly executionMode?: HarnessExecutionMode;
    readonly providerId?: string | null;
    readonly harnessAuth?: HarnessAuthBinding | null;
    readonly plugins?: PluginDesiredState;
  };
  readonly configuration?: {
    readonly values?: Readonly<Record<string, unknown>>;
    readonly secretBindings?: SecretBindings;
  };
}

// Typed launch fields may contain string tokens until rendering and admission.
export interface PresetTemplate {
  readonly variables?: Readonly<Record<string, PresetVariable>>;
  readonly agent?: Readonly<Record<string, unknown>>;
  readonly configuration?: {
    readonly values?: Readonly<Record<string, unknown>>;
    readonly secretBindings?: Readonly<Record<string, unknown>>;
  };
}

export interface Preset {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly template: PresetTemplate;
  readonly createdAt: string;
}

const refs: Record<string, Type.TSchema> = {
  SafeJsonValue: JsonValue,
  PluginDesiredState: PluginDesiredStateSchema,
  PluginDesiredSelection: PluginDesiredSelectionSchema,
  PluginToolPolicy: PluginToolPolicySchema,
};
const agentSchema = Type.Partial(Type.Omit(CreateAgentBody, ["configurationId"]));
const configurationSchema = Type.Object(
  {
    values: Type.Optional(ConfigurationValues),
    secretBindings: Type.Optional(SecretBindingsSchema),
  },
  { additionalProperties: false },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type AdmissionSchema = Type.TSchema & {
  readonly $ref?: string;
  readonly anyOf?: AdmissionSchema[];
  readonly type?: string;
  readonly properties?: Record<string, AdmissionSchema>;
  readonly patternProperties?: Record<string, AdmissionSchema>;
};

/** Extend the existing schema only where the original scalar awaits a variable. */
function deferredSchema(
  schema: AdmissionSchema,
  source: unknown,
  resolved: unknown,
  variables: Readonly<Record<string, PresetVariable>>,
): Type.TSchema {
  if (schema.$ref && schema.$ref !== "SafeJsonValue") {
    return deferredSchema(refs[schema.$ref]!, source, resolved, variables);
  }
  if (Array.isArray(schema.anyOf)) {
    return Type.Union(
      schema.anyOf.map((part: Type.TSchema) => deferredSchema(part, source, resolved, variables)),
    );
  }
  if (["string", "number", "boolean"].includes(schema.type ?? "")) {
    const missing = unresolvedPresetVariableTypes(source, variables);
    if (missing.length) {
      return missing.every((type: string) => type === schema.type)
        ? Type.Literal(resolved as string)
        : Type.Never();
    }
    return schema;
  }
  if (schema.type !== "object" || !isRecord(source) || !isRecord(resolved)) {
    return schema;
  }
  const properties: Record<string, Type.TSchema> = { ...schema.properties };
  for (const [key, value] of Object.entries(source)) {
    let child = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (!child) {
      child = Object.entries(schema.patternProperties ?? {}).find(([pattern]) =>
        new RegExp(pattern).test(key),
      )?.[1] as Type.TSchema | undefined;
    }
    if (child) {
      Object.defineProperty(properties, key, {
        value: deferredSchema(child, value, resolved[key], variables),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return { ...schema, properties, ...(schema.patternProperties ? { patternProperties: {} } : {}) };
}

function validateNamespaceReferences(
  settings: PresetLaunchSettings,
  namespaceId: string,
  template: PresetTemplate,
) {
  const bindings = settings.configuration?.secretBindings ?? {};
  const sources: { source: unknown; original: unknown }[] = Object.entries(bindings).map(
    ([key, binding]) => ({
      source: binding.source,
      original: (template.configuration?.secretBindings?.[key] as { source?: unknown } | undefined)
        ?.source,
    }),
  );
  const auth = settings.agent?.harnessAuth;
  if (auth && "source" in auth) {
    sources.push({
      source: auth.source,
      original: (template.agent?.harnessAuth as { source?: unknown } | undefined)?.source,
    });
  }
  for (const { source, original } of sources) {
    const unresolved =
      isRecord(original) &&
      unresolvedPresetVariableTypes(original.namespaceId, template.variables ?? {}).length;
    if (isRecord(source) && source.namespaceId !== namespaceId && !unresolved) {
      throw new PresetValidationError(
        "Preset credential references must belong to the same Namespace.",
      );
    }
  }
}

/** Admission for persisted templates; existing create/deploy admission still owns rendered settings. */
export function normalizePresetTemplate(input: unknown, namespaceId: string): PresetTemplate {
  const template = validatePresetTemplate(input);
  const resolved = presetTemplateDefaults(template);
  for (const [field, schema] of [
    ["agent", agentSchema],
    ["configuration", configurationSchema],
  ] as const) {
    if (template[field] === undefined) {
      continue;
    }
    const admittedSchema = deferredSchema(
      schema,
      template[field],
      resolved[field],
      template.variables ?? {},
    );
    if (!Check(refs, admittedSchema, resolved[field])) {
      throw new PresetValidationError(`Preset ${field} contains invalid launch settings.`);
    }
  }
  if (
    Object.keys(template.configuration?.secretBindings ?? {}).some(
      (name) => !isAllowedSecretBindingDestination(name),
    )
  ) {
    throw new PresetValidationError(
      "A preset Secret binding uses a reserved or invalid environment destination.",
    );
  }
  validateNamespaceReferences(resolved, namespaceId, template);
  return immutableCopy(template);
}
