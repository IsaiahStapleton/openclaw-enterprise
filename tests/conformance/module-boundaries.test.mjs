import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { verifyModuleBoundaries } from "../../scripts/verify-module-boundaries.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const fixture = new URL("../fixtures/module-boundaries/", import.meta.url);
const run = promisify(execFile);
const cli = join(repository, "scripts/verify-module-boundaries.mjs");
const policy = JSON.parse(await readFile(new URL("policy.json", fixture), "utf8"));

async function workspace(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "module-boundaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fixture, root, { recursive: true });
  const config = { ...policy, ...overrides };
  const write = async (path, content) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await write("policy.json", JSON.stringify(config));
  return {
    root,
    write,
    check: (extra = {}) => verifyModuleBoundaries({ root, policy: config, ...extra }),
    args: ["--root", root, "--policy", join(root, "policy.json")],
  };
}

const rules = (report) => report.violations.map((item) => item.rule).sort();
const from = (report, path) => report.edges.filter((edge) => edge.from === path);

// These fixtures express caller-selected rules, without adopting architecture
// policy for the repository running this reusable analyzer.
test("discovers new sources and resolves public leaves and source extension mapping deterministically", async (t) => {
  const { root, write, check } = await workspace(t);
  let report = await check();
  assert.equal(report.ok, true, JSON.stringify(report.violations));
  assert.ok(
    report.edges.some(
      (edge) => edge.specifier === "./leaf.js" && edge.to === "packages/library/src/leaf.ts",
    ),
  );
  assert.ok(
    report.edges.some(
      (edge) =>
        edge.specifier === "@fixture/library/leaf" && edge.to === "packages/library/src/leaf.ts",
    ),
  );
  await write("apps/app/src/new/nested.mjs", 'import "../index.ts";');
  report = await check();
  assert.ok(report.files.includes("apps/app/src/new/nested.mjs"));
  assert.equal(from(report, "apps/app/src/new/nested.mjs")[0].to, "apps/app/src/index.ts");
  assert.deepEqual(await check(), report);
  assert.equal(JSON.stringify(report).includes(root), false);
});

test("matches path and specifier boundaries, exclusions, and dependency kinds", async (t) => {
  const boundary = {
    rule: "consumer-to-private",
    from: ["apps/app/src/consumers/**"],
    to: ["apps/app/src/private/**"],
    specifiers: ["external-driver", "external-driver/**"],
    exceptFrom: ["apps/app/src/consumers/adapter.ts"],
    exceptTo: ["apps/app/src/private/public.ts"],
    kinds: ["import", "export"],
    message: "Use the public leaf.",
  };
  const { write, check } = await workspace(t, { boundaries: [boundary] });
  await write("apps/app/src/private/store.ts", "export const store = 1; export interface Store {}");
  await write("apps/app/src/private/public.ts", "export const safe = 1;");
  await write(
    "apps/app/src/consumers/invalid.ts",
    `
    import type { Store } from "../private/store.ts";
    export { store } from "../private/store.ts";
    import "external-driver/subpath";
    import "external-driver-other";
    import "../private/public.ts";
    await import("../private/store.ts");
  `,
  );
  await write("apps/app/src/consumers/adapter.ts", 'import "../private/store.ts";');
  await write("apps/app/src/consumers-other.ts", 'import "./private/store.ts";');
  const report = await check();
  assert.deepEqual(rules(report), Array(3).fill("consumer-to-private"));
  assert.equal(report.violations.filter((item) => item.typeOnly).length, 1);
  assert.ok(report.violations.every((item) => item.from.endsWith("/invalid.ts")));
});

test("enforces blocked package exports, cross-package sources and internal root barrels", async (t) => {
  const { write, check } = await workspace(t);
  await write(
    "packages/library/src/private.ts",
    `
    import type { Value } from "./index.ts";
    export type { Value } from "@fixture/library";
  `,
  );
  await write(
    "apps/app/src/private.ts",
    `
    import type { Value } from "../../../packages/library/src/leaf.ts";
    import "@fixture/library/src/leaf.ts";
    import "@fixture/library/blocked";
  `,
  );
  const report = await check();
  assert.deepEqual(rules(report), [
    "cross-package-source",
    "internal-root-barrel",
    "internal-root-barrel",
    "unsupported-package-export",
    "unsupported-package-export",
  ]);
  const allowed = await check({
    policy: { ...policy, packageImports: { sourcePaths: "allow", internalRoot: "allow" } },
  });
  assert.deepEqual(rules(allowed), ["unsupported-package-export", "unsupported-package-export"]);
});

