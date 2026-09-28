import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  defaultInstallSettings,
  githubUpgradeSettings,
  githubUpgradeValues,
} from "../helpers/production-sign-in.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const helm = process.env.OCC_HELM_BIN ?? "helm";
const recoveryUserId = "Xk3u9pQ2rT7vW1yZ";

let tooling;
try {
  await execute(helm, ["version", "--short"], { cwd: repository });
  await execute("yq", ["--version"], { cwd: repository });
  tooling = { skip: false };
} catch {
  tooling = { skip: "Install Helm and yq, or set OCC_HELM_BIN, to render the production chart." };
}

async function render(overrides = {}) {
  const args = [
    "template",
    "oce",
    "deploy/helm/openclaw-enterprise",
    "--namespace",
    "openclaw-system",
    "--values",
    "deploy/examples/production/values.yaml",
  ];
  for (const [key, value] of Object.entries(overrides)) {
    args.push("--set", `${key}=${value}`);
  }
  const { stdout } = await execute(helm, args, { cwd: repository, maxBuffer: 2_000_000 });
  const parsed = await new Promise((resolve, reject) => {
    const child = execFile(
      "yq",
      ["eval-all", "-o=json", "-I=0", ".", "-"],
      { cwd: repository, maxBuffer: 2_000_000 },
      (error, output) => (error ? reject(error) : resolve(output)),
    );
    child.stdin.end(stdout);
  });
  return parsed.trim().split("\n").map(JSON.parse);
}

function deploymentEnv(objects, component) {
  const deployment = objects.find(
    ({ kind, metadata }) =>
      kind === "Deployment" && metadata.labels?.["app.kubernetes.io/component"] === component,
  );
  assert.ok(deployment, component);
  return deployment.spec.template.spec.containers[0].env;
}

// The sign-in settings the PostgreSQL proofs compose the API from, as the chart renders them.
function signInSettings(env) {
  return Object.fromEntries(
    env
      .filter(({ name }) => /^OCC_(AUTH_|AGENT_NATIVE_ADMIN_|GATEWAY_API_KEY_PATH$)/.test(name))
      .map(({ name, value, valueFrom }) => [
        name,
        value ?? { secretKeyRef: valueFrom.secretKeyRef },
      ]),
  );
}

const githubEgress = ({ kind, metadata }) =>
  kind === "NetworkPolicy" && metadata.name.endsWith("-api-github-login-egress");

test(
  "the example install renders password-only sign-in and GitHub only as an upgrade",
  tooling,
  async () => {
    const install = await render();
    assert.deepEqual(signInSettings(deploymentEnv(install, "api")), defaultInstallSettings);
    assert.equal(install.some(githubEgress), false);

    const upgrade = await render(githubUpgradeValues(recoveryUserId));
    assert.deepEqual(
      signInSettings(deploymentEnv(upgrade, "api")),
      githubUpgradeSettings(recoveryUserId),
    );
    assert.equal(upgrade.filter(githubEgress).length, 1);

    const proxied = await render({
      "api.trustedProxy.preset": "ingress-nginx",
      "api.trustedProxy.cidrs[0]": "10.42.0.0/16",
    });
    assert.deepEqual(signInSettings(deploymentEnv(proxied, "api")), {
      ...defaultInstallSettings,
      OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.42.0.0/16",
      OCC_AUTH_TRUSTED_PROXY_PRESET: "ingress-nginx",
    });
    for (const objects of [install, upgrade, proxied]) {
      assert.ok(
        !deploymentEnv(objects, "worker").some(({ name }) =>
          /^OCC_AUTH_(GITHUB_|TRUSTED_PROXY_|CLIENT_IP_HEADER)/.test(name),
        ),
      );
    }
  },
);
