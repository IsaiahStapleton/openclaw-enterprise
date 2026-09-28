# Render installation profiles

Installation profiles generate the two trusted files used by a production
OpenClaw Enterprise install: a Helm values overlay and the Installation startup
YAML mounted into the controller. Use a profile when you want the standard
OpenClaw or Codex defaults without editing the production examples by hand.

Profiles do not create clusters, Secrets, databases, DNS, certificates, hosted
plugin credentials, ChatGPT service accounts, repository registries, or Slack
consumers. They render configuration for an already prepared environment.

## Choose a profile

Use `openclaw` for embedded OpenClaw Agents with the bundled OpenClaw
PluginDriver. Plugin selection starts through manual or API configuration.

Use `codex` for dedicated Codex Agents with the bundled Codex PluginDriver.
Hosted plugin discovery and Codex runtime authentication both use an existing
`codex_pat` token path by default: add a same-Namespace Secret or enter the PAT
during Agent creation. Profile rendering does not create the token or make
catalog discovery ready.

Both profiles enable:

- Native admin UI and private gateway routing.
- Standard OpenClaw and Standard Codex Preset seeding.
- Kubernetes Compute, Kubernetes Configuration, Kubernetes Secrets, native IAM,
  private metrics, digest-pinned images, DNS policy, trusted proxy CIDRs, and
  plugin-status proxy CIDRs.

Repository support is optional. When enabled, the renderer wires the broker
container, GitHub Backend, Repo Driver, and Compute peer. The repository registry
still needs Namespace IDs from the first bootstrap pass, so most installs render
once with repositories disabled, bootstrap the platform, create the registry,
then render again with `repository.enabled: true`.

## Prepare inputs

Create a JSON file outside the repository or under an ignored local output
directory. Every field in the file is consumed by the renderer; unsupported
fields fail preflight.

```json
{
  "controlPlane": {
    "releaseName": "oce",
    "namespace": "openclaw-system",
    "clusterName": "production-west",
    "controllerImage": "registry.example/openclaw-enterprise/controller@sha256:<64-hex>",
    "authBaseUrl": "https://console.example.internal",
    "adminEmail": "admin@example.invalid",
    "bootstrapPasswordClaimName": "occ-bootstrap-admin-password",
    "apiClients": [{ "namespace": "operator-tools", "podLabels": { "app": "operator" } }],
    "databaseCidrs": ["10.45.0.12/32"],
    "clusterCidrs": ["10.43.0.1/32"],
    "dns": { "namespace": "kube-system", "podLabels": { "k8s-app": "kube-dns" } },
    "gatewayClassName": "eg",
    "gatewayApiKeySecretName": "occ-private-gateway-key",
    "agentNativeAdminDomain": "agents.example.internal",
    "sharedCookieDomain": "example.internal",
    "gatewayTrustedProxyCidrs": ["10.46.0.0/24"],
    "pluginStatusProxySourceCidrs": ["10.47.0.10/32"],
    "nodeSelector": { "oce-role": "control" }
  },
  "runtime": {
    "image": "registry.example/openclaw-enterprise/runtime@sha256:<64-hex>",
    "gatewayStorageClassName": "occ-gateway-rwo",
    "nodeSelector": { "oce-role": "agents" },
    "gatewayNodeSelector": { "oce-role": "control" },
    "transportSecretPrefix": "openclaw-agent-transport"
  },
  "channels": {
    "slackProxyUpstreamCidrs": ["198.51.100.0/24"]
  }
}
```

For the `codex` profile, add the reviewed Codex seccomp profile and model
discovery egress:

```json
{
  "runtime": {
    "codexSeccompProfile": "openclaw/codex-0.156.0-<profile-sha256>.json"
  },
  "codex": {
    "modelDiscoveryCidrs": ["198.51.100.20/32"]
  }
}
```

This fragment shows only the additional shape. Merge it with the base input.

If you have qualified the ChatGPT Backend admin credential path and want OCE to
issue managed runtime credentials, add the optional managed ServiceAccount
binding:

