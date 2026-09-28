import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const helm = process.env.OCC_HELM_BIN ?? "helm";

let helmSkip = false;
try {
  execFileSync(helm, ["version", "--short"], { cwd: repository, stdio: "ignore" });
} catch {
  helmSkip = "Install Helm, or set OCC_HELM_BIN, to verify rendered profile values.";
}

function baseInput(overrides = {}) {
  return {
    controlPlane: {
      releaseName: "oce",
      namespace: "openclaw-system",
      clusterName: "profile-qualification",
      controllerImage: `registry.example.invalid/openclaw-enterprise/controller@sha256:${digestA}`,
      authBaseUrl: "https://console.oce.example.internal",
      adminEmail: "admin@example.invalid",
      bootstrapPasswordClaimName: "occ-bootstrap-admin-password",
      apiClients: [{ namespace: "operator-tools", podLabels: { app: "occ-operator" } }],
      databaseCidrs: ["192.0.2.10/32"],
      clusterCidrs: ["192.0.2.11/32"],
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayClassName: "eg",
      gatewayApiKeySecretName: "occ-private-gateway-key",
      agentNativeAdminDomain: "agents.oce.example.internal",
      sharedCookieDomain: "oce.example.internal",
      gatewayTrustedProxyCidrs: ["192.0.2.12/32"],
      pluginStatusProxySourceCidrs: ["192.0.2.13/32"],
      nodeSelector: { "oce-role": "control" },
      metrics: {
        scraperNamespaceLabels: { name: "monitoring" },
        scraperPodLabels: { app: "prometheus" },
      },
    },
    runtime: {
      image: `registry.example.invalid/openclaw-enterprise/runtime@sha256:${digestB}`,
      gatewayStorageClassName: "occ-gateway-rwo",
      nodeSelector: { "oce-role": "agents" },
      gatewayNodeSelector: { "oce-role": "control" },
      transportSecretPrefix: "openclaw-agent-transport",
    },
    channels: {
      slackProxyUpstreamCidrs: ["203.0.113.10/32"],
    },
    ...overrides,
  };
}

function codexInput(overrides = {}) {
  const input = baseInput();
  return {
    ...input,
    ...overrides,
    runtime: {
      ...input.runtime,
      codexSeccompProfile: "profiles/codex.json",
      ...(overrides.runtime ?? {}),
    },
    codex: {
      modelDiscoveryCidrs: ["192.0.2.20/32"],
      ...(overrides.codex ?? {}),
    },
  };
}

function managedCodexInput(overrides = {}) {
  return codexInput({
    ...overrides,
    codex: {
      managedServiceAccounts: {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        adminSecretName: "occ-chatgpt-admin",
        adminSecretKey: "admin-key",
        providerCidr: "192.0.2.21/32",
      },
      ...(overrides.codex ?? {}),
    },
  });
}

function render(profile, input) {
  const directory = mkdtempSync(join(tmpdir(), `oce-profile-${profile}-`));
  const inputPath = join(directory, "input.json");
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  let summary;
  try {
    summary = execFileSync(
      process.execPath,
      [
        "scripts/render-installation-profile.mjs",
        "--profile",
        profile,
        "--input",
        inputPath,
        "--out-dir",
        directory,
      ],
      { cwd: repository, encoding: "utf8" },
    );
  } catch (error) {
    error.profileRendererOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    error.profileRendererDirectory = directory;
    throw error;
  }
  return {
    directory,
    summary: JSON.parse(summary),
    values: readFileSync(join(directory, "values.yaml"), "utf8"),
    installation: readFileSync(join(directory, "installation.yaml"), "utf8"),
    preflight: JSON.parse(readFileSync(join(directory, "preflight.json"), "utf8")),
  };
}

