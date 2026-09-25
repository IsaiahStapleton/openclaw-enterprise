import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const chartPackage = "ghcr.io/openclaw/charts/openclaw-enterprise";
export const chartPushParent = "oci://ghcr.io/openclaw/charts";

export async function writeBootstrapChart(directory, version) {
  assert.match(version, /^0\.0\.0-bootstrap\.[1-9][0-9]*\.[1-9][0-9]*$/);
  await mkdir(join(directory, "templates"), { recursive: true });
  await writeFile(
    join(directory, "Chart.yaml"),
    [
      "apiVersion: v2",
      "name: openclaw-enterprise",
      `version: ${version}`,
      "description: Non-deployable GHCR chart package bootstrap marker",
      "type: application",
      "sources:",
      "  - https://github.com/openclaw/openclaw-enterprise",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "templates", "marker.yaml"),
    '{{ fail "This bootstrap marker is not a deployable OpenClaw Enterprise chart." }}\n',
  );
}
