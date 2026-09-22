# Build complete capabilities behind small interfaces

Start a design or refactor with one caller's task, the component responsible for
it, and the outcomes that must hold. **Minimize what a caller must understand;
make what an owner must guarantee obvious.** A useful abstraction lets callers
complete their work while its owner manages the necessary complexity.

These principles guide contributions to OpenClaw Enterprise (OCE). The
[platform design and implementation status](../design.md#implementation-status)
remain authoritative. Verify current behavior before relying on a target
capability. Apply the principles to the change at hand; they do not require a
broader rewrite.

## Define behavior before choosing an interface

Describe who calls the capability, what resources and operations it covers, and
what success means. Include lifetime, failure, cleanup, and any ordering or
concurrency guarantees that affect the caller. Distinguish configuration from
permission to perform a particular operation. Names such as “session,” “client,”
or “ready” cannot establish those semantics.

Find the existing architectural owner and follow its contract, composition, and
lifecycle. Extend that owner when the required behavior is missing. Introduce a
new primitive only when none fits and the architecture permits it. Connect the
capability to a real caller in the regular Agent workflow. A helper with a suitable
name and direct tests still needs that integration.

## Put complete tasks behind small, deep interfaces

A deep interface provides useful behavior through a small set of concepts. Let
callers ask for a complete task without assembling its internal protocol. Keep
queues, counters, transport details, and intermediate states private unless
consumers need them to make a decision.

Small does not mean incomplete. Retain the identities, deadlines, operations, and
outcomes needed to use the capability correctly. Make ownership transfer and
cleanup obligations visible. Expose intended public types through the package's
curated entry point. When returning a smaller public result, construct it
explicitly: a narrower type annotation does not remove runtime fields.

## Reuse mechanisms that satisfy the contract

Before building a subsystem, compare the existing owner's capabilities and
reusable implementations against the required behavior. Include integration,
operational dependencies, authority, failure, and cleanup costs. Similar names
or method signatures do not establish equivalent guarantees.

Prefer a delegated tool's native configuration and extension points when they
meet the contract. Integration glue should avoid maintaining a second parser for
that tool's arguments, aliases, or configuration grammar. A normal hook still
needs to see enough information, at the right time, to perform its responsibility.
Record a material gap; resolve it at the appropriate boundary or explicitly
narrow the supported behavior.

Keep routing and authorization separate: routing chooses a destination;
authorization decides whether the effective operation is allowed. State whether a
guarantee applies to each request or to a whole command. A command may issue
several requests; authorizing each request does not guarantee that no earlier
request takes effect before a later one fails.

## Make dependencies, values, and state owners explicit

Choose concrete collaborators at startup or session construction. Pass each
operation the capabilities it needs and its changing inputs. Avoid mutable global
lookups and broad context objects forwarded through unrelated helpers.

Separate decisions from effects. A decision function derives a value from
explicit inputs; named effectful operations perform I/O; orchestration connects
them in execution order. Prefer stable bindings, derived values, and composition.
Use early guards for terminal cases and exhaustive handling when distinct
outcomes require different behavior. Extract functions around coherent purposes,
not a line limit. Short comments can explain an invariant or orient readers to a
group of related operations.

Give necessary mutation one owner with named transitions and a clear lifetime.
A class or closure may express that ownership; neither makes captured clocks,
state, or I/O pure. Derive configuration variants and observations as values.
Preserve the identity and ownership contract of live sockets, leases, and
ownership handles; copying their fields does not create an independent resource. The practical
[readable-code guide](readable-code.md) develops these choices with examples.

## Match precision to consequences

Validate external data at the responsible trust boundary, then use the admitted
values. Keep persisted invariants in their authoritative database constraints;
avoid repeating validation without an additional boundary to protect. Define
outbound data deliberately as part of the caller's contract.

Use absence when it leads to one ordinary caller action. Use distinct outcomes
when the caller must react differently to rejection, work that never started,
uncertain completion, or success. Preserve the information needed for that decision without
exposing every internal state. Translate exceptions at the boundary that can
explain or act on them; preserve cleanup during propagation. Avoid speculative
schemas for opaque data that the component does not interpret.

## Preserve invariants when simplifying control flow

Write down the semantic obligations before rearranging code: who owns the state,
when effects may occur, what counts as completion, and who still owes cleanup.
Judge the change against those obligations before judging its syntax.

A timeout may end the caller's wait while work remains in flight. Closing an
owner may stop new work before existing work settles. Keep the resources and
cleanup duties required by that outstanding work. Retry uncertain operations only
under an established idempotency or reconciliation contract. Flattening branches,
removing mutation, or extracting callbacks is useful when it makes these rules
easier to see and preserves their behavior.

## Prove the behavior through supported callers

Choose observations that demonstrate the promised contract, including consequential
failure. New platform functionality needs integration coverage through the
supported Agent workflow and relevant dependencies. A small setup and observation
vocabulary can make scenarios readable; keep their actions, assertions, and
lifecycle visible. A fixture that recreates application policy proves its own
answers.

Match the claim to what ran. Source review, composed behavior, installed runtime,
and live external-service behavior answer different questions. When delivery is
part of the claim, exercise the emitted entry point with its actual dependencies
and inputs. Confirm that the intended verification selected the required cases;
name skips and missing prerequisites. Passing checks cannot establish behavior
they never exercised.

Use the [design-review skill](../../.agents/skills/design-review/SKILL.md) to
apply these principles to one workflow. Favor the smallest coherent change that
makes the caller's task simpler and the owner's guarantees clearer.
