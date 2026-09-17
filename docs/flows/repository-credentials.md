---
created: "2026-09-17"
updated: "2026-09-17"
last_updated_session: "extraction-preparation"
---

# Repository credential lifecycle flow

## Overview

The callable service binds an immutable grant to one ephemeral session and owns credential use and cleanup.

## Entry Points

`apps/repository-credentials/src/service.ts:createCredentialService` composes admission, reserve, execute, status, close, and shutdown operations.

## Flow

```mermaid
graph TD
  Open["Admit immutable grant"] --> Reserve["Reserve bounded exchange"]
  Reserve --> Acquire["Reuse or acquire and capture"]
  Acquire --> Dispatch["Check original use at dispatch"]
  Dispatch --> Settle["Join I/O and release use"]
  Close["Close local admission"] --> Cleanup["Settle actions and retire captures"]
  Cleanup --> Finalize["Finalize auxiliary authority"]
```

## Execution Trace

### 1. Admit, execute, and close

`apps/repository-credentials/src/service.ts:createCredentialService` admits the trusted profile and deadline. `sessions.ts` retains bearer digests and immutable bindings. `custody.ts` owns original attempts, captured material, and use leases. `lifecycle.ts` coalesces acquisition, checks sufficient validity, and coordinates replacement and retirement through the bound factory. `provider-queue.ts` bounds provider work; `lifecycle/exchange.ts` joins tracked exchange work before releasing use. Closure prevents new admission before cleanup and original settlement. Uncertainty does not imply successful revocation.

## Debugging and Verification

Run the available common-owner and adapter cases listed in the [testing guide](../testing/repository-credentials.md). Controlled time advances beyond hour thirteen without changing the admitted bearer. Inspect active uses and pending/uncertain cleanup separately. Listener/client and delivered-container qualification are pending.

## Related docs

- [Reference](../reference/repository-credentials.md)
- [Build and configuration](../guides/repository-credentials.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-17 21:49: Document callable common lifecycle ownership. (extraction-preparation - 2f8435756d0e82f0cc5205b009f5f1e0df692808)
