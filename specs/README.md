# Specifications

This directory holds architectural decisions and implementation plans:

```text
specs/
  rfcs/      Architectural proposals and decisions
  plans/     Implementation plans and delivery records
  .archive/  Preserved historical specifications
```

An RFC defines a decision; a plan describes its implementation. Plans can also
stand alone, and link relevant RFCs through `rfc` frontmatter. Use one Markdown
file per document, or a folder with `index.md` when companions are needed.
See the [specification process](../docs/contributing/specifications.md) for
authoring, numbering, and review.

## RFCs

Status reflects each RFC’s recorded decision, not implementation or release availability.

| RFC                                                                                                               | Status      |
| ----------------------------------------------------------------------------------------------------------------- | ----------- |
| [RFC-0001: Generic OIDC sign-in for existing accounts](rfcs/0001-oidc-sign-in.md)                                 | Proposed    |
| [RFC-0002: Agent workload tags](rfcs/0002-agent-workload-tags.md)                                                 | Proposed    |
| [RFC-0003: Gateway–Harness storage split](rfcs/0003-gateway-harness-storage-split.md)                             | Proposed    |
| [RFC-0004: Initial OCC Prometheus metrics](rfcs/0004-occ-prometheus-metrics.md)                                   | Accepted    |
| [RFC-0005: Harness authentication bindings](rfcs/0005-harness-auth-binding.md)                                    | Proposed    |
| [RFC-0006: Basic RBAC for personal and team Agents](rfcs/0006-basic-rbac/index.md)                                | Proposed    |
| [RFC-0007: GitHub sign-in for existing accounts](rfcs/0007-human-federated-sign-in/index.md)                      | Unspecified |
| [RFC-0008: Repository credentials for ordinary Agents](rfcs/0008-repository-credentials/index.md)                 | Unspecified |
| [RFC-0009: Native OpenClaw plugin tool policies](rfcs/0009-native-plugin-tool-policy.md)                          | Proposed    |
| [RFC-0010: Agent access](rfcs/0010-agent-access.md)                                                               | Proposed    |
| [RFC-0011: Independent production image upgrades](rfcs/0011-coordinated-image-upgrade.md)                         | Proposed    |
| [RFC-0012: Default production observability](rfcs/0012-production-observability.md)                               | Unspecified |
| [RFC-0013: Platform audit](rfcs/0013-platform-audit/index.md)                                                     | Proposed    |
| [RFC-0014: Plugin policy enforcement](rfcs/0014-plugin-policy-enforcement.md)                                     | Proposed    |
| [RFC-0015: Recover repository credential cleanup after broker loss](rfcs/0015-repository-credential-recovery.md)  | Proposed    |
| [RFC-0016: Credential Gateway Driver for Sandbox-injected credentials](rfcs/0016-sandbox-credential-injection.md) | Proposed    |
| [RFC-0017: Agent egress for 0.x](rfcs/0017-agent-egress-0x/index.md)                                              | Unspecified |
| [RFC-0018: Installation profiles: openclaw and codex](rfcs/0018-installation-profiles-design/index.md)            | Accepted    |
