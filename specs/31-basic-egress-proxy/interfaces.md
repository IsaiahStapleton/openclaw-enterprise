# Egress interfaces

> **Historical custom-proxy proposal:** deferred for 0.x by the
> [current disposition](../31-basic-egress-proxy.md#current-disposition).
> The original contracts below are retained for reference.

[Overview](../31-basic-egress-proxy.md) · [Admission order](architecture.md#admission-and-preparation)

This page owns the RFC's complete proposed policy, resolution and startup
contracts, followed by lifecycle and protected receiving requirements. These
shapes do not establish an implemented interface or installed confinement.
Unresolved owner decisions remain explicit below.

## Selection and policy

Installation supplies permitted modes, named policy generations and defaults.
OCC must authorize the exact Agent and all referenced resources. Only authorized
selection can change enforcement. Omitted input resolves to a materialized
operator default. Without Installation configuration, compatibility is explicit
open. Existing persisted Agents receive explicit open selection.

The proposal defines these closed selection, route, peer, limits, policy and
snapshot shapes:

```ts
export type EgressSelection =
  { readonly mode: "open" } | { readonly mode: "restricted"; readonly policyId: string };

/**
 * Exact values are raw queries without a leading '?'. Keys are split on '&'
 * and the first '=', decoded once as UTF-8 form data ('+' means space), and
 * must not equal ASCII-case-insensitive 'dns'. Values remain opaque. Matching
 * preserves the original raw bytes, including parameter order and escapes.
 */
export type EgressQueryRule =
  { readonly mode: "none" } | { readonly mode: "exact"; readonly value: string };

export interface EgressRouteV1 {
  readonly id: string;
  /** Canonical HTTPS origin, including the fixed :443 port and no trailing slash. */
  readonly origin: string;
  readonly methods: readonly string[];
  readonly escapedPaths: readonly string[];
  readonly query: EgressQueryRule;
}

/** An exact, separately admitted internal DNS/network destination. */
export interface EgressInternalPeerV1 {
  readonly id: string;
  readonly dnsName: string;
  readonly ipv4: string;
  readonly ports: readonly { readonly protocol: "TCP" | "UDP"; readonly port: number }[];
}

export interface EgressLimitsV1 {
  readonly dnsConcurrency: number;
  readonly dnsCacheEntries: number;
  readonly dnsMaxCNAMEChain: number;
  readonly dnsMaxAnswers: number;
  readonly dnsMaxMessageBytes: number;
  readonly dnsMaxTTLSeconds: number;
  readonly maxConnections: number;
  readonly maxConcurrentRequests: number;
  readonly maxHeaderBytes: number;
  readonly maxRequestBodyBytes: number;
  readonly maxResponseBodyBytes: number;
  readonly dnsTimeoutMs: number;
  readonly tlsHandshakeTimeoutMs: number;
  readonly dialTimeoutMs: number;
  readonly responseHeaderTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly streamTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

export interface EgressPolicyDocumentV1 {
  readonly version: 1;
  readonly policyId: string;
  readonly generation: number;
  /** Compute-owned identifiers for the supported runtime and network tuple. */
  readonly runtimeProfile: string;
  readonly networkProfile: string;
  readonly routes: readonly EgressRouteV1[];
  readonly internalPeers: readonly EgressInternalPeerV1[];
  readonly limits: EgressLimitsV1;
  /** Original absolute expiry, when the admitted policy has one. */
  readonly expiresAt?: string;
}

export type EgressRevisionSnapshot =
  | { readonly mode: "open" }
  | {
      readonly mode: "restricted";
      readonly policy: EgressPolicyDocumentV1;
      readonly digest: string;
    };
```

The proposed admission helpers validate or detach values
without creating resources. Invalid input throws an error rather than returning
a permission result:

```ts
export function admitEgressSelection(value: unknown): EgressSelection;
export function admitEgressPolicy(value: unknown): Readonly<EgressPolicyDocumentV1>;
export function egressPolicyDigest(policy: EgressPolicyDocumentV1): string;
export function freezeEgressRevisionSnapshot(value: unknown): EgressRevisionSnapshot;
```

Admission rejects unknown or missing fields. Policy IDs, route/peer IDs and profile
identifiers match `[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}`. Generation is a positive safe
integer. `expiresAt`, when present, is an exact UTC timestamp with milliseconds
such as `2026-09-20T12:00:00.000Z`. Its absence does not create a C1 lease.

A policy has 1–256 uniquely identified routes. Origins are canonical lowercase
DNS HTTPS origins with explicit `:443` and no trailing slash. DNS names have
at most 253 characters, 1–63-character labels and an alphabetic-leading final label. Each route has 1–7
unique methods from `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, and
1–128 unique escaped paths. Paths begin with one `/`, contain at most 4,096
characters and reject invalid/noncanonical escapes, query/fragment delimiters,
backslashes, encoded separators, encoded percent signs and decoded dot segments
or control/space characters.

Exact queries contain 1–4,096 visible ASCII characters without a leading `?`,
fragment marker, backslash or malformed/noncanonical escape. Keys must decode
successfully and cannot equal ASCII-case-insensitive `dns`. Raw bytes remain
unchanged for matching. [HTTP routing](protocol-and-routing.md#http-streaming)
owns the decoding and request procedure.

There are at most 128 internal peers, with unique IDs and canonical DNS names
that do not overlap public-origin names. Each has an IPv4 address excluding `0.0.0.0` and multicast, plus 1–16
unique TCP/UDP port pairs in 1–65,535. These are internal-peer constraints, not
proof that an address is a globally routable public-origin peer.

Every limit is a positive safe integer. These are contract maxima, not operational
defaults:

| Field                                                                         |            Maximum |
| ----------------------------------------------------------------------------- | -----------------: |
| `dnsConcurrency`                                                              |              4,096 |
| `dnsCacheEntries`                                                             |             65,536 |
| `dnsMaxCNAMEChain`                                                            |                 16 |
| `dnsMaxAnswers`                                                               |                256 |
| `dnsMaxMessageBytes`                                                          |             65,535 |
| `dnsMaxTTLSeconds`                                                            |             86,400 |
| `maxConnections`, `maxConcurrentRequests`                                     |        65,536 each |
| `maxHeaderBytes`                                                              |          1,048,576 |
| `maxRequestBodyBytes`, `maxResponseBodyBytes`                                 | 1,073,741,824 each |
| `dnsTimeoutMs`, `tlsHandshakeTimeoutMs`, `dialTimeoutMs`, `shutdownTimeoutMs` |        60,000 each |
| `responseHeaderTimeoutMs`, `idleTimeoutMs`                                    |     3,600,000 each |
| `streamTimeoutMs`                                                             |         86,400,000 |

DNS message size is at least 512 bytes. Concurrent requests cannot exceed
connections. Canonical policy JSON is at most 512 KiB. Admission detaches and
freezes the policy. The digest is `sha256:` plus the SHA-256 of admitted JSON with
recursively sorted object keys and unchanged array order. Snapshot freezing
revalidates the digest.

The immutable AgentRevision stores the effective mode and this snapshot, including
policy identity/generation, exact routes, internal peers, tuple, bounds and
applicable original expiry. The [original State transaction](architecture.md#admission-and-preparation)
also owns mandatory admission evidence and reconcile intent. Neither a later
default nor retry can mutate that accepted selection.

## Compute resolution

The proposed optional ComputeDriver method is an internal capability check,
not an HTTP endpoint:

```ts
resolveEgressPolicy?(input: ComputeEgressResolutionInput): Promise<ComputeEgressResolutionResult>;
```

```ts
export interface ComputeEgressResolutionInput {
  readonly namespace: Readonly<Namespace>;
  readonly agent: Readonly<Agent>;
  readonly harness: RevisionHarnessDescriptor;
  readonly harnessAuth: HarnessAuthSnapshot;
  readonly configuration: Readonly<Configuration>;
  /** Undefined asks the selected Driver for its operator-configured default. */
  readonly selection?: EgressSelection;
}

export type ComputeEgressResolutionResult =
  | { readonly status: "resolved"; readonly egress: EgressRevisionSnapshot }
  | { readonly status: "denied"; readonly code: "selection_not_permitted" | "policy_unavailable" }
  | { readonly status: "unsupported"; readonly code: "unsupported_profile" };
```

The referenced Namespace, Agent, Harness and Configuration types retain their
Contracts ownership. Trusted OCC supplies these exact records. Resolution creates
or changes no workload resource. `resolved` returns an admitted snapshot.
`denied` distinguishes disallowed selection from unavailable policy.
`unsupported` rejects the offered runtime/network combination before effects.
No result creates application authority.

`runtimeProfile` and `networkProfile` identify the qualified installation tuple.
They are distinct from a Kubernetes Pod class label. A valid digest cannot make
an unsupported tuple usable. Workers validate the persisted policy and selected
Driver and reauthorize dispatch, without re-resolving defaults. Finite offered
tuples and absence-of-capability admission wiring remain owner implementation
gates. No error-to-open fallback is selected.

## Dataplane startup

Trusted Compute preparation produces this private input for the Go service:

```ts
export interface EgressDataplaneConfigV1 {
  readonly version: 1;
  readonly binding: {
    readonly namespaceId: string;
    readonly agentId: string;
    readonly revisionId: string;
    readonly resourceGeneration: number;
  };
  readonly policy: Extract<EgressRevisionSnapshot, { mode: "restricted" }>;
  readonly listeners: { readonly dns: string; readonly https: string; readonly health: string };
  /** Numeric IPv4:port endpoints. There is no ambient DNS fallback. */
  readonly resolvers: readonly string[];
  readonly proxyIPv4: string;
  readonly certificates: readonly {
    readonly origin: string;
    /** Complete ordered leaf-to-self-signed-root interception chain. */
    readonly certificateFile: string;
    readonly privateKeyFile: string;
  }[];
  /** Separately owned public CA bundle; no interception authority key may overlap. */
  readonly upstreamTrust: { readonly mode: "pemFile"; readonly caFile: string };
}
```

Bounds and applicable absolute expiry are inside `policy.policy`. There are no
separate invented lease fields. Binding identifies the exact revision and resource
generation. Listener addresses, fixed numeric resolvers, proxy IPv4, protected
leaf/key references and independent upstream roots all come from preparation.

The proposed Go decoder must bound input to 1 MiB and JSON nesting to 32.
It rejects duplicate keys, trailing
JSON, unknown/missing fields and wrong types before any listener can open.
Namespace, Agent and revision IDs use their respective `ns_`, `agt_` and `rev_`
UUIDv4 forms. Resource generation is a positive safe integer. Expired policies
are refused.

The three listeners are distinct nonmulticast numeric IPv4 endpoints with nonzero ports.
There are 1–4 distinct, non-unspecified, nonmulticast IPv4 resolver endpoints with
nonzero ports and no ambient fallback. Proxy IPv4 must be globally unicast and cannot be loopback or link-local. It is not classified as a
public upstream destination.

Material paths are clean absolute paths of at most 4,096 characters. Files must
be regular and at most 1 MiB. Certificate/key paths differ. Each admitted origin
has exactly one complete ordered leaf-to-self-signed-root chain, bounded to 16
certificates, and one matching private key. The leaf covers exactly its DNS origin
and no other SAN class, is current and permits supported TLS handshake use.
If present, KeyUsage must permit digital signatures and ExtendedKeyUsage must
permit server authentication. An absent extension imposes no corresponding usage
restriction.
Independent roots must contain CA certificates and cannot overlap interception
authority. [TLS custody](protocol-and-routing.md#tls-and-certificate-custody)
retains the separate mandatory check on actual upstream verified chains.

## Close and observation

Selected close ownership is authenticated Compute resource lifecycle and process
shutdown, including `SIGTERM`. Extend that lifecycle to the exact proxy role,
resource generation and original object UID. Retrying deletion must preserve a
successor. This is not a new close RPC, credential or lease supervisor.

The service's private close is idempotent and terminal for the exact binding and
generation, with a safe reason. It withdraws admission immediately, then cancels
requests and sockets before awaited cleanup. Compute alone establishes observed
Pod/process termination. The producer integration is a C0 gate, not a completed
export implied by this prose.

Observation distinguishes observed closure from pending or unknown cleanup.
Record route/session closure, provider cleanup, runtime stop request, observed
physical stop and possibly dispatched effects separately. Runtime stop remains
pending until termination is observed. Never replay an uncertain mutation because
its stream closed.

Existing Audit/State owners receive bounded safe decisions, owner-issued identity
references, policy generation, route ID, dispatch state, counts and
observed/unknown outcomes. [Safe evidence](security.md#evidence-and-closure)
owns disclosure restrictions. No diagnostic field becomes durable authority.

## Receiving bridge

C3 requires Egress's accepting Go listener and authenticated Go–TypeScript bridge.
Before native TLS handshake, select an already-admitted exact peer. Routing hints,
headers or serialized identity cannot authorize peer selection or replace
receiving-owner-held connection evidence. Concrete shared-listener peer selection
and the bridge producer remain owner-reviewed implementation gates.

The [identity contract](https://github.com/openclaw/openclaw-enterprise/pull/247)
owns opaque verified-workload evidence and finite currentness. The
[credential contract](https://github.com/openclaw/openclaw-enterprise/blob/eb52cc4cfe68f08017e7ece6585fe7e937e0747a/docs/reference/repository-credentials.md)
owns acquisition, sessions and effects. The existing bearer supplier is not the
proposed protected receiving extension. The supplier's
[`RepositoryCredentialDriver` and `RepositoryCredentialRuntimeBinding`](https://github.com/openclaw/openclaw-enterprise/blob/eb52cc4cfe68f08017e7ece6585fe7e937e0747a/packages/contracts/src/repository-credentials.ts)
retain resolution, open/status/close, original deadline and new/retained material
semantics. C3 extends these owners rather than treating their bearer as identity.

The separate integration supplier at `6538069`, which is not merged main, declares
[`VerifiedWorkloadV1`, `RuntimeWorkloadVerifierV1` and `TrustedRuntimeRegistrationReaderV1`](https://github.com/openclaw/openclaw-enterprise/blob/65380694085693d6edb5218372ccddbc2ba493d9/packages/contracts/src/runtime-identity-v1.ts).
Their process-local proof requires actual native X.509 connection and trusted
registration/assignment producers. It is neither a serialized wire proof nor
operation permission. Inspection must preserve recipient, connection incarnation,
original expiry and current sources. Reuse does not establish the egress bridge.

Egress must preserve the following local obligations before using these owners:

1. Retain the same native connection, handled request, stream and recipient
   through acquisition, waits and physical dispatch on every protected route,
   including `checkContinue`.
2. Associate the original invocation and current requester/complete-audience
   authority with that exact work. A shared execution or credential session cannot
   choose a requester implicitly. Ambiguity denies dispatch and result delivery.
3. Keep a current original waiter for shared acquisition. Withdrawing one waiter
   neither authorizes its work nor cancels another waiter's work.
4. Recheck currentness after waits. Immediately before creating an effect and
   delivering its result, synchronously assert currentness and the session fence,
   without an unguarded await between the assertion and that boundary.
5. Retain custody for late settlement and idempotent close, even after the
   requester has withdrawn.

The [bootstrap/current-serving proposal](architecture.md#protected-receivers)
still needs Compute, Harness, identity and credential producers. Concurrent
invocation association also remains an owner decision. These gaps cannot be
filled with a serialized proof record or a new guessed message schema.

## Examples and owner decisions

These complete selection examples use the proposed shape. `model-only` is an
illustrative operator policy ID, not an offered default or an executed fixture:

```json
{ "mode": "open" }
```

```json
{ "mode": "restricted", "policyId": "model-only" }
```

With open permitted, resolution can return the complete proposed result below:

```json
{ "status": "resolved", "egress": { "mode": "open" } }
```

For the restricted selection, an unavailable named policy returns
`{status:"denied",code:"policy_unavailable"}`. A disallowed selection returns
`{status:"denied",code:"selection_not_permitted"}`. An unsupported tuple returns:

```json
{ "status": "unsupported", "code": "unsupported_profile" }
```

These outcomes precede resources. A stale generation during activation closes
readiness/access rather than selecting open. Its observation wire shape is not
selected here. Restricted success contains the full validated policy and computed
digest shown in the declared union, never a fabricated digest or partial policy.

Use nominal platform identifiers and curated package indexes. These proposed
wire shapes retain their declared strings. Additional context, Driver
capabilities, credential callbacks or Harness requirements need real producers
and consumers. Startup derives from the immutable revision.

Authority/receiver owners must define the committed withdrawal event, evidence
age, request-start/skew rule, monotonic deadline, renewal cadence and closure
reserve. The selected [30-second and scoped five-second outcomes](security.md#withdrawal-and-recorded-limits)
remain binding. Installation/product and authority owners still owe finite tuple
selection and prospective-default versus audited-withdrawal mechanics.
[Delivery](delivery.md#decisions-and-follow-ups) records the closure gates.
