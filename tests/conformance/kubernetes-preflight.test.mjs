import assert from "node:assert/strict";
import test from "node:test";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

function driverForVersion(gitVersion) {
  const driver = createTestKubernetesComputeDriver("compute-kubernetes-preflight");
  let namespaceReads = 0;
  driver.apiClients = Promise.resolve({
    version: {
      async getCode() {
        return { gitVersion };
      },
    },
    core: {
      async listNamespace() {
        namespaceReads += 1;
        return { items: [] };
      },
    },
  });
  return { driver, namespaceReads: () => namespaceReads };
}

test("Kubernetes preflight warns below 1.35 without blocking authenticated access", async () => {
  const fixture = driverForVersion("v1.34.12+k3s1");

  const result = await fixture.driver.preflight();

  assert.deepEqual(result, {
    warnings: [
      {
        code: "KUBERNETES_VERSION_BELOW_MINIMUM",
        message: "Kubernetes 1.34.12 is below the supported minimum 1.35.0.",
      },
    ],
  });
  assert.equal(
    fixture.namespaceReads(),
    1,
    "an advisory version warning must not skip the authenticated namespace preflight",
  );
});

test("Kubernetes preflight accepts supported Kubernetes release families", async () => {
  for (const gitVersion of ["v1.35.0", "v1.35.0+k3s1", "v1.35.8+k3s1", "v1.36.4+k3s1"]) {
    const fixture = driverForVersion(gitVersion);
    assert.deepEqual(await fixture.driver.preflight(), { warnings: [] });
    assert.equal(fixture.namespaceReads(), 1);
  }
});

test("Kubernetes preflight rejects an invalid API server version response", async () => {
  const fixture = driverForVersion("current");
  await assert.rejects(fixture.driver.preflight(), /version preflight returned invalid data/);
  assert.equal(fixture.namespaceReads(), 0);
});