test("distinguishes runtime conditional exports from declarations using native resolution", async (t) => {
  const { root, write, check } = await workspace(t);
  // A real package link makes Node an independent resolution oracle. Targets
  // throw if executed: both the oracle and analyzer must only resolve paths.
  await mkdir(join(root, "node_modules/@fixture"), { recursive: true });
  await symlink(join(root, "packages/library"), join(root, "node_modules/@fixture/library"), "dir");
  const path = "apps/app/src/conditional.mjs";
  await write(
    path,
    `
    import "@fixture/library/conditional";
    import { createRequire } from "node:module";
    const load = createRequire(import.meta.url);
    load("@fixture/library/conditional");
    await import(load.resolve("@fixture/library/conditional"));
  `,
  );
  await write(
    "apps/app/src/types.ts",
    'import type { Selected } from "@fixture/library/conditional";',
  );
  const loader = createRequire(join(root, path));
  const requireTarget = relative(root, loader.resolve("@fixture/library/conditional"));
  const { stdout } = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'console.log(import.meta.resolve("@fixture/library/conditional"))',
    ],
    { cwd: root },
  );
  const importTarget = relative(root, fileURLToPath(stdout.trim()));
  assert.notEqual(requireTarget, importTarget);
  assert.throws(() => loader.resolve("@fixture/library/blocked"), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
  const report = await check();
  assert.equal(report.ok, true, JSON.stringify(report.violations));
  const edges = from(report, path);
  assert.equal(
    edges.find(
      (edge) => edge.kind === "import" && edge.specifier === "@fixture/library/conditional",
    ).to,
    importTarget,
  );
  assert.equal(edges.find((edge) => edge.kind === "require").to, requireTarget);
  assert.equal(edges.find((edge) => edge.kind === "dynamic-import").to, requireTarget);
  assert.equal(
    from(report, "apps/app/src/types.ts")[0].to,
    "packages/library/src/conditional.d.ts",
  );
  const runtimeResolution = report.resolutions.find(
    (item) =>
      item.reference.from === path &&
      item.reference.kind === "import" &&
      item.reference.specifier === "@fixture/library/conditional",
  );
  assert.equal(runtimeResolution.runtimeTarget, importTarget);
  assert.equal(runtimeResolution.typeTarget, "packages/library/src/conditional.d.ts");
  const typeResolution = report.resolutions.find(
    (item) => item.reference.from === "apps/app/src/types.ts",
  );
  assert.equal(typeResolution.runtimeTarget, importTarget);
  assert.equal(typeResolution.typeTarget, "packages/library/src/conditional.d.ts");
});

test("honors Node's default node-addons export condition for import and require", async (t) => {
  const consumer = "apps/app/src/addons.mjs";
  const secret = "packages/library/src/secret.mjs";
  const { root, write, check } = await workspace(t, {
    boundaries: [
      {
        rule: "forbidden-native-leaf",
        from: [consumer],
        to: [secret],
        message: "Use the public leaf.",
      },
    ],
  });
  const manifest = JSON.parse(await readFile(join(root, "packages/library/package.json"), "utf8"));
  manifest.exports["."] = { "node-addons": "./src/secret.mjs", default: "./src/safe.mjs" };
  await write("packages/library/package.json", JSON.stringify(manifest));
  for (const name of ["secret", "safe"])
    await write(
      `packages/library/src/${name}.mjs`,
      'throw new Error("Analyzer must not execute targets.");',
    );
  await mkdir(join(root, "node_modules/@fixture"), { recursive: true });
  await symlink(join(root, "packages/library"), join(root, "node_modules/@fixture/library"), "dir");
  await write(
    consumer,
    `
    import "@fixture/library";
    import { createRequire } from "node:module";
    const load = createRequire(import.meta.url);
    load("@fixture/library");
  `,
  );
  // node-addons is a default Node condition. Both native resolvers select its
  // target before default; neither the oracle nor analyzer executes that target.
  const { stdout } = await run(
    process.execPath,
    ["--input-type=module", "-e", 'console.log(import.meta.resolve("@fixture/library"))'],
    { cwd: root },
  );
  const importTarget = relative(root, fileURLToPath(stdout.trim()));
  const requireTarget = relative(
    root,
    createRequire(join(root, consumer)).resolve("@fixture/library"),
  );
  assert.equal(importTarget, secret);
  assert.equal(requireTarget, secret);
  const report = await check();
  assert.deepEqual(
    {
      targets: from(report, consumer).map((edge) => edge.to),
      violations: rules(report),
    },
    {
      targets: [importTarget, requireTarget],
      violations: ["forbidden-native-leaf", "forbidden-native-leaf"],
    },
  );
});

