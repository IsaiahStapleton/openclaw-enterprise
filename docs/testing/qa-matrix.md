# Run the shipped installation QA matrix

Run this credentialed suite to verify the two development installation paths with
real Standard OpenClaw and Standard Codex agents:

```sh
pnpm cli:build
OCC_TEST_QA_MATRIX=1 node --env-file="$TEST_ENV_FILE" \
  --test tests/integration/qa-matrix-real.test.mjs
```

The suite calls `scripts/dev-up` for Compose OCC + Kubernetes compute and
Kubernetes OCC + Kubernetes compute. Both use Sandbox Driver `none`. Each
installation runs its two presets sequentially, selecting the appropriate Plugin
Driver and stopping the prior agent before switching. It creates unique clusters,
Compose projects, ports, and private state directories. It does not select an
existing cluster or change the default kubeconfig.

## Coverage and applicability

| Proof                                                                                 | Compose OpenClaw | Compose Codex | Kubernetes OpenClaw | Kubernetes Codex |
| ------------------------------------------------------------------------------------- | ---------------- | ------------- | ------------------- | ---------------- |
| Startup, ready default Namespace, shipped presets                                     | Yes              | Shared        | Yes                 | Shared           |
| Real model nonce, unauthenticated denial, exact Agent/revision/Pod                    | Yes              | Yes           | Yes                 | Yes              |
| Authenticated console and native UI WebSocket model turn                              | Yes              | Yes           | Yes                 | Yes              |
| Native repository checkout/edit/commit/push/PR; independent remote readback; disposal | Yes              | Yes           | Yes                 | Yes              |
| Read-only repository push rejected                                                    | —                | Yes           | —                   | Yes              |
| Calendar per-call allow-once/deny, automatic review, disabled tool                    | —                | Yes           | —                   | Yes              |
| One Slack ingress, threaded response, and native outbound root                        | Unsupported      | Yes           | Unsupported         | Yes              |

Linear READ is explicitly excluded because the provider is currently broken.
Calendar must perform a successful harmless read before approval denial can pass.
A provider error does not establish denial. Allow-once and the subsequent denial
share a session; the observer correlates native call/result identities. Explicitly
disabled tools must remain unavailable even when their approval policy permits use.

Compose native UI access uses the documented gateway password through a
loopback TLS relay. Kubernetes native access uses the console's authenticated
native-admin endpoint with the documented [per-Agent native-admin opt-in](../guides/deploy/native-admin.md). The suite installs only its uniquely named CA trust entry,
keeps browser certificate verification enabled, and removes that trust entry at
cleanup. Compose does not claim integrated shared-session native tabs.

Slack applies only to Codex. The sender and gateway bot must be distinct members
of the authorized channel. The sender credential must permit posting plus
`conversations.history` and `conversations.replies` reads for that channel. There is exactly one initial send per applicable cell,
no send retry, and at least 60 seconds of observation after the first response.
History and thread reads are paginated; the observer requires the expected bot,
channel, original `thread_ts`, exact nonce, and native Codex turn evidence. A
separate native-tool task sends one new root message, also checked against its
actual tool result and observed for duplicates. A competing Socket Mode consumer
can cause a failure; the suite does not stop it or resend to compensate. Run with an app reserved for this proof.

## Prerequisites and credentials

Follow the [Kubernetes prerequisites](kubernetes.md) and the
[Compose with Kubernetes compute procedure](../guides/deploy/local-compose-kubernetes.md).
Docker, k3d, kubectl, Helm, Go, OpenSSL, Chromium/Playwright, `certutil`, and a matching
installed workspace dependency graph are required. Allow enough disk and memory
for the images, OCC, PostgreSQL, Envoy, and the agent workloads.

Set these values in a private environment file. Credential paths must name
regular files with no group/other permissions. Do not put secret values in command
arguments or commit the environment file.