```json
{
  "codex": {
    "managedServiceAccounts": {
      "workspaceId": "11111111-1111-4111-8111-111111111111",
      "adminSecretName": "occ-chatgpt-admin",
      "adminSecretKey": "admin-key",
      "providerCidr": "198.51.100.30/32"
    }
  }
}
```

Managed issuance is separate from the default existing-token path. Rendering
the optional Backend and ServiceAccount Driver wiring does not prove live
service-account creation until the admin credential flow is qualified.

If you opt in to repositories, add the broker inputs:

```json
{
  "repository": {
    "enabled": true,
    "image": "registry.example/openclaw-enterprise/repository-credentials@sha256:<64-hex>",
    "backendId": "github-primary",
    "registryConfigMapName": "occ-repository-registry-v1",
    "serviceConfigSecretName": "occ-repository-service-config",
    "appKeySecretName": "occ-repository-app-key",
    "tlsSecretName": "occ-repository-tls",
    "publicCaSecretName": "occ-repository-public-ca",
    "serviceName": "git",
    "upstreamCidrs": ["198.51.100.0/24"]
  }
}
```

## Render files

Run the renderer from the repository root:

```sh
node scripts/render-installation-profile.mjs \
  --profile codex \
  --input .build/profile-inputs/codex.json \
  --out-dir .build/profile-renders/codex
```

On success, the output directory contains:

- `values.yaml`: Helm values for `deploy/helm/openclaw-enterprise`.
- `installation.yaml`: Installation startup YAML for the
  `occ-installation-startup` Secret.
- `preflight.json`: rendered output paths, warnings, prerequisites, and next
  steps.

If required input is missing or unsupported input is present, the renderer writes
`preflight.json` with `ok: false`, does not write `values.yaml` or
`installation.yaml`, and exits nonzero.

## Apply rendered output

Create the Installation startup Secret from the rendered file:

```sh
kubectl --namespace openclaw-system create secret generic occ-installation-startup \
  --from-file=installation.yaml=.build/profile-renders/codex/installation.yaml \
  --dry-run=client -o yaml | kubectl apply -f -
```

Then install or upgrade the chart with the rendered values:

```sh
helm upgrade --install oce deploy/helm/openclaw-enterprise \
  --namespace openclaw-system \
  --values .build/profile-renders/codex/values.yaml
```

After Helm finishes, retrieve the bootstrap service key from the protected
bootstrap PersistentVolumeClaim and verify authenticated OCC access.

## Required environment checks

Before calling the install ready, verify these prerequisites outside the
renderer:

- Kubernetes 1.35 or later, enforced NetworkPolicies, and exact API/database
  egress destinations.
- Envoy Gateway, cert-manager, wildcard DNS and TLS for native admin, and the
  shared cookie parent domain.
- A default ReadWriteOnce storage class for dedicated Codex workspace claims and
  `runtime.gatewayStorageClassName` for gateway state.
- For Codex, the configured localhost seccomp profile installed and verified on
  every node selected by `runtime.nodeSelector`.
- For Slack, separate runtime and Console directory proxies. Rendering proxy
  wiring does not enable a Slack consumer. The default profile input uses the
  chart-managed restricted proxy Service; if you use an external proxy instead,
  provide the literal IPv4 `runtimeProxyUrl` and `directoryProxyUrl` inputs and
  omit `slackProxyUpstreamCidrs`.
- For hosted plugin discovery and Codex runtime authentication, a
  same-Namespace `codex_pat` token Secret or entered PAT during Agent creation.
  Rendering the Codex profile does not create or verify that credential.
- For optional OCE-managed ChatGPT service-account runtime credentials, the
  admin Secret, workspace authority, and app connections described in
  [Configure the ChatGPT Backend](../integrations/chatgpt.md). Treat managed
  issuance as unverified until the admin credential flow is separately proven.
- For repositories, the first bootstrap pass must create Namespace IDs before
  you create the registry ConfigMap and rerender with repository support enabled.

## Related

- [Production installation](production-installation.md)
- [Amazon EKS](eks.md)
- [Codex sandbox setup](codex-sandbox.md)
- [ChatGPT Backend](../integrations/chatgpt.md)
- [Repository credential installation](../repository-credentials/installation.md)
