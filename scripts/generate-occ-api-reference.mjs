import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { STATUS_CODES } from "node:http";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const documentPath = new URL("../packages/contracts/openapi/occ-api.openapi.json", import.meta.url);
const referenceDirectoryPath = new URL("../docs/reference/api/", import.meta.url);

export const API_REFERENCE_WORD_LIMIT = 2500;

function slugifySegment(value) {
  return (
    String(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "operation"
  );
}

function tagAnchor(tag) {
  return slugifySegment(tag);
}

function operationAnchor(path, method) {
  const pathId = path
    .toLowerCase()
    .replace(/[{}]/g, "")
    .replace(/[^a-z0-9]+/g, "");
  return `${method.toLowerCase()}-${pathId}`;
}

function schemaType(schema, document) {
  if (schema.$ref) {
    const name = schema.$ref.split("/").at(-1);
    return document.components?.schemas?.[name]?.title ?? name;
  }

  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" or ");
  if (schema.anyOf) {
    return schema.anyOf.map((alternative) => schemaType(alternative, document)).join(" or ");
  }
  if (schema.type === "array") return `array<${schemaType(schema.items ?? {}, document)}>`;
  if (
    schema.type === "object" &&
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    return `object<string, ${schemaType(schema.additionalProperties, document)}>`;
  }

  return schema.format ? `${schema.type} (${schema.format})` : (schema.type ?? "any");
}

function resolveSchema(schema, document) {
  if (!schema?.$ref) return schema;

  if (!schema.$ref.startsWith("#/")) return schema;

  return (
    schema.$ref
      .slice(2)
      .split("/")
      .reduce(
        (value, segment) => value?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")],
        document,
      ) ?? schema
  );
}

function schemaConstraints(schema) {
  const constraints = [];

  if (schema.minLength !== undefined) constraints.push(`min length: ${schema.minLength}`);
  if (schema.maxLength !== undefined) constraints.push(`max length: ${schema.maxLength}`);
  if (schema.minimum !== undefined) constraints.push(`minimum: ${schema.minimum}`);
  if (schema.maximum !== undefined) constraints.push(`maximum: ${schema.maximum}`);
  if (schema.minItems !== undefined) constraints.push(`min items: ${schema.minItems}`);
  if (schema.maxItems !== undefined) constraints.push(`max items: ${schema.maxItems}`);
  if (schema.pattern) constraints.push(`pattern: \`${schema.pattern.replaceAll("|", "\\|")}\``);
  if (schema.default !== undefined) constraints.push(`default: ${JSON.stringify(schema.default)}`);
  if (schema.description) constraints.push(schema.description.replaceAll("|", "\\|"));

  return constraints.join("; ") || "—";
}

function schemaRows(schema, document, parent = "") {
  const resolvedSchema = resolveSchema(schema, document);
  const rows = [];

  for (const [name, property] of Object.entries(resolvedSchema.properties ?? {})) {
    const resolvedProperty = resolveSchema(property, document);
    const field = parent ? `${parent}.${name}` : name;
    const required = resolvedSchema.required?.includes(name) ? "Yes" : "No";
    const columns = [
      `\`${field}\``,
      `\`${schemaType(property, document)}\``,
      required,
      schemaConstraints(resolvedProperty),
    ];
    rows.push(`| ${columns.join(" | ")} |`);

    if (resolvedProperty.type === "object" && resolvedProperty.properties) {
      rows.push(...schemaRows(resolvedProperty, document, field));
    } else if (resolvedProperty.type === "array") {
      const resolvedItems = resolveSchema(resolvedProperty.items, document);
      if (resolvedItems.properties) rows.push(...schemaRows(resolvedItems, document, `${field}[]`));
    }
  }

  return rows;
}

function schemaTable(schema, document) {
  const resolvedSchema = resolveSchema(schema, document);
  const rows = schemaRows(resolvedSchema, document);
  if (rows.length === 0) return `Schema: \`${schemaType(schema, document)}\`.`;

  return ["| Field | Type | Required | Constraints |", "| --- | --- | --- | --- |", ...rows].join(
    "\n",
  );
}

