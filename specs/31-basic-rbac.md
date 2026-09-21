# RFC: Basic RBAC for personal and team Agents

**Date:** 2026-09-18

**Status:** Proposed. Implementation and qualification remain open.

**Owner:** OCC authorization and Agent invocation.

**Original source baseline:** `046e12b007bb1b4928bd3f7497a2353714be11a8`.

## Problem and proposal

People need to create, operate and share Agents without giving every user
administrative access or exposing another person's content. This RFC proposes basic
role-based access control (RBAC) over OpenClaw Enterprise's existing exact-action
identity and access management (IAM): fixed roles, explicit grants to identities or
direct human Groups, and deny Restrictions that override matching grants.
Enrollment alone grants no access.

## Access model

The [twenty fixed roles](31-basic-rbac/interfaces.md#permissions-and-targets)
separate everyday responsibilities. An Agent viewer reads metadata and status;
a collaborator invokes the Agent and reads content; an editor changes configuration
and workspace content; an operator deploys and controls its lifecycle. Repository
and audit permissions are separate. Installation administration implies neither
content nor audit access.

Grants target an exact resource, a matching Agent or Configuration creator
collection in one Namespace, Namespace Agents for audit, or retained exact-Agent
audit. The last two targets permit only audit-reader grants.

An authorized human Installation administrator manages Groups, memberships, grants,
Restrictions and approved creation profiles through the selected IAM Driver.
[Policy administration](31-basic-rbac/interfaces.md#policy-administration) commits
each change with its revision, audit and withdrawal intent in one State transaction,
while preserving a usable local-password administrator and recoverable outcomes.

## Personal and team use

The human remains the requester, distinct from the Agent's ServicePrincipal.
A personal context uses that person's authority. A team context uses its shared
content baseline and admitted service authority, never a member's personal
credentials. The OpenClaw Control Plane (OCC) checks current invocation authority
before dispatch and content permission for the whole audience before replying.

```mermaid
---
config:
  theme: base
  htmlLabels: true
  themeVariables:
    fontSize: 16px
    lineColor: "#8B949E"
    edgeLabelBackground: "#FFFFFF"
  flowchart:
    curve: linear
    rankSpacing: 28
    padding: 12
---
flowchart TB
  Human["<b>Enrolled human</b><br/>Personal DM or team mention"]
  Gate["<b>OCC admission</b><br/>Current context and grants"]
  Turn["<b>Actual Agent turn</b><br/>Admitted protected operations"]
  Reply["<b>Native response</b><br/>Authorized whole audience"]
  Refuse["<b>Refuse or withdraw</b><br/>Authority missing or stale"]
  Human -.->|verified event| Gate
  Gate -.->|durable admission| Turn
  Turn -.->|recheck and disclose| Reply
  Gate -.->|deny or narrow| Refuse
  classDef pending fill:#F3F4F6,stroke:#98A2AE,color:#44505F,stroke-width:1px,stroke-dasharray:4 4
  classDef gate fill:#F7F1E5,stroke:#B3A078,color:#514532,stroke-width:1px
  class Human,Turn,Reply pending
  class Gate,Refuse gate
  linkStyle default stroke:#8B949E,stroke-width:1px
```

Dashed connections are proposed handoffs. The
[request lifecycle](31-basic-rbac/architecture.md#request-lifecycle) and
[invocation design](31-basic-rbac/invocation-and-content.md) explain execution,
protected credentials and separate dispatch/reply safeguards.

## Delivery and limits

The first usable checkpoint has deployer A and a different requester B use Slack
with a dedicated Codex Agent for a protected model turn and repository HEAD read
under `git-read`. The full selected scope also requires local accounts,
personal and team access, Teams, separately qualified Claude Code, repository
profiles and measured withdrawal.

Enforced admission fails closed without downgrade. Compatibility mode promises
neither verified execution nor bounded withdrawal. The
[security requirements](31-basic-rbac/security.md#withdrawal-and-failure) set
30-second limits for new-work refusal and the last protected bytes, with stricter
scoped limits and separate physical-stop and provider-cleanup outcomes.

[Delivery](31-basic-rbac/delivery.md) defines the increments, unresolved mechanisms
and acceptance evidence. [Human sign-in](https://github.com/openclaw/openclaw-enterprise/pull/246),
[identity](https://github.com/openclaw/openclaw-enterprise/pull/247),
[gVisor](https://github.com/openclaw/openclaw-enterprise/pull/248),
[egress](https://github.com/openclaw/openclaw-enterprise/pull/249) and
[History](https://github.com/openclaw/openclaw-enterprise/pull/250) retain their
separate requirements and acceptance gates. Custom roles, delegated administration,
per-effect authorization, directory synchronization and stronger private
compartments are deferred.
