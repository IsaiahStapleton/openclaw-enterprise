# Make code readable through values, composition, and ownership

Follow one caller task from input to observable result. Keep decisions in
functions that take data and return values; make effects and their orchestration
easy to find. A reader should need little surrounding context to understand a
step and identify who owns resources after failure. This guide puts the
[design philosophy](design-philosophy.md) into practice. Its readability
preferences are recommendations; the linked language documents establish the
mechanics.

The **illustrative TypeScript sketch** below exports enabled catalog entries in
input order. An empty selection leaves the existing report untouched and returns
zero. Successful export returns the entry count; load and write failures propagate.
Labels are already validated single-line values. The writer owns file handling.

## Give functions coherent jobs and meaningful names

A function can own a decision, transformation, effect, or orchestration. Extract
one when its name captures meaning or its scope owns a resource, even if used
once. Choose scope by purpose, with no line quota. Forwarding a large context
through many wrappers adds navigation without explaining responsibility.

Prefer short names that retain their meaning in context: `entries`, `report`,
`loadEntries`. Keep related functions nearby. An occasional one- or two-line
function-group comment can identify decisions, effects, or orchestration without
listing every member. Explain purpose and invariants; omit syntax narration.

```ts
type Entry = Readonly<{ label: string; enabled: boolean }>;
type ReportOptions = Readonly<{ title: string; bullet: string }>;
type Report = Readonly<{ count: number; text: string }>;

// Decisions: preserve catalog order and derive a report without changing inputs.
function summarizeCatalog(entries: readonly Entry[], options: ReportOptions): Report {
  const enabledEntries = entries.filter((entry) => entry.enabled);
  const lines = enabledEntries.map((entry) => `${options.bullet} ${entry.label}`);
  return {
    count: enabledEntries.length,
    text: lines.length === 0 ? "" : [options.title, ...lines].join("\n"),
  };
}
```

The intermediate names expose the transformation. The function makes decisions
from explicit inputs and performs no I/O. In larger modules, put the main
operation where readers can find it first, then follow its named steps.

## Prefer stable bindings and early returns

