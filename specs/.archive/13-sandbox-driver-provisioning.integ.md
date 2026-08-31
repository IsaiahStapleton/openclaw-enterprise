---
title: SandboxDriver OpenShell Kubernetes integration plan
authors:
  - Kevin Lin
created: 2026-08-26
last_updated: 2026-08-26
status: draft
---

# Integration Plan: SandboxDriver OpenShell Kubernetes

## Purpose

Prove that a real `KubernetesComputeDriver`, OpenShell gateway and controller,
OpenClaw gateway, and dedicated Codex Harness can provision one provider-owned
Sandbox, complete an authenticated model-backed Agent turn, and enforce a
hardcoded outbound allowlist. Use narrowly scoped integration-only adapters for
current OpenShell gaps; do not add production lifecycle methods or claim those
adapters establish production compatibility.

**Implementation specification:**
[SandboxDriver provisioning and lifecycle](13-sandbox-driver-provisioning.md).

**Existing runtime validation:**
[harness-topology-k3d-real.test.mjs](../../tests/integration/harness-topology-k3d-real.test.mjs)
and its [real-cluster helpers](../../tests/helpers/kubernetes-real.mjs).

## Scope and prerequisites

The test uses the existing explicitly selected disposable k3d cluster,
PostgreSQL-backed controller and worker, digest-pinned real OpenClaw and Codex
images, an existing authorized model credential, and enforcing Kubernetes
NetworkPolicies. The fixture additionally installs the real OpenShell gateway,
Agent Sandbox CRD and controller, required operator-managed RBAC, and an
approved RuntimeClass or equivalent disposable-cluster admission configuration.

OpenShell runs in Kubernetes sidecar topology with
`process_binary_aware_network_policy = false`. The trusted network init
container retains its required networking capabilities; the long-running
network sidecar does not require `SYS_PTRACE` or `DAC_READ_SEARCH`. The Codex
Harness remains nonroot, drops all Linux capabilities, and cannot escalate
privileges. Endpoint-level network enforcement remains enabled.

The initial fixture deploys one dedicated Agent in one Namespace. Embedded
execution, per-tool Sandbox creation, credential brokering, binary-specific
network rules, multi-Agent shared-gateway identity, and production-grade port
publication are outside this integration.

## Architecture and ownership

```text
Enterprise Namespace
|
+-- SandboxDriver-provisioned OpenShell gateway infrastructure
|   `-- OpenShell gateway creates and manages Sandbox resources
|
+-- Compute-owned OpenClaw gateway Pod
|   `-- APP_SERVER_TOKEN from its existing Kubernetes Secret
|
+-- Compute-owned Harness Service and NetworkPolicies
|   `-- Route authenticated TCP/WebSocket traffic on port 18790
|
+-- Agent-owned shared workspace PVC
|   `-- Integration-only credential subpath
|
`-- OpenShell-owned Sandbox
    `-- Agent Sandbox controller-owned Harness Pod
        +-- Trusted OpenShell network init container
        +-- Unprivileged OpenShell network sidecar
        `-- Nonroot Codex app-server Harness
```

Compute owns Namespace admission, the Agent gateway, ServiceAccount, shared
workspace PVC, existing Secrets, NetworkPolicies, Services, and revision
activation. OpenShell owns its Sandbox and containment; its controller owns the
Harness Pod. Test-owned credential materialization is disposable fixture
infrastructure, not a new platform resource or supported production behavior.

## Provisioning and lifecycle

Use the existing Compute lifecycle:

1. `ComputeDriver.ensureNamespace` creates the exact Namespace and default-deny
   baseline.
2. The optional `SandboxDriver.ensureNamespace` hook creates or reuses one
   OpenShell gateway and installs its required narrowly scoped bootstrap
   NetworkPolicies before reporting Namespace readiness.
3. Before revision admission, OCC invokes OpenShell's `configureAgent` hook,
   validates its provider-owned Codex configuration, and freezes the result
   alongside the selected `sandboxDriverId`.
4. `ComputeDriver.prepareRevision` creates the OpenClaw gateway, per-Agent
   ServiceAccount, existing transport/model Secrets, shared PVC, inactive
   Harness Service, and revision NetworkPolicies.
5. An integration-only specialization of the real `OpenShellSandboxDriver`
   prepares its temporary credential bridge inside `provisionHarness`, then
   invokes the real provider implementation with an adapted startup command
   and PVC subpath mounts. A SandboxDriver without `provisionHarness` leaves
   ordinary Harness Deployment creation with Compute.
6. The real OpenShell gateway creates one Sandbox. Because stock OpenShell also
   lacks projected-volume configuration, fixture-only operator authority
   suspends that Sandbox, injects the exact approved projected ServiceAccount
   token and read-only Harness mount, then resumes it before Compute observes
   readiness. The Agent Sandbox controller creates the resulting Harness Pod.
7. Compute waits for ordinary workload readiness, identifies the exact
   revision-owned Pod, activates existing Harness routing, and admits a real
   gateway-to-Codex Agent turn.
8. Revision retirement passes the immutable revision to its SandboxDriver,
   which derives and deletes the exact Sandbox even when its Pod is gone.
   Production Compute has no Sandbox custom-resource permissions; Namespace
   deletion removes the Namespace-scoped gateway and fixture-owned helpers.

The credential bridge must complete before creating the Sandbox. An
`onWorkloadReady` callback cannot initialize `APP_SERVER_TOKEN`: the Codex
process and its authenticated readiness probe require that token before the
workload becomes ready. No new Compute lifecycle method is needed.

## Test-only credential bridge

The current OpenShell Kubernetes driver does not expose the required
`secretKeyRef` environment configuration. The integration fixture works around
that limitation without modifying upstream OpenShell:

1. A short-lived fixture-owned Kubernetes Job receives the exact existing
   `APP_SERVER_TOKEN` and `OPENAI_API_KEY` through Kubernetes Secret references.
2. The Job mounts only a revision-scoped credential subpath of the existing
   Agent PVC, writes both values without logging them, and restricts directory
   and file permissions to the Harness UID.
3. The integration SandboxDriver adds a read-only mount of that same subpath at
   `/run/enterprise-credentials`.
4. The startup wrapper loads the files into the normal Codex environment and
   then executes the unmodified dedicated Harness entrypoint:

```sh
export APP_SERVER_TOKEN="$(cat /run/enterprise-credentials/app-server-token)"
export OPENAI_API_KEY="$(cat /run/enterprise-credentials/openai-api-key)"