test("matches native export-array fallback and keeps valid types separate from invalid runtime exports", async (t) => {
  const { root, write, check } = await workspace(t);
  const manifest = JSON.parse(await readFile(join(root, "packages/library/package.json"), "utf8"));
  manifest.exports["./array-null"] = [null, "./src/conditional.mjs"];
  manifest.exports["./array-invalid"] = ["../invalid.mjs", "./src/conditional.mjs"];
  manifest.exports["./invalid-runtime"] = {
    types: "./src/conditional.d.ts",
    default: "../invalid.mjs",
  };
  await write("packages/library/package.json", JSON.stringify(manifest));
  await mkdir(join(root, "node_modules/@fixture"), { recursive: true });
  await symlink(join(root, "packages/library"), join(root, "node_modules/@fixture/library"), "dir");
  await write(
    "apps/app/src/arrays.mjs",
    `
    import "@fixture/library/array-null";
    import "@fixture/library/array-invalid";
    import "@fixture/library/invalid-runtime";
  `,
  );
  await write(
    "apps/app/src/valid-types.ts",
    'import type { Selected } from "@fixture/library/invalid-runtime";',
  );
  const loader = createRequire(join(root, "apps/app/src/arrays.mjs"));
  const targets = ["@fixture/library/array-null", "@fixture/library/array-invalid"].map(
    (specifier) => relative(root, loader.resolve(specifier)),
  );
  assert.throws(() => loader.resolve("@fixture/library/invalid-runtime"), {
    code: "ERR_INVALID_PACKAGE_TARGET",
  });
  const report = await check();
  assert.deepEqual(rules(report), ["unsupported-package-export"]);
  assert.deepEqual(
    from(report, "apps/app/src/arrays.mjs").map((edge) => edge.to),
    targets,
  );
  const types = report.resolutions.find(
    (item) => item.reference.from === "apps/app/src/valid-types.ts",
  );
  assert.equal(types.status, "local");
  assert.equal(types.typeTarget, "packages/library/src/conditional.d.ts");
  assert.equal(types.runtimeTarget, null);
});

test("does not treat a declaration-only target as runtime code", async (t) => {
  const { write, check } = await workspace(t);
  await write("apps/app/src/declaration.d.ts", "export interface Value {};");
  await write(
    "apps/app/src/declaration-consumer.ts",
    `
    import "./declaration.d.ts";
    import type { Value } from "./declaration.d.ts";
  `,
  );
  const report = await check();
  assert.deepEqual(rules(report), ["unresolved-local-import"]);
  const references = report.resolutions.filter(
    (item) => item.reference.from === "apps/app/src/declaration-consumer.ts",
  );
  const runtime = references.find((item) => !item.reference.typeOnly);
  assert.equal(runtime.status, "unresolved");
  assert.equal(runtime.runtimeTarget, null);
  assert.equal(runtime.typeTarget, "apps/app/src/declaration.d.ts");
  assert.equal(references.find((item) => item.reference.typeOnly).status, "local");
});

