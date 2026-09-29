# Bundled Slack Channel Driver

The bundled `SlackChannelDriver` validates enabled Slack credentials before
provisioning or deployment and reads people and channels for the Console's
name picker. It uses the Agent's selected same-Namespace `SLACK_BOT_TOKEN`
Secret; the controller does not configure or store another token.

The Driver calls Slack [`auth.test`](https://docs.slack.dev/reference/methods/auth.test/)
to require a bot identity and identify its workspace, then [`users.list`](https://docs.slack.dev/reference/methods/users.list/)
or [`conversations.list`](https://docs.slack.dev/reference/methods/conversations.list/).
The bot needs `users:read` for people, `channels:read` for public channels, and
`groups:read` for private channels. Slack returns only resources visible to the
bot. The Driver scans a bounded number of pages per query and returns a cursor
when more pages remain. The Console displays the workspace and saves selected
IDs, never names.

For exact-ID searches and saved IDs, the Driver calls [`users.info`](https://docs.slack.dev/reference/methods/users.info/)
or [`conversations.info`](https://docs.slack.dev/reference/methods/conversations.info/)
directly. The Console shows selected names as removable chips, with exact IDs
available on hover. IDs the bot cannot see remain visible without a name.
Search in the field and choose a result, or paste exact IDs and press Enter.
The Console waits 300 ms after typing and shows up to five results per page.
Enter searches immediately. Next and Previous reuse fetched matches before
requesting another provider page.
Unselected search text is never saved. Channel access explicitly selects
**Specific people** or **Everyone in these channels**; removing the last person
does not switch to everyone.

An invalid token, missing scope, rate limit, invalid response, or unavailable
Slack service produces a safe error without returning the token or upstream
payload. Retry after fixing the token or scopes. Exact IDs can be entered when
directory browsing is unavailable.

## Credential admission

When Slack is enabled, OCC resolves its native environment SecretRefs through
exact same-Namespace `operate` grants. The Driver requires an `xapp-` app token
for Socket Mode and an `xoxb-` bot token, then calls `auth.test` to require a bot
and workspace identity. These [prefixes identify token roles](https://docs.slack.dev/authentication/tokens/);
the app-token check does not verify validity, scopes, or that both tokens belong
to the same app. Validation never opens a Socket Mode connection or sends a
message. HTTP mode validates the bot token; disabled accounts are skipped.

Provider calls run outside database transactions. OCC rechecks the exact
Configuration and each validated Secret's backend identity and resource version
before accepting work or creating a revision. Changed sources require a retry.
Queued provisioning validates again before runtime credential setup. This is
admission evidence, not a promise that mutable Secrets or provider permissions
cannot change after admission; runtime connectivity remains a separate check.

Role mismatch, provider rejection, temporary unavailability, missing binding,
and changed Secret errors return sanitized `CHANNEL_CREDENTIAL_*` codes with
the native field path. The Console keeps the selections and shows the error
beside the relevant selector. An unavailable provider is retryable and is not
reported as an invalid token. App credentials remain server-side throughout.

## Enable lookup in production

With production default-deny egress, set Helm `api.channelDirectoryProxyUrl` to an approved HTTP or HTTPS proxy endpoint,
for example `http://198.51.100.25:3128` after replacing the example IP and port.
The value must contain one literal IPv4 address and an explicit port, without
credentials or a path. The chart passes it to the API and worker as
`OCC_CHANNEL_DIRECTORY_PROXY_URL` and allows their Pod egress only to that IP and
port. Agent Pod egress remains separately configured.

The proxy must permit HTTP `CONNECT` to `slack.com:443`. The Driver sends its
Slack API requests through that tunnel and verifies Slack's TLS certificate.
Restrict the proxy to that destination. Keep the selected bot token in the
same-Namespace Secret; the proxy endpoint needs no token or other credential in
the Helm value. Without a reachable provider route, directory lookup and enabled-Slack
admission return unavailable; exact-ID entry cannot bypass credential admission. See the
[production controller settings](../settings/production.md) for the environment
contract.

See the [ChannelDriver contract](channel.md) for OCC authorization and
[Slack Configuration](../configuration/secrets.md#native-channel-configuration)
for gateway token bindings.