exec "$@"
```

The credential directory is a sibling of the approved `workspace`, `sessions`,
`generated-images`, `bundled-skills`, and `plugin-skills` subpaths. It must not
appear under `/home/node/workspace`; neither the helper nor the Harness should
mount the PVC root. Delete the helper and credential files during cleanup and
never print values in commands, logs, Agent output, snapshots, or assertions.

This is an explicit test-only deviation: the extra credential PVC mount and
helper Job do not prove production `secretKeyRef` support, brokered delivery,
or the normal guarantee that the model credential exists only in its final
Harness Pod. Use fixture-scoped Kubernetes authority for the helper rather than
granting production Compute broader Secret, Pod, or Job permissions.

Current OpenShell also rejects projected ServiceAccount token volumes in its
gateway driver configuration. Production must fail closed until upstream
supports the exact approved projected volume and read-only Harness mount. The
integration fixture alone may remove the unsupported request field, suspend the
provider-created Sandbox, patch its Pod template with Compute's unchanged
audience, expiration, token path, and read-only mount, then resume the Sandbox
before returning control to Compute. This operator-owned compatibility bridge
does not grant production drivers additional authority or substitute a static
credential or OpenShell gateway token.

If OpenShell requires one existing mount under `/sandbox` to suppress its
default PVC, add a read-only alias of an approved existing subpath for this test.
Never mount the Agent PVC root and record that extra alias as another fixture
deviation rather than production workspace-conformance proof.

## Dedicated WebSocket transport

The OpenClaw gateway and Codex Harness share the existing real
`APP_SERVER_TOKEN`. Codex listens on `0.0.0.0:18790`; the gateway authenticates
its connection to `ws://agent-<id>:18790`. Preserve the Compute-owned Service,
expected revision labels, and existing gateway-to-Harness NetworkPolicies.

Use direct Service-to-Sandbox-Pod routing. OpenShell sidecar topology exposes
the provider-owned Pod through the existing Compute-owned selector-based
Service and narrowly scoped NetworkPolicies:

```text
OpenClaw gateway -> Compute-owned Service -> OpenShell Harness Pod
```

The real integration has verified this native route against OpenShell
`v0.0.113`; no forwarding Pod, supervisor relay, or alternate routing adapter
is needed. If direct routing fails, fail the integration explicitly.

## Hardcoded outbound network policy

Configure OpenShell with default-deny egress and an endpoint allowlist
equivalent to:

```yaml
network_policies:
  openclaw:
    name: openclaw
    endpoints:
      - host: www.openclaw.org
        port: 443

  model_provider:
    name: model-provider
    endpoints:
      - host: api.openai.com
        port: 443
```

Add only the actual model/authentication hosts required by the selected Codex
credential and model. Do not allow `acme.com`. DNS, OpenShell gateway callbacks,
and trusted control-plane traffic are infrastructure prerequisites, not
blanket user-egress exceptions.

Kubernetes NetworkPolicy must permit the OpenShell network sidecar's approved
outbound path and gateway-to-Harness transport while retaining the existing
default-deny baseline. OpenShell performs hostname-level allow/deny enforcement
inside that Kubernetes network envelope. Additive Kubernetes policies must not
silently make denied Agent traffic reachable outside the OpenShell boundary.

## Integration driver and fixture boundary

Construct the normal Compute implementation with an integration-only
specialization of the real provider driver:

