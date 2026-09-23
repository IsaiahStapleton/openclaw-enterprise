# Human account lifecycle

The [MVP RFC](../31-human-federated-sign-in.md) selects attachment to existing accounts.
The contracts below now have one owner in the architecture detail.

## Identity and method ownership

See [immutable account and method ownership](architecture.md#identity-and-method-ownership): preserve the real Principal, password, contact information, and grants.

## Administration and currentness

See [authorized local controls](architecture.md#administration-and-currentness) for attachment, disable, account-wide revoke, selected-session logout, and exact result lookup.

## Atomic policy and recovery

See [transactional recovery protection](architecture.md#atomic-policy-and-recovery). Joint policy administration remains outside the increment.

## Activation and supported consumers

See the [proposed activation and support contract](architecture.md#activation-and-supported-consumers), including the unresolved password-account creation obligation.

## Console grants

The [first usable delivery](../31-human-federated-sign-in.md#first-usable-delivery) reads an existing authorized Agent with recorded existing grants. IAM still checks each exact resource. Optional panels deny gracefully; cross-Namespace denial and grant removal require proof. Broader object creation, revision access, deployment, and runtime health are outside this sign-in increment.
