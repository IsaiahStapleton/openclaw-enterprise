# Write RFCs and implementation plans

Start with the [specification index](../../specs/README.md) and the current
[platform design](../design.md). Reuse an existing decision or plan when it owns
the work. Follow [Contributing](../../CONTRIBUTING.md) for review and merge policy.

## Choose the document

An **RFC** proposes an architectural decision: the problem, selected approach,
alternatives, ownership, trust boundaries, and required outcomes. An
**implementation plan** turns an RFC or existing architecture into concrete
changes, dependencies, and verification.

- For an architectural decision, write an RFC using the [RFC process](rfcs.md)
  and [template](rfc-template.md). A small change can keep its delivery steps in
  a short RFC section.
- For a bigger feature with an RFC, write a separate implementation plan. Link
  the RFC's requirements instead of copying its rationale and design.
- For substantial work within existing architecture, write a standalone plan.
  A plan does not require an RFC. Routine fixes need neither document.

The repository-local [spec skill](../../.agents/skills/spec/SKILL.md) supports:

```text
$spec rfc <description>
$spec plan RFC-0042 <description>
$spec plan <description>
```

The first command drafts a proposal. The second creates or updates that RFC's
implementation plan. The third looks for an owning RFC and otherwise creates a
standalone task plan. These commands author documents; they do not approve a
decision or start implementing it. Existing authorization for broader work
still applies. No personal skill installation is required.

## Files and numbering

Use single Markdown files by default:

```text
specs/
  README.md
  rfcs/
    0042-runtime-trust.md
  plans/
    rfcs/
      0042-runtime-trust.md
    tasks/
      0042-credential-cleanup.md
```

**RFC numbers and task-plan numbers are independent sequences.** Use the full
identifiers `RFC-0042` and `TASK-0042` in conversation and links. An RFC plan
reuses its RFC's number and topic; it does not allocate another number. Keep one
primary plan per RFC, with milestones inside it. Link additional relevant RFCs
as dependencies.

For each sequence, allocate one above its highest used number, with at least
four digits. Inspect existing files, the index, and Git history so deleted or
renamed records do not free numbers. Historical shared numbers through **41**
are reserved in both sequences; new numbers start at **0042** or higher.
Recheck for collisions before creating a file and before merging. If concurrent
branches allocate the same new ID, renumber the later unmerged document and
update its links. Never overwrite an existing document.

Add one index row per workstream and link between an RFC and its plan. If a
standalone task later gains an RFC, retain its task ID and path and add the
relationship; do not create a duplicate plan merely to change its category.

When substantial evidence, diagrams, or independently useful milestones need
companions, use a directory named `<number>-<topic>/` with the main document at
`index.md` inside it. Move an existing `<number>-<topic>.md` into that directory
when adding companions; do not keep a second top-level document. Keep the same
ID, update incoming and relative links, and link companions from `index.md` and
back to it. This applies to RFCs, RFC-linked plans, and standalone task plans:

```text
specs/rfcs/0042-runtime-trust/
  index.md
  architecture.svg
specs/plans/rfcs/0042-runtime-trust/
  index.md
  qualification.md
specs/plans/tasks/0042-credential-cleanup/
  index.md
  inventory.md
```

Do not create empty directories or a separate reports area. PR screenshots
and recordings remain outside the repository, as required by
[Console Storybook](console-storybook.md).

## Status and review

Keep status in the owning document rather than duplicating it in the index.

| Document      | Status values                            |
| ------------- | ---------------------------------------- |
| RFC decision  | Proposed, Accepted, Rejected, Superseded |
| Plan delivery | Planned, In progress, Completed, Stopped |

New RFCs start **Proposed**. Record acceptance or another decision only when
supported by the responsible reviewers' decision or the contribution policy;
drafting a plan is not acceptance. If an RFC contains its own delivery steps,
track delivery separately from its decision status.

Request human feedback early. Planning and implementation can proceed while
the RFC is reviewed, subject to [review policy](../../CONTRIBUTING.md#prepare-a-pull-request)
and any specific holds. Keep an active RFC and its plan consistent as decisions
change. Follow the repository's independent-review workflow when requested.

A plan names the real caller, affected owners and files, ordered work, material
dependencies, and observable success and failure checks. Use phases only when
they deliver independently useful outcomes or enforce real sequencing. Record
blockers beside the affected work. Keep required integration proof explicit;
source inspection, fixtures, and live runtime evidence make different claims.

Before marking delivery Completed, record the implementation PR or commit,
verification results and limits, and updated current references, guides, and
flows. An unmet required outcome keeps its milestone incomplete unless an
authorized scope change is recorded. Acceptance of an RFC is not evidence of
availability. Use [documentation checks](documentation.md#preview-and-check)
for document-only changes, without running product tests.

## Historical records and first-phase organization

Completed, rejected, stopped, and superseded documents stay in their existing
RFC or plan location. A later substantial change gets a new document that links
its predecessor and explains what it supersedes. Current supported behavior
belongs in [reference](../reference/README.md), and current architecture belongs
in the platform design.

Preserve historical decisions, dates, evidence, recorded statuses, and Manual
Notes. Keep mixed historical design and implementation records intact, choosing
their home by primary purpose. Existing names, including duplicate numeric
prefixes and date-based names, are grandfathered; documents with companions use
those names for their directories and `index.md` for the main document. Refer to
the full path when a number is ambiguous. Do not infer completion from placement or
rewrite historical content to match the new template.

This first phase moves non-archived specifications and supporting evidence.
`specs/.archive/` remains unchanged and is linked from the index. Its referenced
images and one forwarding page remain at their existing paths so archived links
still resolve. A future archive reorganization requires a separate change.
