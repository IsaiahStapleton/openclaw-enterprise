/** Test-only deterministic compute driver; production development uses Docker. */
export function createDevelopmentComputeDriver() {
  return Object.freeze({
    id: "compute-local-development",
    capability: "compute",
    implementation: "deterministic-local-development",
    async ensureNamespace(namespace) {
      return {
        namespaceId: namespace.id,
        namespaceReady: true,
      };
    },
    async deleteNamespace(namespace) {
      return {
        namespaceId: namespace.id,
        namespaceDeleted: true,
      };
    },
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async stopRevision() {},
    async retireRevision() {},
  });
}
