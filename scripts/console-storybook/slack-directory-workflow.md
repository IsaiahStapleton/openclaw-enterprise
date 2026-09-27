# Slack directory

These stories use the production Console controls with simulated Secrets and directory results. They do not read a real token or contact Slack.

1. Open **Components / Channels / Saved Slack IDs show current names** and **Qualified Slack targets keep names and IDs**. The editor resolves saved bare and qualified targets into transient name labels while retaining exact values.
2. Open **Find Slack channels by name** and **Resolve duplicate Slack people**. Search, move to the next page, and choose a result. The picker shows the bot workspace and saves a bare ID. Existing qualified targets remain unchanged.
3. Inspect **Slack directory needs a bot Secret**, **Slack directory access denied**, **Slack directory loading**, and **New search supersedes pending results**. In the last story, search for `platform` while the first request is pending. The late first page must not replace the newer result.
