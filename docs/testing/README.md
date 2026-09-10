# Testing

Choose a test suite, prepare its prerequisites, and interpret its results.
These guides are for contributors verifying Enterprise changes. Run commands
from the repository root. For installation and supported product settings, use
the [deployment guide](../guides/deploy.md) and [settings reference](../reference/settings.md).

## Run tests

| Command                 | Tests selected                                                            |
| ----------------------- | ------------------------------------------------------------------------- |
| `pnpm test`             | All conformance and integration tests.                                    |
| `pnpm test:conformance` | Conformance tests only.                                                   |
| `pnpm test:integration` | Integration tests only, including infrastructure and real-runtime suites. |

`pnpm test` selects every conformance and integration file. A green result can
include skipped infrastructure tests; it is not proof that every integration
ran. Run prepared infrastructure suites by exact filename, one suite at a time.
The `pnpm test`, `pnpm test:conformance`, `pnpm test:integration`, and
`pnpm test:postgres` scripts run `scripts/verify-workspace-boundary.mjs` before
the Node.js test runner.

Keep their variables scoped to a subshell or one test process. In particular,
the OpenShell suite detects **any** configured test database, Kubernetes context,
or runtime image as selection, then requires its explicit opt-in and full setup.
Running `pnpm test:integration` after exporting only `OCC_TEST_DATABASE_URL` can
therefore fail in OpenShell. Setting `OCC_TEST_OPENSHELL_K3D_REAL=0` does not
override that selection behavior.

## Integration tests

Each suite page contains its setup, commands, environment variables, and coverage limits.
See [GitHub Actions](ci.md) for automatic and manually dispatched coverage.