test("uses native CommonJS file and directory resolution from file and trailing-slash anchors", async (t) => {
  const { root, write, check } = await workspace(t);
  const base = "apps/app/src/native";
  await write(`${base}/helper.js`, 'throw new Error("must not execute");');
  await write(`${base}/indexed/index.js`, 'throw new Error("must not execute");');
  await write(`${base}/selected/package.json`, JSON.stringify({ main: "entry.cjs" }));
  await write(`${base}/selected/entry.cjs`, 'throw new Error("must not execute");');
  await write(
    `${base}/load.mjs`,
    `
    import { createRequire } from "node:module";
    const load = createRequire(import.meta.url);
    load("./helper"); load("./indexed");
    await import(load.resolve("./selected"));
  `,
  );
  await write(
    `${base}/directory.mjs`,
    `
    import { createRequire } from "node:module";
    import { fileURLToPath } from "node:url";
    const urlLoader = createRequire(new URL("./", import.meta.url));
    const pathLoader = createRequire(fileURLToPath(new URL("./", import.meta.url)));
    urlLoader("./helper"); pathLoader("./indexed");
  `,
  );
  const nativeLoader = createRequire(join(root, base, "load.mjs"));
  const directoryLoader = createRequire(join(root, base) + "/");
  const report = await check();
  assert.equal(report.ok, true, JSON.stringify(report.violations));
  assert.deepEqual(
    from(report, `${base}/load.mjs`)
      .filter((edge) => ["require", "dynamic-import"].includes(edge.kind))
      .map((edge) => edge.to)
      .sort(),
    ["./helper", "./indexed", "./selected"]
      .map((specifier) => relative(root, nativeLoader.resolve(specifier)))
      .sort(),
  );
  assert.deepEqual(
    from(report, `${base}/directory.mjs`)
      .filter((edge) => edge.kind === "require")
      .map((edge) => edge.to)
      .sort(),
    ["./helper", "./indexed"]
      .map((specifier) => relative(root, directoryLoader.resolve(specifier)))
      .sort(),
  );
  assert.ok(
    from(report, `${base}/directory.mjs`).some(
      (edge) => edge.kind === "dependency-anchor" && edge.to === base,
    ),
  );
});

test("resolves anchored loads against their actual provider and checks foreign package anchors", async (t) => {
  const boundary = {
    rule: "consumer-to-private",
    from: ["apps/app/src/consumer/**"],
    to: ["apps/app/src/private/**"],
    message: "Use the public leaf.",
  };
  const { root, write, check } = await workspace(t, { boundaries: [boundary] });
  await write("apps/app/src/private/target.cjs", "exports.value = 1;");
  // The importer-relative decoy must not conceal the forbidden actual target.
  await write("apps/app/src/consumer/src/private/target.cjs", "exports.value = 2;");
  await write(
    "apps/app/src/consumer/load.mjs",
    `
    import { createRequire } from "node:module";
    const load = createRequire(new URL("../../package.json", import.meta.url));
    load("./src/private/target.cjs");
    await import(load.resolve("./src/private/target.cjs"));
  `,
  );
  await write(
    "apps/app/src/foreign.mjs",
    `
    import { createRequire } from "node:module";
    const load = createRequire(new URL("../../../packages/library/", import.meta.url));
  `,
  );
  const loader = createRequire(join(root, "apps/app/package.json"));
  const target = relative(root, loader.resolve("./src/private/target.cjs"));
  const report = await check();
  assert.deepEqual(rules(report), [
    "consumer-to-private",
    "consumer-to-private",
    "cross-package-source",
  ]);
  assert.ok(
    report.violations
      .filter((edge) => edge.rule === "consumer-to-private")
      .every((edge) => edge.to === target),
  );
  assert.equal(
    report.violations.find((edge) => edge.rule === "cross-package-source").kind,
    "dependency-anchor",
  );
});

test("tracks loader aliases, module objects and wrappers while respecting lexical shadows", async (t) => {
  const { write, check } = await workspace(t, {
    boundaries: [
      {
        rule: "forbidden-driver",
        from: ["apps/app/src/**"],
        specifiers: ["external-driver"],
        message: "Use the adapter.",
      },
    ],
  });
  const known = [
    [
      "ts",
      'import { createRequire } from "node:module"; const factory = (createRequire); const load = (factory(import.meta.url) satisfies ReturnType<typeof createRequire>); const alias = load; (alias!)("external-driver");',
    ],
    [
      "mjs",
      'import module from "node:module"; const m = module; const { createRequire: factory } = m; let load = factory(import.meta.url); load("external-driver");',
    ],
    [
      "mjs",
      'import * as module from "module"; const load = module["createRequire"](import.meta.url); const { resolve } = load; await import(resolve("external-driver"));',
    ],
    [
      "cjs",
      'const { createRequire } = require("node:module"); var load = createRequire(__filename); const alias = load; alias("external-driver");',
    ],
    [
      "cts",
      'import module = require("node:module"); const load = module.createRequire(__filename); load("external-driver");',
    ],
    ["cjs", 'const mod = module; mod["require"]("external-driver");'],
  ];
  for (const [index, [extension, source]] of known.entries())
    await write(`apps/app/src/known-${index}.${extension}`, source);
  await write(
    "apps/app/src/shadows.mjs",
    `
    import { createRequire } from "node:module";
    const factory = createRequire;
    function shadow(factory) { const load = factory(import.meta.url); load("external-driver"); }
    function shadowModule(module) { module.require("external-driver"); }
    function shadowRequire(require) { require("external-driver"); }
  `,
  );
  // Arbitrary function bodies are outside the evaluator's bounded propagation.
  await write(
    "apps/app/src/wrapper.mjs",
    `
    import { createRequire } from "node:module";
    const wrap = (value) => value;
    const load = wrap(createRequire(import.meta.url));
    load("external-driver");
  `,
  );
  const report = await check();
  assert.equal(
    report.violations.filter((edge) => edge.rule === "forbidden-driver").length,
    known.length,
  );
  for (const [index, [extension]] of known.entries())
    assert.ok(
      report.violations.some((edge) => edge.from === `apps/app/src/known-${index}.${extension}`),
    );
  assert.equal(
    report.edges.some(
      (edge) => /\/(shadows|wrapper)\.mjs$/.test(edge.from) && edge.specifier === "external-driver",
    ),
    false,
  );
});

