# Organize and name development docs

Use this guidance when planning navigation or adding, combining, moving, or
renaming product, operator, or contributor documentation. Check the repository's
`AGENTS.md`, `docs/layout.md`, and `docs/docs.json` for actual file ownership and
navigation. The six sections below are the proposed site organization; this
does not mean those menus or every level of grouping are implemented. When a
navigation rollout is in scope, update the repository guidance, navigation,
owning indexes, and incoming links together. Preserve working paths, routes, and
anchors; a shorter label does not require a new URL.

## Organize around the reader's task

A menu selects a sidebar; a sidebar group supplies context; each page answers
one coherent question or helps complete one task. Organize around reader intent,
not the code tree. Keep the most useful starting path first and ongoing work
separate from first-time setup.

| Section         | What belongs there                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Getting Started | Orientation, concepts, setup, and the first successful use.                                                                  |
| Topics          | Product concepts, feature behavior, configuration, and feature troubleshooting that do not belong to a named implementation. |
| Integrations    | Named Drivers, Providers, or channels; their setup, support limits, and comparisons.                                         |
| Operate         | Production installation and ongoing work: monitoring, platform troubleshooting, credentials, upgrades, and recovery.         |
| Reference       | Exact CLI and HTTP API contracts: commands, flags, requests, responses, and errors.                                          |
| Contribute      | Work on the platform itself: Design, Local Development, Repository Layout, and Documentation.                                |

Give each subject one owning page and link it from other useful locations.
For example, explain Sandbox in Topics; keep OpenShell setup in Integrations
and link to it. Put base Driver contracts under contributor Design in site
navigation, without changing their repository source location just to match the
menu. Put internal execution flows and guides for testing code behind contributor
indexes, and link historical specs from an index of past designs. `docs/testing/`
owns code verification, not documentation authoring. Do not promote an
unfinished or unverified workflow into normal navigation; a known limitation of
a documented feature belongs prominently in its owning page.

## Name pages for their context

- Use short, familiar sidebar labels, usually one to four words. When the
  group already names the subject, use `Overview`, `Quickstart`, `Configure`,
  or `Troubleshoot`. Keep a specific noun when it distinguishes nearby pages:
  `Local Setup`, `Audit Log`, `Service API Keys`, `Agent Revisions`, or
  `Driver Development`. Put explanations such as what changes or when they
  take effect in the introduction or section headings.
- Use Title Case for sidebar labels, preserving product names and acronyms such
  as Agent, IAM, CLI, and HTTP API. Write article titles and section headings
  in sentence case; add context to the article title when it helps someone
  arriving directly, for example `IAM overview` or `Troubleshoot Agents`.
  Write `Quickstart` and `Troubleshoot` as one word; use `Setup` as a noun and
  `Set up` as a verb.
- Check what the renderer can actually represent. The current site's frontmatter
  `title` sets the shared sidebar and browser tab title; it falls back to the
  Markdown H1 when omitted. A descriptive H1 still appears in the indexed article,
  but there is no independently configurable sidebar or search title. If a
  generic shared title would be hard to distinguish, use the shortest qualified
  title, such as `IAM Overview`. Do not invent frontmatter fields or deeper
  navigation levels; use an index or propose tooling changes separately when the
  current format cannot represent the intended structure.
- Combine a workflow and reference when they cover the same resource for the
  same reader and fit on one useful page. For example, `Service API Keys` can
  hold issue/revoke instructions, permissions, and reference details under
  distinct headings. Split when audiences or tasks are independently useful,
  or when the repository's length rules call for it; give sibling pages
  distinct names. Keep status and caveats near the opening instead of turning
  the sidebar label into a sentence.