Use `const` by default. Repeated reassignment and growing `if`/`else if`/`else`
ladders invite a closer look: derive a value, name it once, and handle terminal
cases before continuing. Keep a changing local when it expresses the operation
more clearly. OCaml's [immutable bindings](https://ocaml.org/docs/tour-of-ocaml)
and Erlang's [single-assignment variables](https://www.erlang.org/doc/system/expressions.html#variables)
provide useful precedents. JavaScript
[`const`](https://www.typescriptlang.org/docs/handbook/variable-declarations.html#const-declarations)
protects a binding, not an object's contents.

```ts
type ReportDependencies = Readonly<{
  loadEntries: () => Promise<readonly Entry[]>;
  writeReport: (text: string) => Promise<void>;
}>;

// Orchestration: leave the existing report untouched when no entries are enabled.
function createCatalogExporter(
  { loadEntries, writeReport }: ReportDependencies,
  options: ReportOptions,
) {
  const selectedOptions = { ...options };
  return async function exportCatalog(): Promise<number> {
    const entries = await loadEntries();
    const report = summarizeCatalog(entries, selectedOptions);
    if (report.count === 0) {
      return 0;
    }
    await writeReport(report.text);
    return report.count;
  };
}
```

The orchestration reads in execution order: load, decide, return or write.
Early returns reduce nesting, not the number of semantic cases. Preserve condition
order, effect order, distinct outcomes, and cleanup. Keep acquisition and cleanup
in their actual scope, using `finally` where needed.

Ordinary two-way conditions, including the text choice above, remain appropriate.
OpenClaw Enterprise (OCE) uses exhaustive `ts-pattern` matching for tagged unions
and branches that would otherwise become nested ternaries. Follow that local convention without
wrapping every `if` in a matcher.

## Return expected outcomes as values

Parsers and validators routinely encounter missing or invalid input. Return those
expected outcomes as values so the caller can decide what to do. An optional
value such as `string | undefined` is enough when every absent result calls for
the same action. Use tagged outcomes when callers need different responses.
Preserve those distinctions, especially when an absent required value must stop
an operation.

The same catalog exporter needs a title and a bullet. Here, a command's input
adapter supplies optional strings. The title must contain non-whitespace text and
no carriage return or newline; surrounding whitespace is trimmed. The bullet must
be exactly `-` or `*`. Both fields are required, and validation reports the first
problem, checking the title before the bullet.

```ts
import { match } from "ts-pattern";

type ReportConfiguration = Readonly<{ title?: string; bullet?: string }>;
type ReportOptionsOutcome =
  | Readonly<{ kind: "missing"; field: "title" | "bullet" }>
  | Readonly<{ kind: "invalid"; field: "title" | "bullet"; reason: string }>
  | Readonly<{ kind: "ready"; options: ReportOptions }>;

function parseReportTitle(value: string): string | undefined {
  const title = value.trim();
  if (title.length === 0 || /[\r\n]/u.test(value)) {
    return undefined;
  }
  return title;
}

function parseReportOptions(input: ReportConfiguration): ReportOptionsOutcome {
  if (input.title === undefined) {
    return { kind: "missing", field: "title" };
  }
  const title = parseReportTitle(input.title);
  if (title === undefined) {
    return {
      kind: "invalid",
      field: "title",
      reason: "Use a nonblank title without carriage returns or newlines.",
    };
  }
  if (input.bullet === undefined) {
    return { kind: "missing", field: "bullet" };
  }
  if (input.bullet !== "-" && input.bullet !== "*") {
    return { kind: "invalid", field: "bullet", reason: "Choose - or *." };
  }
  return { kind: "ready", options: { title, bullet: input.bullet } };
}

async function exportConfiguredCatalog(
  input: ReportConfiguration,
  dependencies: ReportDependencies,
): Promise<string> {
  return match(parseReportOptions(input))
    .with({ kind: "missing" }, ({ field }) => `Set the required ${field}.`)
    .with({ kind: "invalid" }, ({ field, reason }) => `Correct ${field}: ${reason}`)
    .with({ kind: "ready" }, async ({ options }) => {
      const exportCatalog = createCatalogExporter(dependencies, options);
      const count = await exportCatalog();
      return count === 0 ? "No enabled entries; report unchanged." : `Exported ${count} entries.`;
    })
    .exhaustive();
}
```

`parseReportTitle` groups its invalid cases because each needs a corrected title.
`parseReportOptions` preserves missing versus invalid fields so the caller can
ask for a required value or explain a correction. Neither case
loads entries or writes a report. No default replaces a missing required option.
With `{ title: "Catalog", bullet: "-" }`, the caller runs the existing exporter:
it prepares the complete report before writing and preserves the empty-selection
behavior.

These values describe expected validation outcomes. The caller does not catch
load or write failures. Exceptional failures such as a full disk or resource
exhaustion propagate, or terminate execution, so the responsible upper layer can
decide what to do. Do not turn them into an empty catalog, a validation message,
or an invented retry. When a failure unwinds through the stack, resource owners
still release what they acquire in `finally`. Fatal termination may prevent cleanup;
returning outcomes does not remove cleanup obligations.

## Select dependencies once; pass changing data explicitly

Choose concrete collaborators at startup or session construction: the composition
root can be a short function. Pass narrow capabilities or capture them in a
factory, avoiding mutable global service lookups deep in a call chain. Immutable
constants and pure functions can remain module-scoped.

The exporter accepts a reader and writer from its caller: inversion of control in
ordinary code. It snapshots the two string options, so later mutation of the
supplied object cannot change the selected formatting. Each invocation still
loads current entries. Passing a function reference does not transfer disposal
responsibility for a connection behind it.

Closures retain access to their lexical environment. Capturing a cache, clock,
mutable record, or I/O operation leaves those effects intact; making dependencies
private does not make the returned exporter pure.

Partial application supplies some arguments now and the rest later. Currying
expresses inputs as successive calls. A setup/per-call split can be useful:

```ts
const options = { title: "Available catalog", bullet: "-" };
const summarizeWith = (selected: ReportOptions) => {
  const snapshot = { ...selected };
  return (entries: readonly Entry[]) => summarizeCatalog(entries, snapshot);
};
const summarizeAvailable = summarizeWith(options);
```

Use this when consumers need a configured function. A direct
`summarizeCatalog(entries, options)` call is clearer without that boundary.
Ramda documents [currying](https://ramdajs.com/docs/#curry) and left-to-right
[`pipe`](https://ramdajs.com/docs/#pipe) composition; `pipe` does not automatically
curry its result. Borrow useful ideas without adding a library or forcing dense
chains that hide arguments.

## Derive values; give mutable state one owner

Clojure separates an identity from the immutable values associated with it over
time. Its [values and state](https://clojure.org/about/state) model suggests a
useful discipline: calculate a new value, then let the owner apply the transition.
TypeScript copies do not inherit Clojure's persistent-collection or coordination
guarantees.

Necessary mutation belongs to an explicit owner with named operations and a
lifetime. Functional programming can accommodate it: OCaml supports
[mutable fields, references, and arrays](https://ocaml.org/docs/mutability-imperative-control-flow).
Erlang's [processes and message passing](https://www.erlang.org/doc/system/conc_prog.html)
suggest narrow interactions and local ownership; JavaScript closures do not
provide process isolation. These ideas require no actor framework.

TypeScript [`readonly`](https://www.typescriptlang.org/docs/handbook/2/objects.html#readonly-properties)
restricts writes through a type; another alias can still mutate the object.
Object [spread is shallow](https://www.typescriptlang.org/docs/handbook/variable-declarations.html#spread).
For options with `page: { size }`, derive a changed page explicitly:
`{ ...options, page: { ...options.page, size: 10 } }`. Share untouched nested
references only under an established immutable-value contract. An outer freeze
alone does not protect nested data.

## Compose behavior and fork configuration values

A class can encapsulate dependencies and transitions; a factory can expose narrow
operations. Choose the form that makes the owner easy to find, and prefer
composition over inheritance. Neither form guarantees purity.

For reusable configuration, “prototype” means an example value and “fork” means
deriving a variant. This pattern does not modify JavaScript prototype chains:

```ts
class ReportStyle implements ReportOptions {
  constructor(
    readonly title: string,
    readonly bullet: string = "-",
  ) {
    Object.freeze(this);
  }

  withTitle(title: string): ReportStyle {
    return new ReportStyle(title, this.bullet);
  }
}

const standard = new ReportStyle("Catalog");
const weekly = standard.withTitle("Weekly catalog");
```

The two fields contain immutable strings; freezing the instance protects those
own fields. `weekly` supplies new exporter options while `standard` keeps its
title. Use a plain object when a class adds no useful vocabulary. Construct the
specific values needed instead of adding a general clone/freeze framework.

Never fork live sockets, leases, transactions, or authority handles by copying
fields. A snapshot can describe a live owner without becoming one. Use the
owner's acquisition or borrowing contract and preserve its cleanup obligations.

## Check when composition does work

Composition feeds one result into another operation. Named stages and ordinary
calls often communicate it best. The array operations above run immediately and
allocate intermediate arrays. For large inputs, assess a loop or streaming
contract; a loop may also clarify ordering and early termination.

Many LINQ operations defer work until enumeration, but sorting must process the
collection before yielding its first result. Microsoft's
[deferred-execution guide](https://learn.microsoft.com/en-us/dotnet/standard/linq/deferred-execution-lazy-evaluation)
distinguishes deferred execution from lazy evaluation. Check when a pipeline runs,
what it retains, and whether reading it again repeats effects. Brevity alone says
little about memory or timing.

## Express test scenarios over the real implementation

A small test vocabulary can combine meaningful builder and observation names with
inspectable scenario data. Clojure's [Lisp guidance](https://clojure.org/about/lisp)
explains code as data and reserves macros for cases where functions are
insufficient. In TypeScript, a scenario array is ordinary test data. Use that
structure without an interpreter, `eval`, or a generic fluent framework.

This sketch exercises `summarizeCatalog` above. In a real test file, import the
application implementation instead of duplicating it.

```ts
import assert from "node:assert/strict";
import test from "node:test";

// Scenario builders allocate fresh inputs; expected reports come from the contract.
function entry(label: string, enabled = true): Entry {
  return { label, enabled };
}

const scenarios = [
  { name: "empty catalog", build: () => [], expected: { count: 0, text: "" } },
  {
    name: "disabled entries are excluded; remaining order is preserved",
    build: () => [entry("Tea"), entry("Coffee", false), entry("Water")],
    expected: { count: 2, text: "Catalog\n- Tea\n- Water" },
  },
];

for (const scenario of scenarios) {
  test(scenario.name, () => {
    const actual = summarizeCatalog(scenario.build(), standard);
    assert.deepEqual(actual, scenario.expected);
  });
}
```

Each case exposes inputs, the operation, and an independently specified result.
Add a row for an independent selection case with the same action and assertions.
A mock that reproduces selection policy proves its own answers.

These pure scenarios do not prove the exporter's no-write behavior or file
persistence. Exercise the actual exported operation through its supported caller
with real storage: verify that an existing report survives an empty export and
inspect its contents after success. New OCE platform capabilities still require
integration coverage through the regular Agent workflow; a directly tested helper
cannot establish that connection. Follow the [testing guide](../testing/README.md).

Build fresh fixtures for each case, including nested mutable values. Register
cleanup when acquiring ownership and await asynchronous work within the test's
lifetime, following the [Node test runner](https://nodejs.org/docs/latest-v24.x/api/test.html).
Use explicit scenarios when timing, hooks, or cleanup differ. For cancellation or
delayed completion, show setup, trigger, intermediate invariant, release, and
final outcome in order. Keep that lifecycle visible rather than interpreting a
list of commands.
