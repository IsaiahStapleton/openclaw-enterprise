# Agent Presets

A Preset stores reusable Agent launch settings and variables in one Namespace.
Select it when creating an Agent, fill its variables, and edit the copied settings
before saving. Editing or deleting the Preset cannot change the new Agent,
Configuration, or deployed revisions.
See [Create an Agent from a Preset](../guides/topics/agent-presets.md).

The checked-in [standard Codex Preset](../guides/topics/standard-codex-preset.md)
uses this same API and chooser. Install it manually or enable the
[Installation defaults](#installation-defaults); its native sandbox settings do not establish Pod-wide egress isolation.

## Installation defaults

The trusted Installation YAML can include bundled Presets and JSON files:

```yaml
presets:
  includeDefaults: true
  files:
    - presets/devday.json
    - presets/devday-partners.json
```

`includeDefaults: true` seeds `default-codex`, **Standard Codex**, and **Standard OpenClaw**.
Omitting it or setting it to `false` disables bundled seeding; explicit
`files` still load. Each JSON file contains one
`{ "name": "...", "template": { ... } }` object. Relative file paths resolve beside
the Installation YAML, independent of the process working directory; absolute
paths are also supported. Mount the files readably for both the API and worker.
Missing, malformed, invalid, or duplicate-name definitions prevent startup.
Files are read at startup, not watched. API startup adds missing defaults to existing ready or
provisioning Namespaces, including the bootstrap Namespace. New Namespace
creation includes the same defaults atomically. Startup skips failed or deleting Namespaces.

Each copy is an ordinary Namespace-owned Preset with its own ID and normal
read/update/delete permissions. Matching names are preserved without comparing
or overwriting their templates. Startup can restore a deleted or renamed
default while enabled; bundle updates do not replace existing copies. Removing the files and disabling
`includeDefaults` stops seeding and leaves saved Presets and Agents unchanged.
Restart the API after changing the YAML, keeping the worker configuration in sync.

Startup selects a persisted Principal authorized to administer the Installation
and requires `preset:create` wherever defaults are missing. Namespace
creators likewise need `preset:create` when this option is enabled. Authorization
or template validation failure rolls back initialization and prevents startup
or Namespace creation. The selected Configuration Driver validates native
values; seeding does not create workloads or credentials.

## Configuration inventory

These are the seven shipped JSON definitions in `deploy/presets/`. Installed
same-name copies can differ; read the Namespace Preset and the Agent's saved
Configuration to inspect actual settings. Presets contain OpenClaw configuration,
including the Codex plugin's app-server options; none supplies a standalone
Codex `config.toml` or a reasoning-effort override.

| Preset / file                                                                           | Agent and credential                                                            | OpenClaw gateway and tools                                                                                          | Codex app-server policy                                                                               |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`default-codex`](../../deploy/presets/default-codex.json)                              | Dedicated; choose name, model, and API key or service account token in the form | Local/LAN; Control UI enabled for loopback origins; Chat Completions enabled; browser/web/elevated settings omitted | Guardian WebSocket; `on-request`; `read-only`; reviewer and network proxy omitted                     |
| [**Standard Codex**](../../deploy/presets/standard-codex.json)                          | Dedicated; name/model variables and masked API key                              | Standard gateway/tool policy below; cached Codex search                                                             | Guardian WebSocket; `on-request`; `workspace-write`; reviewer `user`; limited workspace network proxy |
| [**Standard OpenClaw**](../../deploy/presets/standard-openclaw.json)                    | Embedded; name/model variables and masked API key                               | Standard gateway/tool policy; web search enabled without the Codex override                                         | None: native OpenClaw, no Codex plugin                                                                |
| [`SWE Agent` / `devday.json`](../../deploy/presets/devday.json)                         | Dedicated; name/model variables; model defaults to `gpt-6-astra`; `codex_pat`   | Standard Codex settings plus Slack and workspace instructions                                                       | Same as Standard Codex, except `approvalPolicy: never`                                                |
| [`Q&A Agent` / `devday-qa.json`](../../deploy/presets/devday-qa.json)                   | Same as SWE Agent                                                               | Same as SWE Agent, including its instructions                                                                       | Same as Standard Codex, except `approvalPolicy: never`                                                |
| [`Oncall Agent` / `devday-oncall.json`](../../deploy/presets/devday-oncall.json)        | Same as SWE Agent                                                               | Same as SWE Agent, including its instructions                                                                       | Same as Standard Codex, except `approvalPolicy: never`                                                |
| [`Community Agent` / `devday-partners.json`](../../deploy/presets/devday-partners.json) | Same model/auth defaults as SWE Agent                                           | Codex; Control UI enabled; community Slack channels and instructions; DMs disabled                                  | Same as Standard Codex, except `approvalPolicy: never`                                                |

