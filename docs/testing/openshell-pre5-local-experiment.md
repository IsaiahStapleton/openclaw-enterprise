# OpenShell v0.1.0-pre.5 local experiment handoff

This note records the September 21, 2026 local experiment against
[`v0.1.0-pre.5`](https://github.com/NVIDIA/OpenShell/tree/v0.1.0-pre.5). Use it to
plan the next OpenShell integration change. It is evidence from a disposable test
environment, not a supported setup procedure or proof that OpenShell can run a
production Agent.

## Result

The experiment deployed the exact pre.5 OpenShell gateway, sandbox runtime, and
supervisor images to a disposable k3d cluster. OpenShell created a Sandbox custom
resource and a provider-owned Agent Pod. Kubernetes reported that Pod as Ready,
and the integration verified its expected PVC mounts, restricted container
security context, secret non-exposure, and gateway routing.

The positive integration still failed: **0 passed, 1 failed, 0 skipped**. The
Codex app-server process inside the Agent exited before it listened on port
18790, so the gateway returned HTTP 408 with
`CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE`. No provider model request
completed.

Pod readiness was not sufficient evidence of Agent readiness. After the
canonical process exited, the OpenShell boundary process remained alive and the
Pod stayed Ready.

## Experiment scope

The run used the branch for
[#272](https://github.com/openclaw/openclaw-enterprise/pull/272) at commit
`b3a4c004`, model `gpt-5.6-sol`, and the real OpenShell k3d integration. The
existing stock test selects the expected fail-closed case because pre.5 cannot
accept the required Secret-backed environment or projected workload identity.
To reach later startup stages, the experiment changed only an isolated worktree
and added temporary compatibility adaptations based on the approach explored in
[#146](https://github.com/openclaw/openclaw-enterprise/pull/146).

The disposable cluster used K3s v1.36.4. Its imported image manifests had these
digests:

| Image                                       | Imported manifest digest                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| OpenShell gateway                           | `sha256:d9e71ec3cc334abba58f83fff051f6c7891b2b123d5bd2a37d10e25cca9fd7d1` |
| OpenShell sandbox runtime                   | `sha256:fee4be7a3aac56a23f7c52446aad9bfe3e196e1e921dfa71b629b1316b84e22b` |
| OpenShell supervisor                        | `sha256:8f11658a225197612ec5e0ecf68ebb03a135ac1e51f363f5a335424ad990bdb7` |
| Original OpenClaw/Codex runtime             | `sha256:d8bcbb159805deddab818b050b6335c3095af9cefcce8770ce59109d68d6f77e` |
| Test-only UID-compatible runtime derivative | `sha256:6b66054d5e2a47b44f34c0ec746751d680c0c72af710744a2251ccb8f79d32a9` |

The adaptations were:

- Materialize `APP_SERVER_TOKEN` and `OPENAI_API_KEY` from their exact
  `SecretKeyRef` sources into a private, revision-specific PVC subpath, then read
  them from the Agent startup wrapper.
- Split the large inline Node command into arguments below OpenShell's 32 KiB
  argument limit.
- Omit the projected service-principal token to avoid the unsupported pre.5
  volume shape.
- Use a disposable derivative of the same Codex runtime image with its Codex
  home owned by UID 10001, which pre.5 selected for the workload.

These changes intentionally weakened the production proof. They established how
far pre.5 could start, but did not satisfy the SandboxDriver contract. None of
the adaptations were committed to PR #272.

## Observed failure sequence

| Stage                             | Observation                                                                             | Consequence                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Stock request                     | Pre.5 rejected the exact Secret-backed environment and projected service-token volume.  | The supported test correctly failed closed before activation.                                                        |
| Pod-template bridge               | Suspending and recreating the Sandbox Pod allowed a projected token to be added.        | Pre.5 rejected the recreated Pod because its workload Pod UID no longer matched the admitted runtime resource claim. |
| Identity omitted                  | The Sandbox, supervisor, gateway, and Agent Pod reached Running or Ready.               | This proved resource creation only; it did not prove the production workload identity.                               |
| Credential bridge, first attempt  | Credential files were mode `0400`, owned by UID 1000, while the Agent ran as UID 10001. | The startup wrapper could not read either credential and exited.                                                     |
| Credential ownership corrected    | The wrapper could read both files.                                                      | Startup progressed to the runtime entrypoint.                                                                        |
| Runtime image ownership corrected | UID 10001 could access `/home/node/.codex`.                                             | Startup progressed far enough to reveal the missing runtime artifact.                                                |
| Canonical stderr captured         | Node reported `ENOENT` for `/etc/openclaw/plugin-runtime/runtime.json`.                 | The app-server exited, port 18790 refused connections, and the model turn returned HTTP 408.                         |

The final failure happened before model-provider authentication. This experiment
therefore says nothing about whether the selected credential or model would have
completed a turn.

## Source boundary behind the final failure

The Kubernetes Compute path creates and mounts the plugin runtime artifacts that
the dedicated Codex entrypoint consumes. The entrypoint reads
`OPENCLAW_PLUGIN_RUNTIME_MANIFEST`, then writes the Codex configuration under
`CODEX_HOME`; see
[`runtime-entrypoints.ts`](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts).

The OpenShell request builder currently translates `workspaceMounts` into PVC
volumes and adds the projected service-principal volume. It does not translate
the plugin runtime ConfigMap mount; see
[`openshell.ts`](../../apps/controller/src/drivers/sandbox/openshell.ts). During
the experiment, the expected `plugin-runtime-*` ConfigMap existed in the Agent
Namespace, but the provider-owned Pod had no mount at
`/etc/openclaw/plugin-runtime`.

This is a contract gap, not a reason to copy ConfigMap contents through another
test-only PVC bridge. The next design must preserve the complete immutable
Harness workload requirements through the SandboxDriver boundary.

## Recommended next steps

1. Define the complete dedicated Harness projection contract before changing the
   driver. Inventory every native Kubernetes Compute input that the canonical
   process needs: immutable image, command, environment, Secret references,
   runtime ConfigMaps, PVC subpaths, per-Agent ServiceAccount, projected token,
   ports, resources, and security context.
2. Decide which missing shapes require upstream OpenShell support and which
   require a richer OCE SandboxDriver contract. Keep OpenShell-specific
   translation in the OpenShell Driver; do not special-case it in platform core.
3. Require upstream support for the exact Secret references, per-Agent
   ServiceAccount, projected audience-bound token, and immutable runtime
   ConfigMap mounts. Do not use the credential PVC or suspend-and-patch bridges
   as production behavior.
4. Resolve runtime user semantics explicitly. Either OpenShell must honor the
   immutable image user or the admitted workload contract must select a UID that
   the runtime image supports. A test-only image ownership rewrite is not a
   release solution.
5. Extend the positive integration only after the complete request is supported.
   The first success checkpoint must confirm that the canonical app-server is
   listening, not merely that the boundary Pod is Ready. Then require the real
   model turn, workload identity, filesystem and egress enforcement, replacement,
   and cleanup assertions already defined by the positive case.
6. Keep the stock pre.5 negative lane until an upstream version satisfies the
   contract. When selecting a newer version, run the negative and positive cases
   deliberately so a prerequisite failure cannot be mistaken for a successful
   Agent deployment.

## Re-run criteria

Follow the [OpenShell test guide](openshell.md) and use its CI-owned preparation
path. Enable `OCC_TEST_OPENSHELL_SECRET_PROJECTION=1` only when the selected
upstream runtime supports every required projection without a local bridge. A
successful handoff must record all of the following:

- exact OpenShell source tag and immutable gateway, sandbox, and supervisor image
  digests;
- immutable OpenClaw gateway and Codex runtime image digests;
- real Sandbox and provider-owned Agent identities;
- canonical app-server listener and authenticated model-turn evidence;
- exact workload identity and mount assertions;
- filesystem, network, replacement, and cleanup results; and
- test totals with no prerequisite skips.

Do not record credentials, Secret values, temporary kubeconfigs, or local state
paths. The disposable resources from this experiment were removed, and the
credential file used for the run was left untouched.

## Related source

- [OpenShell test setup and supported proof](openshell.md)
- [OpenShell SandboxDriver contract and upstream preconditions](../reference/drivers/openshell-sandbox.md)
- [OpenShell provisioning flow](../flows/openshell-sandbox-provisioning.md)
- [Real OpenShell integration](../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs)
- [OpenShell Kubernetes fixture](../../tests/helpers/openshell-kubernetes-real.mjs)
- [Real gateway model-turn assertion](../../tests/helpers/kubernetes-real.mjs)
