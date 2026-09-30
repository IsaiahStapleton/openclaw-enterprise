# GitHub Actions testing

Choose automated or manual test lanes and understand their coverage.

## GitHub Actions

Metrics HTTP/persistence coverage belongs to the `postgres-application` lane, including a
separate migrator-role connection for test-only table contention. The
`logging-collector` lane also runs real Prometheus/Grafana collection and
dashboard provisioning. See [metrics testing](metrics.md) for local setup.

The [suite index](../../scripts/ci/test-suites.json) holds lane references and coverage groups. Each `scripts/ci/test-suites/<lane>.json` owns its files, inputs, environment and resources; edit it for test changes, or the index for lane or group changes. The [loader](../../scripts/ci/test-suites.mjs) assembles them. Check that every active test file has one lane owner:

```sh
node scripts/ci/run-tests.mjs audit
```

CI uses [run-ci-lane](../../.github/actions/run-ci-lane/action.yml) for setup, tests, cleanup and job isolation.

Compare per-file `wallDurationMs`, preparation `[ci-timing]` phases and Actions timestamps for slow setup or tests; timings include image archive save and import. Imports copy the archive to each owned k3d node and use node-local `ctr image import`: k3d `tools-node` can hide per-node failures while exiting successfully. Imports are serialized per cluster, then preparation verifies digest and CRI references.

`checks-baseline` runs `pnpm docs:check` and the [dependency policy](repository-boundaries.md). Pages above 1,500 visible words require review; above 2,500 fail except the approved [API reference](../reference/api.md) and `AGENTS.md` files. The generated API, site build, navigation, and links must pass. Run `pnpm docs:check-length` for word counts alone.

CI Impact and Suite Audit start independently. Full mode runs `checks-baseline`, the ten-lane matrix, and `runtime-image-fixture`; `CI Required` requires their outcomes and same-source artifacts. Kubernetes fixture and observability lanes use `ubuntu-22.04` for bridge netfilter support; `runtime-image-fixture` and `CI Required` also use it. The repository credential platform lane uses `blacksmith-16vcpu-ubuntu-2404` to build the delivered runtime image and platform fixture in one job; other lanes and the audit use `blacksmith-8vcpu-ubuntu-2404`.

For a verified documentation-only PR merge tree, `docs-checks` verifies checkout identity and runs formatting, `docs:install`, `docs:check`, and `docs:build`. The check covers word limits, links and navigation. Docs mode runs no conformance, integration, browser, Go, or other product tests. `CI Required` verifies the mode and requires successful impact, audit and documentation jobs, with full test jobs skipped. Missing, failed, cancelled or unexpectedly skipped selected jobs fail. Docs mode does not run the test-result aggregator or require test artifacts.

The selector loads policy from the verified PR base. Code, configuration, workflow, mixed or unknown changes and non-PR events select full; unavailable or unverifiable evidence selects full or fails closed. A base without the selector also selects full. Hosted validation is not yet established.

The `pull_request` workflow itself is PR-controlled. Base-controlled selector
policy does not prevent a changed workflow from bypassing these checks. A trusted
required workflow or other external enforcement is not established by this
source. See the [testing flow](../flows/github-actions-testing.md) for details.

The repository credential platform lane proves HTTP, PostgreSQL, Unix control and credential material inside
Kubernetes; compatible fixture lanes prove NetworkPolicy enforcement. The images
packaging lane uses the full tool profile to derive the reviewed Codex seccomp
profile in an owned k3d cluster and export `OCC_TEST_CODEX_SECCOMP_PROFILE`
before native runtime image smoke tests.

Full Integration is manual and uses the immutable event commit. Lanes require
`main` except `k3d-model`, which also accepts an `integration-model` branch
allowlist. Environment gates apply only to lanes that declare one;
`helper-timeout` and standalone `logging-collector` declare none. The ChatGPT
`provider-account` lane is main-only without per-run approval; other model,
routing, Slack, OpenShell, and additional OpenTelemetry lanes require approval.
Missing selected prerequisites fail. A PR aggregate is not full credentialed coverage;
targeted protected runs report only their selected lanes.

The `postgres` lane owns migration compatibility tests; `postgres-application`
owns the remaining PostgreSQL files. Each has a disposable PostgreSQL server.
Kubernetes fixture files run in `k3d-fixture-configuration`,
`k3d-fixture-state`, and `k3d-fixture-plugins`, each with independent cluster,
database, image, and cleanup state. Files run sequentially within each lane. The audit requires one owner per file; Full Integration aggregates its selected `full` group or targeted lane.