### Plain console default

**Start with default Preset** reads the authorized `default-codex` copy in the
selected Namespace. Its shipped template has no variables, model, name, or
credential; the ordinary form collects them. An operator-customized copy with
variables opens the variable chooser first. Missing or unreadable defaults
disable quick-start; other readable Presets remain selectable. Install the file
through `includeDefaults`, `presets.files`, or Preset POST to enable it.

The shipped default file also supplies the console's shared configuration base
for empty templates, **Reset template**, and provider/Harness switches. It replaces
the former inline starter. The installed copy supplies initial draft settings;
normal field edits preserve unrelated settings, while **Reset template** explicitly
returns to the shipped base with the selected model. No installed credential or
private template is exposed by the public shared-default asset.

### Standard harness presets

The standard gateway policy is local mode, LAN binding, Control UI disabled, and
an environment reference to `OPENCLAW_GATEWAY_PASSWORD`. Browser, elevated tools,
and web fetch are explicitly disabled; web search is enabled. Neither standard
file explicitly enables Chat Completions.

All Codex presets route `codex/<model>` through `agentRuntime.id: codex`, a
fail-closed `openai-responses` provider at `http://127.0.0.1:9`, and the Codex
plugin. The plain form adds this routing after model selection. Guardian
WebSocket transport uses `${APP_SERVER_URL}` and `${APP_SERVER_TOKEN}` at runtime.
OpenClaw instead routes `openai/<model>` through `agentRuntime.id: openclaw` and
`https://api.openai.com/v1` with `openai-responses`.