| Suite                                                     | What it verifies                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Local API and lifecycle](local.md#local-checks)          | HTTP routes, authentication, startup, workers, and Driver packages.                     |
| [Console browser checks](local.md#console-browser-checks) | Console interactions against real API routes with local test storage.                   |
| [PostgreSQL](postgresql.md)                               | Persistence, constraints, authentication, queue claims, recovery, and bootstrap.        |
| [Images and Helm](images.md)                              | Bundled modules, runtime startup, and rendered production packaging.                    |
| [Docker Compose](docker.md)                               | The Compose stack and real embedded OpenClaw and dedicated Codex model turns.           |
| [SSH hosts](ssh.md)                                       | Real SSH/systemd lifecycle, state persistence, and deletion without a model turn.       |
| [Kubernetes](kubernetes.md)                               | Cluster fixtures, real runtime execution, Secret delivery, and private gateway routing. |
| [Production TUI](production-tui.md)                       | Helm-installed control plane, native TUI interaction, and revision cutover.             |
| [Slack](slack.md)                                         | Live Socket Mode ingress and a gateway-authored reply through dedicated Codex.          |
| [ChatGPT service accounts](service-accounts.md)           | Provider account creation, credential delivery, and a model turn.                       |
| [OpenShell](openshell.md)                                 | Provider-owned execution and filesystem/network enforcement through real tools.         |

## Requirements and credentials

Use Node.js 24 or newer and the pnpm version pinned in
[`package.json`](../../package.json), with dependencies installed from the lockfile:

```sh
pnpm install --frozen-lockfile
```

The tests import TypeScript source directly; a separate build is not required
to invoke them. Some local integrations also execute Git, `tar`, and pnpm. The
Driver-package test installs local fixture archives offline into temporary
directories with lifecycle scripts disabled.

| Input you supply                                                        | Used by                                                          | Where it comes from                                                                                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                                                        | Docker, ordinary Kubernetes runtime tests, Slack, and OpenShell. | An existing authorized provider credential with access to the selected model.                                                                                                 |
| `OCC_TEST_CHATGPT_ADMIN_KEY_PATH` and `OCC_TEST_CHATGPT_WORKSPACE_ID`   | Real ChatGPT service-account test.                               | A protected file containing an authorized workspace admin key, plus its exact workspace ID. The test issues the Agent's credential itself; it does not need `OPENAI_API_KEY`. |
| `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `OCC_TEST_SLACK_SENDER_BOT_TOKEN` | Slack test only.                                                 | An existing Socket Mode app, its bot, and a distinct sender bot in the same workspace and test channel.                                                                       |
| Application-role database URLs                                          | PostgreSQL and Kubernetes integrations.                          | The disposable databases prepared in the [PostgreSQL guide](postgresql.md). The documented local passwords are development fixtures, not production credentials.              |
| Dedicated kubeconfig                                                    | Kubernetes integrations.                                         | The disposable cluster prepared in the [Kubernetes guide](kubernetes.md), with authority to provision the test's scoped resources and RBAC.                                   |

Tests generate their own local login credentials, session secrets, transport
tokens, and scoped Kubernetes Secrets. The Kubernetes Secret API case also
provisions its test IAM grants, after proving deployment is denied without the
Agent's exact `operate` grant. You do **not** need to prepare Agent-specific
Secrets or manually grant native IAM access before running that case. This
test setup does not provide a public IAM-management interface; see the
[Secret binding requirements](../reference/drivers/kubernetes-secret.md#bind-a-secret-to-gateway-environment).

Supply real keys through your authorized credential manager or an existing
private environment file. Test entrypoints do not automatically load `.env`.
For example, after preparing a file outside the repository:

```sh
TEST_ENV_FILE=/absolute/path/to/private/runtime-test.env
chmod 600 "$TEST_ENV_FILE"
node --env-file="$TEST_ENV_FILE" --test tests/integration/docker-compute-real.test.mjs
```

That file must contain the inputs for the selected suite, including its opt-in
and images. Node passes the loaded environment to test subprocesses. Existing
exported values take precedence over the file, so avoid stale selectors or keys
in the parent shell. Do not print credentials, commit them, or include them in
command-line arguments. For the ChatGPT admin key, use its dedicated file-path
option in the [ChatGPT service-account guide](service-accounts.md).

Model suites make real provider requests. Set `OCC_TEST_OPENAI_MODEL` explicitly
to an authorized model that supports Codex custom tools; the Kubernetes examples
use `gpt-5.1`. Docker, OpenShell, and ChatGPT account suites default to
`gpt-5.6-sol`. The Kubernetes Harness defaults to `gpt-4.1`, which does not
support the documented dedicated Codex request shape; override it when running
that suite. ChatGPT account tests require a model available to the issued
account's Codex credentials.

## Results, cleanup, and troubleshooting

Read the test runner's pass, failure, and skip counts. Record the selected files,
commit, nonsecret image digests/model, and which optional cases were enabled.
Do not report a skipped model turn, database case, or cluster case as verified.
Keep optional live Configuration cases and mutually exclusive Slack selection
distinct from missing prerequisites.

Tests normally clean up their own temporary processes, resources, and files.
Kubernetes suites leave the selected cluster and database in place. Logging
cleanup removes its local Docker backend container and JSONL/config directory
without requiring a live Kubernetes API; the disposable k3d cluster owns
Collector Namespace and RBAC cleanup. After all needed suites finish, remove only
the disposable cluster you created:

```sh
k3d cluster delete oce
```

Retain failure evidence before removing test resources. Review and remove only
databases created for this run when no test connections remain. Do not delete
shared Compose volumes, existing databases, or unrelated clusters. Slack messages
remain; provider-account cleanup failures require explicit follow-up.

| Symptom                                                  | Check or recovery                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Green command with expected integration coverage absent  | Inspect skips and selection variables; target the exact suite with its full prerequisites.                                                                    |
| OpenShell prerequisite error during a database-only run  | Run `test:postgres` and the singleton-worker file directly; do not invoke the all-integration glob with shared infrastructure variables.                      |
| Provider authentication or unsupported custom-tool error | Check credential/model access without printing the key; explicitly select a compatible model.                                                                 |
| Kubernetes `ImagePullBackOff`                            | Import the local tag and register the exact configured digest alias inside k3s.                                                                               |
| Bootstrap database already contains an Installation      | Use a new disposable, migrated bootstrap database.                                                                                                            |
| Secret-backed deployment denied                          | The test's missing-grant case deliberately expects `403`; a failing positive case needs exact caller and Agent `operate` grants, not broader Kubernetes RBAC. |
| Missing Helm or `yq`                                     | Install the required tools before claiming packaging coverage; this test does not install them.                                                               |

## Related

- [Deployment guide](../guides/deploy.md)
- [Runtime image recipe](../../deploy/runtime/README.md)
- [Contributor integration boundaries](../../AGENTS.md#running-integration-tests)