The `repository-credentials-container` lane builds
`.build/repository-credentials/{service,client}` with Dockerfiles under
`deploy/runtime/repository-credentials/` and records source, `gh` version and
three image IDs, selected through
`REPOSITORY_CREDENTIALS_TEST_IMAGE`, `REPOSITORY_CREDENTIALS_SERVICE_IMAGE` and
`REPOSITORY_CREDENTIALS_CLIENT_IMAGE`; its real Git/gh fixtures also receive
`REPOSITORY_CREDENTIALS_NODE_IMAGE` and the extracted, version-checked
`REPOSITORY_CREDENTIALS_GH_BINARY`. The [credential test guide](repository-credentials.md)
separates detached artifacts, the combined image, rendered Compose, running
container isolation and authorized live proof. Preparation and suite ownership
do not establish a result: inspect executed cases and skips at the tested
commit, including whether a pull-request run tested a merge commit.

Kubernetes fixture lanes load bridge netfilter and enable IPv4 bridge filtering
before cluster creation so K3s enforces NetworkPolicies on bridged Pod traffic.
Setup fails if this cannot be enabled; deny-traffic assertions remain required.

Each Kubernetes fixture lane owns a server/worker cluster with shared test-owned
local-path storage. Preparation registers and verifies the fixture image digest
on both nodes and derives the API server proxy source `/32` from its route to
the worker Pod network. The [plugin status tests](plugins.md#local-and-integration-suites)
use that address to exercise the private status endpoint across nodes with
NetworkPolicy enforcement.

Kubernetes fixture startup logs phase timings and host resource and pressure snapshots. On cluster or readiness failure, preparation collects bounded
node, system Pod, event and redacted node-container diagnostics before cleanup;
k3d rollback is disabled long enough to retain them. Inspect the
`diagnostics-<artifact-prefix>-<lane>` artifact or local
`<state-file>.diagnostics.json`. Failed diagnostic commands are marked unavailable or timed out; collection preserves the original failure. Raw
kubeconfig, environment values and Pod specs are excluded. After a failed prepared
run, local callers must run `node scripts/ci/cleanup.mjs --state <state-file>`.
Diagnostics explain setup failures without establishing coverage.

The `k3d-model`, `gateway-routing`, `slack`, and `k3d-otel` lanes prepare the controller image and workspace routing for dedicated Harness node enrollment. Supply an immutable `NODE_BASE_IMAGE` for the build. Preparation supplies the imported controller digest and private routing CA paths; Slack still requires approved runtime images and credentials.

Routing, OpenShell, and logging have CI preparation contracts. Routing installs
pinned Gateway API, cert-manager v1.18.4 and Envoy Gateway v1.6.7 manifests and
generates a private test CA. OpenShell creates an owned K3s v1.36.4 cluster,
installs a matched kubectl, configures and smoke-tests the selected RuntimeClass
with the cluster's `runc` handler, installs CLI/chart and Agent Sandbox assets,
and imports gateway and supervisor images. Only that disposable cluster exempts
the selected RuntimeClass from Pod Security Admission; preparation proves an
ordinary violating Pod is rejected and the same Pod is admitted with that class.
The full OpenShell suite proves provider-owned supervisor filesystem, endpoint/L7
network, and process enforcement while the sidecar policy remains binary-unaware.
Logging preparation owns a real OpenTelemetry Collector backend with JSONL evidence;
`OCC_TEST_OTEL_LOGS_URL` is no longer an external input. The Collector and
Docker-model jobs use [setup-test-docker](../../.github/actions/setup-test-docker/action.yml)
to pin Docker 29.4.0 for the production `fluentd-write-timeout` option. It replaces
the preinstalled daemon and shares `/var/run/docker.sock` across the CLI, Compose,
and Driver; other jobs keep the runner daemon. Full-suite acceptance requires
main-only protected hosted execution of every selected lane. See the
[delivery status](../../specs/19-github-actions-test-coverage/delivery-status.md#delivery-status)
for proof boundaries and live gaps.

Each lane runs whole test files. The runner validates Node case results and required names; skips, TODOs, missing results, zero cases, failures and cleanup errors fail the selected lane. The aggregate checks required job and lane results at the same source commit without repeating case validation. Ordinary `pull_request` jobs may save pnpm-store caches within the PR merge-ref scope; protected jobs use the approved event commit and do not promote PR build artifacts.

Prepare infrastructure only on a disposable host or through reviewed CI helpers.
Each run owns its Compose project, databases, cluster and temp files. CI writes
private cleanup state under `RUNNER_TEMP` and uploads sanitized results and
bootstrap diagnostics; hosted-runner state disappears after the job.
The images-packaging lane attempts to retain sanitized cleanup records for its
prepared controller and runtime tags, but not the separate runtime-images test tag.
A planned record does not prove an image exists; export or upload failure or
runner loss can prevent retention. Missing state or an empty inventory does not
prove cleanup; a tag name is metadata, not authentication or deletion authority.
Results include source commit, case outcomes, cleanup status and available image
digests by role, excluding private registry names and prepared environment values.
Local failures can retain cleanup state while the host and state path exist. On
Docker Desktop or similar VM-backed hosts, run one Kubernetes lane at a time when
measured disk or network pressure has caused instability; the GitHub matrix remains
parallel. Model/service tests require the approved credentials and spend policy in
the [implementation specification](../../specs/19-github-actions-test-coverage.md).

See the [execution flow](../flows/github-actions-testing.md) for entrypoints, result accounting, cleanup and failures. Use the [suite-specific guides](README.md#integration-tests) to reproduce runs locally.

Failed browser tests upload
[diagnostics](local.md#browser-failure-diagnostics).

A retry replaces its lane result artifact; other lanes keep theirs. Preserve failed results before retrying if needed; earlier logs remain. Full-mode reruns require every selected lane and aggregate to pass.

### Select immutable images for local preparation

Set `OPENCLAW_CI_K3S_IMAGE` to an approved `image@sha256:<digest>` before
`node scripts/ci/prepare.mjs --lane <lane> --state <private-state-file>`
to bypass k3d's online release-channel lookup. Otherwise ordinary Kubernetes lanes
default to `+v1.35`. Both paths require the API server to report Kubernetes 1.35.x;
OpenShell retains its separately pinned image. Mutable overrides fail before
resource creation. Clean up a failed run's owned resources before reusing its state path.

Preparation reuses a supplied immutable workload image in the local Docker daemon
only when `docker image inspect` records the requested digest in `RepoDigests`;
a mutable tag or unverified image is insufficient. Missing or mismatched images
are pulled and rechecked before import. Other Docker inspection failures stop
preparation. Cleanup removes owned import tags and preserves the supplied image.

On GitHub-hosted runners, both observability lanes remove unused SDKs and require
36 GiB free before building and importing images. SDK removals run concurrently
with a ten-minute deadline and per-directory timing receipts; local runs omit this
guarded cleanup. Both use single-node clusters and overlap independent pulls,
builds, and cluster setup, then serialize k3d imports per cluster to avoid
importer races. The demo lane imports only its three services and a Node
image for protocol fixtures; it does not build OCC. State writes remain
serialized, and all in-flight operations settle before failure cleanup.

Image imports time out after ten minutes. Preparation verifies each immutable
reference on every schedulable node. Errors and timeouts fail preparation; lane
cleanup removes the owned cluster and partial imports.

### Integration coverage by trigger

The [CI workflow](../../.github/workflows/ci.yml) runs on pull requests, pushes to `main`, merge groups, and manual dispatch.
[Full Integration](../../.github/workflows/full-integration.yml) runs only by
manual dispatch, using the requested lane or `all`, not on pushes or merges. The
`k3d-model` branch exception below does not enable other lanes outside `main`.
`provider-account` remains manual because its configured admin credential cannot
authenticate from the hosted runner.

### Run Kubernetes model tests before merge

A repository administrator must add the exact branch name to the
`integration-model` environment's deployment rules, retaining `main`, required
reviewers, and self-review prevention. Wildcards fail preflight. The reviewed
branch gains access to the existing model credential only after reviewer approval.

```sh
gh workflow run full-integration.yml --ref '<approved-branch>' -f lane=k3d-model
```

The reviewer must inspect the run's commit before approval. Each job checks out
immutable `github.sha`; moving the branch does not change an existing run.
The dispatcher cannot approve their own run; a different collaborator must
dispatch or approve. Remove the branch rule after the proof completes.
Other lanes, including `all` and `provider-account`, remain main-only. This lane
runs real Kubernetes topology tests, including embedded invalid-credential
cutover and recovery, and the local first-Agent proof: a fresh installer deploys
and reuses their own Agent, verifies real model responses, and cannot replace the
credential after external changes. Ordinary fixture CI does not run these tests.

### Integration tests outside automatic CI

These integration files have no automatic workflow entrypoint.
A green `CI Required` check does not establish their coverage. This inventory describes workflow selection, not
local or hosted test results.

#### Manual Full Integration lanes

These ten files run only when selected in
[Full Integration](../../.github/workflows/full-integration.yml), using the listed
lane or `all`. Model/service lanes require configured credentials and infrastructure.
`helper-timeout` is separate because it spends five minutes testing the helper deadline.

| Lane               | Integration test file                                                                                            | Coverage absent from automatic CI                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `docker-model`     | [docker-compute-real.test.mjs](../../tests/integration/docker-compute-real.test.mjs)                             | Docker Compose deployment and real embedded OpenClaw/dedicated Codex model turns.                                        |
| `k3d-model`        | [harness-topology-k3d-real.test.mjs](../../tests/integration/harness-topology-k3d-real.test.mjs)                 | Dedicated Codex continuity across Pod replacement and embedded model turns with persisted credentials or the Secret API. |
| `k3d-model`        | [local-first-agent-real.test.mjs](../../tests/integration/local-first-agent-real.test.mjs)                       | Fresh local Agent deployment and reuse with real model replies; external changes block credential replacement.           |
| `gateway-routing`  | [harness-topology-k3d-routing-real.test.mjs](../../tests/integration/harness-topology-k3d-routing-real.test.mjs) | Dedicated Codex consumption of workspace files through the real Envoy/OCC route.                                         |
| `production-tui`   | [production-tui-k3d-real.test.mjs](../../tests/integration/production-tui-k3d-real.test.mjs)                     | Helm-installed production control plane, interactive TUI, and revision cutover.                                          |
| `slack`            | [harness-topology-k3d-slack-real.test.mjs](../../tests/integration/harness-topology-k3d-slack-real.test.mjs)     | Real Slack ingress and a gateway-authored reply through the approved proxy and Codex Agent.                              |
| `provider-account` | [service-account-driver-real.test.mjs](../../tests/integration/service-account-driver-real.test.mjs)             | Actual ChatGPT service-account creation, credential delivery, and a dedicated Codex model turn.                          |
| `openshell`        | [sandbox-driver-openshell-k3d-real.test.mjs](../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs) | Provider-owned dedicated Codex Harness and real OpenShell sandbox enforcement.                                           |
| `helper-timeout`   | [dev-up-timeout.test.mjs](../../tests/integration/dev-up-timeout.test.mjs)                                       | Full 300-second readiness deadline for a running but unready worker.                                                     |
| `k3d-otel`         | [harness-topology-k3d-otel-real.test.mjs](../../tests/integration/harness-topology-k3d-otel-real.test.mjs)       | Actual OTLP logs emitted during embedded and dedicated runtime model turns.                                              |

#### No GitHub workflow entrypoint

[dev-up-k3d-real.test.mjs](../../tests/integration/dev-up-k3d-real.test.mjs)
belongs to the CLI-only `dev-up-k3d` lane, outside both workflow groups and
Full Integration dispatch. See [run the local installation lane](README.md#run-the-local-installation-lane).

[repository-credentials-k3d-real.test.mjs](../../tests/integration/repository-credentials-k3d-real.test.mjs)
belongs to the explicitly selected `repository-credentials-installed` CLI lane,
excluded from both workflow groups and Full Integration dispatch. Follow the
[installed repository credential qualification](repository-credentials.md)
for protected App inputs, authorized live writes, model execution, and cleanup.

[repository-credentials-live.test.mjs](../../tests/integration/repository-credentials-live.test.mjs)
belongs to the `repository-credentials-live` lane, excluded from both workflow
groups and Full Integration dispatch. Follow the
[repository credential qualification guide](repository-credentials.md) for the
authorized disposable repository, protected service setup, and cleanup. The
automatic container lane exercises controlled provider behavior and separate
container credential isolation. A passing run establishes only selected checks
at its recorded source and images, not installed platform or live-provider qualification.

[postgres-azure-workload-identity.test.mjs](../../tests/integration/postgres-azure-workload-identity.test.mjs)
belongs to the `postgres-azure-workload-identity` lane, excluded from the `ci`
and `full` groups and Full Integration dispatch. Follow the
[Azure PostgreSQL test procedure](postgresql.md#azure-workload-identity-connections)
for private input setup and result handling. Ordinary constructor,
security-rejection, and password cases in
[postgres-connection-auth.test.mjs](../../tests/integration/postgres-connection-auth.test.mjs)
run in the mandatory `postgres` lane.

[ssh-compute-real.test.mjs](../../tests/integration/ssh-compute-real.test.mjs) belongs
to the `ssh-host` lane, excluded from the `ci` and `full` groups and
Full Integration dispatch. No workflow provisions its disposable Linux/systemd
SSH host or invokes the lane. The readiness-only selector proves real-host
readiness, revision cutover, state isolation/persistence, and deletion without
a model call. The optional `OCC_TEST_SSH_MODEL=1` selector adds
[real provider execution and runtime credential proof](ssh.md#runtime-credential-model-proof).
Follow [SSH raw hosts](ssh.md#ssh-raw-hosts) for the disposable host, required
environment settings, and direct test command.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).

## Production observability lane

`k3d-observability` checks raw metrics and OTLP exports in PR/main CI on Ubuntu
22.04. The [Observability Demo workflow](../../.github/workflows/observability-demo.yml)
runs `k3d-observability-demo` for relevant changes, merge groups, and manual dispatch;
Full Integration includes it with `all`. Both retain strict case counts, image
digests, and cleanup.

Gateway/Codex model-log proof remains in protected `k3d-otel`; ordinary CI does
not establish it. See [local commands, scope, and prerequisites](metrics.md#kubernetes-observability-acceptance).
