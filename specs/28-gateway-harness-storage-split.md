# Gateway–Harness storage split

**Status: Proposed.** Covers [#76](https://github.com/openclaw/openclaw-enterprise/issues/76)
and [#89](https://github.com/openclaw/openclaw-enterprise/issues/89), building on
Russell Bryant's placement design in [#125](https://github.com/openclaw/openclaw-enterprise/pull/125).
This is a review draft, not implemented behavior. It carries forward pre-Agent
defaults and durable-state ownership from his [#131](https://github.com/openclaw/openclaw-enterprise/pull/131),
while retaining live Agent-document editing.

## 1. Storage and the security boundary

**Keep the workspace on the Harness host. Give Gateway separate storage and
limited access across the boundary.** A compromised Harness must not gain access
to Gateway credentials or policy; Gateway must not treat the Harness filesystem
as its own trusted filesystem. Native Harness file tools continue to work locally.

| Baseline                                             | How both sides access files                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Existing internal deployment informing this proposal | Each host has local copies; synchronization propagates selected content.                                        |
| Current OCE Kubernetes code                          | Both Pods mount one RWX PVC for five [file categories][oce-storage]. This differs from the internal deployment. |
| Proposal                                             | Each side owns its storage; explicit requests replace shared paths and ongoing synchronization.                 |

```mermaid
flowchart LR
  subgraph CP["Control plane"]
    O["OCC: configuration and lifecycle"]
    DB[("OCC database<br/>File defaults and initial snapshots")]
    G["Per-Agent Gateway<br/>Channels, context and tools"]
    GP[("Gateway persistent volume<br/>Conversation history and routing<br/>Owner submissions and delivery bytes")]
    O --- DB
    G --- GP
  end
  subgraph HP["Harness host: Pod or DevBox"]
    H["Harness<br/>Native file tools"]
    B["SSH / OpenClaw node endpoint<br/>Restricted file and memory operations"]
    WP[("Harness persistent volume<br/>Git repo and project files<br/>Agent docs, memory files and index<br/>Skills and task input/output folders")]
    HS[("Harness persistent state<br/>Thread and resume data")]
    H --- WP
    H --- HS
    B --- WP
  end
  O -->|"Initial files; approved configuration"| B
  G <-->|"Doc reads/saves; memory queries<br/>Attachment and skill transfers"| B
  G <-->|"Existing turn, reply and tool APIs"| H
  classDef reuse fill:#dbeafe,stroke:#2563eb,color:#172554;
  classDef adapt fill:#fef3c7,stroke:#b45309,color:#451a03;
  classDef data fill:#f3f4f6,stroke:#6b7280,color:#111827;
  class H reuse;
  class O,G,B adapt;
  class DB,GP,WP,HS data;
```

Gray = storage; blue = reuse; yellow = adapt; purple below = new command handling.
Gateway history supports chat and routing; Harness thread data supports resume.
The Harness resume database stays local; Gateway stores thread references.

| Cross-boundary need                                  | Allowed access                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Owner opens/saves Agent docs; Gateway builds context | Named documents on Harness storage. Bootstrap reads have a separate allowlist from owner writes.                  |
| Attachment input/output                              | Gateway writes admitted inputs and retrieves selected outputs in task-bound folders. Harness uses ordinary paths. |
| Memory search                                        | Gateway requests workspace-memory results; workspace files and index stay on the Harness host.                    |
| Skills                                               | Gateway receives an approved catalog; required bodies/scripts are available locally to the Harness.               |
| Harness calls a Gateway tool                         | Existing authenticated APIs return authorized results, never general access to Gateway storage.                   |

Bind endpoints to the exact Namespace, Agent and admitted revision. Enforce
operation/path/size limits using guarded file operations; UI and Harness input
cannot select arbitrary Gateway files or commands. Permitted outputs are
delivered normally; this limits access without claiming to detect unsafe content.

## 2. Agent documents: change the caller, reuse remote I/O

```mermaid
flowchart LR
  UI["Owner UI"] -->|"Existing file API"| OCC["OCC authorization<br/>Forward content hash"]
  OCC --> RPC["Gateway agents.files.get/set<br/>Select local or remote backend"]
  RPC --> FS["SandboxFsBridge<br/>Gateway-side remote adapter"]
  FS --> R["Harness host<br/>Guarded read/check/write"]
  R --> W[("Live Agent document")]
  classDef reuse fill:#dbeafe,stroke:#2563eb,color:#172554;
  classDef adapt fill:#fef3c7,stroke:#b45309,color:#451a03;
  classDef data fill:#f3f4f6,stroke:#6b7280,color:#111827;
  class UI reuse;
  class OCC,RPC,FS,R adapt;
  class W data;
```

- **Reuse:** [OpenShell remote mode][openshell] already uses [SandboxFsBridge][bridge].
  The [SSH backend][ssh] can adopt an existing remote workspace without mirroring
  local files into it. Start with that transport; no standalone file daemon.
- **Change:** [Gateway file handlers][agent-files], identity and [bootstrap loading][bootstrap]
  still use local paths. Resolve the Agent's selected backend at those callers.
  Keep local OpenClaw behavior as the default. OCE retains its existing
  [file client][oce-files], four filenames (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`,
  `USER.md`), 16 KiB limit and authorization. Runtime reads such as `BOOTSTRAP.md`
  and `MEMORY.md` do not expand owner editing permissions.
- **Live saves:** forward upstream `hash` / `expectedHash` through OCE's API,
  client and UI. Check/write and serialize owner saves on the Harness host;
  retain submissions on Gateway for recovery. Reject detected conflicts;
  preserve the existing unknown-outcome behavior when acknowledgement is lost.
- **Concurrency limit:** this detects stale edits but cannot exclude arbitrary
  native shell writes between check and write. Tasks continue; a later Harness
  write may replace an owner save. Saving does not force an active model to reread
  the document or hot-reload mandatory policy.

`node.invoke` / [`system.run`][node-exec] can run fixed commands, but has no stdin
field and returns capped text. Node-only hosts need bounded file commands in
the existing node process. Remote hash checking also needs implementation.
File access should survive a stopped Harness; an unreachable host returns
unavailable, without a stale-copy fallback.

## 3. Files before Agent creation (#89)

| Stage                | Proposed ownership and behavior                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before creation      | Add validated file defaults to OCC-owned Configuration data, outside native OpenClaw configuration values. Use the same four-file scope and limit.                                                                     |
| Create Agent         | In the authorized creation transaction, copy the selected defaults into an Agent-owned initial snapshot. Later template edits do not alter it.                                                                         |
| First start          | Pin that snapshot in the admitted revision. ComputeDriver materializes it before serving turns and records initialization completion. Retry the same snapshot idempotently; an unexpected existing file is a conflict. |
| After initialization | The Harness workspace is authoritative. Owner edits use section 2. Reconnect, restart and redeploy must not reapply defaults over live files.                                                                          |

Extend [Configuration, Agent and AgentRevision][oce-contracts] persistence,
creation and first-start logic. The [current live API][oce-api] requires an active
revision; it cannot store precreation files. Initialization failure keeps turns
disabled until the pinned snapshot is successfully applied.

## 4. Remaining consumers of the shared paths

### Memory

```mermaid
flowchart LR
  T["Gateway memory tools"] --> R["New node memory commands<br/>search / get / forget"]
  R --> M["Existing MemoryIndexManager<br/>Harness-local state"]
  M --- I[("Workspace memory files + index")]
  T --> S["Existing Gateway session search"]
  classDef reuse fill:#dbeafe,stroke:#2563eb,color:#172554;
  classDef adapt fill:#fef3c7,stroke:#b45309,color:#451a03;
  classDef added fill:#ede9fe,stroke:#7c3aed,color:#2e1065;
  classDef data fill:#f3f4f6,stroke:#6b7280,color:#111827;
  class S reuse;
  class T,M adapt;
  class R added;
  class I data;
```

Keep the [existing index manager][memory-manager] with the files so its local
watcher sees native edits. Wire [search/get][memory-tools] to new Agent-bound
node commands; no remote workspace-memory endpoint was found in the audited
path. Session search stays on Gateway. Memory-only configuration, embedding
access, merged results and forgetting/provenance require integration; report
an unavailable workspace source explicitly.

### Attachments, skills and configuration

| Reuse                                                                            | Required adaptation                                                                                                    |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [`prepareWorkerTurnAttachments`][attachments]                                    | Adapt its stdin-capable transport and ownership checks; stage admitted inputs before starting the turn.                |
| [Codex remote media reader][outputs] / SSH bridge                                | Fetch selected task outputs; retain delivery bytes on Gateway. Use SSH/node when app-server is stopped.                |
| [Node skill catalog][skill-catalog] + [`transferSkillResources`][skill-transfer] | Bind approved roots, adapt transfer/cleanup, and verify native Harness discovery and execution.                        |
| [OCE configuration and plugin installation][oce-runtime]                         | Deliver side-specific config/assets. Gateway plugins remain trusted; Harness scripts/plugins stay on the Harness host. |

Mandatory policy updates require an applied-version acknowledgement and any
required restart before new turns; ordinary document edits do not.

## 5. Delivery

1. **Prototype:** disable sync for document and attachment paths; prove owner
   read/save and attachment upload → native Harness read → output delivery,
   including conflicts, denied paths and unavailable-host behavior.
2. **Complete consumers:** initial defaults, Memory and skills. Preserve live
   files across replacement, with only one active runtime writer.
3. **Integrate OCE:** change [PVCs, mounts, validation and cleanup][oce-storage]
   together. The [direct-Codex entrypoint][oce-runtime] starts app-server, not a
   node host; node transport requires image/startup changes. Remove each shared
   category only after its consumer works, including the old Gateway-session
   copy and generated-image paths.

**Decisions for review:** live editing rather than deployment-only updates;
initial defaults applied once; SSH reuse first, node support separately qualified.
OpenClaw changes use opt-in remote routing; local behavior stays the default.
The prototype provides implementation feedback; OCE still needs its own real
deployment and replacement tests.

Source audit: OCE `b2658e0`; OpenClaw `9b99c61` (pinned reuse reference, not a
claim about the deployed runtime). Implementation will update
[file flows](../docs/flows/workspace-files.md), [Agent reference](../docs/reference/agents.md),
[Harness execution](../docs/reference/harness-execution.md), and the accepted
[platform design](../docs/design.md).

[oce-storage]: https://github.com/openclaw/openclaw-enterprise/blob/b2658e0f5c71d08307f0e4bce6e68d9774387c51/apps/controller/src/drivers/compute/kubernetes/index.ts#L264
[oce-files]: https://github.com/openclaw/openclaw-enterprise/blob/b2658e0f5c71d08307f0e4bce6e68d9774387c51/apps/controller/src/gateway/workspace-files-client.ts#L20
[oce-api]: https://github.com/openclaw/openclaw-enterprise/blob/b2658e0f5c71d08307f0e4bce6e68d9774387c51/apps/controller/src/index.ts#L1806
[oce-contracts]: https://github.com/openclaw/openclaw-enterprise/blob/b2658e0f5c71d08307f0e4bce6e68d9774387c51/packages/contracts/src/index.ts#L274
[oce-runtime]: https://github.com/openclaw/openclaw-enterprise/blob/b2658e0f5c71d08307f0e4bce6e68d9774387c51/apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts#L613
[openshell]: https://github.com/openclaw/openclaw/blob/9b99c6113fe03bde15af4539fd6a9692c9fa252c/extensions/openshell/src/backend.ts#L370
[bridge]: https://github.com/openclaw/openclaw/blob/9b99c6113fe03bde15af4539fd6a9692c9fa252c/src/agents/sandbox/remote-fs-bridge.ts#L47
[ssh]: https://github.com/openclaw/openclaw/blob/9b99c6113fe03bde15af4539fd6a9692c9fa252c/src/agents/sandbox/ssh-backend.ts#L167
[agent-files]: https://github.com/openclaw/openclaw/blob/9b99c6113fe03bde15af4539fd6a9692c9fa252c/src/gateway/server-methods/agents.ts#L1557
[bootstrap]: https://github.com/openclaw/openclaw/blob/9b99c6113fe03bde15af4539fd6a9692c9fa252c/src/agents/workspace.ts#L1226
[node-exec]: https://github.com/openclaw/openclaw/blob/9b99c6113fe03bde15af4539fd6a9692c9fa252c/src/node-host/invoke-types.ts#L26
[memory-manager]: https://github.com/openclaw/openclaw/blob/9b99c6113fe03bde15af4539fd6a9692c9fa252c/extensions/memory-core/src/memory/manager.ts
[memory-tools]: https://github.com/openclaw/openclaw/blob/9b99c6113fe03bde15af4539fd6a9692c9fa252c/extensions/memory-core/src/tools.ts
[attachments]: https://github.com/openclaw/openclaw/blob/9b99c6113fe03bde15af4539fd6a9692c9fa252c/src/gateway/worker-environments/worker-turn-attachments.ts#L86
[outputs]: https://github.com/openclaw/openclaw/blob/9b99c6113fe03bde15af4539fd6a9692c9fa252c/extensions/codex/src/app-server/remote-workspace-media.ts
[skill-catalog]: https://github.com/openclaw/openclaw/blob/9b99c6113fe03bde15af4539fd6a9692c9fa252c/src/skills/runtime/remote-skills.ts
[skill-transfer]: https://github.com/openclaw/openclaw/blob/9b99c6113fe03bde15af4539fd6a9692c9fa252c/src/gateway/worker-environments/skill-resource-transfer.ts#L106