function operationReference(path, method, operation, document, { headingLevel = 2 } = {}) {
  const sections = [
    `${"#".repeat(headingLevel)} \`${method.toUpperCase()} ${path}\``,
    `<span id="${operationAnchor(path, method)}"></span>`,
    operation.summary ?? "No summary.",
    `**Operation ID:** \`${operation.operationId ?? `${method}_${path}`}\``,
    `**Permissions:** ${operation.description ?? "No IAM permission required."}`,
  ];

  if (operation["x-openclaw-permissions"]?.length) {
    sections.push(
      [
        "| Action | Resource | Scope |",
        "| --- | --- | --- |",
        ...operation["x-openclaw-permissions"].map(({ action, resourceKind, scope, condition }) => {
          const qualifier =
            condition === "associated_service_account"
              ? " (when associated)"
              : condition === "existing_namespace"
                ? " (when selecting an existing namespace)"
                : condition === "bound_secret"
                  ? " (when bound)"
                  : "";
          return `| \`${action}\` | \`${resourceKind}\` | \`${scope}\`${qualifier} |`;
        }),
      ].join("\n"),
    );
  }

  if (operation.parameters?.length) {
    sections.push(
      "## Parameters",
      [
        "| Name | In | Type | Required | Constraints |",
        "| --- | --- | --- | --- | --- |",
        ...operation.parameters.map((parameter) => {
          const columns = [
            `\`${parameter.name}\``,
            parameter.in,
            `\`${schemaType(parameter.schema, document)}\``,
            parameter.required ? "Yes" : "No",
            schemaConstraints(parameter.schema),
          ];
          return `| ${columns.join(" | ")} |`;
        }),
      ].join("\n"),
    );
  }

  if (operation.requestBody) {
    sections.push(
      "## Request body",
      `**Required:** ${operation.requestBody.required ? "Yes" : "No"}`,
    );

    for (const [contentType, content] of Object.entries(operation.requestBody.content ?? {})) {
      sections.push(`**Content type:** \`${contentType}\``, schemaTable(content.schema, document));
    }
  }

  sections.push(
    "## Responses",
    [
      "| Status | Meaning |",
      "| --- | --- |",
      ...Object.keys(operation.responses).map((status) => {
        const meaning = STATUS_CODES[status] ?? operation.responses[status].description;
        return `| \`${status}\` | ${meaning} |`;
      }),
    ].join("\n"),
  );

  for (const [status, response] of Object.entries(operation.responses)) {
    if (!status.startsWith("2")) continue;

    for (const [contentType, content] of Object.entries(response.content ?? {})) {
      sections.push(
        `**\`${status}\` response body:** \`${contentType}\``,
        schemaTable(content.schema, document),
      );
    }
  }

  return sections.join("\n\n");
}

const pageDefinitions = [
  {
    title: "Authentication",
    slug: "authentication",
    operationIds: [
      "createAuthAccount",
      "createServiceKey",
      "revokeServiceKey",
      "getAuthSession",
      "signInEmail",
      "signOut",
    ],
  },
  {
    title: "Platform",
    slug: "platform",
    operationIds: ["getInstallation", "bootstrapInstallation", "listProviders"],
  },
  {
    title: "Namespaces",
    slug: "namespaces",
    operationIds: ["listNamespaces", "createNamespace", "deleteNamespace", "getNamespace"],
  },
  {
    title: "Agents",
    slug: "agents",
    operationIds: ["listAgents", "createAgent", "getAgent", "updateAgent"],
  },
  { title: "Agent deployment", slug: "agents-deployment", operationIds: ["deployAgent"] },
  {
    title: "Agent runtime credentials",
    slug: "agents-runtime-credentials",
    operationIds: ["getAgentRuntimeCredentials", "provisionAgentRuntimeCredentials"],
  },
  {
    title: "Agent workspace files",
    slug: "agents-workspace",
    operationIds: ["getAgentWorkspaceFile", "putAgentWorkspaceFile"],
  },
  {
    title: "Agent revisions",
    slug: "agent-revisions",
    operationIds: ["listAgentRevisions", "getAgentRevision"],
  },
  {
    title: "Configurations",
    slug: "configurations",
    operationIds: [
      "createConfiguration",
      "deleteConfiguration",
      "getConfiguration",
      "updateConfiguration",
    ],
  },
  {
    title: "Secrets",
    slug: "secrets",
    operationIds: ["createSecret", "deleteSecret", "getSecret", "updateSecret"],
  },
  {
    title: "Service accounts",
    slug: "service-accounts",
    operationIds: [
      "listServiceAccounts",
      "createServiceAccount",
      "deleteServiceAccount",
      "getServiceAccount",
      "updateServiceAccountCredential",
      "createServiceAccountCredential",
    ],
  },
];