test("keeps Node file bindings local across JavaScript and TypeScript module formats", async (t) => {
  const variants = [
    ["ts", "module"],
    ["js", "module"],
    ["mjs", "module"],
    ["mts", "module"],
    ["ts", "commonjs"],
    ["js", "commonjs"],
    ["cjs", "commonjs"],
    ["cts", "commonjs"],
  ];
  const observed = [];
  const expected = [];
  for (const [extension, type] of variants) {
    const base = "apps/app/src/scoped";
    const consumer = `${base}/b.${extension}`;
    const secret = `${base}/secret.${extension}`;
    const { write, check } = await workspace(t, {
      packages: ["apps/app"],
      sourceRoots: [base],
      boundaries: [
        { rule: "forbidden-secret", from: [consumer], to: [secret], message: "Use the safe leaf." },
      ],
    });
    await write("apps/app/package.json", JSON.stringify({ name: "@fixture/app", type }));
    // Node gives each file its own bindings, even when import() is its only
    // module syntax. The earlier file's same-named const must not hide this edge.
    await write(`${base}/a.${extension}`, `const target = "./safe.${extension}";`);
    await write(consumer, `const target = "./secret.${extension}"; import(target);`);
    for (const name of ["safe", "secret"])
      await write(
        `${base}/${name}.${extension}`,
        'throw new Error("Analyzer must not execute targets.");',
      );
    const report = await check();
    observed.push({
      extension,
      type,
      targets: from(report, consumer).map((edge) => edge.to),
      violations: rules(report),
      ok: report.ok,
    });
    expected.push({
      extension,
      type,
      targets: [secret],
      violations: ["forbidden-secret"],
      ok: false,
    });
  }
  assert.deepEqual(observed, expected);
});

test("does not preserve falsely known targets through reassigned paths or loaders", async (t) => {
  const { write, check } = await workspace(t);
  await write(
    "apps/app/src/reassigned.mjs",
    `
    import { createRequire } from "node:module";
    let target = "./index.ts";
    target = process.env.TARGET;
    await import(target);
    let load = createRequire(import.meta.url);
    load = (name) => name;
    load("./index.ts");
  `,
  );
  const report = await check();
  assert.equal(
    from(report, "apps/app/src/reassigned.mjs").some((edge) => edge.to === "apps/app/src/index.ts"),
    false,
  );
  assert.ok(
    report.violations.some(
      (edge) => edge.rule === "unresolved-dynamic-import" && edge.from.endsWith("reassigned.mjs"),
    ),
  );
});

test("bounds cyclic loader provenance and reports an unresolved dependency without aborting", async (t) => {
  const { write, check } = await workspace(t);
  // This invalid self-reference must remain an unknown dependency. Traversing
  // between loader provenance and path evaluation must not exhaust the stack.
  await write(
    "apps/app/src/cyclic-loader.mjs",
    `
    import { createRequire } from "node:module";
    const load = createRequire(load.resolve("x"));
    load("./x.mjs");
  `,
  );
  const report = await check();
  assert.equal(report.ok, false);
  assert.ok(
    report.violations.some(
      (item) =>
        item.rule === "unresolved-dynamic-import" && item.from === "apps/app/src/cyclic-loader.mjs",
    ),
  );
  assert.equal(from(report, "apps/app/src/cyclic-loader.mjs").length, 0);
});