The standard Codex network proxy enables the `workspace` base profile in
`limited` mode. Its nine allowed build domains and disabled proxy/socket escape
options are listed in the [standard Codex guide](../guides/topics/standard-codex-preset.md#build-network-allowlist).
Cached search uses `tools.web.search.openaiCodex.mode: cached`.

Omitted fields inherit the selected native runtime's defaults; omission does
not establish a particular reviewer, network policy, or tool permission. Compute
adds managed identity, authentication, transport, and placement settings, while
selected Plugin and Sandbox Drivers can supply additional runtime configuration.
The [Harness contract](harness-execution.md) and
[standard policy boundary](../guides/topics/standard-codex-preset.md) explain those
limits. A saved template does not prove live Codex policy enforcement.

## DevDay custom presets

[`SWE Agent`](../../deploy/presets/devday.json) is based on
**Standard Codex**, uses `approvalPolicy: never`, and adds Slack Socket Mode.
It uses the Codex harness with **Service Accounts** authentication (`codex_pat`).
All four DevDay presets expose only `name` and `model` variables; `model` defaults
to `gpt-6-astra` and remains editable. After **Use Preset**, choose an existing service account Secret or
**Create new Secret...** before creating the Agent.
DevDay files are opt-in through `presets.files`; `includeDefaults` does not load them.

[`Community Agent`](../../deploy/presets/devday-partners.json) uses the SWE
runtime with Control UI enabled and community instructions. It checks Linear
when available and uses other sources if access fails. Direct messages are disabled.

[`Q&A Agent`](../../deploy/presets/devday-qa.json) and
[`Oncall Agent`](../../deploy/presets/devday-oncall.json) copy the entire SWE Agent
template, including Slack and workspace instructions. Uncomment desired files in the example Installation YAML.

SWE Agent, Q&A Agent, and Oncall Agent prefill these channels:

| Channel           | ID            |
| ----------------- | ------------- |
| oce-feedback      | `C0C49E7CS4A` |
| oce-team          | `C0C43A2QA11` |
| oce-feedback-test | `C0C569NN9ME` |
| oce-team-test     | `C0C4A0JH2BG` |

Community Agent prefills its own channel list:

| Channel            | ID            |
| ------------------ | ------------- |
| oce-team           | `C0C43A2QA11` |
| oce-team-test      | `C0C4A0JH2BG` |
| oce-community      | `C0C5KF0JLSC` |
| oce-community-test | `C0C5KF0DWLQ` |

In the Console, choose **SWE Agent**, fill its variables, and use **Edit Slack** to
choose allowed senders and bind Slack app/bot Secrets. Presets allow all channel members (`users: ["*"]`)
without requiring mentions. Narrow the sender list if needed. Files contain no credentials.
Workspace instructions in `template.agent.initialWorkspaceFiles.AGENTS.md` include
draft decisions. `{{vars.name}}` expands when applying the Preset; later name edits
do not re-render the copied file.
To revise them, update that content and the existing Namespace Preset through the API. Restarting with a changed
JSON file preserves already-installed same-name copies.

## Contents

A Preset has `id`, `namespaceId`, a Namespace-unique `name`, `template`, and
`createdAt`. OCC assigns the ID, Namespace, and creation time. An empty template
is valid. Its optional fields are:

| Field                          | Purpose                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `variables`                    | Named scalar inputs, their types, descriptions, and optional defaults.                                    |
| `agent.name`                   | Suggested Agent name; the saved Agent still needs a unique name.                                          |
| `agent.executionMode`          | Embedded or dedicated execution.                                                                          |
| `agent.backendId`              | Installation-configured Backend ID, or null.                                                              |
| `agent.harnessAuth`            | Auth method default, credential binding, password variable token, or null; never stored credential bytes. |
| `agent.initialWorkspaceFiles`  | Optional creation-time workspace contents keyed by supported filename.                                    |
| `agent.plugins`                | Desired plugin selections and policies.                                                                   |
| `configuration.values`         | Native Agent Configuration JSON, including models, Harness settings, channels, and sandbox settings.      |
| `configuration.secretBindings` | Bindings to Secrets in this Namespace.                                                                    |

These use the existing [Agent](agents.md) and [Configuration](configuration.md)
contracts. Installation-owned Driver selection, generated identities, runtime
state, and Agent revision IDs are not template settings. A supplied
`configuration.values` replaces the console's starter JSON; it does not merge
with it. Omitted settings use the form's normal defaults.

## Workspace files

`template.agent.initialWorkspaceFiles` is a partial map for `AGENTS.md`, `SOUL.md`,
`IDENTITY.md`, and `USER.md`. Values must be valid Unicode strings without NUL,
at most 16 KiB of UTF-8 per file. Limits also apply after variable expansion.
Omitted files keep the Console defaults; an explicit empty string creates an
empty file. Users can review and edit the rendered contents in **Advanced settings →
Workspace files** before creation. Password variables are not allowed in files.

For example, add this within `template.agent`:

```json
{
  "initialWorkspaceFiles": {
    "IDENTITY.md": "# Identity\nName: {{ vars.name }}\n",
    "USER.md": ""
  }
}
```

The ordinary Agent/provisioning APIs stage these contents for first deployment.
Preset files embed workspace contents; they do not read arbitrary workspace paths.

## Variables

Declare variables inside `template.variables`, then refer to them with
`{{ vars.name }}` in a launch-setting string. For example:

```json
{
  "variables": {
    "name": { "type": "string", "description": "Agent name" },
    "model": { "type": "string", "default": "openai/gpt-5.1" }
  },
  "agent": { "name": "{{ vars.name }}", "executionMode": "embedded" },
  "configuration": {
    "values": { "agents": { "defaults": { "model": "{{ vars.model }}" } } }
  }
}
```

This is a partial template, not a complete deployment configuration. Add the
native settings and credentials required by your Installation before deploying.

- Names match `[A-Za-z_][A-Za-z0-9_]*`. Types are `string`, `number`, `boolean`, and
  `password`; numbers must be finite. Optional `description` text labels inputs.
- A default must have the declared type. An omitted input uses its default;
  explicit `false`, `0`, and an empty string override defaults. Referenced
  variables without a default need an input. Unknown names and wrong types fail.
- A token occupying the entire string retains its scalar type. A token inside
  a longer string requires a string variable. For example, `"{{ vars.count }}"`
  can become a JSON number; `"worker-{{ vars.name }}"` stays a string.
- Object keys inside `configuration.values` can use string variables, including
  model catalog keys. Two keys that render to the same name are rejected.
  Other schema field names cannot be variables.
- Rendering makes one pass over JSON. Quotes in an input remain data, and input
  values are not evaluated again. There are no expressions, filters, loops,
  environment lookups, or Secret reads. Malformed `vars.` expressions fail.
- Other placeholders, including `${NAME}` and unrelated `{{ ... }}` text,
  remain literal. To preserve a Preset token itself, prefix it with a backslash:
  JSON `"\\{{ vars.name }}"` renders as literal `{{ vars.name }}`.

Password variables are masked string inputs with no stored default. They may
appear only as a whole token in `agent.harnessAuth.secret`, with method
`api_key` or `codex_pat`, for example:

```json
{
  "variables": { "modelSecret": { "type": "password" } },
  "agent": {
    "harnessAuth": { "method": "api_key", "secret": "{{ vars.modelSecret }}" }
  }
}
```

A method-only `agent.harnessAuth`, such as `{ "method": "codex_pat" }`,
preselects authentication without supplying credentials. The creation form still
requires a Secret selection; a concrete Agent requires a complete credential binding.

For the password variable bound to authentication, the Console offers **Create new Secret**
or **Use existing Secret**. Existing mode lists readable Secret metadata from the
current Namespace and uses the selected reference without fetching its value.
Switching modes clears any entered token. The saved Preset remains unchanged.

In new mode, **Use Preset** carries the entered value into the form's masked credential input.
**Create Agent** creates a Secret in the current Namespace, then uses its reference
for Agent authentication and grants the Agent access through the ordinary creation
flow. The value never belongs in Preset storage, Agent JSON, or Configuration JSON.
API clients rendering this form must likewise create a Secret and replace `secret`
with `source: <SecretRef>` before submitting an ordinary Agent request. Rendering
alone does not create resources. Existing mode reuses the selected Secret and
grants this Agent exact access through the same creation flow. Partial saves
follow normal creation recovery; retrying credential access does not recreate the Agent.

String variables can still supply existing credential reference IDs.
[SecretRefs](configuration/secrets.md) remain structured, unresolved references;
ordinary Namespace and credential permissions still apply. In Preset write requests,
`agent.harnessAuth.source` and `configuration.secretBindings.*.source` may omit
`namespaceId`. OCC fills it from the request's Namespace before validating and
storing the template. A supplied Namespace is still validated; an explicit
cross-Namespace reference is rejected. This shorthand applies only to Preset
writes; ordinary Agent and Configuration APIs require complete references.

The template and
rendered JSON each have a 1 MiB size limit and a maximum depth of 64.

## CRUD and permissions

The collection path is `/namespaces/:namespaceId/presets`; an exact Preset adds
`/:presetId`. Use the [generated API reference](api.md#presets) for full schemas
and response envelopes.

| Request                                            | Result                  | Required permission                          |
| -------------------------------------------------- | ----------------------- | -------------------------------------------- |
| `POST` collection with `{name, template}`          | `201`, created Preset   | `preset:create` on the Namespace collection. |
| `GET` collection                                   | `200`, readable Presets | `preset:read` checked on each candidate.     |
| `GET` exact Preset                                 | `200`, Preset           | `preset:read` on that Preset.                |
| `PATCH` exact Preset with `name` and/or `template` | `200`, updated Preset   | `preset:update` on that Preset.              |
| `DELETE` exact Preset                              | `204`                   | `preset:delete` on that Preset.              |

An included `template` replaces the whole template, including variable
definitions; omitted fields stay unchanged. Writes check the template structure,
variable syntax and default types, credential-binding structure, known
cross-Namespace credential references, and credential literals at their native
use sites. Ordinary launch-field errors, such as an invalid execution mode or
plugin policy, can remain in a saved Preset. The console checks values needed
to populate its form; the existing creation APIs validate completed settings.
The selected
[Configuration Driver](drivers/configuration.md#optional-validation) must support
value validation when a template contains `configuration.values`.

Fresh native-IAM bootstrap includes Preset CRUD permissions. On existing
Installations, the upgrade adds those four permissions only to the unchanged
built-in Installation administrator Role: its ID has the `role_admin_` UUID
format, its name is exactly `Installation administrator`, it has no Namespace,
and its permissions are exactly the 26 original grants, in any order.

Custom, renamed, reduced, or extended Roles retain their grants. Their IAM policy
owner must explicitly grant Preset access; rerunning bootstrap does not change
stored Roles. The public Namespace policy API supports exact-Preset access, but
cannot edit an Installation Role or grant collection-wide `create`.

Preset access grants no permission to create Agents or use referenced Secrets.
After rendering, Configuration and Agent creation enforce their existing schemas,
credential rules, and authorization before saving. Deployment rechecks admission.
The console performs rendering and form checks first; these do not replace server
validation. Audit records omit templates and variable values.

Invalid inputs return `400`; denied access returns `403`; a missing exact target
returns `404`; duplicate names or lifecycle conflicts return `409`; unavailable
IAM, persistence, or required Driver capability returns `503`. Delete Presets
before deleting their Namespace. Deleting one removes its resource-scoped IAM
bindings, but keeps copied Agents, Configurations, and credential sources.

## Limits and recovery

Presets are managed through the HTTP API; the console only selects and applies
them. There are no Preset CLI commands, inheritance, version history, or Agent
metadata recording which Preset was used. Creation still saves a Configuration
and an Agent separately. Follow [partial-save recovery](console/create-and-deploy.md#create-an-agent)
if the second save fails or a response is lost.

A Preset is read once when selected. **Use Preset** renders its variables and
opens an ordinary editable Agent form. The chooser closes; changing the draft
does not update or reread the Preset. Before saving, **Start over** discards the
unsaved draft and returns to the chooser. Restart is disabled once a Configuration
has saved or a save outcome is uncertain. The saved Configuration remains available for recovery
if Agent creation fails.

A valid Preset is not necessarily a valid Agent configuration. A later Agent
validation error can leave a saved Configuration; follow the recovery steps
above. Later deployments read the Agent's own draft. Credential rotation retains
its normal behavior.
