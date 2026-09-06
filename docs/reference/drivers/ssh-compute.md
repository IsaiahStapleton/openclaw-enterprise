# SSH Compute Driver

`SshComputeDriver` (`compute-ssh`, implementation `occ/ssh`) realizes Namespaces
and embedded OpenClaw AgentRevisions on operator-owned Linux hosts over SSH.
Each Agent has one systemd gateway unit. OCC still owns resources, authorization,
immutable admission, and activation; the Driver owns only their host realization.
Trusted Installation YAML can select this bundled Driver in development or production.

Local conformance and startup coverage exercise the implementation. The opt-in
real-host integration below passed on 2026-09-05 against the disposable systemd
container rig with OpenClaw `2026.7.1`; rerun it for any host or runtime you
intend to operate. Neither suite proves a model turn.

## Requirements and configuration

Provision Linux with systemd, util-linux `flock`, a root SSH account, Node.js 24,
a readable OpenClaw entrypoint, and the configured gateway runtime account. The controller processes
need the system `ssh` executable and protected identity and known-hosts files;
the controller image's `node:24-bookworm` base ships the OpenSSH client.
The Driver never installs or upgrades host software and has no `sudo` fallback.
API and worker production preflight both verify configured hosts, so both
processes need these SSH inputs. Hosts receive no controller credentials,
database access, or Installation YAML.

In the existing trusted Installation document at `OCC_CONFIG_PATH`, select:

```yaml
drivers:
  compute:
    id: compute-ssh
    configuration:
      ssh:
        identityFile: /etc/openclaw/ssh/id_ed25519
        knownHostsFile: /etc/openclaw/ssh/known_hosts
        connectTimeoutSeconds: 10
      hosts:
        stable:
          address: 203.0.113.10
          port: 22
          user: root
          nodePath: /usr/bin/node
          openclawPath: /opt/openclaw/current/dist/index.js
      runtime:
        nodePath: /usr/bin/node
        openclawPath: /opt/openclaw/current/dist/index.js
        user: openclaw
        root: /var/lib/openclaw-enterprise
        systemdUnitDirectory: /etc/systemd/system
      network:
        gatewayPortRange:
          start: 18800
          end: 18899
```

This is the Compute selection only. Keep the required `occ`, Configuration,
IAM, and Secret selections from the
[Installation contract](selection.md). SSH does not consume the Secret Driver;
OCC Secret bindings are unsupported. Select Configuration storage appropriate to
the control plane; SSH does not provision Kubernetes namespaces for bundled
ConfigMap or Secret storage. SSH selection does not add a raw-host control-plane
installer or alter the existing production API security requirements.

