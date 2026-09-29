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
const digestD = "d".repeat(64);
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
      managedSlackProxy: true,
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

function render(
  profile,
  input,
  directory = mkdtempSync(join(tmpdir(), `oce-profile-${profile}-`)),
) {
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

function helmTemplate(output, extraValueFiles = [], releaseName = "oce") {
  return execFileSync(
    helm,
    [
      "template",
      releaseName,
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

function deploymentChecksum(manifests, component) {
  const document = manifests
    .split(/\n---\n/)
    .find(
      (entry) =>
        entry.includes("kind: Deployment") &&
        entry.includes(`app.kubernetes.io/component: ${component}`),
    );
  assert.ok(document, `expected ${component} Deployment in Helm output`);
  const match = document.match(/openclaw\.dev\/installation-checksum: "([a-f0-9]{64})"/);
  assert.ok(match, `expected ${component} installation checksum annotation`);
  return match[1];
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
  assert.match(openclaw.values, /slackProxy:\n {2}enabled: true/);
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
  assert.match(codex.values, /slackProxy:\n {2}enabled: true/);
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

test(
  "long release names keep Installation routing attached to the rendered Gateway",
  { skip: helmSkip },
  () => {
    for (const profile of ["openclaw", "codex"]) {
      // Exercise the DNS-name boundary and Helm's maximum supported release length.
      for (const length of [48, 49, 53]) {
        const input = profile === "codex" ? codexInput() : baseInput();
        const releaseName = "r".repeat(length);
        input.controlPlane.releaseName = releaseName;
        const output = render(profile, input);
        const gateway = helmTemplate(output, [], releaseName)
          .split(/\n---\n/)
          .find((document) => /\nkind: Gateway\n/.test(document));
        assert.ok(gateway, "Helm must render the Gateway referenced by Compute");
        const gatewayName = gateway.match(/^ {2}name: (\S+)$/m)?.[1];
        const routingName = output.installation.match(/^\s+gatewayName: (\S+)$/m)?.[1];
        assert.ok(gatewayName && gatewayName.length <= 63);
        assert.equal(routingName, gatewayName, `${profile}: release length ${length}`);
      }
    }
  },
);

test("failed rerenders remove stale deployable artifacts from a reused directory", () => {
  for (const profile of ["openclaw", "codex"]) {
    const input = profile === "codex" ? codexInput() : baseInput();
    const output = render(profile, input);
    const notes = join(output.directory, "operator-notes.txt");
    writeFileSync(notes, "Retain operator-owned files.\n");

    // A failed second run must not leave the first run's configuration deployable.
    const invalid = structuredClone(input);
    invalid.controlPlane.databaseCidrs = ["invalid-cidr"];
    const error = renderError(() => render(profile, invalid, output.directory));
    assert.match(error.profileRendererOutput, /must be an IPv4 \/32 CIDR/);
    for (const name of ["values.yaml", "installation.yaml"]) {
      assert.equal(existsSync(join(output.directory, name)), false);
    }
    const preflight = JSON.parse(readFileSync(join(output.directory, "preflight.json"), "utf8"));
    assert.equal(preflight.ok, false);
    assert.deepEqual(preflight.outputs, { preflight: join(output.directory, "preflight.json") });
    assert.equal(readFileSync(notes, "utf8"), "Retain operator-owned files.\n");

    // Recovery regenerates both artifacts; malformed JSON must also invalidate that success.
    assert.equal(render(profile, input, output.directory).preflight.ok, true);
    writeFileSync(join(output.directory, "input.json"), "{");
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            "scripts/render-installation-profile.mjs",
            "--profile",
            profile,
            "--input",
            join(output.directory, "input.json"),
            "--out-dir",
            output.directory,
          ],
          { cwd: repository, stdio: "pipe" },
        ),
      /unavailable or invalid JSON/,
    );
    for (const name of ["values.yaml", "installation.yaml", "preflight.json"]) {
      assert.equal(existsSync(join(output.directory, name)), false);
    }
    assert.equal(readFileSync(notes, "utf8"), "Retain operator-owned files.\n");
  }
});

test("both profiles preserve provider ranges and public Slack egress", { skip: helmSkip }, () => {
  for (const profile of ["openclaw", "codex"]) {
    // Provider ranges must survive rendering; individual DNS answers are not stable.
    const input = profile === "codex" ? codexInput() : baseInput();
    input.repository = {
      enabled: true,
      image: `registry.example.invalid/openclaw-enterprise/repository-credentials@sha256:${digestC}`,
      backendId: "github-primary",
      registryConfigMapName: "occ-repository-registry-v1",
      serviceConfigSecretName: "occ-repository-service-config",
      appKeySecretName: "occ-repository-app-key",
      tlsSecretName: "occ-repository-tls",
      publicCaSecretName: "occ-repository-public-ca",
      upstreamCidrs: ["140.82.112.0/20", "192.30.252.0/22"],
    };
    const output = render(profile, input);
    const manifests = helmTemplate(output);
    assert.match(manifests, /repository-credentials/);
    assert.match(manifests, /cidr: "140\.82\.112\.0\/20"/);
    assert.match(manifests, /cidr: "192\.30\.252\.0\/22"/);
    const slackPolicy = manifests
      .split(/\n---\n/)
      .find(
        (document) =>
          document.includes("kind: NetworkPolicy") &&
          document.includes("name: openclaw-enterprise-slack-proxy"),
      );
    assert.ok(slackPolicy);
    assert.match(slackPolicy, /cidr: 0\.0\.0\.0\/0\s+except:/);
    assert.doesNotMatch(output.values, /slackProxyUpstreamCidrs/);
  }
});

test(
  "startup-only installation changes roll API and worker pod templates",
  { skip: helmSkip },
  () => {
    const original = render("codex", codexInput());
    const changed = render(
      "codex",
      codexInput({
        runtime: {
          image: `registry.example.invalid/openclaw-enterprise/runtime@sha256:${digestD}`,
        },
      }),
    );

    assert.match(original.values, /installationChecksum: [a-f0-9]{64}/);
    assert.match(changed.values, /installationChecksum: [a-f0-9]{64}/);
    assert.notEqual(original.installation, changed.installation);

    const originalManifests = helmTemplate(original);
    const changedManifests = helmTemplate(changed);
    for (const component of ["api", "worker"]) {
      assert.notEqual(
        deploymentChecksum(originalManifests, component),
        deploymentChecksum(changedManifests, component),
        `${component} checksum annotation changes when only installation.yaml changes`,
      );
    }
  },
);

test(
  "profile preset files reach startup YAML and roll both controllers",
  { skip: helmSkip },
  () => {
    const original = render("codex", codexInput());
    const changed = render(
      "codex",
      codexInput({ presets: { files: ["/app/deploy/presets/devday.json"] } }),
    );
    assert.match(
      changed.installation,
      /presets:\n {2}includeDefaults: true\n {2}files:\n {4}- \/app\/deploy\/presets\/devday.json/,
    );
    const originalManifests = helmTemplate(original);
    const changedManifests = helmTemplate(changed);
    for (const component of ["api", "worker"]) {
      assert.notEqual(
        deploymentChecksum(originalManifests, component),
        deploymentChecksum(changedManifests, component),
      );
    }
  },
);

test("profile preset files reject malformed paths and unknown settings", () => {
  for (const files of ["presets/custom.json", [""], [42]]) {
    assertPreflightFailure("codex", codexInput({ presets: { files } }), /presets.files/);
  }
  assertPreflightFailure("codex", codexInput({ presets: { unknown: true } }), /presets.unknown/);
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
    /Active repository sessions are not restored after broker loss/,
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
