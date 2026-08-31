# TODO

- #gap Runtime Compute Driver configuration changes are not pinned to existing
  AgentRevisions. Design revision stability and an AgentRevision retirement
  lifecycle before relying on unchanged runtime behavior across configuration
  updates.
- #enhancement Support explicit lifecycle-hook ordering so selected Drivers can
  declare preparation priority while teardown and rollback retain reverse order.