| Setting                                  | Contract                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ssh.identityFile`, `ssh.knownHostsFile` | Required absolute worker-local file paths.                                                                                                             |
| `ssh.connectTimeoutSeconds`              | Positive safe integer, default `10`.                                                                                                                   |
| `hosts`                                  | Nonempty map keyed by exact platform Namespace **name**, not resource ID.                                                                              |
| `hosts.<name>.address`, `.user`          | Required hostname/IP and SSH user `root`.                                                                                                              |
| `hosts.<name>.port`                      | Integer `1`–`65535`, default `22`.                                                                                                                     |
| `hosts.<name>.nodePath`, `.openclawPath` | Optional absolute host-specific overrides.                                                                                                             |
| `runtime.nodePath`, `.openclawPath`      | Required absolute shared host executable/entrypoint paths.                                                                                             |
| `runtime.user`                           | Required existing host account running the gateways.                                                                                                   |
| `runtime.root`                           | Required absolute state root; `/var/lib/openclaw-enterprise` is recommended. Never under `/tmp` or `/var/tmp`: `PrivateTmp` hides those from the unit. |
| `runtime.systemdUnitDirectory`           | Absolute path, default `/etc/systemd/system`.                                                                                                          |
| `network.gatewayPortRange`               | Inclusive integers `1024 <= start <= end <= 65535`.                                                                                                    |

Unknown keys fail startup. Paths cannot contain whitespace, quotes, control
characters, shell metacharacters, or systemd expansion syntax. Host ports and
paths are trusted operator settings, never caller-selected placement. The
worker uses `BatchMode=yes`, `StrictHostKeyChecking=yes`, `IdentitiesOnly=yes`,
the explicit known-hosts file and identity, the configured connect timeout, and
`LogLevel=ERROR`. Each invocation sends the controller-owned CommonJS helper on
stdin with one base64 JSON operation argument. Operations are bounded to 180
seconds and terminated on compute cancellation; readiness polling is bounded
to 120 seconds. Closing the SSH session does not signal the remote helper, so
the helper writes a heartbeat line every second and stops mutating as soon as
a write to the closed session pipe fails; it also enforces its own deadline
below the transport timeout. A step already handed to `systemctl` completes on
the host.

## Host layout and ownership

`nsHash`, `agentHash`, and `revHash` are the first 12 hexadecimal characters of
SHA-256 of the exact Namespace, Agent, and AgentRevision IDs.

```text
<root>/namespaces/<nsHash>/namespace.json
<root>/namespaces/<nsHash>/agents/<agentHash>/agent.json
<root>/namespaces/<nsHash>/agents/<agentHash>/home/
<root>/namespaces/<nsHash>/agents/<agentHash>/state/
<root>/namespaces/<nsHash>/agents/<agentHash>/gateway.env
<root>/namespaces/<nsHash>/agents/<agentHash>/env
<root>/namespaces/<nsHash>/agents/<agentHash>/revisions/<revHash>/openclaw.json
<root>/namespaces/<nsHash>/agents/<agentHash>/revisions/<revHash>/revision.json
<root>/namespaces/<nsHash>/agents/<agentHash>/current -> revisions/<revHash>
<root>/namespaces/<nsHash>/agents/<agentHash>/served.json
<systemdUnitDirectory>/openclaw-enterprise-gateway-<agentHash>.service
```

Markers record exact Driver, Namespace, Agent, and ServicePrincipal ownership.
Revision markers also record revision ID/number, configuration hash, and
Harness. Foreign markers, changed snapshots, unexpected symlinks, and units
without the exact Namespace/Agent ownership header are refused rather than
adopted. JSON markers and `gateway.env` are `0600`; `home/` and `state/` are
`0700` and owned by `runtime.user`. The native configuration snapshot stays owned
by the SSH account with mode `0640` and the runtime account's group, so the
gateway can read but never rewrite its admitted document. `served.json` records
the revision whose restart last reached readiness; a pointer flip alone never
counts as served. Writes and the `current` symlink are replaced atomically.

Port allocation chooses the lowest unused port across all Agent markers under
the shared root on that host, including other Namespaces. A kernel `flock` on
`<root>/.compute-lock`, held by a helper child whose stdin is the helper itself,
serializes allocation and lifecycle effects; acquisition waits up to 30 seconds.
Whatever ends the helper closes that pipe and the kernel releases the lock, so
there is no stale-lock state to reclaim. All Drivers addressing the same host
must use the same root and unit directory for that inventory to be shared.
Reserve the configured range for these gateways; the Driver does not claim ports
belonging to unrelated host processes.

## Namespace and revision lifecycle

Preflight verifies both local SSH files, then probes every host for SSH
reachability, `systemctl --version`, `flock` on `PATH`, executable Node, readable
OpenClaw, and runtime account resolution. Failure names the configured host and stops
production startup.

`ensureNamespace` creates or verifies the Namespace marker and invokes selected
`afterNamespacePrepared` hooks. An unmapped name fails permanently. Before
revision operations, the worker calls `bindAgent` with server-owned Namespace,
Agent, and ServicePrincipal identities; an unbound revision fails closed.

`prepareRevision` accepts only `openclaw`/`embedded` without OCC Secret bindings.
It verifies ownership, allocates or reuses the Agent port, writes the immutable
snapshot, and renders the stable systemd unit. A superseded candidate returns
not-ready without changing host state. A revision that is current, recorded in
`served.json`, active, and ready returns immediately. Otherwise preparation
atomically replaces `current`, restarts the unit, polls
`http://127.0.0.1:<port>/readyz`, and only then records `served.json`, so a
helper interrupted between the pointer flip and the restart is repaired by a
restart on the next attempt instead of being accepted. An inactive unit or
readiness timeout fails the attempt. This is a bounded restart with interrupted
Agent service, not zero-downtime cutover.