| Variable                                                               | Required value                                                                                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_TEST_QA_OPENAI_KEY_FILE`                                          | Authorized OpenClaw model API key file.                                                                                                        |
| `OCC_TEST_QA_CODEX_TOKEN_FILE`                                         | Authorized Codex service-account PAT file, admitted as `codex_pat`.                                                                            |
| `OCC_TEST_QA_OPENAI_MODEL`, `OCC_TEST_QA_CODEX_MODEL`                  | Optional authorized model overrides; both default to `gpt-6-luna` when unset or empty.                                                         |
| `OCC_TEST_QA_REPOSITORY_AUTHORIZED`                                    | `1`, authorizing disposable branches and PRs in the registry repository.                                                                       |
| `OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY`                               | Private directory containing `registry.json`, `private-key.pem`, and `upstream-cidrs.json`, as described below.                                |
| `OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE`                               | Independent GitHub observer/cleanup credential. Alternatively select an absolute managed gh wrapper with `OCC_TEST_QA_GITHUB_OBSERVER_BINARY`. |
| `OCC_TEST_CODEX_CALENDAR_TOOL_NAME`                                    | Exact native transcript name of an available harmless Calendar read tool.                                                                      |
| `OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT`                                | Pattern establishing a genuine successful Calendar read.                                                                                       |
| `OCC_TEST_QA_SLACK_APP_TOKEN_FILE`, `OCC_TEST_QA_SLACK_BOT_TOKEN_FILE` | Approved Socket Mode app and gateway bot token files.                                                                                          |
| `OCC_TEST_QA_SLACK_SENDER_TOKEN_FILE`                                  | Distinct approved sender token file with channel and thread read access.                                                                       |
| `OCC_TEST_QA_SLACK_CHANNEL_ID`                                         | Authorized channel joined by both bots.                                                                                                        |

The repository input uses the [development repository registry](../guides/deploy/local-repository-credentials.md)
with exactly one authorized repository, the `${OCC_INITIAL_NAMESPACE_ID}` placeholder,
and `git-read` and `git-full` profiles. Upstream CIDRs must be approved IPv4 `/32`
endpoints. The runner never gives its observer token to an agent. Git commands and
PR creation execute through the real native agent and repository broker; the
observer reads independent remote state and cleans up only verified owned refs.
A private registry copy restricts pushes to this run’s exact branch names. Any
existing push allowlist must permit those names. The repository stage enables
native command tools explicitly; initial model/UI checks retain the preset tool
policy. Read-only rejection uses a fresh Agent workspace.

Optional settings:

- `OCC_DEVELOPMENT_K3S_IMAGE`: explicitly select an available K3s image for the
  Compose launcher to avoid release-channel resolution during replay.
- `OCC_DEVELOPMENT_K3D_DNS_RESOLVER`: the approved upstream resolver when the host
  resolver is unreachable from the disposable cluster.

- `OCC_TEST_QA_CONTROLLER_IMAGE` and `OCC_TEST_QA_RUNTIME_IMAGE`: select together;
  immutable locally available references whose source revision matches the checkout.
- `OCC_TEST_QA_REPOSITORY_IMAGE`: an immutable broker image from the same checkout.
  Without selected images, the launcher and fixture build from source.
- `OCC_TEST_BROWSER_EXECUTABLE`: an existing Chromium executable.
- `OCC_TEST_CODEX_CALENDAR_PLUGIN_ID`, `OCC_TEST_CODEX_CALENDAR_PROMPT`, and
  `OCC_TEST_CODEX_CALENDAR_EXPECT`: existing Calendar fixture overrides.
- `OCC_TEST_QA_INSTALLATION`: `compose` or `kubernetes` for a partial local replay.
  The default `all` covers both; CI forces `all`. A partial run is labeled in
  `matrix.json` and cannot establish a full matrix pass.
- `OCC_TEST_QA_ARTIFACTS`: output directory; otherwise a private temporary directory
  is allocated and printed.

Missing prerequisites fail their selected stages. An opt-out skip from running
without `OCC_TEST_QA_MATRIX=1` is not a matrix pass.

## CI, evidence, and recovery

The `qa-matrix` lane belongs to the `full` group and is selectable in the
**Full Integration** workflow. It uses the protected `integration-qa` environment;
configure independent reviewers and the approved main branch before dispatch.
The workflow materializes file-backed credentials in runner temporary storage and
uploads only the outcome/evidence JSON files. It does not upload private state or
raw command logs. In a full run, this job follows the focused Slack job so they
cannot compete for Socket Mode delivery.
`scripts/ci/test-suites/qa-matrix.json` owns lane registration.

Replay through the credentialed runner with the same environment:

```sh
node --env-file="$TEST_ENV_FILE" scripts/ci/prepare.mjs --lane qa-matrix \
  --state /tmp/qa-matrix-state.json
node --env-file="$TEST_ENV_FILE" scripts/ci/run-tests.mjs run qa-matrix \
  --state /tmp/qa-matrix-state.json --results /tmp/qa-matrix-results.json
```

`matrix.json` lists each stage's outcome. Cell evidence records Agent/revision/Pod
identities, nonce results, independently observed repository SHAs, credential
session disposal, and Slack timestamps. A parent failure or successful static
check must not be reported as a live cell pass.

Ordinary cleanup stops agents and calls `scripts/dev-down` with each owned state
directory. If repository disposal is uncertain, the fixture retains its
installation and reports the recovery path. Keep that broker alive until its
sessions are `DISPOSED`, with zero active uses, active/pending/uncertain cleanup,
and no auxiliary cleanup pending. Do not delete another run's resources.

## Consolidated coverage

| Previous owner                                                        | Canonical or retained owner                                                                                                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar policy case in `plugin-driver-real.test.mjs`                 | Shared `calendar-review.mjs`, executed in both Codex matrix cells. Other plugin isolation/failure cases remain.                                                |
| Native Git/PR journeys in `repository-credentials-k3d-real.test.mjs`  | Shared `repository-native-journey.mjs`, executed in all four matrix cells. Installed credential isolation and sandboxed read-only denial remain focused cases. |
| Retrying Slack delivery in `harness-topology-k3d-slack-real.test.mjs` | `slack-delivery.mjs` single-send proof in both Codex cells. Credential placement, proxy denial, and Socket Mode checks remain focused.                         |
| Browser chat helpers in `native-admin-k3d-real.test.mjs`              | Shared `native-ui-chat.mjs`. Native access boundaries, session isolation, drift, and lifecycle cases remain focused.                                           |
| `dev-up-k3d-real.test.mjs` and topology model suites                  | Retain launcher rejection, teardown, sandbox, and topology/isolation contracts. The matrix adds the exact four shipped combinations.                           |

Shared fixture extraction does not imply that a live run passed. Consult the
specific run's outcome and evidence files.
