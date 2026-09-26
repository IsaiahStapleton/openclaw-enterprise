# Egress security

> **Historical custom-proxy proposal:** deferred for 0.x by the
> [current disposition](../31-basic-egress-proxy.md#current-disposition).
> The original contracts below are retained for reference.

[Overview](../31-basic-egress-proxy.md) · [Architecture](architecture.md)

The historical design separates network confinement from permission to perform
an operation. C1 constrains workload traffic. C3 adds external credential custody
and authentic execution/requester checks. Read these guarantees with their
trust assumptions and unresolved mechanisms below.

## Assets, actors and trust

The protected assets are provider and model credentials, authority to perform
operations, private service reachability and the integrity of policy and lifecycle
evidence. Untrusted actors include tool code and its descendants, requests that
it constructs, copied bearers and callers outside the assigned workload.

The node, Container Network Interface (CNI), Kubernetes control plane and proxy
remain trusted. The Agent cannot relabel workloads, mutate network policies,
execute privileged or host-network workloads, acquire `NET_ADMIN` or `NET_RAW`,
or mount writable host paths. Separate proxy and workload Pods keep the proxy's
upstream grants outside the workload's network identity.

Compute owns classification and actual resource observation. State owns admitted
selection. Identity owns receiving verification, while IAM and the operation
owner decide permission. A human requester, Agent ServicePrincipal, deployer and
executor are distinct actors. None can be inferred from possession of a repository
session alone.

## Network and protocol threats

A second additive network policy could restore direct access even when the
restricted policy looks correct. The control is the complete
[policy union and positive classification](architecture.md#network-containment),
including managed/adopted Namespaces and Sandbox producers. Only an authorized
selection can enter or leave enforcement. Workload configuration, environment
variables and request headers cannot broaden admitted policy.

DNS can name an allowed origin while returning unusable or forbidden addresses.
The proxy therefore authorizes the original question before lookup, validates the
entire answer set and commits exact numeric peers before answering. It cannot
substitute ambient resolution or a generic private-address exception. The
[DNS procedure](protocol-and-routing.md#dns-admission) owns cache and refresh rules.

Interception trust must not become upstream trust. The workload trusts a public
interception bundle, while the proxy verifies the actual upstream certificate
against independent roots and excludes every admitted interception key from
verified chains. The [TLS procedure](protocol-and-routing.md#tls-and-certificate-custody)
also preserves the signing-key boundary and peer-supplied alternate-chain case.

A valid TLS origin does not validate later HTTP requests. Each request must pass
exact origin, method, escaped-path and query checks. Ambiguous targets, conflicting
framing and unsupported tunnels are refused. Fresh forwarding construction and
restricted transport behavior prevent client-controlled authority from bypassing
those checks. [HTTP streaming](protocol-and-routing.md#http-streaming) owns the
complete rules.

Forbidden destinations and operations fail before unintended upstream application
bytes. Route matching grants neither application authority nor content-loss
prevention. Qualification must observe the denied receiver, because a local
refusal alone does not prove that no bytes escaped.

## Protected authority and custody

**Recorded C1 limit:** `OPENAI_API_KEY` remains in the executing embedded workload,
including the historical probe child's explicit environment. C1 covers traffic
from the admitted, checked network profile. It does not establish external key
custody, verified current execution, copied-key denial outside the Pod or protected
authority withdrawal. These are scope limits, not evidence that C3 is optional.

C3 keeps real model/provider credentials outside tool execution. Substitution
covers only the configured origin and admitted operation. The authentication
renderer and startup probe must use the protected model path without projecting
the provider key into the workload. Dedicated material and repository-consumer
integration remain with the dedicated runtime owner.

Before acquisition and effects, the receiver checks original personal/team
invocation or repository authority, current IAM, exact execution, resource and
operation, authority sequence and the original absolute ceiling. Execution
identity grants no permission. The [RBAC proposal](https://github.com/openclaw/openclaw-enterprise/pull/245)
owns authentic invocation and audience authority. Egress consumes current account
and permission state, including the consequences of the
[human account lifecycle](https://github.com/openclaw/openclaw-enterprise/pull/246),
without inferring a requester from a session or deployer.

Every protected route must reject external, sibling-Agent, copied-bearer and
retired-assignment replay. Forwarded identity strings, headers and serialized
observations cannot create receiving proof. The same native connection, request,
stream and recipient remain owned across waits, with current original waiters and
final effect/result fences as defined by the
[bridge contract](interfaces.md#receiving-bridge).

A relay certificate identifies the relay. Trusted assignment and private ingress
associate its Agent. Pod ingress does not prove the sending container. Stronger
same-Pod origin is separately deferred until the runtime and identity owners can
supply that proof.

## Withdrawal and recorded limits

RBAC and State must order renewal against durable withdrawal. Receivers consume
finite authenticated currentness, preserve original scope and absolute ceiling,
reject stale positive evidence and never revive terminal closure. Renewal-network
loss must independently expire local access. The timing contract still needs its
owner-defined committed starting event, evidence age, request-start/skew rule,
monotonic deadline, cadence and closure reserve.

The selected outcome is at most **30 seconds** from that defined event to both
new-request refusal and the last protected bytes or closure of active exchanges.
Measure both endpoints with blocked consumers, saturated listeners and renewal
loss. Selected stricter five-second contracts prevail within their scope. The
[identity/currentness proposal](https://github.com/openclaw/openclaw-enterprise/pull/247)
owns evidence validity. Egress must implement transport refusal and closure.

Refuse new work synchronously before awaited cleanup. Reserve control capacity,
cancel requests and close sockets even when consumers are blocked. Restart cannot
extend original validity or revive a terminal protected binding. An uncertain
mutation must never be replayed merely because its stream closed.

Use the distinct [close observations](interfaces.md#close-and-observation).
Runtime stop remains pending until Compute observes termination. Independent physical expiry
during control-plane failure is future runtime-owned hardening, not an existing
guarantee.

**Recorded supplier limit:** restart loses provider-token cleanup inventory. Local
session closure does not prove remote token revocation, and tokens can remain
valid until original expiry. Durable cleanup custody and restart/late-settlement
recovery remain credential-owner follow-up if selected. This limit does not waive
the selected local refusal and final-byte bounds.

The proposed earliest-containment mechanism, bootstrap/current-serving join and
bridge producer are unresolved requirements or decisions. They are not accepted
residual risks. [Delivery](delivery.md#decisions-and-follow-ups) identifies their
owners and closure evidence.

## Evidence and closure

Audit and State own bounded, closed observations through the
[observability contract](https://github.com/openclaw/openclaw-enterprise/pull/250).
Egress supplies authentic initiator, executor and authorization references, policy
generation, route ID, decisions, dispatch state, counts and observed or unknown
outcomes. It must not manufacture a durable acceptance or physical result from
diagnostics.

Exclude credentials, key material, headers, cookies, bodies, full queries, raw
URLs or paths and provider errors. Health and diagnostics must remain sanitized.
Evidence failure cannot block local protective refusal or claim a newly committed
stop or revocation. Observation and retention do not extend authority or original
validity. Audit erasure cannot remove durable dispatch/reply fences or authorize
replay.

The service image must run non-root with public roots, a read-only filesystem and
no network-administration capabilities. Pin necessary dependencies and retain
source/modification attribution, notices, licenses and dependency inventory.
These packaging controls complement the trusted-proxy boundary.

[Acceptance evidence](delivery.md#acceptance-evidence) requires the complete
receiver-observed protocol, network and lifecycle negative cases on the installed
artifact. Component tests cannot replace installed CNI denial, live provider
readback or the independent release decision.
