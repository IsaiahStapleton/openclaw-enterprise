import { isAbsolute, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript-compiler-api";
import { createLoaderAnalysis, unwrap } from "./loader-provenance.mjs";
import { freezeRecord, slash, sourceExtension } from "./workspace.mjs";

function normalizedSpecifier(root, value) {
  try {
    if (value.startsWith("file:")) {
      return `file:${slash(relative(root, fileURLToPath(value)))}`;
    }
    if (isAbsolute(value)) {
      return `file:${slash(relative(root, value))}`;
    }
  } catch {
    /* Keep malformed URL text for its resolution diagnostic. */
  }
  return value;
}

function assignedSymbols(source, checker) {
  const symbols = new Set();
  function assign(node) {
    node = unwrap(node);
    if (ts.isIdentifier(node)) {
      symbols.add(checker.getSymbolAtLocation(node));
    } else if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
      ts.forEachChild(node, assign);
    } else if (ts.isPropertyAssignment(node)) {
      assign(node.initializer);
    } else if (ts.isShorthandPropertyAssignment(node)) {
      symbols.add(checker.getShorthandAssignmentValueSymbol(node));
    } else if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) {
      assign(node.expression);
    }
  }
  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      assign(node.left);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
    ) {
      assign(node.operand);
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      assign(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return symbols;
}

/** Parse/bind the snapshot only. Emit import references; make no resolution or policy decisions. */
export function collectSourceImports(snapshot) {
  const texts = new Map(snapshot.files.map((file) => [file.absolutePath, file.text]));
  const options = {
    allowJs: true,
    noResolve: true,
    noLib: true,
    target: ts.ScriptTarget.Latest,
    // Both Node ESM and CommonJS isolate file-local bindings, including files
    // that contain only dynamic imports and no static import/export syntax.
    moduleDetection: ts.ModuleDetectionKind.Force,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (path, languageVersionOrOptions) =>
    texts.has(path)
      ? ts.createSourceFile(path, texts.get(path), languageVersionOrOptions, true)
      : undefined;
  const program = ts.createProgram([...texts.keys()], options, host);
  const checker = program.getTypeChecker();
  const references = [];
  const diagnostics = [];
  for (const file of snapshot.files) {
    const source = program.getSourceFile(file.absolutePath);
    const commonjs = /\.[cm][jt]s$/.test(file.path)
      ? /\.[c][jt]s$/.test(file.path)
      : file.packageType !== "module";
    const analysis = createLoaderAnalysis({
      checker,
      path: file.absolutePath,
      commonjs,
      assigned: assignedSymbols(source, checker),
    });
    const line = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    for (const error of source.parseDiagnostics) {
      diagnostics.push(
        freezeRecord({
          category: "syntax",
          rule: "source-syntax",
          from: file.path,
          to: "",
          specifier: "",
          kind: "syntax",
          typeOnly: false,
          bindings: [],
          line: source.getLineAndCharacterOfPosition(error.start ?? 0).line + 1,
          message: ts.flattenDiagnosticMessageText(error.messageText, " "),
        }),
      );
    }
    function record(
      node,
      kind,
      typeOnly = false,
      bindings = ["*"],
      anchor = file.absolutePath,
      override,
    ) {
      const value = override ?? analysis.value(node);
      references.push(
        freezeRecord({
          from: file.path,
          specifier:
            value.status === "known"
              ? normalizedSpecifier(snapshot.root, value.value)
              : node.getText(source),
          kind,
          typeOnly: typeOnly || source.isDeclarationFile,
          bindings: [...bindings].sort(),
          line: line(node),
          mode: value.mode ?? (kind === "require" ? "require" : "import"),
          anchor: Object.hasOwn(value, "anchor") ? value.anchor : anchor,
          value,
        }),
      );
    }
    function visit(node) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        const bindings = [
          ...(clause?.name ? [`${clause.isTypeOnly ? "type" : "value"}:default`] : []),
          ...(named && ts.isNamedImports(named)
            ? named.elements.map(
                (item) =>
                  `${clause.isTypeOnly || item.isTypeOnly ? "type" : "value"}:${(item.propertyName ?? item.name).text}`,
              )
            : named
              ? ["*"]
              : []),
        ];
        record(node.moduleSpecifier, "import", clause?.isTypeOnly ?? false, bindings);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const bindings =
          node.exportClause && ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements.map(
                (item) =>
                  `${node.isTypeOnly || item.isTypeOnly ? "type" : "value"}:${(item.propertyName ?? item.name).text}`,
              )
            : ["*"];
        record(node.moduleSpecifier, "export", node.isTypeOnly, bindings);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        record(node.argument.literal, "import-type", true);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        record(node.moduleReference.expression, "require", node.isTypeOnly);
      } else if (ts.isCallExpression(node)) {
        const loader = analysis.reference(node.expression);
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          record(node.arguments[0] ?? node, "dynamic-import");
        } else if (loader?.kind === "require") {
          record(node.arguments[0] ?? node, "require", false, ["*"], loader.anchor);
        } else if (loader?.kind === "unknown-loader") {
          record(node.arguments[0] ?? node, "require", false, ["*"], null, {
            status: "unknown",
            reason: loader.reason,
          });
        } else if (analysis.builtin(node.expression, "node:module") === "createRequire") {
          const target = analysis.value(node.arguments[0]);
          if (
            target.value &&
            (target.value.startsWith("file:") || isAbsolute(target.value)) &&
            target.value !== file.absolutePath &&
            target.value !== pathToFileURL(file.absolutePath).href
          ) {
            record(node.arguments[0], "dependency-anchor");
          }
        }
      } else if (ts.isNewExpression(node) && analysis.isURL(node.expression)) {
        const target = analysis.value(node);
        try {
          if (
            target.value?.startsWith("file:") &&
            sourceExtension.test(new URL(target.value).pathname)
          ) {
            record(node, "path");
          }
        } catch {
          /* The containing recognized load reports invalid arguments. */
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return freezeRecord({ references, diagnostics });
}