function helmTemplate(output, extraValueFiles = []) {
  return execFileSync(
    helm,
    [
      "template",
      "oce",
      "deploy/helm/openclaw-enterprise",
      "--namespace",
      "openclaw-system",
      "--values",
      join(output.directory, "values.yaml"),
      ...extraValueFiles.flatMap((path) => ["--values", path]),
    ],
    {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 2_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function renderError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail("expected the profile renderer to reject the input");
}

function assertPreflightFailure(profile, input, expected) {
  const error = renderError(() => render(profile, input));
  assert.match(error.profileRendererOutput, expected);
  const directory = error.profileRendererDirectory;
  assert.equal(existsSync(join(directory, "preflight.json")), true);
  assert.equal(existsSync(join(directory, "values.yaml")), false);
  assert.equal(existsSync(join(directory, "installation.yaml")), false);
  const preflight = JSON.parse(readFileSync(join(directory, "preflight.json"), "utf8"));
  assert.equal(preflight.ok, false);
  assert.match(preflight.errors.join("\n"), expected);
}

test("renderer supports exactly the openclaw and codex profiles", () => {
  const openclaw = render("openclaw", baseInput());
  assert.equal(openclaw.summary.ok, true);
  assert.equal(openclaw.preflight.profile, "openclaw");
  assert.match(openclaw.installation, /id: occ-plugin/);
  assert.doesNotMatch(openclaw.installation, /id: codex-plugin/);
  assert.match(openclaw.values, /agentNativeAdmin:\n {2}enabled: true/);
  assert.match(openclaw.values, /repositoryCredentials:\n {2}enabled: false/);
  assert.match(
    openclaw.values,
    /slackProxy:\n {2}enabled: true\n {2}upstreamCidrs:\n {4}- 203.0.113.10\/32/,
  );
  assert.match(
    openclaw.installation,
    /channels:\n\s+proxyUrl: http:\/\/openclaw-enterprise-slack-proxy\.openclaw-system\.svc:3128/,
  );
  assert.match(
    openclaw.installation,
    /managedProxy:\n\s+hostname: openclaw-enterprise-slack-proxy\.openclaw-system\.svc/,
  );
  assert.match(openclaw.installation, /app\.kubernetes\.io\/component: slack-proxy/);

  const codex = render("codex", codexInput());
  assert.equal(codex.summary.ok, true);
  assert.equal(codex.preflight.profile, "codex");
  assert.match(codex.installation, /id: codex-plugin/);
  assert.match(codex.installation, /catalogSource: hosted/);
  assert.doesNotMatch(codex.installation, /service_account: chatgpt-service-accounts/);
  assert.match(
    codex.values,
    /slackProxy:\n {2}enabled: true\n {2}upstreamCidrs:\n {4}- 203.0.113.10\/32/,
  );
  assert.match(
    codex.installation,
    /channels:\n\s+proxyUrl: http:\/\/openclaw-enterprise-slack-proxy\.openclaw-system\.svc:3128/,
  );
  assert.match(codex.preflight.prerequisites.join("\n"), /Slack consumers remain inactive/);
  assert.match(codex.preflight.warnings.join("\n"), /existing codex_pat token/);
});

test("managed ChatGPT service-account wiring is optional and explicit", () => {
  const codex = render("codex", managedCodexInput());
  assert.equal(codex.summary.ok, true);
  assert.match(codex.values, /backend:\n {2}chatgpt:\n {4}enabled: true/);
  assert.match(codex.installation, /service_account: chatgpt-service-accounts/);
  assert.match(codex.preflight.warnings.join("\n"), /issuance is wired but remains unverified/);
});

test("rendered profile values pass Helm chart validation", { skip: helmSkip }, () => {
  const openclaw = render("openclaw", baseInput());
  assert.match(helmTemplate(openclaw), /kind: Deployment/);

  const codex = render("codex", codexInput());
  assert.match(helmTemplate(codex), /kind: Deployment/);

  const repositoryOutput = render(
    "codex",
    codexInput({
      repository: {
        enabled: true,
        image: `registry.example.invalid/openclaw-enterprise/repository-credentials@sha256:${digestC}`,
        backendId: "github-primary",
        registryConfigMapName: "occ-repository-registry-v1",
        serviceConfigSecretName: "occ-repository-service-config",
        appKeySecretName: "occ-repository-app-key",
        tlsSecretName: "occ-repository-tls",
        publicCaSecretName: "occ-repository-public-ca",
        upstreamCidrs: ["192.0.2.30/32"],
      },
    }),
  );
  assert.match(helmTemplate(repositoryOutput), /repository-credentials/);
});

test("Helm catches generated profile Secret collisions", { skip: helmSkip }, () => {
  const repositoryOutput = render(
    "codex",
    managedCodexInput({
      repository: {
        enabled: true,
        image: `registry.example.invalid/openclaw-enterprise/repository-credentials@sha256:${digestC}`,
        backendId: "github-primary",
        registryConfigMapName: "occ-repository-registry-v1",
        serviceConfigSecretName: "occ-repository-service-config",
        appKeySecretName: "occ-repository-app-key",
        tlsSecretName: "occ-repository-tls",
        publicCaSecretName: "occ-repository-public-ca",
        upstreamCidrs: ["192.0.2.30/32"],
      },
    }),
  );
  const collision = join(repositoryOutput.directory, "secret-collision.yaml");
  writeFileSync(
    collision,
    "repositoryCredentials:\n  serviceConfigSecretName: occ-chatgpt-admin\n",
  );

  const error = renderError(() => helmTemplate(repositoryOutput, [collision]));
  assert.match(
    `${error.stdout ?? ""}${error.stderr ?? ""}`,
    /repositoryCredentials\.serviceConfigSecretName must use a dedicated Secret distinct from chatgpt/,
  );
});

test("renderer rejects the removed default profile", () => {
  assert.throws(() => render("default", baseInput()), /--profile must be one of: openclaw, codex/);
});

test("repository opt-in is explicit and keeps the two-stage placeholders separate", () => {
  const output = render(
    "codex",
    codexInput({
      repository: {
        enabled: true,
        image: `registry.example.invalid/openclaw-enterprise/repository-credentials@sha256:${digestC}`,
        backendId: "github-primary",
        registryConfigMapName: "occ-repository-registry-v1",
        serviceConfigSecretName: "occ-repository-service-config",
        appKeySecretName: "occ-repository-app-key",
        tlsSecretName: "occ-repository-tls",
        publicCaSecretName: "occ-repository-public-ca",
        upstreamCidrs: ["192.0.2.30/32"],
      },
    }),
  );
  assert.equal(output.summary.ok, true);
  assert.match(output.values, /repositoryCredentials:\n {2}enabled: true/);
  assert.match(output.values, /registryConfigMapName: occ-repository-registry-v1/);
  assert.match(output.installation, /type: github/);
  assert.match(
    output.installation,
    /registryPath: \/etc\/openclaw\/repository-registry\/registry.json/,
  );
  assert.match(
    output.preflight.warnings.join("\n"),
    /Broker or worker Pod replacement loses active sessions/,
  );
});

test("preflight rejects inputs that the selected profile does not consume", () => {
  assertPreflightFailure(
    "openclaw",
    baseInput({
      runtime: {
        ...baseInput().runtime,
        codexSeccompProfile: "profiles/codex.json",
      },
    }),
    /runtime.codexSeccompProfile is only consumed by the codex profile/,
  );

  assertPreflightFailure(
    "codex",
    codexInput({
      repository: {
        enabled: false,
        backendId: "github-primary",
      },
    }),
    /repository fields other than enabled are only consumed/,
  );
});

test("preflight rejects invalid CIDRs before rendering", () => {
  assertPreflightFailure(
    "codex",
    codexInput({
      controlPlane: {
        ...baseInput().controlPlane,
        databaseCidrs: ["999.999.999.999/32"],
      },
    }),
    /controlPlane.databaseCidrs\[0\] must be an IPv4 \/32 CIDR/,
  );

  assertPreflightFailure(
    "codex",
    managedCodexInput({
      codex: {
        modelDiscoveryCidrs: ["192.0.2.20/32"],
        managedServiceAccounts: {
          workspaceId: "11111111-1111-4111-8111-111111111111",
          adminSecretName: "occ-chatgpt-admin",
          providerCidr: "999.999.999.999/32",
        },
      },
    }),
    /codex.managedServiceAccounts.providerCidr must be an IPv4 \/32 CIDR/,
  );
});

test("preflight rejects metrics and native admin inputs that Helm would reject", () => {
  assertPreflightFailure(
    "codex",
    codexInput({
      controlPlane: {
        ...baseInput().controlPlane,
        metrics: {
          scraperNamespaceLabels: { name: "monitoring" },
        },
      },
    }),
    /controlPlane.metrics requires both scraperNamespaceLabels and scraperPodLabels, or neither/,
  );

  assertPreflightFailure(
    "codex",
    codexInput({
      controlPlane: {
        ...baseInput().controlPlane,
        agentNativeAdminDomain: "https://agents.oce.example.internal",
      },
    }),
    /controlPlane.agentNativeAdminDomain must be a DNS hostname without a wildcard, port, scheme, or path/,
  );

  assertPreflightFailure(
    "codex",
    codexInput({
      controlPlane: {
        ...baseInput().controlPlane,
        agentNativeAdminDomain: "agents.other.example.internal",
      },
    }),
    /controlPlane.agentNativeAdminDomain must be inside controlPlane.sharedCookieDomain/,
  );
});
