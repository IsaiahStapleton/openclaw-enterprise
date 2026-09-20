# Agent workspace files

Use the console to read or edit an active Agent's `AGENTS.md`, `SOUL.md`,
`IDENTITY.md`, and `USER.md`. Changes go directly to the live workspace; they
are not saved in the Configuration draft or copied into an Agent Revision.

## Edit a file

You need `read` on the Agent to load files and `operate` to save them. The Agent
must have an active revision and a reachable gateway. Platform workspace access
is documented for [Kubernetes](../deploy/workspace-routing.md#agent-workspace-files);
it is not available with the bundled [SSH Driver](../../reference/drivers/ssh-compute.md#credentials-and-supported-boundaries).

1. Open **Agents**, select the Agent in the intended Namespace, and open
   **Workspace files**.
2. Select the file you want to edit. Use **Reload** before editing if another
   person might have changed it; reloading discards your unsaved changes.
3. Edit the text, then select **Save** for that file. Saving creates or replaces
   only the selected file. Each file can contain up to 16 KiB of UTF-8 text.
4. Reload the file to confirm the expected content was stored.

There is no version check: if two people edit a file, the last write wins. Do
not put credentials in these files. Use a [Secret](../../reference/configuration/secrets.md)
for credential values.

## If files cannot be loaded or saved

- **Immediately after deployment:** the gateway may still be starting. Confirm
  the expected [revision](agent-revisions.md) became active, then reload. If
  access stays unavailable, have an operator check
  [workspace routing](../deploy/workspace-routing.md#agent-workspace-files).
- **A save has an unknown outcome:** it may have succeeded. Reload the affected
  file and compare its content with your edit before saving again. A failure
  for one file does not establish what happened to the others.
- **The request is rejected:** check that the file is one of the four supported
  names, your text fits the limit, and you have Agent `operate` permission.

For automation, the [workspace file API](../../reference/agents.md#workspace-files)
documents the paths, limits, and errors.
