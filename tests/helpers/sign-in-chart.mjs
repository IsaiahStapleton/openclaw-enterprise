import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const repository = fileURLToPath(new URL("../../", import.meta.url));
const helm = process.env.OCC_HELM_BIN ?? "helm";

/** `test` options: skip unless Helm and yq can render the production chart. */
export async function chartTooling() {
  try {
    await execute(helm, ["version", "--short"], { cwd: repository });
    await execute("yq", ["--version"], { cwd: repository });
    return { skip: false };
  } catch {
    return { skip: "Install Helm and yq, or set OCC_HELM_BIN, to render the production chart." };
  }
}

function templateArguments(overrides) {
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
  return args;
}

/** Renders the example install with `--set` overrides and returns the parsed objects. */
export async function renderChart(overrides = {}) {
  const { stdout } = await execute(helm, templateArguments(overrides), {
    cwd: repository,
    maxBuffer: 2_000_000,
  });
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

/** The chart's refusal message for values it must not render. */
export async function chartRefusal(overrides) {
  try {
    await execute(helm, templateArguments(overrides), { cwd: repository, maxBuffer: 2_000_000 });
  } catch (error) {
    return String(error.stderr);
  }
  throw new Error(`The chart rendered ${JSON.stringify(overrides)}.`);
}

export function deploymentEnv(objects, component) {
  const deployment = objects.find(
    ({ kind, metadata }) =>
      kind === "Deployment" && metadata.labels?.["app.kubernetes.io/component"] === component,
  );
  assert.ok(deployment, component);
  return deployment.spec.template.spec.containers[0].env;
}

/** The API Pod's sign-in settings: literal values, or the Secret keys they come from. */
export function signInSettings(env) {
  return Object.fromEntries(
    env
      .filter(({ name }) => /^OCC_(AUTH_|AGENT_NATIVE_ADMIN_|GATEWAY_API_KEY_PATH$)/.test(name))
      .map(({ name, value, valueFrom }) => [
        name,
        value ?? { secretKeyRef: valueFrom.secretKeyRef },
      ]),
  );
}
