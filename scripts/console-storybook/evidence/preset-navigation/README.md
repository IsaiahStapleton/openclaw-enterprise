# Unsaved Preset draft navigation evidence

Tested Console source: `ee0c677b673055b4314a4ae08c6a49eafe13ea1f`.
Environment: Linux, Node.js 26.5.0, Playwright 1.63.0, Chromium 153,
1280 × 900 viewport. Storybook was rebuilt from this source.

Story: **Pages / Create Agent / Keep an unsaved Preset draft**
(`pages-create-agent--create-preset-navigation`).

The walkthrough applies Standard Codex, edits the name and AGENTS.md, opens
Namespaces, uses browser Back/Forward, and returns through Agents → Create Agent.
It cancels Start over once, confirms it, and verifies the chooser remains after
another navigation round trip. The restored API-key field is empty.

- [Restored draft](draft-restored.png)
- [Restored workspace edit](workspace-restored.png)
- [Chooser after explicit discard](draft-discarded.png)
- [Navigation and discard video](navigation-and-discard.webm)

These are simulated UI fixtures with synthetic credentials. They demonstrate
browser state and controls, not backend persistence, deployment, or model execution.
The separate browser regressions exercise real controller routes with in-memory
platform storage and the filesystem Configuration Driver.
