# Production TUI tests

Verify a Helm-installed control plane, native TUI interaction, and revision
cutover on a disposable k3d cluster. Prepare the
[shared requirements](README.md#requirements-and-credentials) first.

## Production TUI Helm test environment

[`production-tui-k3d-real.test.mjs`](../../tests/integration/production-tui-k3d-real.test.mjs)
is the opt-in end-to-end production TUI proof. It installs the actual Helm
chart into the selected disposable k3d cluster, starts task-owned PostgreSQL and
HTTPS operator proxy Pods, provisions a Namespace and embedded OpenClaw Agent
through the production API, drives the native TUI with a PTY, verifies revision
cutover, and records nonsecret evidence as it progresses. The test sets
`agents.defaults.skipBootstrap` to `true` in the disposable demo Agent
Configuration so fresh-workspace `BOOTSTRAP.md` onboarding does not replace the
nonce reply; existing workspaces with bootstrap files are unaffected. Missing
prerequisites fail the selected test instead of skipping. Allow at least 4 GiB
per gateway container because the test runs the TUI as a second OpenClaw process
inside the embedded gateway.

| Variable                                       | Requirement or default                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `OCC_TEST_PRODUCTION_TUI_REAL`                 | Set to `1` to explicitly opt into the Helm-backed production TUI suite.                                                 |
| `OCC_TEST_KUBERNETES_KUBECONFIG`               | Absolute path to the dedicated disposable k3d kubeconfig.                                                               |
| `OCC_TEST_KUBERNETES_CONTEXT`                  | Explicit `k3d-*` context with a verified loopback HTTPS Kubernetes API.                                                 |
| `OCC_TEST_PRODUCTION_CONTROLLER_IMAGE`         | Imported immutable controller image reference used by the Helm chart.                                                   |
| `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`            | Imported immutable runtime image reference used for the embedded OpenClaw gateway.                                      |
| `OCC_TEST_PRODUCTION_POSTGRES_IMAGE`           | Imported immutable PostgreSQL image reference for the task-owned database Pod.                                          |
| `OCC_TEST_PRODUCTION_NODE_IMAGE`               | Imported immutable Node image reference for the operator HTTPS proxy and network probes.                                |
| `OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE` | Optional second immutable controller image; set with the runtime candidate to exercise both independent release paths.  |
| `OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE`    | Optional second immutable runtime image; set with the controller candidate to exercise both independent release paths.  |
| `OPENAI_API_KEY`                               | Existing authorized provider credential used only by the Agent-owned embedded gateway path.                             |
| `OCC_TEST_OPENAI_MODEL`                        | Authorized provider model; defaults to `gpt-6-astra`.                                                                   |
| `OCC_TEST_PRODUCTION_TUI_KEEP`                 | Optional `1` retains the owned Helm release, namespaces, final gateway, `attach.sh`, and `proof.json` rehearsal output. |

Use the production TUI suite only with image references that already exist in
the selected cluster, including the Node, PostgreSQL, controller, and runtime
digests. Default cleanup uninstalls the Helm release and deletes only the
task-owned namespaces. `OCC_TEST_PRODUCTION_TUI_KEEP=1` changes that finalizer
for operator rehearsal: it keeps the owned setup running, leaves an executable
`attach.sh` for the final gateway TUI session, and writes `proof.json` with the
cluster, image, Namespace, Agent, revision, Pod, and nonce-response evidence.
Do not treat an in-progress run as passing live proof until the test completes.

When both upgrade image variables are set, the test runs a controller-only
release and then a runtime-only release after the initial revision and model
proof. It verifies that the controller release retains every Agent revision and
that the runtime release keeps the controller digest, replaces two running
Agents, preserves one stopped Agent, and completes a fresh model turn. Setting
only one variable fails the selected test. Omitting both keeps the original
installation and TUI coverage but does not prove either upgrade path.

## Run the suite

Put the required inputs in the [private environment file](README.md#requirements-and-credentials)
after importing the selected images into the disposable cluster:

```sh
OCC_TEST_PRODUCTION_TUI_REAL=1 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/production-tui-k3d-real.test.mjs
```

### Run an isolated upgrade qualification lane

Use the `production-tui` lane from the reviewed source revision, including the
upgrade implementation under test. In the private environment file, set
`OPENAI_API_KEY`, `OCC_TEST_OPENAI_MODEL`, `OCC_TEST_PRODUCTION_POSTGRES_IMAGE`,
and `OCC_TEST_PRODUCTION_NODE_IMAGE`. Select the compatible prior release in
`OCC_TEST_PRODUCTION_CONTROLLER_IMAGE` and `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`,
and the reviewed candidate in both `OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE`
and `OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE`. Each reference must use an
immutable digest; each candidate must differ from its matching baseline. Verify
image provenance separately. Supplying either candidate makes all four images
mandatory and selects supplied images instead of building the current checkout.

With Docker, k3d, kubectl, Helm, yq, and the built OCC CLI available, run:

```sh
run_dir="$(mktemp -d)"
node --env-file="$TEST_ENV_FILE" scripts/ci/prepare.mjs \
  --lane production-tui --state "$run_dir/state.json"
node --env-file="$TEST_ENV_FILE" scripts/ci/run-tests.mjs run production-tui \
  --state "$run_dir/state.json" --results "$run_dir/results.json"
install -m 600 "$run_dir/state.json" "$run_dir/state-before-cleanup.json"
node scripts/ci/cleanup.mjs --state "$run_dir/state.json"
```

Run cleanup even if preparation or the test fails; retain the private state if
cleanup reports a surviving resource. The private copy preserves the image mapping
after successful cleanup removes its working state. Use the same image selection
for both commands. Preparation creates a loopback-only disposable cluster, an isolated
PostgreSQL service, and a logging backend. The test also creates a separate
PostgreSQL Pod with migration and application roles. It imports each approved
source digest into the owned k3d nodes and supplies an immutable local platform
manifest reference to the test. The private state records the original source,
host image ID, and imported reference; the local alias can differ from a registry
index digest, so this is not proof of exact registry-reference deployment. Do not
print or publish the private state or environment file.

Confirm the test's evidence includes both independent image upgrades and a fresh
model reply. A passing TUI test with both candidate variables omitted does not
prove upgrade behavior. The local cluster result is not live EKS proof.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