test("bounds cyclic computed factory provenance inside dynamic imports", async (t) => {
  const { write, check } = await workspace(t);
  // Computed module members cross the same provenance/evaluation boundary as
  // loader anchors; the cycle must stay unknown when consumed by import().
  await write(
    "apps/app/src/cyclic-factory.mjs",
    `
    import * as module from "node:module";
    const factory = module[factory()];
    await import(factory("./x.mjs"));
  `,
  );
  const report = await check();
  assert.equal(report.ok, false);
  assert.ok(
    report.violations.some(
      (item) =>
        item.rule === "unresolved-dynamic-import" &&
        item.from === "apps/app/src/cyclic-factory.mjs",
    ),
  );
  assert.equal(from(report, "apps/app/src/cyclic-factory.mjs").length, 0);
});

test("resolves URL and path helper aliases, encoded file URLs and lexical path constants", async (t) => {
  const { write, check } = await workspace(t);
  await write("apps/app/src/target.mjs", 'throw new Error("must not execute");');
  await write(
    "apps/app/src/urls.mjs",
    `
    import * as url from "node:url";
    import path from "node:path";
    const urls = url;
    const { fileURLToPath: toPath, pathToFileURL: toURL } = urls;
    const { dirname: parent, join: combine } = path;
    const directory = parent(toPath(import.meta.url));
    await import(toURL(combine(directory, "target.mjs")).href);
  `,
  );
  await write(
    "apps/app/src/encoded.mjs",
    'await import(new URL("./%74arget.mjs?probe=1#fragment", import.meta.url).href);',
  );
  await write(
    "apps/app/src/scoped.mjs",
    'const target = "./missing.mjs"; function scoped() { const target = "./" + "target.mjs"; return import(target); }',
  );
  const report = await check();
  assert.equal(report.ok, true, JSON.stringify(report.violations));
  const imports = report.edges.filter(
    (edge) => /\/(urls|encoded|scoped)\.mjs$/.test(edge.from) && edge.kind === "dynamic-import",
  );
  assert.equal(imports.length, 3);
  assert.ok(imports.every((edge) => edge.to === "apps/app/src/target.mjs"));
});

test("resolves ESM literal paths with URL semantics and preserves literal CommonJS filenames", async (t) => {
  const base = "apps/app/src/literals";
  const consumer = `${base}/imports.mjs`;
  const secret = `${base}/secret.mjs`;
  const { root, write, check } = await workspace(t, {
    boundaries: [
      { rule: "forbidden-secret", from: [consumer], to: [secret], message: "Use the safe leaf." },
    ],
  });
  const esmSpecifiers = ["./%73ecret.mjs", "./secret.mjs?view=1#probe"];
  const cjsSpecifiers = ["./literal?name.cjs", "./%73ecret.cjs"];
  for (const name of ["secret.mjs", "literal?name.cjs", "%73ecret.cjs"])
    await write(`${base}/${name}`, 'throw new Error("Analyzer must not execute targets.");');
  await write(
    consumer,
    esmSpecifiers.map((specifier) => `import ${JSON.stringify(specifier)};`).join("\n"),
  );
  await write(
    `${base}/loads.cjs`,
    cjsSpecifiers.map((specifier) => `require(${JSON.stringify(specifier)});`).join("\n"),
  );
  // Native resolution, without importing targets, independently distinguishes
  // ESM URL decoding/query semantics from CommonJS literal filesystem lookup.
  const { stdout } = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `console.log(JSON.stringify(${JSON.stringify(esmSpecifiers)}.map((specifier) => import.meta.resolve(specifier))))`,
    ],
    { cwd: join(root, base) },
  );
  const esmTargets = JSON.parse(stdout).map((url) => relative(root, fileURLToPath(url)));
  assert.deepEqual(esmTargets, [secret, secret]);
  const loader = createRequire(join(root, base, "loads.cjs"));
  const cjsTargets = cjsSpecifiers.map((specifier) => relative(root, loader.resolve(specifier)));
  assert.deepEqual(cjsTargets, [`${base}/literal?name.cjs`, `${base}/%73ecret.cjs`]);
  const report = await check();
  assert.deepEqual(
    {
      esm: from(report, consumer).map((edge) => edge.to),
      cjs: from(report, `${base}/loads.cjs`).map((edge) => edge.to),
      violations: rules(report),
    },
    { esm: esmTargets, cjs: cjsTargets, violations: ["forbidden-secret", "forbidden-secret"] },
  );
});

