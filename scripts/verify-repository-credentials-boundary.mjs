import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parsers } from "prettier/plugins/typescript";

const sourceRoot = fileURLToPath(new URL("../apps/repository-credentials/src/", import.meta.url));
const sourceExtensions = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"]);

// Adding an I/O owner or member requires security review; see the owning test guide.
const reviewedImports = {
  "backends/github/material.ts": { "node:crypto": ["KeyObject", "constants", "sign"] },
  "backends/github/provider-transport/request.ts": { "node:https": ["request"] },
  "config.ts": {
    "node:crypto": ["createPrivateKey"],
    "node:fs": ["constants"],
    "node:fs/promises": ["lstat", "open"],
    "node:tls": ["createSecureContext"],
  },
  "lifecycle.ts": { "node:crypto": ["randomUUID"] },
  "sessions.ts": { "node:crypto": ["createHash", "randomBytes", "randomUUID"] },
};
const ordinaryBuiltins = new Set([
  "node:os",
  "node:path",
  "node:perf_hooks",
  "node:stream",
  "node:stream/promises",
  "node:url",
  "node:zlib",
]);
const senderConsumers = {
  "backends/github/provider-transport/request.ts": {
    "backends/github/provider-transport.ts": ["sendProviderRequest"],
  },
};
const rawGlobals = new Set([
  "fetch",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
  "require",
  "eval",
  "Function",
  "global",
  "globalThis",
  "console",
  "module",
]);
const reviewedProcessMembers = {
  "check-config.ts": ["argv", "exitCode", "stderr", "stdout"],
  "config.ts": ["getuid"],
};
const runtimeTypeScript = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TSParameterProperty",
  "TSExportAssignment",
  "TSModuleDeclaration",
  "TSModuleBlock",
  "TSEnumDeclaration",
  "TSEnumBody",
  "TSEnumMember",
]);

function slash(path) {
  return path.split(sep).join("/");
}

async function sourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (sourceExtensions.has(extname(entry.name))) {
      if (!entry.isFile()) {
        throw new Error(`Credential source must be a regular file: ${path}`);
      }
      files.push(path);
    }
  }
  return files.sort();
}

function name(node) {
  return node?.type === "Identifier" ? node.name : node?.value;
}

function member(node) {
  if (node?.type !== "MemberExpression") {
    return undefined;
  }
  return !node.computed || node.property.type === "Literal" ? name(node.property) : undefined;
}

function isReference(parent, key) {
  if (parent?.type === "MemberExpression" && key === "property" && !parent.computed) {
    return false;
  }
  if (["Property", "MethodDefinition", "PropertyDefinition"].includes(parent?.type)) {
    if (key === "key" && !parent.computed) {
      return false;
    }
  }
  if (key === "id" || key === "label") {
    return false;
  }
  return true;
}

function unwrappedValue(node) {
  while (runtimeTypeScript.has(node?.type) && node.expression) {
    node = node.expression;
  }
  return node;
}

