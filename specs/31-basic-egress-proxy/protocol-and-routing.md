# Egress protocol and routing

> **Historical custom-proxy proposal:** deferred for 0.x by the
> [current disposition](../31-basic-egress-proxy.md#current-disposition).
> The original contracts below are retained for reference.

[Overview](../31-basic-egress-proxy.md) · [Interfaces](interfaces.md)

The restricted proxy admits a name, binds it to vetted numeric peers, verifies TLS
and checks each HTTP request. Each decision has its own scope and lifetime. These
procedures and the [policy/startup contracts](interfaces.md) are proposed behavior
requiring connected listeners and installed qualification.

## DNS admission

The initial public-origin profile supports bounded UDP and TCP DNS, IPv4 A answers
and hostname HTTPS. Unsupported question types receive controlled negative
responses. An internal name or proxy Service address belongs to a separate
admitted address class, never a generic allow-private exception.

1. **Authorize the original question.** Canonicalize the requested name and check
   it against admitted policy before querying a resolver. CNAME traversal cannot
   grant authority to a question that was originally forbidden.
2. **Use fixed resolvers.** Send the query only to admitted numeric resolver
   endpoints. Bound concurrency, message size, CNAME depth and answer count. No
   ambient resolver or alternate DNS fallback is permitted.
3. **Validate the entire answer.** Require continuous name resolution and reject
   loops or broken continuity. Reject the whole answer set if any address is
   forbidden or unusable. Public-origin peers must be globally routable.
   This excludes IANA non-public classes, including benchmark and documentation
   ranges, even if another address in the response is acceptable.
4. **Commit before answering.** Record vetted numeric peers under the exact
   binding, policy generation and original origin. Only then answer the workload
   with the proxy address. Subsequent upstream dialing uses that committed set.
5. **Expire without extension.** Bound cache size and time to live (TTL). Once
   DNS admission expires, a fresh dial requires new resolution and validation.
   A failed refresh cannot extend stale data.

The [IANA registry](https://www.iana.org/assignments/iana-ipv4-special-registry/)
provides the special-address classifications. The proxy Service and exact
internal routes do not inherit the public-origin classification rule. Their
separate admission must identify the intended peer and allowed ports.

DNS expiry controls new dialing. It need not terminate an otherwise valid
existing stream. Policy/authority expiry, explicit stop and retirement retain
their independent cancellation rules under [bounds and closure](#bounds-and-closure).
This distinction prevents a cache refresh from becoming a renewal of authority.

## TLS and certificate custody

Server Name Indication (SNI) is the name sent by a TLS client before HTTP begins.
The proxy requires an exact admitted DNS SNI and a prepared leaf certificate with
the matching Subject Alternative Name (SAN). It rejects missing or IP-literal SNI
and unsupported protocols. A route cannot be added by presenting a different name
at the handshake.

Compute and the material owner prepare a finite set of exact-origin certificates
using existing Kubernetes Secret ownership. Certificate-authority signing keys
stay outside both the proxy service and tool execution. The workload receives
only public interception trust. The proxy receives only the necessary short-lived
leaf keys and their certificate chains, plus a separately owned upstream CA
bundle. There is no runtime issuer. New origins and replacements require newly
admitted material.

Probe, gateway and tool child must receive that public trust through the pinned
runtime's supported mechanism and continue normal TLS verification. A configured
bundle that the real child never consumes is insufficient.

For upstream TLS:

1. Select an admitted numeric peer from the current DNS binding.
2. Dial that peer while preserving the original DNS name as `ServerName`.
3. Verify the upstream certificate against independent public roots before
   forwarding application bytes.
4. Reject every actual verified chain containing any admitted interception key,
   including an alternate chain supplied only by the peer.

Merely configuring distinct root files does not satisfy the last rule.
[Startup validation](interfaces.md#dataplane-startup) must check complete origin
material, certificate validity, supported handshake key usage and independent
trust. Those checks cannot establish peer-only alternate-chain exclusion at a
live TLS connection. Startup validation and that runtime requirement remain
separate evidence.

## HTTP streaming

The initial profile uses HTTP/1.1 and supports streamed model responses. Every
request must be checked, including later requests on a downstream keepalive
connection. Successful TLS validation does not authorize the next request.

1. Match the request's origin and port to the admitted TLS origin.
2. Match the exact case-sensitive method and escaped path against the route.
3. Apply the explicit query policy. `none` accepts no query. `exact` compares the
   original raw query bytes, preserving parameter order and escapes.
4. Reject ambiguous or unsupported input before forwarding.
5. Construct a fresh upstream request with fixed authority and framing. Remove
   or sanitize hop-by-hop headers rather than forwarding the caller's transport
   assumptions.
6. Stream only within the admitted response and time bounds.

The refusal rules are independent:

- Reject absolute-form targets and ambiguous encoded separators or dot segments.
- Reject conflicting message framing.
- Reject `CONNECT`, protocol upgrades and unsupported HTTP versions.
- Reject DNS-over-HTTPS operations, including the prohibited query-key form.

The [policy contract](interfaces.md#selection-and-policy) supplies the concrete
path and query validation. Query keys are split at `&` and the first `=`, then
decoded once as UTF-8 form data, where `+` means space. A key equal to `dns` under
ASCII case-insensitive comparison is forbidden. Values remain opaque. This
validation does not normalize the bytes used for exact matching.

No ambient proxy configuration or automatic redirect following is permitted.
Upstream connection reuse is initially disabled. Downstream keepalive still
requires the per-request checks above. Never retry an uncertain mutation after
dispatch, including on the C1 forwarding path. Closing a stream does not establish
that the upstream operation did not occur.

The first fixture is configured `POST https://api.openai.com/v1/responses`.
It is not a platform provider constant. Add bootstrap routes only when the
pinned runtime demonstrably requires them. Each added route needs policy and
material admission through the same owners.

## Bounds and closure

Installation supplies finite values through [EgressLimitsV1](interfaces.md#selection-and-policy).
The service must bound DNS work, connections, handshakes, goroutines, headers,
request bodies, response bodies, dialing, response-header waits, idle time,
streams and shutdown. Concurrency and cache limits constrain resource use as well
as elapsed time.

Reserve control and close capacity under saturation. Otherwise the requests that
consume capacity could prevent their own cancellation. A blocked streaming
consumer cannot delay admission withdrawal or socket closure indefinitely.

Stop, retirement, applicable local expiry and process shutdown are terminal
triggers. The service must:

1. Deny new admissions before awaiting cleanup.
2. Cancel owned requests and close sockets.
3. Retain a safe terminal reason and expose only sanitized observations.
4. Leave physical termination to Compute's observation of the owned resource.

Failed setup or stale generation closes readiness and access. Restart extends no
original absolute validity and revives no terminal protected binding. When a C1
policy has no expiry, this proposal does not invent a lease. C3 still requires its
original authority deadline and independently progressing local expiry.

[Authenticated Compute lifecycle and process shutdown](interfaces.md#close-and-observation)
own closure of the exact proxy role, generation and original object UID. Repeated
cleanup must preserve a successor. The service's private close is idempotent and
terminal. Pending or unknown cleanup is not observed completion.

The [protected withdrawal contract](security.md#withdrawal-and-recorded-limits)
adds currentness renewal and measured refusal/final-byte endpoints. Record its
distinct results through the [close observations](interfaces.md#close-and-observation).
Neither uncertainty nor a lost response permits replay of a mutation.

## Private repository route

C2 consumes the credential owner's exact reviewed Driver/runtime binding. Managed
Git and `gh` use their own session configuration, allowlisted environment, service
CA and exact admitted private peer. Model interception cannot substitute for this
route, and direct GitHub access cannot replace the credential service.

The [repository credential supplier](https://github.com/openclaw/openclaw-enterprise/blob/eb52cc4cfe68f08017e7ece6585fe7e937e0747a/docs/reference/repository-credentials.md)
retains parsing, repository authorization, profiles, sessions, custody, dispatch,
deadlines and uncertain effects. Egress adds no duplicate credential service.
A revision-owned session does not identify the human requesting each operation.

Contribution deliberately authorizes `git-full`, with `git-read` as an explicit
control. The supplier's `git-full` ceiling includes its admitted Git, selected
REST, GraphQL, PR, issue and comment operations. It is broader than a single-PR
capability, and GraphQL uses the installation-token grant without per-field
authorization. The [delivery proof](delivery.md#increments-and-qualification)
must exercise the actual admitted profile and direct-bypass denials.

The supplier loses provider cleanup inventory on restart. Local session closure
does not prove provider-token revocation, and tokens can survive until original
expiry. Keep cleanup uncertainty visible. C3's dedicated material and receiving
integration must preserve these credential-owned outcomes while adding authentic
execution and requester authority.