test("reports unknown dynamic paths and anchors without interpreting comments or embedded scripts", async (t) => {
  const { write, check } = await workspace(t);
  await write(
    "apps/app/src/unknown.mjs",
    `
    import { createRequire } from "node:module";
    // import "./comment-missing.mjs";
    const script = 'require("./embedded-missing.mjs")';
    import "./missing.mjs";
    import "#unregistered";
    export const dynamic = (name) => import(name);
    export function anchored(anchor) {
      const load = createRequire(anchor);
      load("./index.ts");
      return import(load.resolve("./index.ts"));
    }
  `,
  );
  const report = await check();
  assert.equal(report.violations.length, 5);
  assert.equal(
    report.violations.filter((edge) => edge.rule === "unresolved-dynamic-import").length,
    3,
  );
  assert.equal(
    from(report, "apps/app/src/unknown.mjs").some((edge) => edge.to === "apps/app/src/index.ts"),
    false,
  );
  assert.equal(JSON.stringify(report).includes("comment-missing"), false);
  assert.equal(JSON.stringify(report).includes("embedded-missing"), false);
});

test("checks registered workspace namespaces and reports source syntax failures", async (t) => {
  const { write, check } = await workspace(t);
  await write("apps/app/src/unregistered.ts", 'import "@fixture/missing";');
  assert.equal((await check()).ok, true);
  assert.deepEqual(
    rules(await check({ policy: { ...policy, workspaceNamespaces: ["@fixture/"] } })),
    ["unknown-workspace-package"],
  );
  await write("apps/app/src/broken.ts", "export const broken = ;");
  const report = await check();
  assert.ok(
    report.violations.some(
      (item) => item.rule === "source-syntax" && item.from === "apps/app/src/broken.ts",
    ),
  );
});

test("classifies runtime, erased type-only and mixed cycles using Node type-stripping semantics", async (t) => {
  const { write, check } = await workspace(t);
  await write(
    "apps/app/src/cycles/type-a.ts",
    'import type { B } from "./type-b.ts"; export interface A { b: B }',
  );
  await write("apps/app/src/cycles/type-b.ts", 'export type { A as B } from "./type-a.ts";');
  await write(
    "apps/app/src/cycles/runtime-a.ts",
    'import { type B } from "./runtime-b.ts"; export interface A {}',
  );
  await write("apps/app/src/cycles/runtime-b.ts", 'export { type A as B } from "./runtime-a.ts";');
  await write(
    "apps/app/src/cycles/mixed-a.ts",
    'import type { B } from "./mixed-b.ts"; export const a = 1;',
  );
  await write("apps/app/src/cycles/mixed-b.ts", 'import "./mixed-a.ts"; export interface B {}');
  await write("apps/app/src/query.ts", 'export type Query = import("./cycles/type-a.ts").A;');
  // Node keeps empty inline-type import/export declarations, evaluating targets.
  assert.match(stripTypeScriptTypes('import { type A } from "./a.ts";'), /import\s*\{\s*\}\s*from/);
  assert.match(stripTypeScriptTypes('export { type A } from "./a.ts";'), /export\s*\{\s*\}\s*from/);
  const report = await check();
  assert.equal(report.runtimeCycles.length, 1);
  // Both all-type and mixed cycles need an erased edge to close the loop.
  assert.equal(report.typeOnlyCycles.length, 2);
  assert.equal(report.typeInvolvingCycles.length, 2);
  assert.ok(report.runtimeCycles[0].every((path) => path.includes("runtime-")));
  assert.deepEqual(rules(report), ["runtime-cycle"]);
  assert.equal(from(report, "apps/app/src/query.ts")[0].typeOnly, true);
  assert.equal(
    (await check({ policy: { ...policy, cycles: { runtime: "report", typeOnly: "report" } } })).ok,
    true,
  );
});

