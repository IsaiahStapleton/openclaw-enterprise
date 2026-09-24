# Console draft navigation evidence

Tested Console source: `58cd8c9d73d401104b31252235c38c2ecc499c62`.
Environment: Linux, Node.js 26.5.0, Playwright 1.63.0, Chromium 153,
1280 × 900 viewport. Storybook was rebuilt from this source.

[Watch the 11-second walkthrough](walkthrough.mp4). It switches tabs and pages,
returns with Back/Forward, and exercises explicit Cancel, Save, and Reload.

| Story                                                                                                        | Screenshot                                        | Demonstrated result                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Pages / Agent detail / Keep Configuration edits (`pages-agent-detail--configuration-navigation`)             | [Configuration](configuration-restored.png)       | Unfinished JSON returns; deployment remains blocked.                                                            |
| Components / Workspace / Keep unsaved files (`components-workspace--workspace-navigation`)                   | [Workspace](workspace-restored.png)               | Text and an empty USER.md survive navigation; Save and Reload remain explicit.                                  |
| Components / Credentials / Keep authentication choices (`components-credentials--authentication-navigation`) | [Authentication](authentication-restored.png)     | Method and an existing Secret ID return; Reload discards the choice. The mask hides a metadata ID, not a token. |
| Components / Channels / Keep Slack edits (`components-channels--slack-navigation`)                           | [Slack](slack-restored.png)                       | Back/Forward reopens the drawer with edited channel IDs; Cancel discards them.                                  |
| Pages / Create Agent / Keep Preset variables (`pages-create-agent--preset-variable-navigation`)              | [Preset variables](preset-variables-restored.png) | Name and model return; the new-token input is empty.                                                            |

The [applied Preset walkthrough](../preset-navigation/README.md) covers the Create
Agent form, workspace inputs, and confirmed Start over at the same source revision.

These are simulated Storybook UI fixtures with synthetic data. They do not prove
backend persistence, Secret propagation, deployment, model execution, or a live
gateway. Separate browser regressions use the real Console, Fastify routes, and
IAM with in-memory platform storage; workspace transport uses Agent-scoped local
files. They check isolation, stale save baselines, explicit discard, and write
outcome recovery. Existing permission-denied, missing-file, and uncertain-write
Storybook previews were also checked in Chromium.
