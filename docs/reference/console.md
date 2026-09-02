# Platform console

The controller serves a read-only browser console at `/console/` on its existing
origin. Sign in, select a Namespace, and inspect accessible Agents, Providers,
and Namespaces. The console has no resource creation, editing, deployment, or
detail screens. Use the API for those supported operations.

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
Provider rows show their configured type. Rows do not open detail pages.
**Refresh** repeats the current read.

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

Supported pages are `/console/login`, `/console/agents`, `/console/providers`,
`/console/namespaces`, and `/console/settings`. `/console/` resolves the session
and opens Agents. Unknown console paths show a generic not-found page.

Static HTML, CSS, and the browser module ship inside the controller image; no
separate frontend service or build is required. Console fallback does not handle
API routes or expose controller source files. See the
[request flow](../flows/platform-console.md) and [test guide](../testing.md) for
implementation and verification.
