# Egress delivery and qualification

[Overview](../31-basic-egress-proxy.md) · [Architecture](architecture.md)

C0, C1, C2 and C3 remain selected. Each needs its own connected consumer and
acceptance evidence. Historical acceptance authorizes implementation work, and
separate supplier contracts support only their demonstrated source scope. This
RFC grants no deployment or release qualification.

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
