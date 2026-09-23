# Federated sign-in interfaces

The [MVP RFC](../31-human-federated-sign-in.md) and [architecture](architecture.md) own the proposed contract; these links preserve the original reference paths.

## Provider configuration and identity

See [the fixed OAuth App profile and immutable identity](architecture.md#provider-configuration-and-identity).

## Browser operations

Expose only configured-provider listing, trusted-origin start, and exact callback. Start accepts a recognized provider and permitted local return. Never expose unrestricted library signup/linking handlers. Follow [protocol validation](security.md#protocol-validation).

## Account administration

See [the minimal authorized operations](architecture.md#administration-and-currentness) and [unknown-outcome handling](architecture.md#atomic-policy-and-recovery). Use expected account incarnation/version and authorized current-state inspection; no exact per-request result lookup is promised.

## Sessions and no access

See [generic denial and administrator verification](architecture.md#sessions-and-no-access). Unknown identity receives no session.

## Enterprise profiles

Future providers are [tentative](../31-human-federated-sign-in.md#selected-scope-and-exclusions). If selected, retain the [original provider identity contracts](https://github.com/openclaw/openclaw-enterprise/blob/085610f971591221b0f9c6e036e1cd7a4de89e0d/specs/31-human-federated-sign-in/interfaces.md#enterprise-profiles); qualify immutable instances and each actual registration separately. Google needs approved stable-subject enrollment; Entra uses tenant-scoped `oid` without unnecessary Graph enrichment.

## Human CLI

CLI is deferred. Its [original approval and credential-custody contract](https://github.com/openclaw/openclaw-enterprise/blob/085610f971591221b0f9c6e036e1cd7a4de89e0d/specs/31-human-federated-sign-in/interfaces.md#human-cli) applies if selected; it does not gate browser delivery.

## Owner decisions

Before implementation acceptance, settle routes/DTOs, fixed errors, expected-version handling, finite local admission/work limits, persisted attempt caps, byte/time/cleanup bounds, and clock assumptions. These open constants do not waive their controls.