The unit runs `<nodePath> <openclawPath> gateway --port <port>` as `runtime.user`,
with `HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and
`OPENCLAW_GATEWAY_PORT`. It uses `Restart=always`, `RestartSec=2`, `SIGTERM`,
`TimeoutStopSec=30`, `NoNewPrivileges=true`, and `PrivateTmp=true`. The admitted
document owns logging; the Driver sets no `OPENCLAW_LOG_LEVEL`. Logs go to journald.

`activateRevision` verifies exact current and served revision, ownership, active
unit, and readiness without performing another cutover. `deactivateRevision` verifies
ownership and returns; the worker only needs deactivation for the dedicated
topology, which SSH preparation rejects. `retireRevision` invokes selected
`beforeWorkloadStop` hooks and removes only that snapshot. If it is still
current, retirement stops/disables the unit and removes the pointer first.
Home, state, operator credentials, and other revisions remain.

`deleteNamespace` invokes `beforeNamespaceDelete`, verifies all owned Agents,
stops/disables their units, removes the unit files, reloads systemd, and removes
the Namespace tree including state. A missing Namespace is already deleted.
Foreign ownership or configuration failures are permanent; transport, timeouts,
and unexpected helper failures are retryable.

## Credentials and supported boundaries

The Driver writes only the per-Agent gateway token in `gateway.env`. Token auth
uses `"${OPENCLAW_GATEWAY_TOKEN}"` in the native document. For native
`gateway.auth.mode: "trusted-proxy"`, the unit omits `gateway.env` entirely.
An older token file may remain after a change to trusted-proxy auth, but the
unit does not load it.

The optional `EnvironmentFile=-<agentDir>/env` is operator-owned and never read
or written by the Driver. Provision model/channel credential lines there and
reference them through native environment SecretRefs. Systemd reads this file
as root; keep it `root:root 0600`. Protect the state root and SSH identity and
never put plaintext credentials in native Configuration or Installation YAML.

Embedded Agents may use any channel provider supported by the host's OpenClaw
build. They share one configured Unix runtime account and the host's networking;
SSH does not provide Kubernetes NetworkPolicy isolation or the channel isolation
of dedicated execution. Operators own host/network trust and credential access.

Dedicated Codex, SandboxDriver composition, OCC Secret delivery, workspace-file
API endpoint resolution, `existingNamespace` adoption, active-runtime
maintenance, macOS launchd, non-root SSH, and zero-downtime rollout are
unsupported. Host runtime upgrades are operator changes followed by explicit
redeployment of each Agent.

## Verification and troubleshooting

Run local conformance and startup checks:

```sh
node --test tests/conformance/ssh-compute.test.mjs
node --test tests/integration/ssh-compute-startup.test.mjs
```

Conformance executes the actual helper locally with SSH and systemd fixtures.
Use [SSH raw-host testing](../../testing.md#ssh-raw-hosts) for the disposable
systemd/sshd container and real OpenClaw proof. Unselected real-host tests report
an explicit skip naming their environment inputs. That proof covers readiness,
cutover, persistence, retirement, and deletion; it does not cover a model turn
or any host other than the one it ran against.

For host failures, inspect the exact unit with `systemctl status` and
`journalctl -u openclaw-enterprise-gateway-<agentHash>.service`. Verify executable
paths, the runtime user, snapshot readability, and operator environment inputs.
An SSH preflight failure usually indicates a missing key/known-host entry,
wrong host path/account, or unavailable systemd. Never disable host-key checking
to bypass it. Ownership errors require operator inspection of the exact markers,
snapshot and unit; the Driver will not repair them. `<root>/.compute-lock` is an
empty file whose kernel lock is released when its holder exits; a killed helper
never leaves it held, so it needs no manual cleanup.

## Related

- [ComputeDriver contract](compute.md)
- [Driver selection](selection.md)
- [Settings](../settings.md#ssh-compute-driver)
- [Deployment](../../guides/deploy.md)
- [SSH real-host test settings](../settings.md#ssh-real-host-test-environment)
