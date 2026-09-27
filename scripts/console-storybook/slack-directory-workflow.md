# Slack directory

These stories use production Console controls with simulated Secrets and directory results. They do not read a real token or contact Slack.

1. Open **Components / Channels / Saved Slack IDs show current names** and **Qualified Slack targets keep names and IDs**. Saved targets appear as removable name chips; hover a chip for the exact saved ID.
2. In **Find Slack channels by name**, type `platform` directly into Channels. Choose the result with the mouse or Arrow Down and Enter. The chip is added without a second modal. Remove it, paste two exact IDs separated by commas, and press Enter. Unselected search text must not become a chip.
3. In **Resolve duplicate Slack people**, distinguish results by handle and ID. Choose a person, then switch channel access between Specific people and Everyone. Switching back preserves the staged people; clearing the last person must still require an explicit access choice before saving.
4. Inspect **Slack directory needs a bot Secret**, **Slack directory access denied**, and **Slack directory loading**. Exact-ID entry remains available. In **New search supersedes pending results**, type `platform` while the first request is pending; the late response must not replace the newer result.
5. Check narrow-screen layout and keyboard focus. Escape closes results without closing the Slack editor. See **Pages / Agent detail / Find Slack plugin approvers** for the same control saving workspace-qualified approvers.
