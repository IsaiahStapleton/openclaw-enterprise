# Feature Spec: OCC Gateway Administration and Command Proxy

**Date:** 2026-08-31

**Status:** Planning — implementation scope approved 2026-08-31

**Owner:** OCC admission and API; bundled Kubernetes Compute implementation

## Problem and Decision

OCC provisions each Agent's gateway but has no authenticated native gateway client or command proxy. A shared gateway token alone does not establish a remote backend client's administrative scopes. Enroll a dedicated OCC device automatically during gateway bootstrap, then let authorized administrators issue native commands through the Agent's `/gateway/` endpoint.

This is an implementation proposal under the [platform design](../docs/design.md), not implemented behavior. The source baseline is Enterprise `4bf6985ebd3e746999bf270aead8921b4be7d812` and OpenClaw `b9d01e71270e15208d191e4ea4afdef31fbf51ac`. Native enrollment is source-backed; the Enterprise integration and compatible runtime images remain to be proved.

## Scope

- Automatic, exact-device enrollment as native `operator` with `operator.admin`; no human approval for each newly provisioned gateway.
- One authenticated HTTP request and native RPC response for a selected, running Agent, in development and production with the bundled Kubernetes Compute implementation.
- An initial command allowlist covering diagnostics, native workspace files, and chat; the same internal client can support future OCC-owned administration flows.
- Preserve OCC Configuration and immutable AgentRevision ownership, exact-resource IAM, isolated Agent credentials, and mutable native workspace state.
- No browser-to-gateway credentials, WebSocket/SSE tunnel, event subscription, generic destination proxy, durable command queue, automatic command replay, new platform resource, or new public Driver contract. Docker and external Compute implementations return unsupported for this endpoint until separately implemented.
- Direct native configuration mutation, software updates, device administration by proxy callers, offline file editing, platform prompts, and a complete operator console are outside this first slice.

## Contract

### Native identity and automatic enrollment

