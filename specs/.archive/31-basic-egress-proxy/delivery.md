# Egress delivery and qualification

**Status:** Superseded

> **Historical custom-proxy proposal:** deferred for 0.x by the
> [current disposition](../../40-agent-egress-0x.md#current-disposition).
> The original contracts below are retained for reference.

[Overview](../../40-agent-egress-0x.md) · [Architecture](architecture.md)

C0–C3 remain selected within the historical custom-proxy proposal, now deferred
for 0.x. Each retains its connected consumer and acceptance requirements. Earlier
implementation acceptance and separate supplier source do not establish current
0.x approval, installed behavior or release qualification.

## Increments and qualification

**C0 — contract readiness.** Review the accepted RFC with real policy, admission,
State, Compute and Go producer/consumer contracts. Fix the first runtime and
enforcing CNI, trusted resolvers, finite bounds, immutable runtime/service images,
certificate preparation/custody and owned close before their implementation.
Reserve the next available migration through the State owner and preserve existing
credential extensions. A draft migration filename does not fix shipping order.

**C1 — ordinary embedded confinement.** Through real API, IAM and PostgreSQL
admission/readback, an authorized user creates native Configuration and an embedded
OpenClaw Agent with its API-key Secret and provisioned transport. Prove worker
persistence and reauthorization, real DNS/TLS/HTTP peers, Compute lifecycle and
packaging. On one installed artifact and explicitly selected enforcing cluster,
the actual authentication probe passes, the gateway streams configured
`POST https://api.openai.com/v1/responses`, and a real tool child completes an
approved HTTPS request. An explicitly open Agent on the same pinned runtime is
the compatibility control. C1 requires neither gVisor nor workload identity and
retains its [tool-visible credential limit](security.md#protected-authority-and-custody).

**C2 — genuine repository contribution.** Consume the credential owner's exact
reviewed implementation through its exported Driver/runtime binding. An ordinary
Agent uses actual managed Git/`gh` to clone/fetch, edit, commit, perform an
admitted push and create a same-repository PR. Deliberately authorize `git-full`
and retain an explicit `git-read` control. Prove profile and direct-bypass denial,
exact private routing, live provider readback and cleanup or uncertainty. Embedded
C2 does not wait for dedicated delivery.

**C3 — dedicated protected composition.** First fix real authority, current-serving,
identity verification, repository receiving and safe-fact exports with their
owners. One installed artifact must then join authentic requester authority,
protected model/probe/repository use, external model custody, dedicated gVisor and
off-Pod replay denial. Prove rotation, replacement, concurrent withdrawal and
renewal loss, including both new-request refusal and final-byte/active-exchange
closure endpoints. The [identity](https://github.com/openclaw/openclaw-enterprise/pull/247)
and [gVisor](https://github.com/openclaw/openclaw-enterprise/pull/248) proposals own
their consumers. Their source interfaces alone do not satisfy the join.

Preserve the accepted C1 commit, tree and evidence manifest. Continue C2/C3 through
genuine reviewed supplier joins. Backport demonstrated C1 defects with the
smallest reviewed regression fix, then bring the accepted fix forward. An early
checkpoint must not erase later selected delivery.

## Acceptance evidence

Source/component checks establish individual behavior. Composed checks establish
interactions in their tested composition. Installed-runtime checks establish the
selected image, runtime and networking behavior. Live-provider checks establish
actual external effects and readback. Release readiness is a separate decision.
Keep these evidence classes distinct in every result.

Required negative cases include:

- **DNS:** Mixed permitted/forbidden answers, rebinding and malformed answers.
- **TLS and HTTP:** Wrong or overlapping upstream certificates, SNI/Host mismatch,
  ambiguous targets or framing, later keepalive requests and unsupported tunnels.
- **Lifecycle:** Blocked streaming consumers, saturation, restart and replacement.
- **Network:** Direct IP, alternate DNS, DNS-over-TLS, DNS-over-HTTPS, IPv6/QUIC,
  sibling, private/metadata, node-local/host-network and forbidden platform paths.
  Exact admitted internal peers are the bounded exception.

Denied receivers must observe no unintended application bytes. Measure the
resolver Service-VIP/backend path and required node/private-path denial on the
selected tuple. Basic CNI receiver evidence is not complete egress-bypass closure.
Verify the [required private status path](architecture.md#network-containment)
across actual API-proxy and dedicated gateway peers on that CNI/overlay. Confirm
successful current status, denial for unrelated peers and withheld readiness when
required status is unavailable. The before-readiness containment requirement is
mandatory. The proposed before-any-untrusted-instruction mechanism remains
separately unqualified.

C3 additionally proves original requester authority, execution authentication,
external model custody and protected repository receiving together. Exercise
external, sibling-Agent, copied-bearer and retired-assignment denials on every
protected route. Include concurrent waiters and renewal loss in measured
withdrawal. Local route closure, provider settlement and observed physical stop
need separate results.

Use a non-root, read-only service image with public roots and no network
administration capabilities. Pin necessary dependencies and retain the license
inventory. Retain source, tree, build and image digests, runtime/CNI identity,
policy/material versions, receiver results and credential limits. Genuine managed
contribution also retains provider readback and cleanup/uncertainty on the consumed
source. No required installed case may be skipped or replaced by a fixture.

Follow the [Kubernetes verification guide](https://github.com/openclaw/openclaw-enterprise/blob/724dcb5cb80b5e76a62e8267a21185a2e91a85c2/docs/testing/kubernetes.md).
Update Agent, Compute, networking, Harness and affected deployment, credential
and testing references under the [platform design](https://github.com/openclaw/openclaw-enterprise/blob/724dcb5cb80b5e76a62e8267a21185a2e91a85c2/docs/design.md).
Documentation checks establish none of the runtime gates above.

## Source status and owner dependencies

The earlier supplier record remains historical. A separate unmerged Go supplier
provides bounded policy/startup work, not composed listeners or installed CNI
proof. State owns the bounded admission and persistence changes, reserves the
next available migration, and preserves accepted credential extensions. Draft
migration filenames do not determine shipping order. SQL and ordinary Agent-flow
evidence remain required.
The separate [identity declarations](interfaces.md#receiving-bridge) at `65380694`
do not supply the missing native listener bridge. The
[native model adapter](https://github.com/openclaw/openclaw-enterprise/blob/65380694085693d6edb5218372ccddbc2ba493d9/docs/flows/external-model-egress.md)
explicitly lacks a controller or Harness caller. These are source observations,
not a composed acceptance record.

The September 25 observation at `5b49801b6332dbd516df250c72a47820ff918208` records that
[RepoDriver](https://github.com/openclaw/openclaw-enterprise/blob/5b49801b6332dbd516df250c72a47820ff918208/packages/contracts/src/repo.ts) supports embedded OpenClaw and
dedicated Codex. [Compute](https://github.com/openclaw/openclaw-enterprise/blob/5b49801b6332dbd516df250c72a47820ff918208/apps/controller/src/drivers/compute/kubernetes/index.ts#L1257-L1281)
refuses repository credentials with a SandboxDriver. Main's
[model-egress builder](https://github.com/openclaw/openclaw-enterprise/blob/5b49801b6332dbd516df250c72a47820ff918208/apps/controller/src/drivers/compute/kubernetes/index.ts#L6834-L6863)
retains broad public IPv4 TCP/443, while the
[embedded probe](https://github.com/openclaw/openclaw-enterprise/blob/5b49801b6332dbd516df250c72a47820ff918208/apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts#L1182-L1225)
consumes the selected model credential. These facts do not establish the
historical protected route or external custody.

The September 25 source refresh adds a Compose-backed OpenShell development
control plane alongside the Kubernetes-only default. The separate gateway runs in
`openshell-system` in Compose mode and `oce-system` in Kubernetes-only mode.
Both prepare operator Workspaces. Their
[qualification procedures](https://github.com/openclaw/openclaw-enterprise/blob/5b49801b6332dbd516df250c72a47820ff918208/docs/testing/openshell.md) distinguish infrastructure
readiness from Agent creation and model turns. Stock pre.7 production projections
remain refused, and the [first-Agent helper](https://github.com/openclaw/openclaw-enterprise/blob/5b49801b6332dbd516df250c72a47820ff918208/scripts/first-agent.mjs#L114-L147)
rejects OpenShell before external calls. Neither development profile is suitable
for a shared cluster or container network.

Production [Helm networking](https://github.com/openclaw/openclaw-enterprise/blob/5b49801b6332dbd516df250c72a47820ff918208/deploy/helm/openclaw-enterprise/templates/networkpolicies.yaml)
adds optional API-only TCP/443 to operator-maintained IPv4 `/32` model-discovery
hosts. Empty defaults grant none. This does not change Harness egress or constrain
services sharing an IP. The private Envoy proxy now inherits the trusted
control-plane node selector. Dedicated Gateway and Harness selectors remain
separate operator settings. The [EKS guide](https://github.com/openclaw/openclaw-enterprise/blob/5b49801b6332dbd516df250c72a47820ff918208/docs/guides/deploy/eks.md)
requires disjoint Ready pools, node-image seccomp provisioning, CSI prerequisites
and actual webhook peers. Source changes do not prove installed enforcement.

At that same pin, [Independent production image upgrades](https://github.com/openclaw/openclaw-enterprise/blob/5b49801b6332dbd516df250c72a47820ff918208/specs/36-coordinated-image-upgrade.md)
is a proposed workflow. Its controller/runtime separation, fleet convergence and
recovery requirements are not implemented upgrade guarantees or egress closure.
It does not change this RFC's historical C0–C3 status or select a new proxy.

**September 26 source observation:** main `e387b38cc259ee4a55936ecb848bbce8210bcd68`
contains the [production-upgrade script](https://github.com/openclaw/openclaw-enterprise/blob/e387b38cc259ee4a55936ecb848bbce8210bcd68/scripts/upgrade-production-images),
authorized [deployment inventory API](https://github.com/openclaw/openclaw-enterprise/blob/e387b38cc259ee4a55936ecb848bbce8210bcd68/docs/reference/api.md#get-installationdeploymentinventory)
and [CLI inventory/status commands](https://github.com/openclaw/openclaw-enterprise/blob/e387b38cc259ee4a55936ecb848bbce8210bcd68/docs/reference/cli.md).
The script uses complete inventory and ordinary deployment admission, reloads
configuration through a Helm checksum, and checks exact replacement revisions,
workload images/readiness and Doctor results. These are source capabilities.
Installed fleet upgrades and provider qualification were not performed here.
The earlier observation and historical specification status remain unchanged.
Upgrade source does not close this RFC's egress requirements.

## Decisions and follow-ups

The remaining choices have named owners and binding outcomes:

- **Compute, Harness, identity and credential owners:** select the exact peer,
  authenticated Go–TypeScript bridge and protected bootstrap probe producers.
  Close the [receiving contract](interfaces.md#receiving-bridge) with actual
  same-connection/request/recipient custody, current waiters and final fences.
  Prove immutable delivery, current-serving selection and predecessor withdrawal.
- **Security, Compute and CNI owners:** decide and qualify the proposed
  [earliest containment](architecture.md#protected-receivers) mechanism. Creation,
  readback and a fixed delay do not acknowledge enforcement.
- **Authority and receiver owners:** specify timing mechanics and demonstrate
  [both withdrawal endpoints](security.md#withdrawal-and-recorded-limits),
  preserving original scope and deadlines under blocked or saturated conditions.
- **Installation/product and authority owners — proposal:** distinguish
  prospective default edits from explicit audited withdrawal of existing weaker
  admissions. Fix finite offered tuples, affected revisions/sessions, effective
  event and renewal eligibility. No grace period, automatic downgrade or
  retroactive assurance is selected. Changed requirements need fresh admission.
  Live enforced sessions retain their requirements until closure.

These choices do not remove C2/C3 or waive their guarantees. Separately triggered
future work remains bounded:

- Additional runtimes, providers, protocols or pooling need a named consumer and
  Compute/Harness/Go route, custody and closure qualification.
- Stronger same-Pod origin needs runtime/identity proof of the sending container.
- Independent physical expiry during OCC/Compute failure needs runtime-owned
  enforcement and measured observed termination.
- Stronger provider cleanup recovery, if selected, belongs to the credential
  owner. It requires durable custody plus restart, late-settlement and provider
  readback evidence.
