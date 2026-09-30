import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import {
  apiRequests,
  detailUrl,
  login,
  nativeValues,
  newPage,
  waitForCondition,
} from "./console-agents-browser-helpers.mjs";

// The console runs against the production controller app, IAM, cursor signing and
// sanitizer. The Compute Driver serves in-memory Pod state in place of a cluster.
async function logsFixture(t) {
  const computeDriver = createRuntimeLogComputeDriver();
  const fixture = await createConsoleAppFixture(t, {
    computeDriver,
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime logs", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Logs Agent", nativeValues("v1"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  return { fixture, computeDriver, namespace, agent, revisionId: active.revision.id };
}

function line(second, raw) {
  return { time: `2026-09-30T12:00:${String(second).padStart(2, "0")}.000000001Z`, raw };
}

function logRequests(requests, revisionId) {
  return requests.filter(({ path }) => path.includes(`/deployments/${revisionId}/runtime/logs`));
}

test("the Logs tab shows runtime status, sanitized output and follows with a cursor", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  const secret = `ghp_${randomUUID().replaceAll("-", "")}`;
  computeDriver.state.restartCount = 1;
  computeDriver.state.events = [
    {
      type: "Warning",
      reason: "BackOff",
      message: "Back-off restarting failed container",
      count: 3,
      lastObservedAt: "2026-09-30T11:59:00Z",
    },
  ];
  computeDriver.state.lines = [
    line(
      1,
      '{"event":"runtime.startup_phase","container":"gateway","phase":"config","outcome":"ok","ms":12,"sinceStartMs":40}',
    ),
    line(2, `pushing with ${secret}`),
    line(3, '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"hi"}}'),
  ];
  computeDriver.state.previousLines = [line(0, "output before the restart")];

  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url.pathname + url.search);

  const card = page.locator(".runtime-pod");
  await card.getByRole("heading", { name: "Gateway" }).waitFor();
  await card.getByText("OOMKilled · exit 137", { exact: false }).waitFor();
  await card.getByText("BackOff ×3: Back-off restarting failed container").waitFor();
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("runtime.startup_phase").waitFor();
  await pane.getByText("pushing with [redacted:token]").waitFor();
  await pane.getByText("1 structured output withheld").waitFor();
  assert.equal(await page.getByText(secret).count(), 0);
  await page.getByText("Kubernetes keeps the current and the previous instance.").waitFor();

  // Follow polls with the view's cursor and labels a restart instead of hiding it.
  computeDriver.state.restartCount = 2;
  computeDriver.state.lines = [line(4, "after the restart")];
  await page.getByRole("button", { name: "Follow" }).click();
  await pane.getByText("after the restart").waitFor();
  await pane.getByText("Container restarted", { exact: true }).waitFor();
  assert.ok(logRequests(requests, revisionId).some(({ path }) => path.includes("cursor=v1.")));
  await page.getByRole("button", { name: "Following" }).click();

  // The previous instance is a separate view and disables follow.
  await page.getByLabel("Previous instance").check();
  await pane.getByText("output before the restart").waitFor();
  assert.equal(await page.getByRole("button", { name: "Follow" }).isDisabled(), true);
  assert.ok(logRequests(requests, revisionId).some(({ path }) => path.includes("previous=true")));

  // Drafts have no runtime and no Logs tab.
  await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "logs").href);
  await page.getByRole("button", { name: "Configuration", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Logs", exact: true }).count(), 0);
});

test("an operator without administer sees status but no log text and is never re-polled", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.lines = [line(1, "operator must not see this")];
  const operator = await fixture.createAccountWithPolicy("runtime-operator", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-runtime-operator",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "operate", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "read", resourceKind: "agent_revision" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-console-runtime-operator",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-runtime-operator",
    });
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url.pathname + url.search, operator.credentials);

  await page.locator(".runtime-pod").getByRole("heading", { name: "Gateway" }).waitFor();
  await page
    .getByText("Log text requires Agent administer and read access plus read access to this version.")
    .waitFor();
  assert.equal(await page.getByText("operator must not see this").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Follow" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Refresh logs" }).isDisabled(), true);
  const denied = logRequests(requests, revisionId).length;
  assert.equal(denied, 1);
  // Status keeps polling every 10 s; the denied log view is not requested again.
  await waitForCondition(
    () =>
      requests.filter(({ path }) => path.endsWith(`/deployments/${revisionId}/runtime`)).length >=
      2,
    "the runtime strip refreshes",
    15_000,
  );
  assert.equal(logRequests(requests, revisionId).length, denied);
});

test("the Logs tab explains cluster RBAC, unsupported Drivers and unavailable reads", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  const { RuntimeLogsForbiddenByClusterError } = await import(
    "../../packages/occ/src/index.ts"
  );
  computeDriver.state.readError = new RuntimeLogsForbiddenByClusterError();
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url.pathname + url.search);
  await page
    .getByText(/Ask your platform operator to enable agentRuntimeLogs in the Helm chart/)
    .waitFor();

  computeDriver.state.readError = new Error(`private detail ${randomUUID()}`);
  await page.getByRole("button", { name: "Refresh logs" }).click();
  await page.getByText(/Runtime status or logs are unavailable/).waitFor();
  assert.equal(await page.getByText(/private detail/).count(), 0);

  computeDriver.state.readError = undefined;
  computeDriver.state.describeError = new Error("cluster unreachable");
  computeDriver.runtimeLogging = "driver";
  await page.reload();
  await page
    .getByText(/This Compute Driver does not expose runtime status or logs/)
    .first()
    .waitFor();
});
