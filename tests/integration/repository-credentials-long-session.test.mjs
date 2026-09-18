import test from "node:test";
import { runInFixtureContainer } from "../fixtures/repository-credentials/container.mjs";
import { qualifyLongSession } from "../fixtures/repository-credentials/long-session.mjs";

test("same session pushes and completes API workflows after controlled hour thirteen", async (t) => {
  if (
    await runInFixtureContainer(t, "tests/integration/repository-credentials-long-session.test.mjs")
  ) {
    return;
  }
  await qualifyLongSession(t);
});
