import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

export class ConfigurationValidationError extends Error {}

const modelCredentialMessage = (path: string): string =>
  `Configuration field ${path} holds a credential value inline, where a reference is required. Store the key as a Secret and select it as the Agent's model credential instead.`;

/**
 * A literal credential in a known model credential field. Its message names the field's
 * JSON pointer within the Configuration values and never the value, so HTTP can return it.
 */
export class ModelCredentialValueError extends ConfigurationValidationError {
  readonly path: string;

  constructor(path: string) {
    // The error contract caps messages at 256 characters; a long provider name shortens the path.
    const budget = 256 - modelCredentialMessage("").length;
    super(modelCredentialMessage(path.length <= budget ? path : `${path.slice(0, budget - 1)}…`));
    this.name = "ModelCredentialValueError";
    this.path = path;
  }
}

const pointer = (...segments: readonly string[]): string =>
  segments.map((segment) => `/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

/** Known native model credential slots must store unresolved references, never values. */
export function validateModelCredentialReferences(values: OpenClawConfigurationDocument): void {
  const validateReference = (value: unknown, path: string, authorizationHeader = false): void => {
    if (value === undefined || value === null) {
      return;
    }
    if (typeof value === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) {
      return;
    }
    if (
      authorizationHeader &&
      typeof value === "string" &&
      /^Bearer \$\{[A-Za-z_][A-Za-z0-9_]*\}$/i.test(value)
    ) {
      return;
    }
    const reference = asRecord(value);
    if (
      reference &&
      Object.keys(reference).length === 3 &&
      [reference.source, reference.provider, reference.id].every(isNonEmptyString)
    ) {
      return;
    }
    throw new ModelCredentialValueError(path);
  };

  const providers = asRecord(asRecord(values.models)?.providers);
  for (const [providerName, provider] of Object.entries(providers ?? {})) {
    const config = asRecord(provider);
    validateReference(config?.apiKey, pointer("models", "providers", providerName, "apiKey"));
    for (const [name, value] of Object.entries(asRecord(config?.headers) ?? {})) {
      if (/^(?:authorization|api-key|x-api-key)$/i.test(name)) {
        validateReference(
          value,
          pointer("models", "providers", providerName, "headers", name),
          name.toLowerCase() === "authorization",
        );
      }
    }
  }
  const env = asRecord(values.env);
  for (const [prefix, settings] of [
    [["env"], env],
    [["env", "vars"], asRecord(env?.vars)],
  ] as const) {
    for (const [name, value] of Object.entries(settings ?? {})) {
      if (
        [
          "OPENAI_API_KEY",
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CODEX_ACCESS_TOKEN",
        ].includes(name)
      ) {
        validateReference(value, pointer(...prefix, name));
      }
    }
  }
}
