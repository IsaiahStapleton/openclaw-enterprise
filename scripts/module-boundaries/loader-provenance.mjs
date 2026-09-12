import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript-compiler-api";

const known = (value, resolution = {}) => Object.freeze({ status: "known", value, ...resolution });
const unknown = (reason) => Object.freeze({ status: "unknown", reason });
export function unwrap(node) {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node))
  )
    node = node.expression;
  return node;
}

/** Bounded lexical provenance, not JavaScript evaluation. No filesystem or policy access. */
export function createLoaderAnalysis({ checker, path, commonjs, assigned }) {
  const symbol = (node) => checker.getSymbolAtLocation(node);
  const declaration = (node) => symbol(node)?.declarations?.[0];
  const moduleValue = (name) =>
    ["module", "url", "path"].includes(name?.replace(/^node:/, ""))
      ? { kind: "module", module: `node:${name.replace(/^node:/, "")}` }
      : undefined;
  function member(base, name) {
    if (base?.kind === "module") return { kind: "builtin", module: base.module, name };
    if (base?.kind === "require" && name === "resolve") return { ...base, kind: "require-resolve" };
    if (base?.kind === "commonjs-module" && name === "require")
      return { kind: "require", anchor: path };
    if (base?.kind === "unknown-loader" && name === "resolve") return base;
    return undefined;
  }
  function property(node, seen) {
    if (ts.isComputedPropertyName(node)) return value(node.expression, seen).value;
    return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
  }
  function reference(input, seen = new Set()) {
    const node = unwrap(input);
    if (!node || seen.has(node) || seen.size >= 64) return undefined;
    seen = new Set([...seen, node]);
    if (ts.isIdentifier(node)) {
      const declared = declaration(node);
      if (!declared) {
        if (node.text === "require") return { kind: "require", anchor: path };
        if (commonjs && node.text === "module") return { kind: "commonjs-module" };
        return undefined;
      }
      if (ts.isImportSpecifier(declared)) {
        const base = moduleValue(declared.parent.parent.parent.moduleSpecifier.text);
        const name = (declared.propertyName ?? declared.name).text;
        return name === "default" ? base : member(base, name);
      }
      if (ts.isNamespaceImport(declared))
        return moduleValue(declared.parent.parent.moduleSpecifier.text);
      if (ts.isImportClause(declared)) return moduleValue(declared.parent.moduleSpecifier.text);
      if (
        ts.isImportEqualsDeclaration(declared) &&
        ts.isExternalModuleReference(declared.moduleReference)
      )
        return moduleValue(value(declared.moduleReference.expression, seen).value);
      let origin;
      if (ts.isVariableDeclaration(declared)) origin = reference(declared.initializer, seen);
      if (
        ts.isBindingElement(declared) &&
        ts.isObjectBindingPattern(declared.parent) &&
        ts.isVariableDeclaration(declared.parent.parent) &&
        !declared.dotDotDotToken &&
        !declared.initializer
      )
        origin = member(
          reference(declared.parent.parent.initializer, seen),
          property(declared.propertyName ?? declared.name, seen),
        );
      if (origin && assigned.has(symbol(node)))
        return {
          kind: "unknown-loader",
          reason: "A recognized loader binding is assigned elsewhere in this source.",
        };
      return origin;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : value(node.argumentExpression, seen).value;
      return member(reference(node.expression, seen), name);
    }
    if (ts.isCallExpression(node)) {
      const callee = reference(node.expression, seen);
      if (callee?.kind === "unknown-loader") return callee;
      if (callee?.module === "node:module" && callee.name === "createRequire") {
        const target = value(node.arguments[0], seen);
        let anchor;
        try {
          if (target.value?.startsWith("file:")) anchor = fileURLToPath(target.value);
          else if (target.value && isAbsolute(target.value)) anchor = target.value;
        } catch {
          /* Invalid URLs remain recognized loaders with unknown anchors. */
        }
        return {
          kind: "require",
          anchor: anchor?.endsWith("/") ? join(anchor, "noop.js") : (anchor ?? null),
        };
      }
      if (callee?.kind === "require") return moduleValue(value(node.arguments[0], seen).value);
    }
    return undefined;
  }
  function builtin(node, module, seen) {
    const origin = reference(node, seen);
    return origin?.kind === "builtin" && origin.module === module ? origin.name : undefined;
  }
  function isURL(input, seen) {
    const node = unwrap(input);
    return (
      builtin(node, "node:url", seen) === "URL" ||
      (node && ts.isIdentifier(node) && node.text === "URL" && !symbol(node))
    );
  }
  function value(input, seen = new Set()) {
    const node = unwrap(input);
    if (!node || seen.has(node) || seen.size >= 64)
      return unknown("Expression is absent, cyclic, or exceeds the 64-node analysis bound.");
    seen = new Set([...seen, node]);
    if (ts.isStringLiteralLike(node)) return known(node.text);
    if (ts.isIdentifier(node)) {
      const declared = declaration(node);
      if (!declared && commonjs) {
        if (node.text === "__filename") return known(path);
        if (node.text === "__dirname") return known(dirname(path));
      }
      if (
        declared &&
        ts.isVariableDeclaration(declared) &&
        declared.parent.flags & ts.NodeFlags.Const &&
        !assigned.has(symbol(node))
      )
        return value(declared.initializer, seen);
      return unknown("Module paths require a local const initializer with no assignment.");
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = value(node.left, seen),
        right = value(node.right, seen);
      return left.status === "known" && right.status === "known" && !left.mode && !right.mode
        ? known(left.value + right.value)
        : unknown("Concatenation has an unknown or unresolved path operand.");
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const item = value(span.expression, seen);
        if (item.status !== "known" || item.mode)
          return unknown("Template has an unknown or unresolved path substitution.");
        text += item.value + span.literal.text;
      }
      return known(text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (
        ts.isMetaProperty(node.expression) &&
        node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        node.expression.name.text === "meta" &&
        node.name.text === "url"
      )
        return known(pathToFileURL(path).href);
      const base = value(node.expression, seen);
      if (base.value?.startsWith("file:") && ["href", "pathname"].includes(node.name.text)) {
        try {
          return known(node.name.text === "href" ? base.value : new URL(base.value).pathname);
        } catch {
          return unknown("Invalid file URL.");
        }
      }
    }
    if (ts.isNewExpression(node) && isURL(node.expression, seen)) {
      const target = value(node.arguments?.[0], seen),
        base = value(node.arguments?.[1], seen);
      if (target.status === "known" && base.status === "known" && !target.mode && !base.mode) {
        try {
          return known(new URL(target.value, base.value).href);
        } catch {
          return unknown("Invalid URL arguments.");
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const loader = reference(node.expression, seen);
      if (loader?.kind === "unknown-loader") return unknown(loader.reason);
      const first = value(node.arguments[0], seen);
      if (first.status !== "known") return first;
      if (loader?.kind === "require-resolve")
        return known(first.value, { mode: "require", anchor: loader.anchor });
      // Never evaluate path manipulation around a deferred require.resolve result.
      if (first.mode)
        return unknown("Path manipulation around require.resolve is outside bounded analysis.");
      const name =
        builtin(node.expression, "node:url", seen) ?? builtin(node.expression, "node:path", seen);
      try {
        if (name === "fileURLToPath" && first.value.startsWith("file:"))
          return known(fileURLToPath(first.value));
        if (name === "pathToFileURL" && isAbsolute(first.value))
          return known(pathToFileURL(first.value).href);
        if (name === "dirname" && isAbsolute(first.value)) return known(dirname(first.value));
        if (["join", "resolve"].includes(name) && isAbsolute(first.value)) {
          const parts = node.arguments.map((argument) => value(argument, seen));
          if (parts.every((part) => part.status === "known" && !part.mode))
            return known((name === "join" ? join : resolve)(...parts.map((part) => part.value)));
        }
      } catch {
        return unknown("Invalid arguments to a supported Node path or URL helper.");
      }
    }
    return unknown(
      "Expression is outside the supported literal, const, URL and Node helper forms.",
    );
  }
  return Object.freeze({ reference, value, builtin, isURL });
}