test("matches exact reviewed exceptions and reports binding changes and stale entries", async (t) => {
  const { root, write, check, args } = await workspace(t);
  const path = "packages/library/src/pending.ts";
  await write(path, 'import type { Value } from "./index.ts";');
  const exception = {
    rule: "internal-root-barrel",
    from: path,
    to: "packages/library/src/index.ts",
    specifier: "./index.ts",
    kind: "import",
    typeOnly: true,
    bindings: ["type:Value"],
    owner: "Fixture maintainers",
    reason: "Awaiting leaf extraction.",
    removeWhen: "Import the leaf directly.",
  };
  const exceptions = { version: 1, exceptions: [exception] };
  assert.equal((await check({ exceptions })).ok, true);
  await write("exceptions.json", JSON.stringify(exceptions));
  const { stdout } = await run(process.execPath, [
    cli,
    ...args,
    "--exceptions",
    join(root, "exceptions.json"),
    "--json",
  ]);
  assert.equal(JSON.parse(stdout).baseline.length, 1);
  await write(path, 'import type { Value, value } from "./index.ts";');
  assert.deepEqual(rules(await check({ exceptions })), ["internal-root-barrel", "stale-exception"]);
  await write(path, 'import { Value } from "./index.ts";');
  assert.deepEqual(rules(await check({ exceptions })), ["internal-root-barrel", "stale-exception"]);
  await write(path, 'import type { Value } from "./leaf.ts";');
  assert.deepEqual(rules(await check({ exceptions })), ["stale-exception"]);
  await assert.rejects(check({ exceptions: { version: 1, exceptions: [exception, exception] } }));
  await assert.rejects(
    check({ exceptions: { version: 1, exceptions: [{ ...exception, owner: "" }] } }),
  );
});

test("binds cycle exceptions to the complete cycle edge set", async (t) => {
  const { write, check } = await workspace(t);
  await write("apps/app/src/cycle-a.mjs", 'import "./cycle-b.mjs"; export const a = 1;');
  await write("apps/app/src/cycle-b.mjs", 'import "./cycle-a.mjs"; export const b = 2;');
  const violation = (await check()).violations.find((item) => item.rule === "runtime-cycle");
  assert.ok(violation);
  const exceptions = {
    version: 1,
    exceptions: [
      {
        ...violation,
        owner: "Fixture maintainers",
        reason: "Existing cycle.",
        removeWhen: "Extract a shared leaf.",
      },
    ],
  };
  assert.equal((await check({ exceptions })).ok, true);
  await write(
    "apps/app/src/cycle-a.mjs",
    'import "./cycle-b.mjs"; export { b } from "./cycle-b.mjs"; export const a = 1;',
  );
  assert.deepEqual(rules(await check({ exceptions })), ["runtime-cycle", "stale-exception"]);
});

test("requires explicit valid policy and reports CLI success, violations and configuration failures", async (t) => {
  const { root, write, check, args } = await workspace(t, { diagnosticLimit: 1 });
  const passed = await run(process.execPath, [cli, ...args, "--json"]);
  assert.equal(passed.stderr, "");
  assert.deepEqual(JSON.parse(passed.stdout), await check());
  await write("apps/app/src/invalid.mjs", 'import "./missing-a.mjs"; import "./missing-b.mjs";');
  await assert.rejects(run(process.execPath, [cli, ...args]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /1 additional violations/);
    assert.equal(
      error.stderr.split("\n").filter((line) => line.includes("[unresolved-local-import]")).length,
      1,
    );
    return true;
  });
  await assert.rejects(run(process.execPath, [cli, ...args, "--json"]), (error) => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).violations.length, 2);
    return true;
  });
  await write("malformed.json", "{");
  await write("invalid.json", JSON.stringify({ ...policy, diagnosticLimit: 0 }));
  for (const options of [
    ["--root", root],
    ["--root", root, "--policy", join(root, "malformed.json")],
    ["--root", root, "--policy", join(root, "invalid.json")],
    [...args, "--unknown"],
  ]) {
    await assert.rejects(run(process.execPath, [cli, ...options]), (error) => {
      assert.equal(error.code, 2);
      assert.notEqual(error.stderr.trim(), "");
      return true;
    });
  }
  await assert.rejects(verifyModuleBoundaries({ root }));
  for (const invalid of [
    { ...policy, version: 2 },
    { ...policy, sourceRoots: ["../outside"] },
    { ...policy, boundaries: [{ rule: "invalid", from: ["apps/**"] }] },
  ]) {
    await assert.rejects(check({ policy: invalid }));
  }
});
