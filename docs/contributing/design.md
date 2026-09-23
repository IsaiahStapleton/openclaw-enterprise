# Platform design

Start with [current architecture](../ARCHITECTURE.md) to understand how the
OpenClaw Control Plane works today. The [platform design](../design.md) defines
the approved target; check its [implementation status](../design.md#implementation-status)
before treating a planned capability as available.

## Find the right source

- [Readable code](readable-code.md) explains functions, values, composition,
  and state ownership through an illustrative TypeScript example.
- [Driver development](driver-development.md) collects the base contracts for
  extending infrastructure behavior. For supported products and setup, use
  [Integrations](../guides/integrations/README.md).
- [Runtime flows](runtime-flows.md) trace how the current code processes
  requests, deploys Agents, and runs background work.
- [Repository layout](../layout.md) maps packages and source directories to
  their owners.
- [Implementation specifications](../../specs/README.md) record individual
  proposals and delivery history. They are not proof that a capability exists in
  the current product.

Keep architecture pages about components, ownership, trust boundaries, and major
interactions. Put a feature's detailed behavior in its current reference and
link it from architecture when it changes a system boundary. See
[Documentation](documentation.md) for file ownership and verification.
