# Platform console

The controller serves a browser console at `/console/` on its existing origin.
Sign in, select a Namespace, inspect accessible Agents, Providers, and
Namespaces, create Agents with editable Configuration JSON and Slack/Teams settings,
edit channel drafts, provision initial runtime credentials, deploy saved drafts, and read or replace supported live workspace files. Rollback,
live runtime health, and Agent deletion are unavailable in the console.
The [deployment guide](../guides/deploy.md) owns runtime checks and operator
procedures; the [generated API reference](api.md) owns supported management API
shapes. Browser chat is not exposed by this console.

## Start and sign in

Start the controller through the [quickstart](../guides/quickstart.md#open-the-platform-console)
or [deployment guide](../guides/deploy.md#open-the-platform-console), then visit
`/console/`. **Username** means your provisioned account email. Enter its password
and select **Login**. Public signup, SSO, and password recovery are unavailable.

The console uses the existing [email/password session contract](authentication.md).
The browser sends cookies to the same origin; it does not store tokens or accept
service keys. Production retains secure cookies and the internal API network
boundary. Visiting a page or using browser Back checks the current session before
showing private content. Expiry clears the view and asks you to sign in again.

## Browse and select a Namespace

The sidebar opens **Agents**, **Providers**, or **Namespaces**. Lists show names
and selectable IDs. Namespace rows include their server lifecycle status;
Provider rows show their configured type. Agent rows open detail pages. Provider
and Namespace rows remain read-only collection entries. **Refresh** repeats the
current read.

| Page       | Scope and permission                                                     |
| ---------- | ------------------------------------------------------------------------ |
| Agents     | Selected Namespace; Namespace `read`, then exact Agent `read` filtering. |
| Namespaces | Installation-wide collection filtered by exact Namespace `read`.         |
| Providers  | Installation-wide configured inventory; Installation `administer`.       |

Use the bottom **OpenClaw Enterprise** menu for **Namespace**, **Settings**, or
**Logout**. The Namespace submenu supports pointer, touch, and keyboard use;
arrow keys move within menus and Escape closes them. A narrow viewport exposes
the same actions through the navigation drawer. Settings shows the signed-in
account and a return link; it contains no configurable settings.

The selected Namespace stays in `?namespace=<id>` across pages, reload, and Back.
Without an explicit selection, the console chooses the first readable `ready`
Namespace, otherwise the first readable Namespace, sorted by name then ID.
An explicit ID that is no longer readable shows **Namespace unavailable** and
requires another selection. With no readable Namespaces, Agents explains that
administrator provisioning or access is needed; global pages remain available.

Switching Namespace from Agent detail or creation returns to the Agents list in
the new scope. Global pages stay open; Providers and Namespaces remain
Installation-wide. Old rows clear immediately,
and late responses from prior navigation cannot restore them. The API makes all
authorization decisions; the selector does not broaden access.

## Agent creation and deployment

The console creates an Agent and its reusable Configuration, provisions supported initial runtime credentials, and deploys the saved draft. Follow [Create and deploy Agents](console/create-and-deploy.md) for the complete workflow, channel constraints, and recovery after partial or uncertain writes.

## Inspect detail, revisions, and channel drafts

An Agent detail page has two views: the saved draft and immutable
AgentRevisions. The saved draft reads the Agent's current Configuration and is
editable only through the supported channel editor. All AgentRevisions are
read-only admitted snapshots. **Selected revision** displays the Agent's current
`activeRevisionId`; neither the newest admitted revision nor the snapshot being
viewed must match it. The URL `revision=<id>` chooses a snapshot to inspect. Use
**View selected revision** to return to the Agent's selected snapshot.

Read-only AgentRevision snapshots cannot be edited, rolled back, redeployed, or
used as a live-health check. Activation means the revision was admitted and
selected by OCC; the console has no live gateway health API. Detail pages
explicitly show **Serving status unavailable**, including when a revision is
selected. There is no observation time, generation, serving revision, failed
activation, or shutdown outcome in the current Agent API response. The console
does not infer these from selection or admission. Follow the
[deployment guide](../guides/deploy/production-agents.md#configure-the-agent-runtime) and
[Agent deployment reference](agents/deployment.md#revisions-and-deployment) for the
installed runtime.

The Channels tab edits Slack and Microsoft Teams settings on the saved
Configuration draft. Saving a channel change patches only `values` on the
Configuration, so existing `secretBindings` are omitted from the PATCH and
retained by the backend. The editor preserves other loaded native keys while
updating the provider block and enabling its plugin. An existing plugin allowlist
is extended; an omitted allowlist stays omitted. Because a Configuration can
be shared by multiple Agents, channel edits can affect future deployments of
other Agents that reference the same Configuration.

Before saving, the browser rereads the Agent and Configuration and checks that
the Agent still references the same Configuration and its generation is unchanged.
These are separate reads; a later concurrent change can still race the PATCH.
Refresh before retrying a conflict or uncertain save.
An unconfirmed PATCH shows **Outcome unknown**, closes the editor, and disables
channel writes until Refresh loads current saved state. The write may have
succeeded; there is no automatic replay. **Disable Slack** and **Disable
Microsoft Teams** edit only the draft. They do not disable access, stop execution,
or change an admitted revision.

Slack editing preserves existing per-channel user restrictions. **Allowed user IDs**
controls the direct-message allowlist. Editing supports Socket Mode settings with fixed unresolved environment
references to `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`. Microsoft Teams editing
supports application ID, tenant ID, require-mention, and a fixed unresolved
environment reference to `MSTEAMS_APP_PASSWORD`. Both channel integrations
require dedicated execution and Kubernetes runtime projection. Initial Slack credentials
can be provisioned in the console; Teams credentials remain operator-provided.
Only Slack Socket Mode has live proof in current
[Slack testing](../testing/slack.md); Teams also requires separately configured
Bot Framework ingress. The simple editor may reject native channel documents it
cannot round-trip, including non-Socket Slack settings, non-standard credential
references, mixed per-channel mention settings, or unsupported plugin shapes.
The native Configuration view remains available for inspection; unsupported
settings require the API or operator workflow.

Agent deletion is unavailable in the current API, so the console cannot delete
an Agent or its revision history. The backend deletion scope remains an open
product question.

## Failures and logout

An authorized empty list is different from a failed read. Access denied,
unavailable dependencies, missing resources, and network failures clear affected
rows and offer the relevant recovery action. Include a displayed request ID when
reporting an API failure. Provider discovery shows configured IDs and types only;
see [Providers](providers.md#read-configured-providers) for its limits.
Backend error text is not rendered. Failure messages use local reason classes,
and request IDs are restricted to the server’s bounded `req_` identifier format.
A current protected `401` immediately clears all private content and closes an
open channel editor, even when a sibling read remains pending. Earlier page
responses cannot restore the view or expire a newer session.

Logout immediately hides private content and stops pending reads. The console
returns to login after sign-out succeeds or a session check confirms that the
session is absent. If it cannot confirm logout, it stays on a blocking error with
Retry. Do not treat that error as confirmation that the server session was revoked.

## Edit workspace files

Open **Workspace files** on an Agent to load `AGENTS.md`, `SOUL.md`, `IDENTITY.md`,
and `USER.md`. This view reads the live Agent workspace independently of the
Configuration draft or browsed AgentRevision. It requires an active revision and
reachable gateway; selection alone does not prove access. Files remain in the
Agent workspace and are never copied into a Configuration or revision.

Each file has its own **Save** and **Reload** action. A save creates or replaces
only that file through the [workspace file API](agents.md#workspace-files).
The editor enforces the API's 16 KiB UTF-8 and Unicode limits. A missing file can
be created; other failed reads keep editing disabled. Agent `read` permits
loading, while `operate` is required to save. Reload replaces unsaved edits with
the current file. Workspace writes have no version check; the last writer wins.

A failed write preserves the editor contents. An unknown outcome disables that
file's Save action until a successful reload, so an uncertain write is never
replayed automatically. Review the loaded contents before deciding whether to
write again. Files load and save independently; success for one file says
nothing about another file's result. For unavailable gateways, follow the
[workspace access setup](../guides/deploy/workspace-routing.md#agent-workspace-files).

## Routes and packaging

Supported pages are `/console/login`, `/console/agents`,
`/console/agents/new`, `/console/agents/:agentId`, `/console/providers`,
`/console/namespaces`, and `/console/settings`. `/console/` resolves the session
and opens Agents. Unknown console paths show a generic not-found page.

Static HTML, CSS, and browser modules ship inside the controller image; no
separate frontend service or build is required. Console fallback does not handle
API routes or expose controller source files. See the
[request flow](../flows/platform-console.md) and
[local testing](../testing/local.md) for implementation and verification.
