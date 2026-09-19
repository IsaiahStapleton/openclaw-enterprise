import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runInFixtureContainer } from "../fixtures/repository-credentials/container.mjs";
import { qualifyLongSession } from "../fixtures/repository-credentials/long-session.mjs";
import { repositoryRoot } from "../fixtures/repository-credentials/runtime.mjs";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";

test("emitted service and client artifacts qualify the same-session thirteen-hour workflow", async (t) => {
  if (
    await runInFixtureContainer(t, "tests/integration/repository-credentials-container.test.mjs", {
      packaged: true,
    })
  ) {
    return;
  }
  await qualifyLongSession(t);
});

// Each host case launches its own selected artifact workflow or inspects host mounts.
if (process.env.REPOSITORY_CREDENTIALS_CONTAINER_CHILD !== "1") {
  test("emitted common owners qualify alternate-backend renewal, authentication and streamed drain", async (t) => {
    await runInFixtureContainer(
      t,
      "tests/conformance/repository-credentials-backend-conformance.test.mjs",
      { packaged: true },
    );
  });

  test("delivered Compose client mounts exclude provider inputs and the control socket", async (t) => {
    const directory = await temporaryDirectory(t);
    const paths = {
      CREDENTIAL_SERVICE_INPUTS: join(directory, "private-inputs"),
      CREDENTIAL_SERVICE_CONTROL: join(directory, "private-control"),
      CREDENTIAL_CLIENT_SESSION: join(directory, "client-parent", "selected-session"),
      CREDENTIAL_CLIENT_WORKSPACE: join(directory, "workspace"),
    };
    const result = await run(
      "docker",
      [
        "compose",
        "--file",
        join(repositoryRoot, "deploy/examples/repository-credentials/compose.yaml"),
        "--profile",
        "client",
        "config",
        "--format",
        "json",
      ],
      {
        env: cleanEnvironment({
          ...paths,
          CREDENTIAL_SERVICE_UID: String(process.getuid?.() ?? 1000),
          CREDENTIAL_SERVICE_GID: String(process.getgid?.() ?? 1000),
        }),
      },
    );
    const composed = JSON.parse(result.stdout);
    const volumes = composed.services.client.volumes;
    assert.deepEqual(
      volumes.map((volume) => volume.source).sort(),
      [paths.CREDENTIAL_CLIENT_SESSION, paths.CREDENTIAL_CLIENT_WORKSPACE].sort(),
    );
    assert.equal(volumes.find((volume) => volume.target === "/session").read_only, true);
    assert.ok(
      composed.services.service.volumes.some(
        (volume) => volume.source === paths.CREDENTIAL_SERVICE_INPUTS,
      ),
    );
    assert.ok(
      composed.services.service.volumes.some(
        (volume) => volume.source === paths.CREDENTIAL_SERVICE_CONTROL,
      ),
    );
  });
}
