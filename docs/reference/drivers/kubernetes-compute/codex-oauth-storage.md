# Codex OAuth credential storage

This page covers the private `codex-home` subpath of the dedicated Harness claim
described in [Harness storage](storage-and-credentials.md#harness-storage) for
the [Kubernetes Compute Driver](../kubernetes-compute.md).

## Private credential directory

OAuth's private `codex-home` directory is excluded from workspace serving and
Sandbox mounts. It retains the complete native `auth.json`, including rotated
refresh tokens and account metadata. Only the bootstrap workload and dedicated
Codex workload mount it; the separate Gateway receives no model credential.

**Launch scope:** persistent runtime-owned credentials deliberately replace the
planned token broker for P0. Brokerage is separate work in progress. After the
initial handoff, OCC retains a consumed source marker and never restores the
original token pair. Restarts and revisions reopen the current disk bundle.
Loss of the claim or credential file requires a new login and explicit deployment.
This version has no broker-based backup, recovery, or shared refresh ownership.

## OAuth launch limits

Codex OAuth login is **Experimental**. The launch MVP targets a new Agent's first
deployment with fresh private credential storage. The following limitations are
recorded for follow-up:

- OAuth requires Compute-owned dedicated Codex without a selected Sandbox Driver.
  The current admission check can accept the unsupported Sandbox combination;
  preparation rejects it after stopping predecessor workloads. Admission-time
  rejection is deferred. Do not select this combination.
- Reconnect bootstrap does not yet reject filesystem links or create exclusive
  temporary files. A process with write access to the private auth directory can
  redirect a replacement bundle into the served workspace. Bootstrap readiness
  can still succeed, consume the source, and leave native startup failing.
  Exclusive writes and final-file validation are deferred reconnect hardening;
  this is separate from the choice to persist tokens on disk. Recovery on
  untrusted reused storage is outside the first-deploy MVP.
- Broker-backed custody, automatic recovery, and shared refresh remain deferred.
  Existing revision reuse does not provide rollback of credential-file changes.
  The [replacement and recovery behavior](storage-and-credentials.md#harness-storage)
  still applies.

The [credential guide](../../../guides/deploy/credential-lifecycle.md#use-a-personal-codex-login)
owns staged-login expiry and manual cleanup.
[Device-login verification](#device-login-verification)
distinguishes existing tests from outstanding live runtime proof.

## Device-login verification

`node --test tests/integration/device-authorization-api.test.mjs` exercises device
login, authenticated discovery, and revision submission through the real HTTP/OCC
workflow. It verifies exact actor and Agent scope, cancellation during an exchange,
and credential redaction using simulated provider transport and a test Secret
Driver. `tests/conformance/harness-device-auth.test.mjs` checks the native protocol
adapter. These cases do not prove live OAuth, token refresh, or runtime deployment.
The bootstrap case in `tests/integration/runtime-image-startup.test.mjs` executes
the actual script on local disk and simulates a rotated bundle. Kubernetes
conformance substitutes API observations; neither proves native refresh or
credential handoff on a real cluster.

Live first-deploy proof remains outstanding: complete device login, search and
select plugins, deploy a new Agent on the supported topology, and verify a real
Codex model turn. Follow-up proof must cover native token refresh, restart and
revision reuse, reconnect, and another discovery login while the deployed Agent
continues operating. The launch scope and deferred fixes are listed in
[OAuth launch limits](#oauth-launch-limits).
