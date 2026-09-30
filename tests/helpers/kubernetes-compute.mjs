import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

/** Construct the production Kubernetes Driver without starting clients or contacting a cluster. */
export function createTestKubernetesComputeDriver(
  id,
  {
    repositoryCredentials = false,
    codexDeviceLogin = false,
    authentication = { mode: "inCluster" },
  } = {},
) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };

  return new KubernetesComputeDriver(
    {
      authentication,
      images: { gateway: "gateway:local", agent: "agent:local", requireImmutableDigest: false },
      resources: {
        gateway: resources,
        agent: resources,
        namespace: { quota: { pods: "10" }, containerDefaults: resources },
      },
      network: {
        dns: { namespace: "kube-system", podLabels: { app: "dns" } },
        gatewayPort: 8080,
        gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
        gatewayClients: [{ namespace: "controller", podLabels: { app: "controller" } }],
        ...(repositoryCredentials
          ? {
              repositoryCredentials: {
                namespace: "controller",
                podLabels: { app: "worker" },
                port: 8443,
              },
            }
          : {}),
      },
      servicePrincipalCredentials: { mode: "disabled" },
      ...(codexDeviceLogin ? { experimental: { codexDeviceLogin: true } } : {}),
      ...(repositoryCredentials
        ? {
            runtime: {
              transportSecretPrefix: "transport",
              gatewayStorageClassName: "local-path",
            },
          }
        : {}),
    },
    { id },
  );
}