OCC uses the published `@openclaw/gateway-client` and `@openclaw/gateway-protocol` contracts, pinned together with a compatible gateway image; `2026.8.1` is the investigated SDK candidate, not a proven image combination. Use a genuine backend client identity, signed Ed25519 challenge, `role: operator`, and requested scope `operator.admin`. Do not impersonate a CLI or browser, disable pairing, enable dangerous authentication fallbacks, or synthesize a trusted-proxy identity. See the [client contract](https://docs.openclaw.ai/gateway/clients#choose-scopes-and-pair-the-device) and [scope semantics](https://docs.openclaw.ai/gateway/operator-scopes).

The bundled Kubernetes adapter owns one stable OCC device identity per Installation/Namespace/Agent, independent of AgentRevision. Store the private key and enrolled device token in an internal, ownership-labelled Kubernetes Secret in the controller namespace; it is not a tenant-visible platform Secret. Only authorized controller processes can read it. Never project these credentials into a gateway, Harness, workspace, revision, response, or log. Reuse existing Agent-owned gateway transport credentials for initial enrollment; only the expected public key, device ID, role, and scope pin are projected to trusted gateway bootstrap code.

Enrollment is part of the existing revision preparation path, before activation:

1. During initial provisioning, atomically create and read back the exact Agent-owned OCC credential record containing its private key, before sending a handshake. Only the reconciliation invocation that created that record may perform the initial enrollment attempt. An existing token-bearing record uses token-only authentication; an existing key-only record means incomplete enrollment requiring operator recovery. Missing established credentials and corrupt records fail closed; never regenerate their identity automatically.
2. Start the gateway through the existing runtime entrypoint. Once it listens, the active enrollment invocation starts one bounded helper through Kubernetes `pods/exec` in the exact owned gateway container, then requests pairing with its signed identity and bootstrap transport credential. The helper checks native pending requests through `openclaw devices list --json`. This is a fixed controller-owned command, not an exec API for proxy callers; verify Pod/Agent/revision ownership before invoking it. Do not install a replayable enrollment hook in Pod startup.
3. The helper approves only the exact pending request matching the projected public key, device ID, `operator` role, and `operator.admin` scope, using `openclaw devices approve <request-id> --json`. It must not approve newest/all requests, prewrite pairing JSON, or grant broader scopes. The native local CLI authenticates over loopback with the existing gateway token. See [devices CLI](https://docs.openclaw.ai/cli/devices) and the native [local CLI authority](https://github.com/openclaw/openclaw/blob/b9d01e71270e15208d191e4ea4afdef31fbf51ac/src/gateway/server/ws-connection/handshake-auth-helpers.ts#L255).
4. Within that same attempt, OCC reconnects after approval, validates the granted operator/admin identity, captures the returned device token, and stops the shared-auth bootstrap client. Await persistence and read-back of that token in the same owned credential record, then prove a connection using only the persisted device token before readiness. The helper approves at most once and exits; neither it nor the shared-auth client is restarted by a later reconciliation of a key-only record.

Use a 60-second initial enrollment deadline, including a helper-local timeout so controller loss cannot leave approval running indefinitely. Reconciliation may retry unavailable token-only connections, but cannot restart initial enrollment from a key-only record. Keep gateway transport readiness independent of enrollment so OCC can reach the pending gateway; do not use a pre-start init container or blocking Kubernetes `postStart` hook. Failure leaves revision preparation unready with a sanitized reason; a ready TCP port alone is insufficient. The first slice uses shared-token bootstrap without `gateway.roles`; reject incompatible profiles rather than silently changing them.

The SDK's token-storage and hello callbacks return `void`; they do not await Kubernetes persistence. Capture the token synchronously and await the adapter's own durable write before readiness. If persistence fails after native approval, the live attempt may retry writing the same captured token, without another handshake or approval. Resolve an uncertain write by reading the exact credential record: a saved token takes the token-only path; a remaining key-only record stays unavailable for explicit operator recovery. A process crash never grants permission to reapprove. See the [SDK host callback contract](https://github.com/openclaw/openclaw/blob/b9d01e71270e15208d191e4ea4afdef31fbf51ac/packages/gateway-client/src/client.ts#L85).

Do not automatically reenroll an established device after revocation/removal, regenerate its key, clear its saved token to enable bootstrap, or fall back from a rejected device token to shared authentication. Operator recovery/reset must first quiesce any active enrollment and wait for its bounded helper to exit, then deliberately reconcile the exact native device and OCC credential record. Native approval-to-token issuance is not an atomic revocation boundary; do not claim safety for a concurrent revoke during the original handoff. No public rotation API or second bootstrap-completion marker is added.

Reuse native pairing in the [shared SQLite state database](https://github.com/openclaw/openclaw/blob/b9d01e71270e15208d191e4ea4afdef31fbf51ac/src/state/openclaw-state-db.paths.ts#L33) and its existing `/home/node/.openclaw/state` PVC mount. Pod restarts and revision replacements with intact state retain the same device identity. Leave existing private-state cleanup unchanged: stopped/unready gateways or lost native state are unavailable, not automatically reenrolled. Stopped-Agent retention and Agent-deletion cleanup remain separate lifecycle work; this spec adds neither a deletion API nor its proof.

### HTTP request and native result

The canonical route is `POST /namespaces/:namespaceId/agents/:agentId/gateway/`, including the trailing slash, with no query parameters. Do not add a global `/gateway/` route or infer an Agent from caller-supplied URLs.

```json
{"method":"agents.files.get","params":{"agentId":"main","name":"AGENTS.md"}}
```

The outer object permits only a nonempty `method` string and optional JSON `params`; the native gateway validates method parameters. `params.agentId` is a native Agent selector inside the already selected gateway, not an OCC target. The caller cannot select a gateway address, namespace, revision, transport token, native identity, scope, timeout, or request ID. Native credentials and connection options are always server-owned.

Successful dispatch returns HTTP 200 using the existing OCC envelope:

```json
{"data":{"ok":true,"payload":{"example":"native payload"}},"meta":{"requestId":"occ-generated-id"}}
```

A native RPC rejection also uses HTTP 200, with `data: {ok:false,error:{code,message,details?,retryable?,retryAfterMs?}}`, preserving the SDK's native error semantics. OCC admission, routing, and transport failures use the existing HTTP error envelope, not a fabricated native RPC result. Preserve native payloads semantically, not byte-for-byte wire frames. Native results are privileged administrator data; never put parameters, results, credentials, or native error details in audit or request logs.

Use the SDK's first-response behavior (`expectFinal: false`), with a fixed 30-second total connection/request deadline after admission. An `accepted` payload acknowledges work and does not claim completion; callers may use an allowed history/status command later. Do not hold HTTP open for native events. On timeout, disconnect, or caller cancellation, stop the local wait without claiming the gateway cancelled the work; a request already sent may have taken effect. Never automatically replay it. Close the per-request client after the response; no connection pool is required for this slice.

Reuse OCC's configured request-body limit (64 KiB by default). Reject proxy responses over 1 MiB of serialized JSON with an OCC dependency failure; they may follow an already executed command. The SDK's investigated inbound frame bound is 25 MiB, so the response cap is not a pre-allocation bound. Keep explicit deadlines and the SDK frame limit; do not invent a streaming parser. Source contracts are the existing [controller HTTP conventions](../apps/controller/src/index.ts), [API primitives](../packages/contracts/src/api/common.ts), and native [request handling](https://github.com/openclaw/openclaw/blob/b9d01e71270e15208d191e4ea4afdef31fbf51ac/packages/gateway-client/src/pending-request.ts).

### Authorization, routing, and command policy

Admit only existing human sessions or non-Agent service API keys. Require exact `Agent`/`administer` authorization for the path's Namespace and Agent through the selected IAM Driver, before discovering credentials or opening a gateway connection. Do not treat `read`, `operate`, native Agent selectors, or Agent ServicePrincipal credentials as equivalent authorization. Add `administer` to the native bootstrap administrator's Agent permissions; other roles need an explicit grant, with no fallback for existing `operate` grants. Reuse the existing [IAM action and exact matching](../packages/iam/src/index.ts) and [request admission](../apps/controller/src/auth/index.ts).

Cookie-authenticated proxy POSTs require an `Origin` matching the configured OCC public origin, and reject conflicting cross-site Fetch Metadata; missing/malformed origin is denied. Compare against trusted server configuration, not the incoming Host header. Apply this check to the application route: Better Auth's own trusted-origin protection does not protect arbitrary OCC POST handlers. Valid service API keys remain usable without browser headers; invalid keys never fall back to cookies. Keep existing development host/origin protections.

Expose a controller-private gateway adapter from Installation composition only when its selected Compute implementation supports this contract. The bundled Kubernetes implementation resolves the current running Agent and verifies Namespace/Agent ownership and selected revision on the gateway resources before accessing the owned credential and dialing its internal Service. Reuse Kubernetes ownership and namespace checks. Return unsupported/unavailable for unimplemented Drivers, stopped/unready Agents, missing credentials, or mismatched ownership; no alternate gateway, caller-selected target, or impersonation fallback. Configure the required API/worker RBAC and narrowly scoped gateway network access. A revision change or transport loss during dispatch is an uncertain outcome; do not retarget/retry a mutation.

The approved initial allowlist is exact and code-owned:

| Native methods | Intended use |
| --- | --- |
| `health`, `status`, `config.get`, `config.schema.lookup`, `agents.list`, `channels.status` | Inspect the selected gateway and its effective configuration. |
| `agents.files.list`, `agents.files.get`, `agents.files.set` | Native workspace authoring; file semantics and validation remain native. |
| `chat.send`, `chat.history`, `chat.abort` | Submit, inspect, or abort a native chat run; first-response semantics apply. |

Reject all other methods before forwarding. In particular, `config.set`, `config.patch`, `config.apply`, `update.run`, native Agent configuration mutations, and device-pairing/token administration are unavailable through this route. The allowlist bounds caller access despite OCC's native admin authority. Extending it requires reviewing each method's effect on OCC ownership; do not automatically include new upstream methods.

Configuration remains OCC-owned: the current [Kubernetes projection](../apps/controller/src/drivers/compute/kubernetes/index.ts) mounts `OPENCLAW_CONFIG_PATH` read-only. Admin pairing does not make live native configuration writes deployable. Configuration changes continue through OCC Configuration admission and AgentRevision deployment; direct native writes need a separate writable-projection and adoption contract. Mutable workspace bytes remain outside revisions. The native gateway enforces native file/path rules; this admin proxy does not replace a narrower user-facing workspace-file API.

Audit the admitted actor, Namespace, Agent, native method, OCC request ID, and dispatch/outcome category through existing audit facilities. Record an authorized dispatch before forwarding; record native success/rejection or an uncertain transport outcome afterward. Audit admission/denial failures without parameters; if required audit storage fails before dispatch, do not send. A failed outcome write after dispatch cannot undo or safely replay the command. Never report uncertain execution as confirmed failure without this qualification.

## Implementation

1. **G1 — Bootstrap native access.** Extend bundled Kubernetes preparation and exact Agent credential ownership with the bounded native CLI helper and pinned SDK adapter. Invoke the helper once in the owned gateway container; keep existing runtime startup and private-state cleanup unchanged. Keep public ComputeDriver contracts and SQL resources unchanged. Wire controller-namespace credential RBAC, tenant-scoped `pods/exec` for the enrollment worker, and gateway transport access in [Helm](../deploy/helm/openclaw-enterprise/templates/). Document the terminal incomplete-enrollment case and quiesced operator reset/revocation procedure in the deployment guide.
2. **G2 — Admit and proxy a command.** Add strict request/result contracts and the Agent-scoped route in `packages/contracts/src/api/` and `apps/controller/src/index.ts`; expose the internal adapter through controller Installation composition. Implement exact `administer`, cookie CSRF, allowlist, owned routing, bounded first-response handling, and sanitized audit. Update the native bootstrap grant, generated OpenAPI, API reference, relevant gateway execution flow, and existing deployment guide when behavior ships; do not label this draft as current support.
3. **G3 — Prove the complete path.** Use a disposable Kubernetes cluster, PostgreSQL with the limited controller role, and a real digest-pinned OpenClaw image. Exercise actual signed enrollment and HTTP-to-WebSocket commands, then repeat after controller/gateway restart and revision replacement. Cover the retained invariants below; use unit/contract tests for HTTP failure mapping, with real native integration as the acceptance proof. Do not substitute an HTTP fixture or skipped integration case for gateway access.

## Verification

| Required outcome | Evidence |
| --- | --- |
| A new Agent becomes administrable without human pairing | Real gateway creates a pending OCC device; exact helper approval yields admin grant; `/gateway/` executes `status` and file get/set through OCC. A second unrelated pending device remains unapproved. |
| Partial enrollment fails closed | Fail/kill OCC after native approval but before token persistence. On restart, a key-only record stays unavailable without helper execution, shared-auth reconnect, or identity replacement. Test an uncertain write that actually persisted: read-back recovers only through token authentication. SDK hello must not make readiness true before durable storage. |
| Restart and revision changes preserve identity and revocation | Record only public device ID; restart controller and gateway, replace revision with intact PVC state, and repeat proxy access with the same ID. Revoke/remove established OCC access, restart, and prove no automatic approval/fallback restores it. Stopped/unready gateways and lost native state return unavailable; quiesced operator recovery is deliberate. |
| Caller boundaries hold | Real IAM cases: unauthorized, `operate`-only, Agent principal, and cross-Namespace callers are denied before native dispatch; explicit `administer` succeeds. Cookie cross-site/missing Origin is denied, same-origin succeeds, and scoped API-key automation succeeds. |
| Routing and command ownership hold | Inject a target URL/extra outer field and call a stopped Agent: no dial. Mismatched Kubernetes ownership is rejected. An allowed native file operation succeeds; `config.patch`, pairing administration, and unknown methods are denied without changes. |
| Native RPC semantics survive the facade | Prove native success and typed rejection, plus `chat.send` accepted acknowledgment without completion claims; retrieve its resulting history. Force a sent-request disconnect/timeout and prove no second dispatch. Oversized input/output and cancellation produce bounded, correctly qualified failures. |
| Credentials and evidence remain isolated | Verify the OCC credential Secret is not mounted in workloads or copied into admitted revisions, API payloads, or logs; native token issuance/storage remains gateway-owned. Helper receives only public pin and its existing transport auth. Audit attributes dispatch to the OCC caller without native arguments/results. Verify incompatible auth profile, missing exec permission, wrong Pod ownership, and enrollment timeout fail closed. |

Run focused contract/type checks and existing real Kubernetes integration checks for changed lifecycle/RBAC behavior. No code, runtime test, enrollment, or rollout is performed by this specification-writing task.

## Manual Notes

## Changelog

- 2026-08-31 11:52: Drafted separate OCC native enrollment and Agent gateway command proxy proposal for independent review. (01a04ae1-7ba7-7372-88a4-488e01f690ae — 4bf6985ebd3e746999bf270aead8921b4be7d812)
- 2026-08-31 12:02: Applied approved review direction: defined durable enrollment ordering and terminal recovery, removed duplicate completion state and Agent-deletion scope, retained the diagnostics/files/chat allowlist, and corrected source links. (01a04ae1-7ba7-7372-88a4-488e01f690ae — 4bf6985ebd3e746999bf270aead8921b4be7d812)
