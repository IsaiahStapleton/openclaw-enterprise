# Feature Spec: Configuration-Native Agent Channels

**Date:** 2026-08-21
**Status:** Planning
**Owner:** Kubernetes ComputeDriver and OpenClaw gateway
**Authority:** [Platform design](../docs/design.md) and [Configuration contract](06-configuration-kind.md)

## Problem and Decision

Enable native OpenClaw channels through existing Agent Configuration, immutable revisions, and
private gateways. A built-in provider requirements list supplies gateway-only credentials and exact
reviewed proxy egress for Slack and Microsoft Teams; only Slack receives live integration coverage.

## Scope

**Changes:** Native `slack`/`msteams` requirements, gateway-only credentials, exact shared proxy
egress, and real Slack proof.

**Does not change:** Configuration CRUD/IAM, Agent deployment, immutable revisions, Codex routing,
worker Secret permissions, or default-deny networking. No Channel resource, API, driver, configurable
provider registry, credential-file projection, direct provider egress, public ingress, app
provisioning, or live Teams integration.

## Contract

Existing Configuration owns all native `channels` settings; OpenClaw owns provider identifiers,
account conventions, plugins, and validation. Explicit Agent deployment snapshots its complete
Configuration; changes require a new deployment and never modify active revisions.

The built-in provider requirements list initially supports:

- `slack`: `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`.
- `msteams`: `MSTEAMS_APP_PASSWORD`; `appId` and `tenantId` are ordinary nonsecret native
  configuration strings.

Enabled providers union their gateway credential requirements and use one shared reviewed outbound
proxy. Unknown enabled providers fail closed; native `channels.defaults` and
`channels.modelByChannel` are shared settings, not providers. Slack retains its native default
account, Socket Mode, sender/channel allowlists, and structured environment SecretRefs. Teams
`appPassword` also uses a native environment SecretRef.

Operators provision an Agent-specific Kubernetes Secret. Kubernetes `secretKeyRef` intentionally
exposes the selected provider credentials to that Agent's gateway process environment only; this
accepted security tradeoff avoids projected files and init containers. Credentials never enter a
separate Agent/Codex workload, persisted Configuration, OCC state, API responses, audit records, or
logs. Enabled channels require dedicated Agent execution; embedded revisions fail closed because
their combined gateway/Agent cannot isolate credentials. Worker Secret-read access remains
forbidden; `.env` values are live-test bootstrap only.

The live test obtains gateway app/bot credentials only from `.env.claw-local` and a distinct
sender bot credential only from `.env.claw-oai`. Both bot user identities belong to the same Slack
workspace; only the exact test channel temporarily permits explicitly allowlisted bot mentions.

Kubernetes runtime configuration uses `channels: { secretPrefix, proxyUrl }`. Gateway NetworkPolicy
retains DNS and the exact owning Agent route and, when a supported provider is enabled, adds only one
reviewed HTTP(S) proxy with a literal IPv4/IPv6 address, `/32` or `/128` destination, and explicit
port. Disabled-channel revisions do not retain proxy egress. Direct public providers, broad
internet, sibling Agents, and public ingress remain denied; missing credentials or an invalid proxy
fail closed.

The main Teams SDK honors `HTTPS_PROXY` for supported REST requests, but live Teams proxy
compatibility, Azure identity and federated flows, and message delivery remain unverified. Actual
Teams ingress additionally requires a separately deployed and reviewed public Bot Framework
`/api/messages` webhook, which is outside this milestone.

## Implementation

1. Extend [Kubernetes ComputeDriver](../apps/controller/src/drivers/compute/kubernetes/index.ts) with
   built-in Slack/Teams requirements, minimal Agent-owned gateway `secretKeyRef` credentials, and
   exact shared proxy egress.
2. Cover supported providers, combined requirements, unsupported providers, disabled revisions, and
   gateway isolation in [Kubernetes conformance tests](../tests/conformance/kubernetes-compute.test.mjs).
3. Retain opt-in Slack-only live proof in
   [existing topology integration](../tests/integration/harness-topology-k3d-real.test.mjs).
4. Document native channel configuration, credentials, proxy behavior, Teams limitations, and Slack
   verification in the existing [Configuration](../docs/reference/configuration.md) and
   [Kubernetes Driver](../docs/reference/drivers/kubernetes-compute.md) guides.

## Verification

- Existing Configuration APIs preserve native provider settings and immutable Agent-owned snapshots.
- Slack and Teams contribute only their required secrets; combined providers union requirements.
- Dedicated placement exposes provider credentials only in its gateway; embedded and unknown-provider
  revisions fail closed.
- Enabled-provider NetworkPolicy permits exactly the reviewed proxy endpoint and denies direct or
  cross-Agent access; disabling channels revokes the provider proxy rule.
- `OCC_TEST_SLACK_LIVE=1` sends a distinct-bot nonce mention and verifies the later gateway-authored
  Slack reply contains that nonce after a real dedicated Codex/model turn.
- Teams remains conformance-only; public webhook ingress and live Teams delivery are out of scope.
- Optional manual proof separately observes an actual Slack mention and Codex/model-generated reply.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-24 21:42]: Generalized built-in channel requirements for Slack and Teams, retained exact shared proxy egress, and limited live integration coverage to Slack. (01a03739-395b-7b82-bcb8-12beff71b9f7 - 6ec9eca)
- [2026-08-24 11:40]: Required distinct-bot, scoped-admission Slack-to-Codex-to-Slack response proof using the two approved credential files. (01a025fa-0dd7-7933-b496-5ec699a269a6 - 9c60f73)
- [2026-08-24 11:13]: Required dedicated Slack execution and rejected embedded revisions to preserve gateway-only token isolation. (01a025fa-0dd7-7933-b496-5ec699a269a6 - 626e183)
- [2026-08-24 11:07]: Approved gateway-only environment SecretRefs, exact proxy egress, shared topology proof, and existing-document-only guidance. (01a025fa-0dd7-7933-b496-5ec699a269a6 - 4a59b19)
- [2026-08-24 08:37]: Removed the standalone Channel model; retained native Configuration, immutable Agent revisions, isolated SecretRefs, reviewed Slack HTTP(S) proxy egress, and real Slack proof. (01a025e7-7108-7fa2-999f-2e6513bab514 - 2e8b2da8d084)
- [2026-08-21 13:11]: Generalized Channel contracts and implementation to existing OpenClaw providers while retaining Slack as the sole live integration fixture. (01a025cf-a22e-7600-889f-f85014fbcc1f - f0020932b28f)
- [2026-08-21 12:59]: Simplified revision ownership, credential and egress implementation choices, and outcome-focused Slack verification. (01a025cf-a22e-7600-889f-f85014fbcc1f - f0020932b28f)
- [2026-08-21 12:54]: Defined exclusive Agent-owned Channels, immutable account admission, native file SecretRefs, restricted Slack egress, and real Slack integration proof. (01a025cf-a22e-7600-889f-f85014fbcc1f - f0020932b28f)