function operationRows(operations) {
  return [
    "| Operation | Summary |",
    "| --- | --- |",
    ...operations.map(({ anchor, method, operation, pagePath, path }) => {
      const href = `${pagePath.replace("docs/reference/", "")}#${anchor}`;
      return `| <span id="${anchor}"></span>[\`${method.toUpperCase()} ${path}\`](${href}) | ${operation.summary ?? "No summary."} |`;
    }),
  ].join("\n");
}

function errorSchema(document) {
  return (
    Object.values(document.paths)
      .flatMap((operations) => Object.values(operations))
      .flatMap((operation) => Object.entries(operation.responses))
      .find(([status, response]) => {
        const schema = resolveSchema(response.content?.["application/json"]?.schema, document);
        return !status.startsWith("2") && schema.properties?.error?.properties?.details;
      })
      ?.at(1).content["application/json"].schema ??
    Object.values(document.paths)
      .flatMap((operations) => Object.values(operations))
      .flatMap((operation) => Object.entries(operation.responses))
      .find(([status, response]) => {
        return !status.startsWith("2") && response.content?.["application/json"]?.schema;
      })
      ?.at(1).content["application/json"].schema
  );
}

function generatedComment() {
  return "<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->";
}

function introduction(document) {
  return [
    `Version \`${document.info.version}\`; OpenAPI \`${document.openapi}\`.`,
    [
      "This reference is generated from the",
      "[checked-in OpenAPI contract](../../packages/contracts/openapi/occ-api.openapi.json).",
      "Run `pnpm openapi:generate` after changing an API route or schema;",
      "`pnpm openapi:check` verifies the generated contract and API reference pages.",
    ].join("\n"),
    [
      "The exported contract comes from the development-enabled OCC app, which is",
      "why the generated title is `Development OCC API`. Use",
      "`POST /installation/bootstrap` only for development or bootstrap flows",
      "that create the first Installation; production bootstraps through the",
      "[Helm initialization Job](../guides/deploy/production-installation.md#provision-system-secrets-and-install)",
      "before serving requests.",
      "After bootstrap, production uses the same authenticated controller resource",
      "operations through the selected Drivers and settings described in",
      "[settings](settings.md).",
    ].join("\n"),
    "See [authentication](authentication.md) for supported credentials and their scope.",
  ];
}

function operationEntries(document) {
  return Object.entries(document.paths).flatMap(([path, operations]) =>
    Object.entries(operations).map(([method, operation]) => ({
      anchor: operationAnchor(path, method),
      method,
      operation,
      operationId: operation.operationId,
      path,
    })),
  );
}

function referencePages(document) {
  const entries = operationEntries(document);
  const byOperationId = new Map(entries.map((entry) => [entry.operationId, entry]));
  const assigned = new Set();
  const pages = pageDefinitions.map((definition) => {
    const pagePath = `docs/reference/api/${definition.slug}.md`;
    const operations = definition.operationIds.map((operationId) => {
      const entry = byOperationId.get(operationId);
      if (!entry)
        throw new Error(`OpenAPI operation ${operationId} is missing from the generated contract.`);
      assigned.add(operationId);
      return { ...entry, pagePath };
    });
    return { ...definition, anchor: tagAnchor(definition.title), pagePath, operations };
  });

  const unassigned = entries.filter((entry) => !assigned.has(entry.operationId));
  if (unassigned.length) {
    throw new Error(
      `OpenAPI operations need API reference page assignments: ${unassigned.map((entry) => entry.operationId).join(", ")}.`,
    );
  }

  return pages;
}

function indexPage(document, pages) {
  const sections = [
    `# ${document.info.title} reference`,
    generatedComment(),
    ...introduction(document),
  ];
  const schema = errorSchema(document);

  if (schema) {
    sections.push(
      "## Error responses",
      [
        "Non-success JSON responses use the following envelope.",
        "Each operation lists its supported status codes.",
      ].join("\n"),
      schemaTable(schema, document),
    );
  }

  sections.push(
    "## Resources",
    [
      "| Resource | Operations |",
      "| --- | --- |",
      ...pages.map((page) => {
        const operations =
          page.operations.length === 1 ? "1 operation" : `${page.operations.length} operations`;
        return `| [${page.title}](api/${page.slug}.md#${page.anchor}) | ${operations} |`;
      }),
    ].join("\n"),
  );

  sections.push("## Operations");
  for (const page of pages) {
    sections.push(`### ${page.title}`, operationRows(page.operations));
  }

  const schemas = Object.entries(document.components?.schemas ?? {});
  if (schemas.length) {
    sections.push(
      "## Shared schemas",
      "Reusable schema names are referenced by operation request and response tables.",
      [
        "| Schema | Type |",
        "| --- | --- |",
        ...schemas.map(
          ([name, schema]) =>
            `| \`${schema.title ?? name}\` | \`${schemaType(schema, document)}\` |`,
        ),
      ].join("\n"),
    );
  }

  return `${sections.join("\n\n")}\n`;
}

