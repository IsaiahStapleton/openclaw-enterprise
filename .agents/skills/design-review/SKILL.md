---
name: design-review
description: Assess designs, public interfaces, state ownership, readability, and refactor proposals when the task calls for design review or structural simplification; not for unrelated routine edits.
---

# Review design through a real caller

Use this skill to explain a design's consequences and identify the smallest
coherent improvement. Preserve the user's chosen task, technologies, and scope.
Read applicable repository instructions and the relevant architecture or feature
contract; distinguish implemented behavior from target design. A review-only
request stays read-only. This skill grants no implementation or publication
authority beyond the user's request.

Read relevant sections of the
[design philosophy](../../../docs/contributing/design-philosophy.md) for the
reasoning behind a design decision, and
[readable code](../../../docs/contributing/readable-code.md) for practical choices
about functions, values, branching, composition, and ownership. Read selectively;
examples illustrate options, while repository policies supply requirements.

## Follow the behavior before changing the structure

Scale the assessment to the question. A local readability issue may need one
source trace and a short paragraph; a lifecycle or interface change needs its
callers and failure paths. The following prompts guide the work, not a mandatory
report template.

1. **Trace a supported caller.** Follow one real task through the affected
   operation to its observable result. Identify the responsibility owner,
   concrete dependencies, mutable state, and effects. For a proposal, distinguish
   existing calls from proposed steps. If a caller or implementation is missing,
   record the gap instead of inventing integration.
2. **Record the invariants that constrain the change.** Name the behavior to
   preserve: relevant inputs and outcomes, authority, identity, ordering,
   lifetimes, and cleanup. Follow consequential failure paths. Where asynchronous
   work outlives its caller, identify who owns settlement and disposal. Keep
   uncertain outcomes distinct when they require different caller behavior.
3. **Audit the interface against its consumers.** Find actual uses of exported
   operations, types, inputs and outputs. Ask which decisions callers need to
   make and which mechanics belong inside the owner. Check runtime values when
   narrowing a response; a narrower type alone does not remove fields. Bound
   claims about unused surface to the consumers searched.
4. **Inspect the relevant sources of complexity.** Check whether branching
   exposes meaningful outcomes, dependencies are selected in a clear place,
   changing operation data is explicit, and configuration is separate from live
   resource ownership. Look for repeated reassignment, deep nesting, forwarding
   wrappers and broad context objects that obscure decisions or effects. These
   are prompts to investigate, not automatic defects. Preserve effect order,
   aliasing constraints and cleanup when comparing alternatives. `if`, `let`,
   loops, closures and classes can each be appropriate.
5. **Choose a scoped action.** Recommend the smallest coherent change that
   addresses a demonstrated problem and preserves the recorded invariants.
   Prefer the existing responsibility owner; check available capabilities before
   introducing an abstraction. Similar syntax alone does not justify shared
   machinery. Keep unrelated improvements outside the assignment. Implement
   only when the user's task authorizes it, following repository development
   guidance.
6. **Match the claim to proof.** Identify the supported caller and observable
   outcomes that would establish the result, including relevant failures. Inspect
   existing evidence and state its limits. When assessing or changing tests, use
   [test-audit](../test-audit/SKILL.md); when selecting executable verification,
   use [enterprise-testing](../enterprise-testing/SKILL.md). Follow repository
   requirements for the kind of change. Source inspection, composed behavior,
   installed runtime, and live-provider results establish different claims;
   missing proof remains a gap.

## Return findings someone can act on

Lead with the consequence for the caller. For each material finding, give a
precise source pointer, the behavior or invariant to preserve, the proposed scoped
change, and the evidence that supports it or the proof still needed. Prioritize
correctness and ownership problems over optional polish. Distinguish what the
source establishes, what you propose, and what remains unknown; do not present
an unrun check as a result.

Use the user's requested format. Otherwise, short paragraphs or a few bullets
are enough. State when no actionable findings remain; do not manufacture a
refactor to satisfy the procedure.

Example invocation:

> Use $design-review to assess the public interface in this diff. Trace a supported
> caller and recommend scoped improvements that preserve its behavior. Keep the
> review read-only.
