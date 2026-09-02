# Platform console

The controller serves a browser console at `/console/` on its existing origin.
Sign in, select a Namespace, inspect accessible Agents, Providers, and
Namespaces, create Agents from existing Configurations, and edit selected channel
settings on an Agent's saved Configuration draft. Agent deployment, rollback,
live runtime health, and Agent deletion are unavailable in the console.

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

Switching Namespace preserves the page. Agents reloads within the new scope;
Providers and Namespaces remain Installation-wide. Old rows clear immediately,
and late responses from prior navigation cannot restore them. The API makes all
authorization decisions; the selector does not broaden access.

## Create an Agent

Select **Create Agent** from the Agents page to create one Namespace-owned Agent.
The console requires an Agent name and an existing same-Namespace Configuration
ID. It can preview that exact Configuration by ID, including its generation and
native values summary, but it does not list or search Configurations. Use the API
or an operator workflow to create the Configuration first.

The form submits `POST /namespaces/:namespaceId/agents` with the selected
execution mode, optional Provider ID, and optional service account ID. Successful
creation saves the Agent draft and opens its detail page at
`/console/agents/:agentId?...&revision=draft&tab=configuration`. It does not
admit an AgentRevision, deploy a workload, or prove runtime health.

## Inspect detail, revisions, and channel drafts

An Agent detail page has two views: the saved draft and immutable
AgentRevisions. The saved draft reads the Agent's current Configuration and is
editable only through the supported channel editor. Historical and active
AgentRevisions are read-only admitted snapshots. The active revision badge points
to the Agent's current activeRevisionId, but the newest revision in history is
not necessarily active. The URL `revision=<id>` selects a specific revision; use
**Return to active revision** to inspect the active snapshot when one is present.

Read-only AgentRevision snapshots cannot be edited, rolled back, redeployed, or
used as a live-health check. Activation means the revision was admitted and
selected by OCC; the console has no live gateway health API.

The Channels tab edits Slack and Microsoft Teams settings on the saved
Configuration draft. Saving a channel change patches only `values` on the
Configuration, so existing `secretBindings` are omitted from the PATCH and
retained by the backend. The editor preserves other loaded native keys while
updating the provider block and plugin allow entry. Because a Configuration can
be shared by multiple Agents, channel edits can affect future deployments of
other Agents that reference the same Configuration.

Before saving, the browser rereads the Agent and Configuration and checks that
the Agent still points at the same Configuration generation. That detects common
stale-editor cases, but it is not atomic lost-update protection; the API accepts
the last valid writer. Refresh before retrying a conflict or uncertain save.

Slack editing supports Socket Mode settings with fixed unresolved environment
references to `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`. Microsoft Teams editing
supports application ID, tenant ID, require-mention, and a fixed unresolved
environment reference to `MSTEAMS_APP_PASSWORD`. Both channel integrations
require dedicated execution and operator-provided Kubernetes runtime projection.
Only Slack Socket Mode has live proof in the current test guide; Teams also
requires separately configured Bot Framework ingress. The simple editor may
reject native channel documents it cannot round-trip, including non-Socket Slack
settings, non-standard credential references, mixed per-channel mention settings,
or unsupported plugin shapes. In that case it shows the native JSON for
inspection and leaves editing to the API or operator workflow.

Agent deletion is unavailable in the current API, so the console cannot delete
an Agent or its revision history. The backend deletion scope remains an open
product question.

## Failures and logout

An authorized empty list is different from a failed read. Access denied,
unavailable dependencies, missing resources, and network failures clear affected
rows and offer the relevant recovery action. Include a displayed request ID when
reporting an API failure. Provider discovery shows configured IDs and types only;
see [Providers](providers.md#read-configured-providers) for its limits.

Logout immediately hides private content and stops pending reads. The console
returns to login after sign-out succeeds or a session check confirms that the
session is absent. If it cannot confirm logout, it stays on a blocking error with
Retry. Do not treat that error as confirmation that the server session was revoked.

## Routes and packaging

Supported pages are `/console/login`, `/console/agents`,
`/console/agents/new`, `/console/agents/:agentId`, `/console/providers`,
`/console/namespaces`, and `/console/settings`. `/console/` resolves the session
and opens Agents. Unknown console paths show a generic not-found page.

Static HTML, CSS, and browser modules ship inside the controller image; no
separate frontend service or build is required. Console fallback does not handle
API routes or expose controller source files. See the
[request flow](../flows/platform-console.md) and [test guide](../testing.md) for
implementation and verification.