function inspectSource(path, root, sources, ast) {
  const file = slash(relative(root, path));
  const failures = [];
  const rawBindings = new Set();
  for (const node of ast.body) {
    if (node.type !== "ImportDeclaration" || node.importKind === "type") {
      continue;
    }
    if (node.source.value.startsWith(".") || ordinaryBuiltins.has(node.source.value)) {
      continue;
    }
    for (const specifier of node.specifiers) {
      if (specifier.importKind !== "type") {
        rawBindings.add(specifier.local.name);
      }
    }
  }
  function deny(node, reason) {
    failures.push(`${file}:${node.loc?.start.line ?? 1}: ${reason}`);
  }
  function edge(node, specifier, names, kind) {
    if (typeof specifier !== "string") {
      deny(node, "nonliteral module loading requires security review");
      return;
    }
    if (specifier.startsWith(".")) {
      let target = slash(relative(root, resolve(dirname(path), specifier)));
      if (
        target === ".." ||
        target.startsWith("../") ||
        target.includes("?") ||
        target.includes("#")
      ) {
        deny(node, `runtime import escapes credential source: ${specifier}`);
        return;
      }
      if (!sources.has(target)) {
        const sourceExtension = { ".js": ".ts", ".mjs": ".mts", ".cjs": ".cts" }[extname(target)];
        const sourceTarget =
          sourceExtension && target.slice(0, -extname(target).length) + sourceExtension;
        if (!sourceTarget || !sources.has(sourceTarget)) {
          deny(node, `runtime import has no scanned credential source: ${specifier}`);
          return;
        }
        target = sourceTarget;
      }
      const consumers = senderConsumers[target];
      if (consumers && !names.every((binding) => consumers[file]?.includes(binding))) {
        deny(node, `raw sender ${target} is not reviewed for ${file}`);
      }
      if (!file.startsWith("client/") && target.startsWith("client/")) {
        deny(node, `service code cannot load client command owner ${target}`);
      }
      return;
    }
    if (ordinaryBuiltins.has(specifier)) {
      return;
    }
    if (
      kind === "import" &&
      names.every((binding) => reviewedImports[file]?.[specifier]?.includes(binding))
    ) {
      return;
    }
    deny(node, `unreviewed runtime ${kind} from ${specifier} (${names.join(", ")})`);
  }

  function visit(node, parent, key) {
    if (!node || typeof node.type !== "string" || node.declare) {
      return;
    }
    if (node.type === "ImportDeclaration") {
      if (node.importKind === "type") {
        return;
      }
      const values = node.specifiers.filter((specifier) => specifier.importKind !== "type");
      // With verbatimModuleSyntax, inline type-only specifiers retain import {}.
      const names = values.length
        ? values.map((specifier) => name(specifier.imported) ?? "*")
        : ["<side-effect>"];
      edge(node, node.source.value, names, "import");
      return;
    }
    if (node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") {
      if (node.exportKind === "type") {
        return;
      }
      const values = node.specifiers?.filter((specifier) => specifier.exportKind !== "type") ?? [];
      if (node.source) {
        const names = values.map((specifier) => name(specifier.local));
        if (!names.length) {
          names.push(node.type === "ExportAllDeclaration" ? "*" : "<side-effect>");
        }
        edge(node, node.source.value, names, "export");
      } else {
        for (const specifier of values) {
          if (rawBindings.has(name(specifier.local))) {
            deny(specifier, "raw I/O binding cannot be re-exported");
          }
        }
        if (node.declaration?.type === "VariableDeclaration") {
          for (const declaration of node.declaration.declarations) {
            const value = unwrappedValue(declaration.init);
            if (value?.type === "Identifier" && rawBindings.has(value.name)) {
              deny(declaration, "raw I/O binding cannot be re-exported");
            }
          }
        }
        visit(node.declaration, node, "declaration");
      }
      return;
    }
    if (node.type === "ExportDefaultDeclaration") {
      const value = unwrappedValue(node.declaration);
      if (value?.type === "Identifier" && rawBindings.has(value.name)) {
        deny(node, "raw I/O binding cannot be re-exported");
      }
    }
    if (node.type === "TSImportEqualsDeclaration") {
      if (node.importKind !== "type") {
        edge(node, node.moduleReference.expression?.value, ["*"], "import");
      }
      return;
    }
    if (node.type === "ImportExpression") {
      edge(node, node.source.type === "Literal" ? node.source.value : undefined, ["*"], "import");
      return;
    }
    if (node.type.startsWith("TS") && !runtimeTypeScript.has(node.type)) {
      return;
    }
    if (node.type === "Identifier" && isReference(parent, key)) {
      if (rawGlobals.has(node.name)) {
        deny(node, `raw global ${node.name} requires security review`);
      }
      if (node.name === "process") {
        const property =
          parent?.type === "MemberExpression" && key === "object" ? member(parent) : undefined;
        if (!property || !reviewedProcessMembers[file]?.includes(property)) {
          deny(node, `raw process capability ${property ?? "<value>"} requires security review`);
        }
      }
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (["comments", "tokens", "loc", "range"].includes(childKey)) {
        continue;
      }
      if (Array.isArray(child)) {
        for (const item of child) {
          visit(item, node, childKey);
        }
      } else {
        visit(child, node, childKey);
      }
    }
  }
  visit(ast);
  return failures;
}

export async function verifyRepositoryCredentialBoundary(root = sourceRoot) {
  const files = await sourceFiles(root);
  const sources = new Set(files.map((path) => slash(relative(root, path))));
  const failures = [];
  for (const path of files) {
    const ast = await parsers.typescript.parse(await readFile(path, "utf8"));
    failures.push(...inspectSource(path, root, sources, ast));
  }
  if (failures.length) {
    throw new Error(
      `Repository credential boundary requires security review:\n${failures.join("\n")}`,
    );
  }
  return files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = await verifyRepositoryCredentialBoundary();
  process.stdout.write(`Repository credential boundary verified: ${count} source files.\n`);
}
