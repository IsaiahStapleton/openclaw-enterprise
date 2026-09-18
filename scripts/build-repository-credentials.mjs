import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parsers } from "prettier/plugins/babel";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const emittedRoot = await realpath(join(repositoryRoot, "apps/controller/dist"));
const artifactRoot = join(repositoryRoot, ".build/repository-credentials");
const clientPath = "drivers/repository-credentials/client";

function contained(root, path) {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function dependencies(source, path) {
  const specifiers = new Set();
  const unsupported = () => {
    throw new Error(`Unsupported runtime import in ${path}`);
  };
  function add(node) {
    if (node?.type !== "StringLiteral") unsupported();
    // Alternate module loaders could hide dependencies from this ESM closure.
    if (node.value === "module" || node.value === "node:module") unsupported();
    specifiers.add(node.value);
  }
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      if (node.source) add(node.source);
    } else if (node.type === "ImportExpression") {
      if (node.options || node.phase) unsupported();
      add(node.source);
    } else if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      if (node.callee.type === "Import") {
        if (node.arguments.length !== 1) unsupported();
        add(node.arguments[0]);
      } else if (node.callee.type === "Identifier" && node.callee.name === "require") {
        unsupported();
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(parsers.babel.parse(source));
  return specifiers;
}

async function closure(name, entrypoints) {
  const files = new Map();
  const pending = entrypoints.map((path) => resolve(emittedRoot, path));
  const allowedRoot = name === "client" ? join(emittedRoot, clientPath) : emittedRoot;
  while (pending.length) {
    const path = pending.pop();
    if (files.has(path)) continue;
    if (
      !contained(allowedRoot, path) ||
      !path.endsWith(".js") ||
      !(await lstat(path)).isFile() ||
      (await realpath(path)) !== path
    ) {
      throw new Error(`Invalid ${name} runtime module: ${path}`);
    }
    const source = await readFile(path, "utf8");
    files.set(path, source);
    for (const specifier of dependencies(source, relative(emittedRoot, path))) {
      if (isBuiltin(specifier)) continue;
      if (
        !/^\.{1,2}\//.test(specifier) ||
        !specifier.endsWith(".js") ||
        /[\\%?#]/.test(specifier)
      ) {
        throw new Error(`Unsupported ${name} runtime dependency: ${specifier}`);
      }
      pending.push(resolve(dirname(path), specifier));
    }
  }
  return files;
}

// Snapshot and validate both complete closures before replacing either artifact.
// Literal dynamic imports are included; source-only types and unrelated platform
// modules never become image inputs.
const service = await closure("service", [
  "repository-credentials.js",
  "composition/repository-credentials/check-config.js",
  "composition/repository-credentials/projected-inputs.js",
  "composition/repository-credentials/probe.js",
]);
const client = await closure(
  "client",
  ["launch", "router", "operator", "git-helper"].map((name) => `${clientPath}/${name}.js`),
);

async function stage(name, files) {
  const destination = join(artifactRoot, name);
  await rm(destination, { recursive: true, force: true });
  for (const [path, source] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    const target = join(destination, "dist", relative(emittedRoot, path));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  await writeFile(
    join(destination, "package.json"),
    `${JSON.stringify({ name: `repository-credentials-${name}`, type: "module" }, null, 2)}\n`,
  );
  await cp(
    join(repositoryRoot, "deploy/runtime/repository-credentials/.dockerignore"),
    join(destination, ".dockerignore"),
  );
}

await stage("service", service);
await stage("client", client);