```ts
class IntegrationOpenShellSandboxDriver extends OpenShellSandboxDriver {
  async provisionHarness(context: SandboxHarnessContext) {
    await this.writeIntegrationCredentials(context);

    return super.provisionHarness({
      ...context,
      requirements: this.withCredentialFiles(context.requirements),
    });
  }
}
```

`withCredentialFiles` adds the read-only credential subpath mount, removes
unsupported Secret-reference environment entries from the provider request, and
wraps the existing Harness command. The fixture must not replace OpenShell's
gateway, controller, policy engine, process supervisor, or actual Harness.

Current OpenShell selects its sandbox ServiceAccount at the gateway level. If
the installed version cannot bind Compute's per-Agent ServiceAccount, either
configure the single-Agent fixture's gateway to use that exact account before
Sandbox creation or report per-Agent identity as an unresolved integration
blocker. Never silently substitute a shared provider account and describe the
test as preserving Enterprise workload identity.

## Automated acceptance checks

The end-to-end case must use the real controller API and worker to create and
deploy a dedicated Agent, then assert:

1. Namespace readiness waits for an actual, reusable OpenShell gateway and its
   required NetworkPolicies.
2. Exactly one revision-owned OpenShell Sandbox and one provider-controlled
   Harness Pod are created; duplicate reconciliation does not create another
   gateway or Sandbox.
3. The Harness uses the expected Agent ServiceAccount and preserves its exact
   audience-bound, short-lived projected ServiceAccount token, approved
   workspace subpaths, revision labels, and unprivileged security context.
   Explicitly identify any integration-only extra mounts.
4. The network sidecar has no binary-inspection capabilities when binary-aware
   policy is disabled; only approved OpenShell init privileges remain.
5. The OpenClaw gateway authenticates to the actual Codex app-server with the
   real shared transport token, and a real provider-backed model turn succeeds.
6. During a real Agent tool invocation,
   `curl -fsS https://www.openclaw.org/` succeeds and
   `curl -fsS https://acme.com/` fails because OpenShell denies that endpoint.
   Preserve provider deny evidence without recording credentials.
7. The existing Compute-owned Service routes directly to the actual provider
   Harness Pod without a forwarding Pod or supervisor relay.
8. Unsupported embedded execution, missing credentials, a missing gateway,
   failed direct routing, or an unready Sandbox fails closed.
9. Retirement removes the provider-owned Sandbox, credential-writer Job,
   credential files, and test-created Namespace.

Extend or reuse
[harness-topology-k3d-real.test.mjs](../../tests/integration/harness-topology-k3d-real.test.mjs)
and [kubernetes-real.mjs](../../tests/helpers/kubernetes-real.mjs). The final run
must use a disposable enforcing k3d cluster, real OpenShell/OpenClaw/Codex
images, an authorized existing model credential, and zero skipped requested
cases. A mocked provider, readiness-only probe, fixture-generated model reply,
or command run outside the sandboxed Harness does not satisfy this plan.

## Existing validation and remaining gaps

The real OpenShell integration has verified sidecar-mode direct Pod routing,
an authenticated provider-backed model turn, endpoint allow/deny enforcement,
provider workload ownership, approved workspace mounts, revision replacement,
and cleanup against OpenShell `v0.0.113`.

Production integration still requires upstream support for per-Sandbox
ServiceAccount selection, projected ServiceAccount token volumes with
read-only Harness mounts, and Kubernetes `secretKeyRef` environment entries.
The real fixture works around those gaps explicitly; its gateway-level
ServiceAccount selection, operator-owned projected-token Pod-template patch,
and temporary credential bridge do not establish production compatibility.
Missing prerequisites must remain explicit blockers, not hidden behind a mock
or described as production conformance.

## References

- [SandboxDriver provisioning and lifecycle](13-sandbox-driver-provisioning.md)
- [Dedicated Harness shared workspace](12-dedicated-harness-shared-workspace-drive.md)
- [OpenShell Kubernetes driver](https://github.com/NVIDIA/OpenShell/blob/main/crates/openshell-driver-kubernetes/README.md)
- [OpenShell sandbox architecture](https://github.com/NVIDIA/OpenShell/blob/main/architecture/sandbox.md)
- [OpenShell Kubernetes Service exposure](https://github.com/NVIDIA/OpenShell/issues/1791)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-27 00:19]: Required the exact projected ServiceAccount identity and
  documented the test-only compatibility bridge for stock OpenShell.
  (019ff887-0245-7f71-81bd-e4ab86c4ab59 - f4211e5)
- [2026-08-26 23:44]: Simplified provider provisioning to optional namespace and
  Harness hooks, persisted only the SandboxDriver identity, and documented
  verified direct Pod routing without speculative relay infrastructure.
  (019ff887-0245-7f71-81bd-e4ab86c4ab59 - cf37c14)
- [2026-08-26 15:42]: Added the real OpenShell dedicated-Harness integration
  plan, temporary PVC credential delivery, direct versus relay-backed Codex
  WebSocket routing, endpoint allow/deny proof, scoped fixture deviations, and
  concrete Kubernetes acceptance checks.
  (01a04011-841f-7c60-ab3f-82411ef117d0)