function apiPage(page, document) {
  return (
    [
      `# ${page.title} API operations`,
      generatedComment(),
      `<span id="${page.anchor}"></span>`,
      `This generated page documents ${page.title.toLowerCase()} API operations. Use the [API index](../api.md) for the full operation list.`,
      ...page.operations.map((entry) =>
        operationReference(entry.path, entry.method, entry.operation, document),
      ),
      "## Related",
      "- [API index](../api.md)",
    ].join("\n\n") + "\n"
  );
}

export function estimateReferenceWords(markdown) {
  const text = markdown.replace(/<!--[^]*?-->/g, " ").replace(/<[^>]*>/g, " ");
  return text.match(/[\p{L}\p{N}]+(?:[._:/{}-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export function validateApiReferenceOutputs(outputs) {
  const oversized = outputs
    .map((output) => ({ ...output, words: estimateReferenceWords(output.content) }))
    .filter((output) => output.words > API_REFERENCE_WORD_LIMIT);

  if (oversized.length) {
    const details = oversized
      .map((output) => `${output.path} has ${output.words} words`)
      .join("; ");
    throw new Error(
      `Generated API reference pages must stay at or below ${API_REFERENCE_WORD_LIMIT} words: ${details}.`,
    );
  }
}

export function generateApiReferenceOutputs(document) {
  const pages = referencePages(document);
  const outputs = [
    {
      label: "API reference index",
      path: "docs/reference/api.md",
      content: indexPage(document, pages),
    },
    ...pages.map((page) => ({
      label: `${page.title} API reference`,
      path: page.pagePath,
      content: apiPage(page, document),
    })),
  ];
  validateApiReferenceOutputs(outputs);
  return outputs;
}

export function generateApiReference(document) {
  return generateApiReferenceOutputs(document).find(
    (output) => output.path === "docs/reference/api.md",
  ).content;
}

async function walkMarkdown(directoryUrl) {
  let entries;
  try {
    entries = await readdir(directoryUrl, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directoryUrl);
    if (entry.isDirectory()) files.push(...(await walkMarkdown(url)));
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(relative(repositoryRoot, fileURLToPath(url)).split("\\").join("/"));
    }
  }
  return files;
}

export async function unexpectedApiReferenceFiles(outputs) {
  const expectedPaths = new Set(outputs.map((output) => output.path));
  return (await walkMarkdown(referenceDirectoryPath)).filter((path) => !expectedPaths.has(path));
}

export async function removeGeneratedApiReferenceDirectory() {
  await rm(referenceDirectoryPath, { recursive: true, force: true });
}

async function run() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--check")) {
    throw new Error("Usage: node scripts/generate-occ-api-reference.mjs [--check]");
  }

  const document = JSON.parse(await readFile(documentPath, "utf8"));
  const outputs = generateApiReferenceOutputs(document);

  if (arguments_[0] === "--check") {
    for (const output of outputs) {
      const path = resolve(repositoryRoot, output.path);
      let existing;
      try {
        existing = await readFile(path, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new Error(`Missing ${output.path}; run pnpm openapi:generate.`);
        }
        throw error;
      }

      if (existing !== output.content) {
        throw new Error(`${output.path} is out of date; run pnpm openapi:generate.`);
      }
    }

    const unexpected = await unexpectedApiReferenceFiles(outputs);
    if (unexpected.length) {
      throw new Error(
        `Unexpected generated API reference file: ${unexpected.join(", ")}; run pnpm openapi:generate.`,
      );
    }

    process.stdout.write(`API reference is current: ${outputs.length} generated pages\n`);
  } else {
    await removeGeneratedApiReferenceDirectory();
    for (const output of outputs) {
      const path = resolve(repositoryRoot, output.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, output.content, "utf8");
      process.stdout.write(`Generated ${output.label}: ${output.path}\n`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await run();
}
