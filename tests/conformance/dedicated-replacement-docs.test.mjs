import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

function section(markdown, heading) {
  const start = markdown.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const next = markdown.indexOf("\n## ", start + heading.length + 2);
  return (next === -1 ? markdown.slice(start) : markdown.slice(start, next)).replace(/\s+/g, " ");
}

// Dogfood D23: dedicated redeploys stop the serving Gateway before the replacement
// is ready, while these pages claimed the predecessor keeps serving.
test("docs describe dedicated Kubernetes replacement as stopping the predecessor first", async () => {
  const exclusive = KubernetesComputeDriver.prototype.requiresStoppedPredecessors;
  assert.equal(exclusive({ harness: { mode: "dedicated" } }), true);
  assert.equal(exclusive({ harness: { mode: "embedded" } }), false);

  const activation = section(
    await read("docs/reference/harness-execution.md"),
    "## Isolation and activation",
  );
  assert.doesNotMatch(activation, /A replacement can be prepared while its predecessor serves/);
  assert.match(activation, /Dedicated replacement stops every earlier revision/);

  const topology = (await read("docs/flows/harness-execution-topology.md")).replace(/\s+/g, " ");
  assert.doesNotMatch(topology, /preparation keeps a healthy predecessor Gateway in place/);
  assert.match(topology, /worker stops every earlier revision, including its Gateway/);

  const deployment = (await read("docs/reference/agents/deployment.md")).replace(/\s+/g, " ");
  assert.match(
    deployment,
    /Unless Compute requests \[exclusive replacement\][^.]*, a replacement must preserve its predecessor's Service selector/,
  );
});
