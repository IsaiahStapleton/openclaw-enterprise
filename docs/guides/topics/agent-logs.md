# View Agent runtime status and logs

The **Logs** tab on an Agent version shows its Pods, restarts, recent Kubernetes
Events and a bounded, redacted page of container output or, for OpenShell
sandboxed Agents, sandbox policy decisions. Use it to find out why a
version crashes, restarts or stops serving. Nothing is stored on the server: each
read fetches one page from the cluster through the Compute Driver.

Runtime status and logs are available for **Kubernetes Compute** only. Docker and
SSH Compute, and Drivers that own their runtime logging (`runtimeLogging:
"driver"`), answer `501 NOT_IMPLEMENTED`.

## Open the Logs tab

1. Open the Agent and select a deployed version. The editable draft is not a
   version and has no runtime; a version without a running Pod shows no Pod.
   When the latest deployment failed, **Deployment activity** links straight to
   that version's Logs tab.
2. Select **Logs**. The runtime strip refreshes every 10 seconds. Each Pod card
   lists its recent warning Events, prefixed with the container they concern.
3. Choose a **Source**: **Gateway** (the OpenClaw Gateway container) or
   **Agent (Harness)** (the dedicated Codex or OpenClaw Harness container, only
   for dedicated execution), or **Sandbox (policy decisions)** (see
   [Sandbox source](#sandbox-source)). Choose a **Pod** when a version has more
   than one. While no Harness Pod is ready, the Gateway logs failed
   connections to it (`ECONNREFUSED`); the console then points you to the
   **Agent (Harness)** source, which holds the cause, such as a failed model
   probe, or to Deployment activity when the Harness Pod does not exist yet.
4. Select **Follow** to poll for new lines every 2 seconds. Following pauses while
   the browser tab is hidden or you scroll up, and stops after a permission denial.
5. Select **Previous instance** after a restart to read the output of the
   container that exited. Following is off for the previous instance.

### Filter the loaded output

The level chips (**error**, **warn**, **info**, **debug**, **unknown**) and the
**Filter** box narrow the rows already loaded in this view: up to 5000 rows of
the current page and later follow polls. The text filter is case-insensitive and
matches the message, kind, subsystem and field values. Filters never ask the
server for more output and do not search the whole container log; to look
further back, use **Download** or the CLI with `--since`. Gap and withheld rows
stay visible while filtering, so hidden loss is never filtered away.

### Download

**Download** saves the last 1000 lines of the selected source, Pod and instance
as a text file named `<agent>-<revision>-<source>-<pod>.log`, using IDs. The
file holds the same classified and redacted records as the page, one per line
(`TIME LEVEL KIND [SUBSYSTEM] MESSAGE key=value`, plus `GAP` and `WITHHELD`
rows), after a `#` header naming the Agent, revision, Pod and container.
Filters do not apply to the download. Each download is a separate audited read;
nothing is kept on the server. The saved file stays on your device, and
redaction is best-effort, so handle it as sensitive and delete it when done.

The HTTP API has the same two reads:

```sh
GET /namespaces/{namespaceId}/agents/{agentId}/deployments/{revisionId}/runtime
GET /namespaces/{namespaceId}/agents/{agentId}/deployments/{revisionId}/runtime/logs?source=gateway&tailLines=200
```

`runtime/logs` accepts only `source` (`gateway`, `agent` or `sandbox`), `pod`, `previous`,
`tailLines` (1 to 1000, default 200), `sinceSeconds` (1 to 86400), `cursor` and
`download`. Pass the returned `cursor` to read only newer lines of the same view.
`download=true` answers `text/plain` with `Content-Disposition: attachment`,
always reads 1000 lines, and cannot be combined with `cursor` (`400`). See the
[API reference](../../reference/api.md).

## Command line

`occ agent runtime AGENT_ID` prints the Pods, sources and Events (with the
container each concerns); `occ agent logs
AGENT_ID --source gateway` prints one page, and `--follow` keeps polling every
2 seconds until Ctrl-C:

```sh
occ agent logs agt_... --source gateway --since 10m --follow
occ agent logs agt_... --source agent --previous -o json
occ agent logs agt_... --source sandbox --follow
```

Both use the active revision unless you pass `--revision`. An Agent with no
active revision, such as one whose first deployment failed, uses the latest
revision and says so on stderr. Gaps and withheld
counts are printed to stderr as notices; `-o json` prints NDJSON records. The
command waits out `429` responses and exits nonzero on `501` and `503`. See the
[CLI reference](../../reference/cli.md#runtime-status-and-logs).

## Who can see what

| Read                                                                       | Required grants                                       | Audited                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| Runtime status: Pods, phase, readiness, restarts, last termination, Events | Agent `operate` and `read`, and `read` on the version | No, like [diagnostics](../../reference/agents.md)         |
| Log text                                                                   | Agent `read_logs` or `administer`, and Agent `read`   | Once per view as `openclaw.agents.runtime_logs.view`      |
| Log download                                                               | Same as log text                                      | Every download as `openclaw.agents.runtime_logs.download` |

Installation administrators hold Agent `administer`. The same principals can
already open the [native admin UI](../../reference/agent-native-admin.md), whose
Logs page shows Gateway log text. To let someone read logs without that
access, bind a Namespace Role with Agent `read_logs` and `read` to the exact
Agent. It covers every version of that Agent, including later deployments.
Runtime status still needs `read` bound to each exact version. A `read_logs`
Restriction blocks log text for everyone, administrators included. Without
`operate`, the Logs tab shows no runtime strip and no Pod picker: it offers
every source, reads the source's current Pod, and says so when this version
lacks a source. Service principals may call both routes under the same grants.
Every request, including each follow poll, is authorized again, so revoking a
grant stops the next poll. See
[authorization](../../reference/authorization.md).

## What the output contains

OCC classifies every line against an allowlist of operational output before
returning it:

- **wrapper**: runtime startup and model-probe events, with fixed fields only.
  The wrapper's fixed plain line
  `Harness model authentication probe failed.` is also a wrapper `error`. A
  line's `code` field shows on the collapsed row.
- **openclaw**: Gateway JSON console records (level, subsystem, message and a
  short list of operational fields such as `status`, `method` and `durationMs`).
  Payload keys such as `prompt`, `content`, `messages`, `args` and `headers` are
  dropped.
- **codex**: Codex tracing records (level, target, message). The start and end
  of a Codex turn read `turn started` and `turn completed` (info, with `model`,
  `turn_id`, token counts and `busy` time); a completed tool call keeps
  `tool_name`, `turn_id` and `total_duration_ms`. Other span records are
  `debug`, such as `span close fs.read_file`; hide them with the **debug** chip.
  Unless the version was deployed with `logging.level: debug`, the Harness
  drops Codex's span `enter` and `exit` records, the readiness probe's local
  connections (`websocket client connected`) and repeats of the remote-control
  preference retry (kept once per 10 minutes) before they are written, so a
  page covers minutes of output, not seconds.
- **text**: plain lines up to 4 KiB, including lines that start with a bracketed
  component tag such as `[node-host] advertised commands: ...`.

Any other structured output, including Codex JSON-RPC protocol traffic, is
**withheld**: the page shows a count, never the content. Oversized lines, and
malformed lines that start like a JSON object or array, are withheld the same way,
and so is a pretty-printed (multi-line) JSON value: its opening line, every member
line and its closing line become one withheld row.

Every retained string is then redacted. OCC replaces PEM blocks, `Authorization`
and cookie header values, `Bearer` tokens, JWTs, known token prefixes (`sk-`, `ghp_`, `ghs_`,
`github_pat_`, `xoxb-`, `AKIA` and others), URL user information, every URL
query value and fragment, `password=`/`token:`/`"api_key":`-style values, and
long base64 or hex runs with `[redacted:<pattern>]`. A PEM block printed over
several lines is masked from an observed BEGIN through END, including across
follow polls in the same container view. Ordered lines newer than the prior cursor
frontier can close a carried block at END or the first line that is not base64,
a PEM header or blank. BEGIN and END on one ordered page can therefore close at
the same timestamp if it is newer than that prior frontier. Replayed overlap and
timestamps at or before the prior frontier do not establish forward progress.
Missing, invalid or out-of-order times cannot close a block known to be open.
PEM-shaped lines may stay masked conservatively for the rest of that view, while
ordinary operational text stays visible. A restart, Pod
change, expired cursor or new view starts without the old masking context.
An initial tail or older cursor may begin inside a block whose BEGIN was never
seen; the reader cannot reconstruct that missing history. Redaction is best-effort
pattern masking: an opaque token under 40 characters with no known prefix and no
key name or `Bearer` next to it stays visible. Do not rely on redaction to make
a runtime that prints secrets safe.
Control characters are removed and messages are capped at 8 KiB.

Kubernetes Event messages in the runtime status are redacted the same way, and
node names, image references and Secret and ConfigMap names are masked in the
standard scheduler and kubelet messages. Other Event text can still name cluster
objects.

Container lines carry `contentClass: "operational"`; sandbox lines carry
`activity`. The `content` class (message text, prompts, tool output) is reserved
and never returned.

## Gaps, limits and retention

A page never silently skips output. It labels what it could see:

| Row                 | Meaning                                                            |
| ------------------- | ------------------------------------------------------------------ |
| Container restarted | The Pod or container instance changed since the last page.         |
| Lines skipped       | New output exceeded one page between polls.                        |
| View resumed        | The cursor was older than one hour; reading restarted at the tail. |
| Page limit reached  | The page hit its byte limit; later lines were not read.            |
| Sandbox buffer lost | The sandbox buffer no longer holds the lines after the last page.  |

Limits per request: 1000 lines, 1 MiB read from the cluster, 32 KiB per input
line, 512 KiB per response, 100 Events per Pod, 10 seconds overall. Each API
replica allows each principal 2 requests per second per Agent with a burst of
10 (`429` with `Retry-After`) and 16 concurrent reads (`503`). The limit and the
operator switch are checked before authorization, so a caller without grants can
spend only its own budget and learns only whether the feature is on.

Kubernetes keeps only the current and the previous instance of each container.
Output from deleted Pods and older restarts is gone. For history, use your
[observability backend](../observability.md).

## Sandbox source

When the Agent's version runs in an [OpenShell sandbox](../../reference/drivers/openshell-sandbox.md),
the **Sandbox** source shows what the OpenShell gateway recorded for that
sandbox: network and HTTP policy decisions (allowed or denied, destination,
method, binary, policy name and engine, denial reason), process launches, and
supervisor tracing. The Harness's own output inside the sandbox is not
available; OpenShell has no read-only API for it.

- OCC derives the sandbox from the version. The source has no Pods and no
  previous instance (`pod` or `previous=true` answers `400
RUNTIME_LOGS_POD_INVALID`).
- Lines are kind `sandbox` with `contentClass: "activity"`. Kept fields:
  `activity`, `action`, `disposition`, `dst_host`, `dst_port`, `method`, `path`,
  `binary`, `pid`, `rule_name`, `rule_type`, `policy_generation`, `reason`,
  `source`, `cmd_line` and `url`. Command lines and URLs often carry tokens:
  they are redacted like every string and cut to 1 KiB. In command lines the
  value after a credential flag is masked too (`-p`, `-pass`, `--pass`,
  `--token`, `--with-token`, `--username`, `-u`, `--user`, `-U` or
  `--proxy-user` with `user:password`, `smbclient -U user%password`,
  `lftp -u user,password`, `redis-cli -a`, `sqlcmd -P`, and the token of
  `vault login`). Masking is best effort: a secret passed
  under another flag name can still show. A message that holds structured data
  is withheld.
- OpenShell keeps the last 2000 lines per sandbox in memory and loses them when
  its gateway restarts. A follow poll that finds its last line gone reports
  **Sandbox buffer lost** or **Lines skipped**. Lines the sandbox drops under
  load are not reported.
- The sandbox stamps its lines when it records them and sends them in batches,
  so a line can arrive after a newer one was shown. A follow poll re-reads the
  5 seconds before the newest line it showed and shows each line once, repeats
  included. A line that arrives more than 5 seconds late, or behind more than
  48 lines in those 5 seconds, can be missed. When more than 48 lines share one
  millisecond, the poll shows **Lines skipped** at that time.
- OCC reads through the read-only `GetSandboxLogs` call. Its OpenShell identity
  needs the `sandbox:read` scope and Workspace role `user`; without the scope
  the read answers `503 RUNTIME_LOGS_CLUSTER_RBAC`. OpenShell hides a sandbox
  from an identity outside its Workspace, so a missing role looks like a
  sandbox that is not provisioned yet or was removed: both answer
  `503 RUNTIME_LOGS_SANDBOX_NOT_FOUND`.

### Which rule decided

Each network or HTTP decision row shows
`rule <name> · engine <engine> · policy generation <generation>`, taken from the
`rule_name`, `rule_type` and `policy_generation` fields:

- **rule** is the policy rule that matched. `no matching rule` means OpenShell
  matched none (it reports `-`), which is the usual cause of a denial.
- **engine** is the OpenShell component that decided, for example `opa`,
  `ssrf`, `mechanistic` or `nftables`.
- **policy generation** is the policy version that decided. The pinned OpenShell
  release does not send it with pushed decision lines, so it usually reads
  `unknown`. Do not assume the current policy decided an older line.

### Relating sandbox decisions to other sources

OpenShell records no Agent turn, session or request ID with a decision. Each
decision row therefore carries the label **Gateway lines: inferred (time
window)**: Gateway or Harness lines near that time may be related, but nothing
links them. The console never labels a join as exact, because no source shares
an ID with the sandbox.

The logs cannot tell you, and you should not infer:

- which Agent turn, session, user or prompt caused a sandbox decision;
- which policy generation decided a line whose generation reads `unknown`;
- which credential OpenShell injected into an allowed request;
- the order of two lines from different sources less than a few seconds apart:
  the sandbox stamps its own lines, the cluster stamps container lines, and
  their clocks can differ;
- who made a request from its source IP address;
- what the Harness printed inside a sandbox, what a deleted Pod or an older
  restart printed, or which lines a sandbox dropped under load.

## Errors

| Response                              | Meaning and action                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `403 FORBIDDEN`                       | Missing grants for that tier. The console names the grants and stops asking for this page.    |
| `400 RUNTIME_LOGS_CURSOR_INVALID`     | The cursor belongs to another principal, version or source, or was altered. Start a new view. |
| `400 RUNTIME_LOGS_POD_INVALID`        | The Pod is not a current Pod of this version and source.                                      |
| `400 RUNTIME_LOGS_SOURCE_UNAVAILABLE` | This version has no such source, for example no Sandbox log or no dedicated Harness.          |
| `429 RUNTIME_LOGS_RATE_LIMITED`       | Wait for `Retry-After`.                                                                       |
| `501 NOT_IMPLEMENTED`                 | The Compute Driver does not expose runtime logs, or an operator disabled them.                |
| `503 RUNTIME_LOGS_CLUSTER_RBAC`       | The cluster or OpenShell denied the read. An operator must grant the roles or scope.          |
| `503 RUNTIME_LOGS_SANDBOX_NOT_FOUND`  | OpenShell reports no such sandbox: not provisioned yet, removed, or outside OCC's Workspace.  |
| `503 RUNTIME_LOGS_AUDIT_UNAVAILABLE`  | The view could not be audited, so nothing was read. Retry.                                    |
| `503 RUNTIME_LOGS_UNAVAILABLE`        | The runtime or cluster is unreachable. Retry.                                                 |
| `504 RUNTIME_LOGS_TIMEOUT`            | The read exceeded 10 seconds. Retry or read fewer lines.                                      |

## Enable or disable (operators)

The `openclaw-enterprise` chart value `agentRuntimeLogs.enabled` (default `true`)
grants `pods/log get` and `events get,list` to the tenant API and Gateway observer
roles and sets `OCC_AGENT_RUNTIME_LOGS_ENABLED`. Set it to `false` to remove the
grants; both routes then answer `501`. Tenant RoleBindings you create by hand
need the same rules; see [production Agents](../deploy/production-agents.md).
Two-cluster installs set the same value on the `openclaw-execution` chart, which
also grants `pods get,list` to its tenant API role.

These grants are read-only and namespace-scoped through your RoleBindings.
Kubernetes RBAC cannot tell Agents apart, so OCC reads only Pods that carry the
exact Agent and version labels. The
[security reference](../../reference/security.md#console-and-api-runtime-log-reads)
describes the boundary.
