import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/workspace-defaults.mjs";

import { createConsoleAppFixture, backendFixtures } from "../helpers/console-app.mjs";

import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

import {
  newPage,
  login,
  apiRequests,
  routeRuntimeCredentials,
  nonAuthWriteRequests,
  openAdvancedSettings,
  expectNoText,
  expectNativeAdminHidden,
  revealNativeConfiguration,
  assertRevisionUrl,
  detailUrl,
  pathRequests,
  configurationPostRequests,
  secretPostRequests,
  routeInstallationWithoutProvisioning,
  agentPostRequests,
  agentDeleteRequests,
  agentStopRequests,
  configurationPatchRequests,
  accessBindingPostRequests,
  waitForCondition,
  createRuntimeAuthFixture,
  optionValues,
  nativeAdminComputeDriver,
  nativeValues,
  nativeAdminValues,
} from "../helpers/console-agents-browser.mjs";

test("Agent detail preserves admitted revision history while draft edits change current configuration", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revision history", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "External API token", "hidden-token");
  const secretBindings = {
    EXTERNAL_API_TOKEN: {
      source: secret.ref,
      delivery: { type: "env" },
    },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Revisioned Agent",
    nativeValues("rev-one"),
  );
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const generationTwo = await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeValues("rev-two"),
  );
  assert.equal(generationTwo.generation, 2);
  const second = await fixture.seedActiveAgentRevision(namespace.id, agent.id, first.revision.id);
  const draft = await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeValues("draft-current"),
    { secretBindings },
  );
  assert.equal(draft.generation, 3);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, first.revision.id, "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, first.revision.id, "configuration").search,
  );
  await page.getByRole("heading", { name: "Revisioned Agent" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByLabel("AgentRevision").selectOption(first.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-one"').waitFor();
  await expectNoText(page, /"marker": "rev-two"|"marker": "draft-current"/);

  await page.getByRole("button", { name: "Newer revision" }).click();
  await page.waitForURL((url) => url.searchParams.get("revision") === second.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-two"').waitFor();
  await expectNoText(page, /"marker": "rev-one"|"marker": "draft-current"/);
  assertRevisionUrl(page, second.revision.id);

  await page.getByRole("button", { name: "Older revision" }).click();
  await page.waitForURL((url) => url.searchParams.get("revision") === first.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-one"').waitFor();
  assertRevisionUrl(page, first.revision.id);

  await page.getByRole("button", { name: "New revision" }).click();
  await page.waitForURL((url) => url.searchParams.get("revision") === "draft");
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "draft-current"').waitFor();
  await expectNoText(page, /"marker": "rev-one"|"marker": "rev-two"/);
  assertRevisionUrl(page, "draft");

  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  const editor = page.getByLabel("Configuration JSON");
  assert.match(await editor.inputValue(), /"marker": "draft-current"/);
  for (const invalidJson of ["{ invalid", "[]"]) {
    await editor.fill(invalidJson);
    await page.getByRole("button", { name: "Save Configuration" }).click();
    await page.getByText("Enter a valid Configuration JSON object.").waitFor();
  }
  assert.deepEqual(configurationPatchRequests(requests, namespace.id, agent.configurationId), []);

  await editor.fill(JSON.stringify(nativeValues("stale-client"), null, 2));
  const stale = await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeValues("stale-server"),
  );
  assert.equal(stale.generation, 4);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  assert.match(await editor.inputValue(), /stale-client/);
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await page.getByText("The saved Configuration changed while you were editing.").waitFor();
  assert.deepEqual(configurationPatchRequests(requests, namespace.id, agent.configurationId), []);

  await page.reload();
  await page.getByRole("heading", { name: "Revisioned Agent" }).waitFor();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  const editedValues = nativeValues("draft-edited");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(editedValues, null, 2));
  await page.getByText("Save or cancel these Configuration edits before deploying.").waitFor();
  await page.getByText("Save or cancel Configuration edits before deploying.").waitFor();
  // Tabs, admitted revision browsing, and global routes preserve this exact unsaved draft.
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("heading", { name: "Channels", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  assert.deepEqual(JSON.parse(await editor.inputValue()), editedValues);
  await page.getByLabel("AgentRevision").selectOption(second.revision.id);
  await page.getByRole("button", { name: "Edit current Configuration" }).click();
  assert.deepEqual(JSON.parse(await editor.inputValue()), editedValues);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  assert.deepEqual(JSON.parse(await editor.inputValue()), editedValues);
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
  assert.deepEqual(configurationPatchRequests(requests, namespace.id, agent.configurationId), []);
  const savedConfiguration = page.waitForResponse(
    (response) =>
      response.url() ===
        `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}` &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save Configuration" }).click();
  assert.equal((await savedConfiguration).status(), 200);
  await page.getByText(/generation 5/).waitFor();
  const patched = configurationPatchRequests(requests, namespace.id, agent.configurationId);
  assert.deepEqual(
    patched.map((request) => request.body),
    [{ values: editedValues }],
  );
  const currentConfiguration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(currentConfiguration.status, 200);
  assert.equal(currentConfiguration.data.generation, 5);
  assert.deepEqual(currentConfiguration.data.values, editedValues);
  assert.deepEqual(currentConfiguration.data.secretBindings, secretBindings);

  await page.getByLabel("AgentRevision").selectOption(first.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-one"').waitFor();
  await expectNoText(page, /"marker": "draft-edited"|"marker": "stale-server"/);
  await page.getByRole("button", { name: "Edit current Configuration" }).click();
  await page.waitForURL((url) => url.searchParams.get("revision") === "draft");
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "draft-edited"').waitFor();

  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  await page.getByLabel("Authentication source").selectOption("");
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  assert.equal(await page.getByLabel("Authentication source").inputValue(), "");
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  assert.equal(await page.getByLabel("Authentication source").inputValue(), "");
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  assert.equal((await saved).status(), 200);
  await page
    .getByText("Select a harness authentication source in Credentials before deployment.")
    .waitFor();
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.harnessAuth, null);
  await page.getByLabel("AgentRevision").selectOption(first.revision.id);
  await page.getByText("API key · Secret configured", { exact: true }).waitFor();
  assert.equal(
    (await page.locator("body").textContent()).includes(agent.harnessAuth.source.id),
    false,
  );
  // Cancel discards the retained baseline too: reopening uses the freshly read saved document.
  await page.getByRole("button", { name: "Edit current Configuration" }).click();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await editor.fill(JSON.stringify(nativeValues("discard-this-edit")));
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeValues("cancel-server"),
  );
  await page.goBack();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  assert.match(await editor.inputValue(), /"marker": "cancel-server"/);
  await editor.fill(JSON.stringify(nativeValues("after-cancel")));
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await page.getByText(/generation 7/).waitFor();
});

test("Agent credentials choose existing Secrets for harness authentication", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Harness Secret picker", { ready: true });
  const originalSecret = await fixture.createSecret(
    namespace.id,
    "Original harness Secret",
    "hidden-original-harness",
  );
  const replacementSecret = await fixture.createSecret(
    namespace.id,
    "Replacement harness Secret",
    "hidden-replacement-harness",
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Harness Picker Agent",
    nativeValues("harness-picker"),
    { harnessAuth: { method: "api_key", source: originalSecret.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Harness Picker Agent" }).waitFor();
  requests.length = 0;
  const apiKeySecret = page.getByLabel("API key Secret");
  await apiKeySecret.selectOption(replacementSecret.id);
  await page.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  const saveResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents/${agent.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  assert.equal((await saveResponse).status(), 200);
  await page.getByLabel("API key Secret").waitFor({ state: "visible" });
  assert.equal(
    await page.getByLabel("API key Secret").evaluate((node) => node.value),
    replacementSecret.id,
  );

  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.deepEqual(current.data.harnessAuth, {
    method: "api_key",
    source: replacementSecret.ref,
  });
  assert.deepEqual(secretPostRequests(requests, namespace.id), []);

  await page.getByLabel("Authentication source").selectOption("codex_pat");
  const serviceAccountSecret = page.getByLabel("Service account token Secret");
  assert.equal(await serviceAccountSecret.evaluate((node) => node.value), "");
  await page.getByLabel("Authentication source").selectOption("api_key");
  assert.equal(
    await page.getByLabel("API key Secret").evaluate((node) => node.value),
    replacementSecret.id,
  );
});

test("Agent credentials report partial harness Secret grant failure", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Harness Secret grant failure", {
    ready: true,
  });
  const originalSecret = await fixture.createSecret(
    namespace.id,
    "Original denied harness Secret",
    "hidden-denied-original",
  );
  const replacementSecret = await fixture.createSecret(
    namespace.id,
    "Denied harness Secret",
    "hidden-denied-replacement",
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Harness Grant Failure Agent",
    nativeValues("harness-grant-failure"),
    { harnessAuth: { method: "api_key", source: originalSecret.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.route(`**/namespaces/${namespace.id}/iam/access-bindings`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "ACCESS_DENIED", message: "masked IAM denial" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000633" },
      }),
    });
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Harness Grant Failure Agent" }).waitFor();
  requests.length = 0;
  await page.getByLabel("API key Secret").selectOption(replacementSecret.id);
  await page.getByRole("button", { name: "Save authentication source" }).click();
  await page
    .getByText(/Authentication source saved, but this Agent's Secret access could not be confirmed/)
    .waitFor();
  assert.equal(await page.getByLabel("Authentication source").isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Retry credential access" }).isDisabled(),
    false,
  );
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);

  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.deepEqual(current.data.harnessAuth, {
    method: "api_key",
    source: replacementSecret.ref,
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
    [replacementSecret.id],
  );
});

test("Agent detail blocks repeat Configuration saves after an uncertain draft update", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Uncertain Configuration", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Uncertain Configuration Agent",
    nativeValues("before-unknown"),
    { harnessAuth: { method: "runtime" } },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  let interceptedPatches = 0;
  await page.route(`**${configurationPath}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      await route.continue();
      return;
    }
    interceptedPatches += 1;
    await route.fetch();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "masked Configuration response" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
      }),
    });
  });

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").search,
  );
  await page.getByRole("heading", { name: "Uncertain Configuration Agent" }).waitFor();
  requests.length = 0;

  const nextValues = nativeValues("after-unknown");
  await page.getByText("Configured on the runtime host").waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), false);
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(nextValues, null, 2));
  await page.getByText("Save or cancel Configuration edits before deploying.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
  await page.getByRole("button", { name: "Save Configuration" }).click();

  await page.getByText("Outcome unknown. Configuration may have been saved.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Save Configuration" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Channels" }).isDisabled(), true);
  await page.evaluate(() => {
    const next = new URL(globalThis.location.href);
    next.searchParams.set("tab", "channels");
    globalThis.history.pushState(globalThis.history.state, "", next);
    globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
  });
  await page.getByText("Outcome unknown. Reload this draft before leaving the editor.").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("tab"), "configuration");
  assert.match(
    await page.getByLabel("Configuration JSON").inputValue(),
    /"marker": "after-unknown"/,
  );
  assert.equal(interceptedPatches, 1);
  assert.equal(configurationPatchRequests(requests, namespace.id, agent.configurationId).length, 1);
  const saved = await fixture.request("GET", configurationPath);
  assert.equal(saved.data.generation, 2);
  assert.deepEqual(saved.data.values, nextValues);

  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await page.getByLabel("Configuration JSON").waitFor();
  assert.equal(await page.getByRole("button", { name: "Save Configuration" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
  await page.getByRole("button", { name: "Reload draft" }).click();
  await page.getByText(/generation 2/).waitFor();
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "after-unknown"').waitFor();
  assert.equal(interceptedPatches, 1);
});

test("Agent stop confirmation uses the real API, preserves Agent state, and deploy resumes", async (t) => {
  const { fixture, namespace, state } = await createRuntimeAuthFixture(t, "Stop success");
  const agent = await fixture.createAgent(namespace.id, "Stop Candidate", nativeValues("stop"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace").pathname +
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace").search,
  );
  await page.getByRole("heading", { name: "Stop Candidate" }).waitFor();
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Stop Agent" }).click();
  let dialog = page.getByRole("dialog", { name: "Stop Stop Candidate?" });
  await dialog
    .getByText(/Configuration, AgentRevisions, Credentials, and workspace data are retained/i)
    .waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 0);
  await page.getByRole("button", { name: "Stop Agent" }).click();
  dialog = page.getByRole("dialog", { name: "Stop Stop Candidate?" });
  await dialog
    .getByText(/Configuration, AgentRevisions, Credentials, and workspace data are retained/i)
    .waitFor();
  const stopResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/stop` &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Stop Agent" }).click();
  const response = await stopResponse;
  assert.equal(response.status(), 202);
  const stoppedBody = await response.json();
  assert.equal(stoppedBody.data.desiredRuntimeState, "stopped");
  assert.equal(stoppedBody.data.activeRevisionId, active.revision.id);

  await page.getByRole("status").getByText("Stop requested.").waitFor();
  await page.getByText(/Runtime shutdown completion is not exposed in Console/).waitFor();
  await page
    .getByText(
      `Selected revision ${active.revision.id.slice(0, 12)}…${active.revision.id.slice(-6)}`,
    )
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Stop Agent" }).isDisabled(), true);
  assert.deepEqual(
    agentStopRequests(requests, namespace.id, agent.id).map((request) => [
      request.method,
      request.path,
      request.body,
    ]),
    [["POST", `/namespaces/${namespace.id}/agents/${agent.id}/stop`, null]],
  );
  const stopped = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(stopped.data.desiredRuntimeState, "stopped");
  assert.equal(stopped.data.activeRevisionId, active.revision.id);
  assert.deepEqual(stopped.data.harnessAuth, { method: "runtime" });
  assert.equal(stopped.data.configurationId, agent.configurationId);
  // Changing only the requested runtime state must reload dependent panels,
  // even while the selected revision remains unchanged pending worker shutdown.
  const stopIndex = requests.findIndex((request) => request.path.endsWith("/stop"));
  assert.ok(
    requests.findIndex((request) => request.path.endsWith("/native-admin")) > stopIndex,
    "native admin status must be reread after stop admission",
  );
  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.deepEqual(
    revisions.data.map((revision) => revision.id),
    [active.revision.id],
  );
  await page.getByRole("button", { name: "Workspace files" }).click();
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();

  const cleared = await state.transact((unit) =>
    unit.agents.compareAndClearActiveRevision(namespace.id, agent.id, active.revision.id),
  );
  assert.equal(cleared.desiredRuntimeState, "stopped");
  assert.equal(cleared.activeRevisionId, undefined);
  await page.getByRole("button", { name: "Refresh stop status" }).click();
  await page
    .getByRole("region", { name: "Stop Agent", exact: true })
    .getByText("No selected revision", { exact: true })
    .waitFor();

  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "New revision", exact: true }).click();
  await page.getByRole("button", { name: "Deploy new revision" }).click();
  await page.waitForURL(/revision=rev_/);
  const running = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(running.data.desiredRuntimeState, "running");
  assert.equal(running.data.configurationId, agent.configurationId);
  assert.deepEqual(running.data.harnessAuth, { method: "runtime" });
});

test("Agent stop uncertainty requires refresh before another stop request", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Stop uncertainty");
  const agent = await fixture.createAgent(
    namespace.id,
    "Uncertain Stop Candidate",
    nativeValues("uncertain-stop"),
    {
      harnessAuth: { method: "runtime" },
    },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const stopPath = `/namespaces/${namespace.id}/agents/${agent.id}/stop`;
  let interceptedStops = 0;
  await page.route(`**${stopPath}`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    interceptedStops += 1;
    await route.fetch();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "masked stop response" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000503" },
      }),
    });
  });

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration").search,
  );
  await page.getByRole("heading", { name: "Uncertain Stop Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Stop Agent" }).click();
  await page
    .getByRole("dialog", { name: "Stop Uncertain Stop Candidate?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  await page.getByText("Outcome unknown. Stop may have been accepted.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Stop Agent" }).isDisabled(), true);
  assert.equal(interceptedStops, 1);
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);
  const stopped = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(stopped.data.desiredRuntimeState, "stopped");

  const refresh = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Refresh stop status" }).click();
  assert.equal((await refresh).status(), 200);
  await page.getByRole("status").getByText("Stop requested.").waitFor();
  assert.equal(interceptedStops, 1);
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);
});

test("Agent stop denial keeps the Agent running with permission feedback", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Stop denial");
  const agent = await fixture.createAgent(
    namespace.id,
    "Denied Stop Candidate",
    nativeValues("stop-denied"),
    {
      harnessAuth: { method: "runtime" },
    },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const limited = await fixture.createAccountWithPolicy("agent-stop-denied", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-agent-stop-denied",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "read", resourceKind: "agent_revision" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-console-agent-stop-denied",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-agent-stop-denied",
    });
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration").search,
    limited.credentials,
  );
  await page.getByRole("heading", { name: "Denied Stop Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Stop Agent" }).click();
  const denied = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/stop` &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("dialog", { name: "Stop Denied Stop Candidate?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  assert.equal((await denied).status(), 403);

  await page.getByText("You do not have permission to stop this Agent").waitFor();
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);
  assert.equal(await page.getByRole("button", { name: "Stop Agent" }).isDisabled(), false);
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.desiredRuntimeState, "running");
  assert.equal(current.data.activeRevisionId, active.revision.id);
});

test("Agent delete confirmation can be canceled without sending a write request", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Delete cancellation", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Cancel Candidate", nativeValues("keep"));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").search,
  );
  await page.getByRole("heading", { name: "Cancel Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Cancel Candidate?" });
  await dialog.getByText(/Agent, its revision history, and its workspace data/i).waitFor();
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  assert.equal(await cancel.evaluate((node) => node.ownerDocument.activeElement === node), true);
  const unexpectedDelete = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "DELETE",
    { timeout: 300 },
  );
  await cancel.click();
  await assert.rejects(unexpectedDelete, /Timeout/);

  await page.getByRole("heading", { name: "Cancel Candidate" }).waitFor();
  assert.match(page.url(), new RegExp(`/console/agents/${agent.id}`));
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.status, "active");
});

test("Agent delete confirmation sends the real delete API and leaves visible queued state", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Delete success", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Success Candidate", nativeValues("go"));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").search,
  );
  await page.getByRole("heading", { name: "Success Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Success Candidate?" });
  await dialog.getByText(/Agent, its revision history, and its workspace data/i).waitFor();
  const deleteResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "DELETE",
  );
  await dialog.getByRole("button", { name: "Permanently delete Agent" }).click();
  const response = await deleteResponse;
  assert.equal(response.status(), 202);
  assert.equal((await response.json()).data.status, "deleting");

  assert.match(page.url(), new RegExp(`/console/agents/${agent.id}`));
  await page.getByRole("status").getByText("Deletion in progress").waitFor();
  await page.getByRole("button", { name: "Refresh deletion status" }).waitFor();
  assert.deepEqual(
    agentDeleteRequests(requests, namespace.id, agent.id).map((request) => [
      request.method,
      request.path,
      request.body,
    ]),
    [["DELETE", `/namespaces/${namespace.id}/agents/${agent.id}`, null]],
  );
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.status, "deleting");

  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("heading", { name: "Agents" }).waitFor();
  await page
    .getByRole("row")
    .filter({ hasText: "Success Candidate" })
    .getByText("Deleting", { exact: true })
    .waitFor();
});

test("Agent delete uncertainty requires refresh before another destructive request", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Delete uncertainty", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Uncertain Candidate",
    nativeValues("uncertain"),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const deletePath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  let interceptedDeletes = 0;
  await page.route(`**${deletePath}`, async (route, request) => {
    if (request.method() !== "DELETE") {
      await route.continue();
      return;
    }
    interceptedDeletes += 1;
    await route.fetch();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "masked deletion response" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
      }),
    });
  });

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").search,
  );
  await page.getByRole("heading", { name: "Uncertain Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Uncertain Candidate?" });
  await dialog.getByText(/Agent, its revision history, and its workspace data/i).waitFor();
  await dialog.getByRole("button", { name: "Permanently delete Agent" }).click();

  await page.getByText("Outcome unknown. Deletion may have started.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Delete Agent" }).isDisabled(), true);
  assert.equal(interceptedDeletes, 1);
  assert.equal(agentDeleteRequests(requests, namespace.id, agent.id).length, 1);
  const deleting = await fixture.request("GET", deletePath);
  assert.equal(deleting.data.status, "deleting");

  const refresh = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${deletePath}` && response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Refresh deletion status" }).click();
  assert.equal((await refresh).status(), 200);
  await page.getByRole("status").getByText("Deletion in progress").waitFor();
  assert.equal(interceptedDeletes, 1);
  assert.equal(agentDeleteRequests(requests, namespace.id, agent.id).length, 1);
});

test("Agent deletion recovery returns a missing Agent detail to its Namespace list", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Deleted detail", { ready: true });
  const agentId = `agt_${randomUUID()}`;
  const { page } = await newPage(t, fixture);
  const unavailable = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agentId}` &&
      response.request().method() === "GET",
  );

  await login(page, fixture, `/console/agents/${agentId}?namespace=${namespace.id}`);
  assert.equal((await unavailable).status(), 404);
  await page.getByRole("heading", { name: "Resource unavailable" }).waitFor();
  await page.getByRole("button", { name: "Back to Agents" }).click();
  await page.waitForURL(
    (url) =>
      url.pathname === "/console/agents" && url.searchParams.get("namespace") === namespace.id,
  );
  await page.getByRole("heading", { name: "No Agents yet", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
});

test("Agent delete denial keeps the Agent visible with permission feedback", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Delete denial", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Denied Candidate", nativeValues("stay"));
  const limited = await fixture.createAccountWithPolicy("agent-delete-denied", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-agent-delete-denied",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "read", resourceKind: "agent_revision" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-console-agent-delete-denied",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-agent-delete-denied",
    });
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").search,
    limited.credentials,
  );
  await page.getByRole("heading", { name: "Denied Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Denied Candidate?" });
  await dialog.getByText(/Agent, its revision history, and its workspace data/i).waitFor();
  const denied = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "DELETE",
  );
  await dialog.getByRole("button", { name: "Permanently delete Agent" }).click();
  assert.equal((await denied).status(), 403);

  await page.getByText("You do not have permission to delete this Agent").waitFor();
  await page.getByRole("heading", { name: "Denied Candidate" }).waitFor();
  assert.match(page.url(), new RegExp(`/console/agents/${agent.id}`));
  assert.equal(agentDeleteRequests(requests, namespace.id, agent.id).length, 1);
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.status, "active");
});

test("Agent detail opens native admin UI only after real API access checks pass", async (t) => {
  const disabledFixture = await createConsoleAppFixture(t);
  await disabledFixture.bootstrap();
  const disabledNamespace = await disabledFixture.createNamespace("Native admin disabled", {
    ready: true,
  });
  const disabledAgent = await disabledFixture.createAgent(
    disabledNamespace.id,
    "Disabled native admin Agent",
    nativeValues("disabled-ui"),
  );
  const disabledRevision = await disabledFixture.seedActiveAgentRevision(
    disabledNamespace.id,
    disabledAgent.id,
  );
  const disabledPage = (await newPage(t, disabledFixture)).page;
  const disabledDetail = detailUrl(
    disabledFixture,
    disabledNamespace.id,
    disabledAgent.id,
    disabledRevision.revision.id,
    "configuration",
  );

  await login(disabledPage, disabledFixture, `${disabledDetail.pathname}${disabledDetail.search}`);
  await disabledPage.getByRole("heading", { name: "Disabled native admin Agent" }).waitFor();
  await expectNativeAdminHidden(disabledPage);

  const cookieDomain = "oce.example.test";
  const consoleHost = `console.${cookieDomain}`;
  const nativeDomain = `agents.${cookieDomain}`;
  const gatewayEndpoint =
    "wss://private-gateway.example.invalid/namespaces/native-admin/agents/agent";
  const fixture = await createConsoleAppFixture(t, {
    originHost: consoleHost,
    publicOrigin: true,
    authCookieDomain: cookieDomain,
    development: { enabled: false },
    https: true,
    authSecureCookies: true,
    nativeAdmin: { enabled: true, domain: nativeDomain, sharedCookieDomain: cookieDomain },
    nativeAdminGatewayApiKey: async () => "native-admin-gateway-api-key",
    computeDriver: nativeAdminComputeDriver(gatewayEndpoint),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Native admin access", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Native admin Agent",
    nativeValues("unsupported-ui"),
  );
  const { page } = await newPage(t, fixture, {
    args: [
      ...fixture.browserArgs,
      `--host-resolver-rules=MAP ${consoleHost} 127.0.0.1,MAP *.${nativeDomain} 127.0.0.1`,
    ],
  });
  const requests = apiRequests(page, fixture.origin);
  const draftDetail = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");

  // A fresh shared-cookie login clears legacy host-only cookies from the Console.
  await page.context().addCookies([
    {
      name: "__Secure-openclaw_occ.session_token",
      value: "old-host-only",
      domain: consoleHost,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await login(page, fixture, `${draftDetail.pathname}${draftDetail.search}`);
  assert.equal(
    (await page.context().cookies(fixture.origin)).some(
      (cookie) => cookie.value === "old-host-only",
    ),
    false,
  );

  // New Agents are stopped; missing an active revision must not suggest a routing problem.
  const initiallyStopped = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  assert.equal(initiallyStopped.status, 200);
  assert.deepEqual(initiallyStopped.data, { status: "stopped" });
  await page.getByText("Start this Agent before opening its native admin UI.").waitFor();
  assert.equal(await page.getByText("Open native admin UI", { exact: true }).isVisible(), false);

  // A real deployment requests running before reconciliation selects the admitted revision.
  const pending = await fixture.deployAgent(namespace.id, agent.id);
  const unavailable = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  assert.equal(unavailable.status, 200);
  assert.deepEqual(unavailable.data, { status: "unavailable" });
  await page.getByRole("button", { name: "Refresh access" }).click();
  await page
    .getByText(
      "Native admin UI access is unavailable because OCE could not load an active AgentRevision. Check this Agent’s deployment, then refresh access.",
    )
    .waitFor({ timeout: 5_000 });
  assert.equal(await page.getByText("Open native admin UI", { exact: true }).isVisible(), false);

  let active = { revision: pending };
  await fixture.activateRevision(namespace.id, agent.id, pending.id);
  const historicalRevisionId = active.revision.id;
  const initialNativeAccess = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  assert.equal(initialNativeAccess.status, 200);
  assert.equal(initialNativeAccess.data.status, "unsupported");
  assert.equal(new URL(initialNativeAccess.data.origin).protocol, "https:");
  const detail = () =>
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  await page.goto(`${fixture.origin}${detail().pathname}${detail().search}`);
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page.getByRole("heading", { name: "Native admin UI" }).waitFor();
  await page
    .getByText("This Agent does not expose a supported native admin UI endpoint.")
    .waitFor();
  assert.equal(await page.getByText("Open native admin UI", { exact: true }).isVisible(), false);

  fixture.policy.restrictions.push({
    id: "deny-native-administer",
    namespaceId: namespace.id,
    resourceKind: "agent",
    resourceId: agent.id,
    action: "administer",
    effect: "deny",
  });
  await page.reload();
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await expectNativeAdminHidden(page);
  fixture.policy.restrictions.length = 0;

  const stopped = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/stop`,
  );
  assert.equal(stopped.status, 202);
  // Reproduce the state after the worker clears the revision, while this historical URL remains open.
  const cleared = await fixture.controller.transact((state) =>
    state.agents.compareAndClearActiveRevision(namespace.id, agent.id, active.revision.id),
  );
  assert.equal(cleared.activeRevisionId, undefined);
  await page.reload();
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page.getByRole("heading", { name: "Native admin UI" }).waitFor();
  await page.getByText("Start this Agent before opening its native admin UI.").waitFor();
  assert.equal(await page.getByText("Open native admin UI", { exact: true }).isVisible(), false);

  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeAdminValues("supported-ui", initialNativeAccess.data.origin),
  );
  active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await page.goto(`${fixture.origin}${detail().pathname}${detail().search}`);
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page.getByText("Native admin UI is available for this Agent’s active revision.").waitFor();
  const expectedAccess = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  assert.equal(expectedAccess.status, 200);
  assert.equal(expectedAccess.data.status, "available");
  assert.equal(expectedAccess.data.activeRevisionId, active.revision.id);
  assert.equal(expectedAccess.data.bootstrapUrl, undefined);
  assert.equal(new URL(expectedAccess.data.url).origin, expectedAccess.data.origin);
  assert.match(new URL(expectedAccess.data.url).hostname, new RegExp(`\\.${nativeDomain}$`));

  // Viewing an older configuration snapshot must still open the current active gateway.
  await page.getByLabel("AgentRevision").selectOption(historicalRevisionId);
  await page.getByText("Native admin UI is available for this Agent’s active revision.").waitFor();
  assertRevisionUrl(page, historicalRevisionId);
  assert.equal(
    await page.getByRole("link", { name: "Open native admin UI" }).getAttribute("href"),
    expectedAccess.data.url,
  );
  const sharedCookies = await page.context().cookies(expectedAccess.data.origin);
  const sessionCookies = sharedCookies.filter((cookie) =>
    cookie.name.endsWith("openclaw_occ_shared.session_token"),
  );
  assert.equal(sessionCookies.length, 1);
  assert.equal(sessionCookies[0].domain, `.${cookieDomain}`);
  assert.equal(sessionCookies[0].httpOnly, true);
  assert.equal(sessionCookies[0].sameSite, "Lax");

  let nativeRequestCookie = "";
  await page.context().route(`${expectedAccess.data.origin}/**`, async (route) => {
    nativeRequestCookie = (await route.request().allHeaders()).cookie ?? "";
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><title>Native admin UI</title>",
    });
  });

  await page.context().addCookies([
    {
      name: "openclaw_occ.session_token",
      value: "legacy-host-only",
      domain: consoleHost,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const consoleCookies = await page.context().cookies(fixture.origin);
  assert.ok(
    consoleCookies.some(
      (cookie) =>
        cookie.name === "openclaw_occ.session_token" && cookie.value === "legacy-host-only",
    ),
    "the migration fixture must contain the legacy host-only console cookie",
  );
  const agentCookies = await page.context().cookies(expectedAccess.data.origin);
  assert.equal(
    agentCookies.some((cookie) => cookie.value === "legacy-host-only"),
    false,
    "a legacy host-only console cookie must not authenticate the Agent host",
  );

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open native admin UI" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  assert.equal(popup.url(), expectedAccess.data.url);
  assert.equal(await popup.evaluate(() => globalThis.opener === null), true);
  assert.match(nativeRequestCookie, /(?:__Secure-)?openclaw_occ_shared\.session_token=/);
  assert.doesNotMatch(nativeRequestCookie, /legacy-host-only/);

  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

for (const action of ["disable", "drawer"]) {
  test(`Channel ${action} blocks deployment and navigation while its Configuration write is pending`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace(`Pending channel ${action}`, { ready: true });
    const agent = await fixture.createAgent(
      namespace.id,
      `Pending channel ${action} Agent`,
      nativeValues("pending-channel", {
        harnessId: "codex",
        channels: { slack: { enabled: true, mode: "socket", channels: {} } },
      }),
      { executionMode: "dedicated", harnessAuth: { method: "runtime" } },
    );
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    const patchStarted = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route(`**${configurationPath}`, async (route, request) => {
      if (request.method() !== "PATCH") {
        await route.continue();
        return;
      }
      patchStarted.resolve();
      await release.promise;
      await route.continue();
    });
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");
    await login(page, fixture, url.pathname + url.search);
    await page.getByText("Configured on the runtime host", { exact: false }).waitFor();
    assert.equal(
      await page
        .locator(".channels-section")
        .evaluate((section) =>
          [...section.childNodes].some(
            (node) =>
              node.nodeType === globalThis.Node.TEXT_NODE && node.textContent.trim() === "null",
          ),
        ),
      false,
    );
    const deploy = page.getByRole("button", { name: "Deploy new revision" });
    assert.equal(await deploy.isEnabled(), true);
    if (action === "disable") {
      await page.getByRole("button", { name: "Disable Slack" }).click();
    } else {
      await page.getByRole("button", { name: "Edit Slack" }).click();
      await page.getByLabel("Slack channel IDs").fill("CPENDING123");
      await page.getByLabel("Allowed channel user IDs").fill("UPENDING123");
      await page.getByRole("button", { name: "Save configuration" }).click();
    }
    await patchStarted.promise;
    // The write has not reached the server; Deploy must not capture the old draft.
    try {
      assert.equal(await deploy.isDisabled(), true);
      assert.equal(
        await page.getByRole("button", { name: "Configuration", exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`)
          .length,
        0,
      );
      await page.evaluate(() => {
        const next = new URL(globalThis.location.href);
        next.searchParams.set("tab", "configuration");
        globalThis.history.pushState(globalThis.history.state, "", next);
        globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
      });
      assert.equal(new URL(page.url()).searchParams.get("tab"), "channels");
    } finally {
      release.resolve();
    }
    await page.getByText(/Configuration .*generation 2/).waitFor();
    assert.equal(await deploy.isEnabled(), true);
  });
}

test("Channel save with a lost response blocks deployment until the draft is reloaded", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Uncertain channel save", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Uncertain channel Agent",
    nativeValues("uncertain-channel", {
      harnessId: "codex",
      channels: { slack: { enabled: true, mode: "socket", channels: {} } },
    }),
    { executionMode: "dedicated", harnessAuth: { method: "runtime" } },
  );
  const { page } = await newPage(t, fixture);
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  await page.route(`**${configurationPath}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      await route.continue();
      return;
    }
    // The API commits, but the browser cannot know that the response was lost.
    assert.equal((await route.fetch()).status(), 200);
    await route.abort("failed");
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");
  await login(page, fixture, url.pathname + url.search);
  await page.getByText("Configured on the runtime host", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isEnabled(), true);
  await page.getByRole("button", { name: "Disable Slack" }).click();
  await page
    .getByText(/Outcome unknown/)
    .first()
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Configuration", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Reload draft" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();
  const saved = await fixture.request("GET", configurationPath);
  assert.equal(saved.data.values.channels.slack.enabled, false);
});

test("Channel drawer saves channel edits without exposing Secret values or dropping unrelated draft state", async (t) => {
  const secretValue = "super-secret-channel-value";
  const slackAppSecretValue = "super-secret-slack-app-value";
  const slackBotSecretValue = "super-secret-slack-bot-value";
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Channel state", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "OpenAI API key", secretValue);
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Slack app token",
    slackAppSecretValue,
  );
  const slackBotSecret = await fixture.createSecret(
    namespace.id,
    "Slack bot token",
    slackBotSecretValue,
  );
  const secretBindings = {
    EXTERNAL_API_TOKEN: {
      source: secret.ref,
      delivery: { type: "env" },
    },
    SLACK_APP_TOKEN: {
      source: slackAppSecret.ref,
      delivery: { type: "env" },
    },
    SLACK_BOT_TOKEN: {
      source: slackBotSecret.ref,
      delivery: { type: "env" },
    },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Channel Agent",
    nativeValues("channels", {
      harnessId: "codex",
      providerModel: "gpt-5.1",
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          replyToMode: "off",
          replyToModeByChatType: { direct: "first", channel: "off" },
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          dmPolicy: "allowlist",
          allowFrom: ["UOLD123"],
          channels: {
            COLD123: {
              requireMention: true,
              users: ["UOLD123"],
            },
          },
        },
        msteams: {
          enabled: false,
          appId: "00000000-0000-4000-8000-000000000000",
          tenantId: "11111111-1111-4111-8111-111111111111",
          appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
          requireMention: true,
        },
      },
    }),
    { executionMode: "dedicated", secretBindings },
  );
  const { page, artifacts } = await newPage(t, fixture);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "channels").pathname +
      detailUrl(fixture, namespace.id, agent.id, "draft", "channels").search,
  );
  await page.getByRole("heading", { name: "Channel Agent" }).waitFor();
  await page.getByRole("button", { name: "Channels" }).click();
  for (const value of [secretValue, slackAppSecretValue, slackBotSecretValue]) {
    await expectNoText(page, value);
  }

  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  const appSecretPath = `/namespaces/${namespace.id}/secrets/${slackAppSecret.id}`;
  const botSecretPath = `/namespaces/${namespace.id}/secrets/${slackBotSecret.id}`;
  const appSecretLink = dialog.getByRole("link", {
    name: "View app token Secret metadata (opens in new tab)",
  });
  const botSecretLink = dialog.getByRole("link", {
    name: "View bot token Secret metadata (opens in new tab)",
  });
  assert.equal(await appSecretLink.getAttribute("href"), appSecretPath);
  assert.equal(await appSecretLink.getAttribute("target"), "_blank");
  assert.equal(await appSecretLink.getAttribute("rel"), "noopener");
  assert.equal(await botSecretLink.getAttribute("href"), botSecretPath);
  await dialog.getByText("Secret menu changes are saved with these channel settings.").waitFor();

  const channelIds = page.getByLabel("Slack channel IDs");
  const allowedUsers = page.getByLabel("Allowed channel user IDs");
  const allowEveryone = page.getByLabel("Allow everyone in these channels to mention the agent");
  assert.equal(await allowedUsers.inputValue(), "UOLD123");
  assert.equal(await allowedUsers.isDisabled(), false);
  assert.equal(await allowEveryone.isDisabled(), true);
  await channelIds.fill("COLD123, CNEW123");
  await allowedUsers.fill("UNEW123");
  assert.equal(await allowEveryone.isDisabled(), true);
  await allowedUsers.fill("");
  assert.equal(await allowEveryone.isEnabled(), true);
  await allowEveryone.check();
  assert.equal(await allowedUsers.isDisabled(), true);
  await allowEveryone.uncheck();
  assert.equal(await allowedUsers.isEnabled(), true);
  await allowedUsers.fill("UNEW123");
  assert.equal(await allowEveryone.isDisabled(), true);
  await dialog
    .getByRole("link", { name: "Open Agent Credentials (opens in new tab)" })
    .scrollIntoViewIfNeeded();
  await dialog.screenshot({
    path: join(artifacts, "agent-channel-drawer-links.png"),
  });

  const appSecretPopupPromise = page.waitForEvent("popup");
  await appSecretLink.click();
  const appSecretPopup = await appSecretPopupPromise;
  await appSecretPopup.waitForLoadState("domcontentloaded");
  assert.equal(new URL(appSecretPopup.url()).pathname, appSecretPath);
  await appSecretPopup.getByText("Slack app token").waitFor();
  const secretMetadataText = await appSecretPopup.locator("body").textContent();
  assert.match(secretMetadataText, new RegExp(slackAppSecret.id));
  assert.doesNotMatch(secretMetadataText, new RegExp(slackAppSecretValue));
  await appSecretPopup.close();

  const credentialsPopupPromise = page.waitForEvent("popup");
  await dialog.getByRole("link", { name: "Open Agent Credentials (opens in new tab)" }).click();
  const credentialsPopup = await credentialsPopupPromise;
  await credentialsPopup.waitForURL(/\/console\/agents\/agt_/);
  const credentialsUrl = new URL(credentialsPopup.url());
  assert.equal(credentialsUrl.pathname, `/console/agents/${agent.id}`);
  assert.equal(credentialsUrl.searchParams.get("namespace"), namespace.id);
  assert.equal(credentialsUrl.searchParams.get("revision"), "draft");
  assert.equal(credentialsUrl.searchParams.get("tab"), "credentials");
  await credentialsPopup.getByRole("heading", { name: "Runtime credentials" }).waitFor();
  await credentialsPopup.close();
  assert.equal(await channelIds.inputValue(), "COLD123, CNEW123");
  assert.equal(await allowedUsers.inputValue(), "UNEW123");

  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();
  for (const value of [secretValue, slackAppSecretValue, slackBotSecretValue]) {
    await expectNoText(page, value);
  }
  assert.equal(await page.getByRole("button", { name: /Microsoft Teams/ }).count(), 0);

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(configuration.status, 200);
  assert.deepEqual(configuration.data.secretBindings, secretBindings);
  assert.deepEqual(configuration.data.values.channels.slack.appToken, {
    source: "env",
    provider: "default",
    id: "SLACK_APP_TOKEN",
  });
  assert.deepEqual(configuration.data.values.channels.slack.botToken, {
    source: "env",
    provider: "default",
    id: "SLACK_BOT_TOKEN",
  });
  assert.deepEqual(configuration.data.values.channels.slack.channels, {
    COLD123: { requireMention: true, users: ["UNEW123"] },
    CNEW123: { requireMention: true, users: ["UNEW123"] },
  });
  assert.equal(configuration.data.values.channels.slack.replyToMode, "off");
  assert.deepEqual(configuration.data.values.channels.slack.replyToModeByChatType, {
    direct: "first",
    channel: "off",
  });
  assert.equal(configuration.data.values.channels.slack.dmPolicy, "allowlist");
  assert.deepEqual(configuration.data.values.channels.slack.allowFrom, ["UOLD123"]);
  assert.equal(
    configuration.data.values.channels.msteams.appId,
    "00000000-0000-4000-8000-000000000000",
  );
  assert.equal(
    configuration.data.values.channels.msteams.tenantId,
    "11111111-1111-4111-8111-111111111111",
  );
  assert.deepEqual(configuration.data.values.channels.msteams.appPassword, {
    source: "env",
    provider: "default",
    id: "MSTEAMS_APP_PASSWORD",
  });
  assert.equal(configuration.data.values.plugins.entries.knowledge.config.marker, "channels");
  assert.deepEqual(
    configuration.data.values.plugins.entries.knowledge.config.thresholds,
    [1, 2, 3],
  );
  assert.equal(configuration.data.values.agents.defaults.model, "codex/gpt-5.1");

  await page.screenshot({ path: join(artifacts, "agent-channels.png"), fullPage: true });
});

for (const [name, channels, reason] of [
  [
    "wildcard channel map",
    { "*": { requireMention: true, users: ["*"] } },
    "Slack wildcard channels must be edited in native Configuration JSON.",
  ],
  [
    "mixed channel sender lists",
    {
      CMIXED123: { requireMention: true, users: ["UONE123"] },
      CMIXED456: { requireMention: true, users: ["UTWO456"] },
    },
    "Existing Slack channels use different allowed channel users. Edit native Configuration JSON to preserve those restrictions.",
  ],
  [
    "comma channel sender ID",
    { CCOMMA123: { requireMention: true, users: ["UONE123,UTWO456"] } },
    "Slack channel users or Require mention values use an unsupported native shape.",
  ],
  [
    "newline channel sender ID",
    { CNEWLINE123: { requireMention: true, users: ["UONE123\nUTWO456"] } },
    "Slack channel users or Require mention values use an unsupported native shape.",
  ],
]) {
  test(`Channel drawer keeps Slack ${name} in native JSON`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Unsupported Slack native", { ready: true });
    const slack = {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      channels,
    };
    const agent = await fixture.createAgent(
      namespace.id,
      `Unsupported Slack ${name}`,
      nativeValues(`unsupported-slack-${name}`, { harnessId: "codex", channels: { slack } }),
      { executionMode: "dedicated" },
    );
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

    await login(page, fixture, url.pathname + url.search);
    await page.getByRole("heading", { name: `Unsupported Slack ${name}` }).waitFor();
    await page.getByText(reason).waitFor();
    assert.equal(await page.getByRole("button", { name: "Edit Slack" }).isDisabled(), true);
    await revealNativeConfiguration(page, "Slack native configuration");
    const nativeJson = JSON.parse(await page.locator(".channel-native pre").textContent());
    assert.deepEqual(nativeJson, slack);
    assert.deepEqual(nonAuthWriteRequests(requests), []);
  });
}

test("Channel drawer binds existing Slack Secrets without dropping unsaved channel edits", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unbound Slack credentials", { ready: true });
  const slackAppSecretValue = "never-visible-menu-app-token";
  const slackBotSecretValue = "never-visible-menu-bot-token";
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Existing menu Slack app token",
    slackAppSecretValue,
  );
  const slackBotSecret = await fixture.createSecret(
    namespace.id,
    "Existing menu Slack bot token",
    slackBotSecretValue,
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CUNBOUND123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Unbound Slack Agent",
    nativeValues("unbound-slack", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Unbound Slack Agent" }).waitFor();
  // Establish a same-document history entry before opening the modal.
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  assert.equal(await dialog.getByRole("link", { name: /Secret metadata/ }).count(), 0);
  const channelIds = dialog.getByLabel("Slack channel IDs");
  await channelIds.fill("CUNBOUND123, CBOUND456");
  await dialog.getByLabel("Slack app token").selectOption(slackAppSecret.id);
  await dialog.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  await dialog.getByLabel("Slack bot token").selectOption(slackBotSecret.id);
  await dialog.getByText("Secret binding staged. Save changes to apply it.").nth(1).waitFor();
  assert.equal(await channelIds.inputValue(), "CUNBOUND123, CBOUND456");
  assert.equal(
    await dialog
      .getByRole("link", { name: "Open Agent Credentials (opens in new tab)" })
      .getAttribute("href"),
    `/console/agents/${agent.id}?revision=draft&tab=credentials&namespace=${namespace.id}`,
  );
  await page.goBack();
  await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
  await page.goForward();
  await dialog.waitFor();
  assert.equal(await channelIds.inputValue(), "CUNBOUND123, CBOUND456");
  assert.equal(await dialog.getByLabel("Slack app token").inputValue(), slackAppSecret.id);
  assert.equal(await dialog.getByLabel("Slack bot token").inputValue(), slackBotSecret.id);
  const beforeSave = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(beforeSave.data.generation, 1);
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings, {
    SLACK_APP_TOKEN: { source: slackAppSecret.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: slackBotSecret.ref, delivery: { type: "env" } },
  });
  assert.deepEqual(configuration.data.values.channels.slack.channels, {
    CUNBOUND123: { requireMention: true, users: ["*"] },
    CBOUND456: { requireMention: true, users: ["*"] },
  });
  const pageText = await page.locator("body").textContent();
  assert.equal(pageText.includes(slackAppSecretValue), false);
  assert.equal(pageText.includes(slackBotSecretValue), false);
});

test("Channel drawer grants only the final selected Slack Secret", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Final Slack grant", { ready: true });
  const firstSecret = await fixture.createSecret(namespace.id, "First Slack app token", "hidden-a");
  const finalSecret = await fixture.createSecret(namespace.id, "Final Slack app token", "hidden-b");
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CFINAL123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Final Slack Grant Agent",
    nativeValues("final-slack-grant", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated", harnessAuth: { method: "runtime" } },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const grantStarted = Promise.withResolvers();
  const releaseGrant = Promise.withResolvers();
  t.after(() => releaseGrant.resolve());
  await page.route(`**/namespaces/${namespace.id}/iam/access-bindings`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    grantStarted.resolve();
    await releaseGrant.promise;
    await route.continue();
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Final Slack Grant Agent" }).waitFor();
  requests.length = 0;
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await dialog.getByLabel("Slack app token").selectOption(firstSecret.id);
  await dialog.getByLabel("Slack app token").selectOption(finalSecret.id);
  await page.getByRole("button", { name: "Save configuration" }).click();
  await grantStarted.promise;
  // Configuration is already saved, but the Agent's Secret grant is still in flight.
  try {
    assert.equal(
      await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole("button", { name: "Credentials", exact: true }).isDisabled(),
      true,
    );
  } finally {
    releaseGrant.resolve();
  }
  await page.getByText(/Configuration .*generation 2/).waitFor();

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings.SLACK_APP_TOKEN, {
    source: finalSecret.ref,
    delivery: { type: "env" },
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
    [finalSecret.id],
  );
});

test("Channel drawer does not grant when Slack Secret selection returns to original", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Original Slack grant", { ready: true });
  const originalSecret = await fixture.createSecret(
    namespace.id,
    "Original Slack app token",
    "hidden-original",
  );
  const temporarySecret = await fixture.createSecret(
    namespace.id,
    "Temporary Slack app token",
    "hidden-temporary",
  );
  const secretBindings = {
    SLACK_APP_TOKEN: { source: originalSecret.ref, delivery: { type: "env" } },
  };
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CORIG123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Original Slack Grant Agent",
    nativeValues("original-slack-grant", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated", secretBindings },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Original Slack Grant Agent" }).waitFor();
  requests.length = 0;
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await dialog.getByLabel("Slack app token").selectOption(temporarySecret.id);
  await dialog.getByLabel("Slack app token").selectOption(originalSecret.id);
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings, secretBindings);
  assert.deepEqual(accessBindingPostRequests(requests, namespace.id), []);
});

test("Channel drawer does not grant Slack Secret access when Configuration save is rejected", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Rejected Slack save", { ready: true });
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Rejected save Slack app token",
    "hidden-rejected-save",
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CREJECT123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Rejected Slack Save Agent",
    nativeValues("rejected-slack-save", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.route(`**${configurationPath}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "ACCESS_DENIED", message: "masked Configuration denial" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000403" },
      }),
    });
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Rejected Slack Save Agent" }).waitFor();
  requests.length = 0;
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  const allowedUsers = dialog.getByLabel("Allowed channel user IDs");
  const allowEveryone = dialog.getByLabel("Allow everyone in these channels to mention the agent");
  assert.equal(await allowEveryone.isChecked(), true);
  assert.equal(await allowedUsers.isDisabled(), true);
  await dialog.getByLabel("Slack app token").selectOption(slackAppSecret.id);
  await page.getByRole("button", { name: "Save configuration" }).click();
  await dialog.getByText(/Access denied|permission/i).waitFor();
  assert.equal(await allowEveryone.isChecked(), true);
  assert.equal(await allowEveryone.isEnabled(), true);
  assert.equal(await allowedUsers.isDisabled(), true);

  const configuration = await fixture.request("GET", configurationPath);
  assert.equal(configuration.status, 200);
  assert.deepEqual(configuration.data.secretBindings ?? {}, {});
  assert.deepEqual(accessBindingPostRequests(requests, namespace.id), []);
});

test("Channel drawer round trips existing Slack everyone channel access", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Slack everyone access", { ready: true });
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom: ["UDM123"],
    channels: { CEVERY123: { requireMention: true, users: ["*"], allowBots: "mentions" } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Slack Everyone Agent",
    nativeValues("slack-everyone", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Slack Everyone Agent" }).waitFor();
  await page.getByRole("button", { name: "Edit Slack" }).click();
  let dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await dialog.getByLabel("Slack channel IDs").fill("CEVERY123, CSECOND123");
  const allowedUsers = dialog.getByLabel("Allowed channel user IDs");
  const allowEveryone = dialog.getByLabel("Allow everyone in these channels to mention the agent");
  assert.equal(await allowEveryone.isChecked(), true);
  assert.equal(await allowedUsers.isDisabled(), true);
  await dialog.getByLabel("Require a mention", { exact: true }).uncheck();
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(`/configurations/${agent.configurationId}`),
  );
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  assert.equal((await saved).status(), 200);

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.values.channels.slack, {
    ...slack,
    channels: {
      CEVERY123: { requireMention: false, users: ["*"], allowBots: "mentions" },
      CSECOND123: { requireMention: false, users: ["*"] },
    },
  });

  await page.getByRole("button", { name: "Edit Slack" }).click();
  dialog = page.getByRole("dialog", { name: "Edit Slack" });
  assert.equal(
    await dialog.getByLabel("Allow everyone in these channels to mention the agent").isChecked(),
    true,
  );
  assert.equal(await dialog.getByLabel("Allowed channel user IDs").isDisabled(), true);
  assert.equal(await dialog.getByLabel("Require a mention", { exact: true }).isChecked(), false);
});

test("Channel drawer reports partial save when post-PATCH Secret grant is rejected", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Partial Slack grant", { ready: true });
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Partial save Slack app token",
    "hidden-partial-save",
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CPARTIAL123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Partial Slack Grant Agent",
    nativeValues("partial-slack-grant", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.route(`**/namespaces/${namespace.id}/iam/access-bindings`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "ACCESS_DENIED", message: "masked IAM denial" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000433" },
      }),
    });
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Partial Slack Grant Agent" }).waitFor();
  requests.length = 0;
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await dialog.getByLabel("Slack app token").selectOption(slackAppSecret.id);
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page
    .getByText(
      "Configuration saved, but Secret access grants could not be confirmed. Reload the draft, inspect saved bindings in Agent Credentials, then ask a Namespace administrator to grant this Agent access to the saved Secret.",
    )
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Slack" }).isDisabled(), true);

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(configuration.status, 200);
  assert.equal(configuration.data.generation, 2);
  assert.deepEqual(configuration.data.secretBindings.SLACK_APP_TOKEN, {
    source: slackAppSecret.ref,
    delivery: { type: "env" },
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
    [slackAppSecret.id],
  );

  assert.equal(
    await page.getByRole("button", { name: "Credentials", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Reload draft" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByText(/Configuration .*generation 2/).waitFor();
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  const appToken = page.getByLabel("Slack app token");
  await appToken.waitFor();
  assert.equal(await appToken.evaluate((node) => node.tagName), "SELECT");
  assert.equal(await appToken.evaluate((node) => node.value), slackAppSecret.id);
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
});

test("Agent credentials choose existing Slack Secrets without reading token values", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime Slack picker", { ready: true });
  const slackAppSecretValue = "never-visible-runtime-app-token";
  const slackBotSecretValue = "never-visible-runtime-bot-token";
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Runtime Slack app token",
    slackAppSecretValue,
  );
  const slackBotSecret = await fixture.createSecret(
    namespace.id,
    "Runtime Slack bot token",
    slackBotSecretValue,
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CRUNTIME123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Runtime Slack Picker Agent",
    nativeValues("runtime-slack-picker", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, {
    transportConfigured: true,
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Runtime Slack Picker Agent" }).waitFor();
  requests.length = 0;
  await page.getByLabel("Slack app token").selectOption(slackAppSecret.id);
  await page.getByLabel("Slack bot token").selectOption(slackBotSecret.id);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .getByText("Channel Secret bindings saved. Deploy the new revision to deliver them.")
    .waitFor();

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings, {
    SLACK_APP_TOKEN: { source: slackAppSecret.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: slackBotSecret.ref, delivery: { type: "env" } },
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
    [slackAppSecret.id, slackBotSecret.id],
  );
  assert.deepEqual(secretPostRequests(requests, namespace.id), []);
  const pageText = await page.locator("body").textContent();
  assert.equal(pageText.includes(slackAppSecretValue), false);
  assert.equal(pageText.includes(slackBotSecretValue), false);
});

test("Agent credentials block tab changes until Slack Secret grants finish", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime Slack navigation grant", {
    ready: true,
  });
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Navigation Slack app token",
    "hidden-navigation-app",
  );
  const slackBotSecret = await fixture.createSecret(
    namespace.id,
    "Navigation Slack bot token",
    "hidden-navigation-bot",
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CNAVIGATE123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Runtime Slack Navigation Agent",
    nativeValues("runtime-slack-navigation", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, {
    transportConfigured: true,
  });
  let markPatchPersisted;
  const patchPersisted = new Promise((resolve) => {
    markPatchPersisted = resolve;
  });
  let releasePatch;
  const patchRelease = new Promise((resolve) => {
    releasePatch = resolve;
  });
  await page.route(
    `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    async (route, request) => {
      if (request.method() !== "PATCH") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      markPatchPersisted();
      await patchRelease;
      await route.fulfill({ response });
    },
  );
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Runtime Slack Navigation Agent" }).waitFor();
  requests.length = 0;
  await page.getByLabel("Slack app token").selectOption(slackAppSecret.id);
  await page.getByLabel("Slack bot token").selectOption(slackBotSecret.id);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await patchPersisted;
  const channelsTab = page.getByRole("button", { name: "Channels", exact: true });
  assert.equal(await channelsTab.isDisabled(), true);
  releasePatch();
  await waitForCondition(
    () => accessBindingPostRequests(requests, namespace.id).length === 2,
    "expected saved Slack Secret grants to finish",
  );
  await page
    .getByText("Channel Secret bindings saved. Deploy the new revision to deliver them.")
    .waitFor();
  await channelsTab.click();
  await page.getByRole("button", { name: "Edit Slack", exact: true }).waitFor();

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings, {
    SLACK_APP_TOKEN: { source: slackAppSecret.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: slackBotSecret.ref, delivery: { type: "env" } },
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
    [slackAppSecret.id, slackBotSecret.id],
  );
});

test("Agent credentials retry outstanding Slack Secret grants after changing one token", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime Slack retained grant", { ready: true });
  const modelSecret = await fixture.createSecret(
    namespace.id,
    "Retained grant model credential",
    "hidden-retained-model",
  );
  const firstAppSecret = await fixture.createSecret(
    namespace.id,
    "First retained Slack app token",
    "hidden-retained-first-app",
  );
  const secondAppSecret = await fixture.createSecret(
    namespace.id,
    "Second retained Slack app token",
    "hidden-retained-second-app",
  );
  const botSecret = await fixture.createSecret(
    namespace.id,
    "Retained Slack bot token",
    "hidden-retained-bot",
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CRETRYGRANT123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Runtime Slack Retained Grant Agent",
    nativeValues("runtime-slack-retained-grant", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated", harnessAuth: { method: "api_key", source: modelSecret.ref } },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, {
    transportConfigured: true,
  });
  let denyGrant = true;
  let rejectNextConfigurationPatch = false;
  await page.route(
    `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    async (route, request) => {
      if (request.method() === "PATCH" && rejectNextConfigurationPatch) {
        rejectNextConfigurationPatch = false;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "CONFLICT", message: "simulated stale configuration" },
            meta: { requestId: "req_00000000-0000-4000-8000-000000000834" },
          }),
        });
        return;
      }
      await route.continue();
    },
  );
  await page.route(`**/namespaces/${namespace.id}/iam/access-bindings`, async (route, request) => {
    if (request.method() !== "POST" || !denyGrant) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "ACCESS_DENIED", message: "masked IAM denial" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000833" },
      }),
    });
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Runtime Slack Retained Grant Agent" }).waitFor();
  requests.length = 0;
  await page.getByLabel("Slack app token").selectOption(firstAppSecret.id);
  await page.getByLabel("Slack bot token").selectOption(botSecret.id);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page.getByText("Resolve the saved Secret access grant before deploying.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);

  const firstConfiguration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(firstConfiguration.data.secretBindings, {
    SLACK_APP_TOKEN: { source: firstAppSecret.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
  });

  denyGrant = false;
  rejectNextConfigurationPatch = true;
  await page.getByLabel("Slack app token").selectOption(secondAppSecret.id);
  await page.getByText("Resolve the saved Secret access grant before deploying.").waitFor();
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page.getByText("Resolve the saved Secret access grant before deploying.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);

  requests.length = 0;
  await page.getByLabel("Slack app token").selectOption(secondAppSecret.id);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .getByText("Channel Secret bindings saved. Deploy the new revision to deliver them.")
    .waitFor();

  const finalConfiguration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(finalConfiguration.data.secretBindings, {
    SLACK_APP_TOKEN: { source: secondAppSecret.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id)
      .map((request) => request.body.resourceId)
      .sort(),
    [botSecret.id, secondAppSecret.id].sort(),
  );
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), false);
});

// A persisted binding must remain blocked for both permission denials and retryable IAM failures.
for (const grantStatus of [403, 429]) {
  test(`Agent credentials report partial Slack Secret grant failure (${grantStatus})`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Runtime Slack grant failure", { ready: true });
    const originalBotSecret = await fixture.createSecret(
      namespace.id,
      "Existing runtime Slack bot token",
      "hidden-existing-runtime-bot",
    );
    const replacementAppSecret = await fixture.createSecret(
      namespace.id,
      "Denied runtime Slack app token",
      "hidden-denied-runtime-app",
    );
    const secretBindings = {
      SLACK_BOT_TOKEN: { source: originalBotSecret.ref, delivery: { type: "env" } },
    };
    const slack = {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      channels: { CRUNTIMEFAIL123: { requireMention: true } },
    };
    const agent = await fixture.createAgent(
      namespace.id,
      "Runtime Slack Grant Failure Agent",
      nativeValues("runtime-slack-grant-failure", { harnessId: "codex", channels: { slack } }),
      { executionMode: "dedicated", secretBindings },
    );
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, {
      transportConfigured: true,
    });
    await page.route(
      `**/namespaces/${namespace.id}/iam/access-bindings`,
      async (route, request) => {
        if (request.method() !== "POST") {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: grantStatus,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "ACCESS_DENIED", message: "masked IAM denial" },
            meta: { requestId: "req_00000000-0000-4000-8000-000000000733" },
          }),
        });
      },
    );
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

    await login(page, fixture, url.pathname + url.search);
    await page.getByRole("heading", { name: "Runtime Slack Grant Failure Agent" }).waitFor();
    requests.length = 0;
    await page.getByLabel("Slack app token").selectOption(replacementAppSecret.id);
    await page.getByRole("button", { name: "Save channel Secrets" }).click();
    await page
      .getByText(
        "Configuration saved, but Secret access grants could not be confirmed. Ask a Namespace administrator to grant this Agent access to the saved Secret.",
      )
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(),
      false,
    );
    await page.getByText("Resolve the saved Secret access grant before deploying.").waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(),
      true,
    );

    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assert.deepEqual(configuration.data.secretBindings, {
      SLACK_APP_TOKEN: { source: replacementAppSecret.ref, delivery: { type: "env" } },
      SLACK_BOT_TOKEN: { source: originalBotSecret.ref, delivery: { type: "env" } },
    });
    assert.deepEqual(
      accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
      [replacementAppSecret.id],
    );
    if (grantStatus === 403) {
      await page.getByRole("button", { name: "Channels", exact: true }).click();
      await page.getByRole("button", { name: "Edit Slack", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Edit Slack" });
      await dialog.getByLabel("Slack channel IDs").fill("CRUNTIMEFAIL123, CRETAINREFS123");
      await dialog.getByRole("button", { name: "Save configuration", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      const afterChannelEdit = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
      );
      assert.deepEqual(afterChannelEdit.data.secretBindings, {
        SLACK_APP_TOKEN: { source: replacementAppSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: originalBotSecret.ref, delivery: { type: "env" } },
      });
      assert.deepEqual(Object.keys(afterChannelEdit.data.values.channels.slack.channels).sort(), [
        "CRETAINREFS123",
        "CRUNTIMEFAIL123",
      ]);
    }
  });
}

test("Runtime-auth Presets retain OpenClaw when changing from Anthropic to OpenAI", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Runtime Preset providers");
  const root = await mkdtemp(join(tmpdir(), "occ-runtime-provider-preset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const primary = "anthropic/claude-runtime-model";
  const values = nativeValues("runtime-preset");
  values.agents.defaults.model = primary;
  values.agents.defaults.models = { [primary]: { agentRuntime: { id: "openclaw" } } };
  values.models.providers = {
    anthropic: {
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      models: [{ id: "claude-runtime-model", name: "claude-runtime-model" }],
    },
  };
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Operator-managed credentials",
      template: {
        agent: {
          name: "Runtime provider Agent",
          executionMode: "embedded",
          harnessAuth: { method: "runtime" },
        },
        configuration: { values },
      },
    },
  });
  assert.equal(preset.status, 201);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "anthropic");
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  // SSH's fixed runtime credential binding requires embedded OpenClaw for either provider.
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "openclaw");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-4.1");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  const created = (await response.json()).data;
  assert.equal(created.executionMode, "embedded");
  assert.deepEqual(created.harnessAuth, { method: "runtime" });
  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${created.configurationId}`,
  );
  assert.equal(saved.data.values.agents.defaults.model, "openai/gpt-4.1");
  assert.deepEqual(saved.data.values.agents.defaults.models["openai/gpt-4.1"].agentRuntime, {
    id: "openclaw",
  });
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 0);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).length,
    0,
  );
});

test("Create Agent discovers hosted plugins with a transient PAT through the selected Driver", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Hosted plugin discovery", { ready: true });
  const { page } = await newPage(t, fixture);
  const originalFetch = globalThis.fetch;
  const logoUrl = "https://plugin-images.example.test/calendar.png";
  const brokenLogoUrl = "https://plugin-images.example.test/missing.png";
  const imageRequests = [];
  // The public image host is the only browser request substituted; the real CSP and image loader run.
  await page.route("https://plugin-images.example.test/**", async (route) => {
    imageRequests.push({ url: route.request().url(), headers: await route.request().allHeaders() });
    await route.fulfill(
      route.request().url() === logoUrl
        ? {
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9foAAAAASUVORK5CYII=",
              "base64",
            ),
          }
        : { status: 404, body: "Image unavailable" },
    );
  });
  let failTools = true;
  let releaseList;
  let listStarted;
  let holdList = false;
  const listPending = new Promise((resolve) => {
    listStarted = resolve;
  });
  const detailStarted = Promise.withResolvers();
  const detailRelease = Promise.withResolvers();
  const hosted = (name, overrides = {}) => ({
    id: `remote-${name}`,
    name,
    scope: "GLOBAL",
    status: "ENABLED",
    installation_policy: "AVAILABLE",
    release: {
      display_name: name === "calendar" ? "Calendar" : name,
      description: "Hosted plugin",
      interface: {
        short_description: "Hosted tools",
        ...(name === "calendar"
          ? {
              logo_url: logoUrl,
              website_url: "https://calendar.example/",
              privacy_policy_url: "https://calendar.example/privacy",
              terms_of_service_url: "https://calendar.example/terms",
            }
          : {}),
        ...(name === "plugin-0" ? { composer_icon_url: brokenLogoUrl } : {}),
      },
      requires_local_executor: false,
      app_ids: ["app_calendar", "app_shared"],
      skills: [],
      mcp_servers: [],
    },
    ...overrides,
  });
  const upstreamCalls = [];
  // Only external HTTP is simulated. Browser, OCC auth/routes, and the selected Driver are real.
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(typeof input === "string" ? input : (input.url ?? input));
    if (!["auth.openai.com", "chatgpt.com"].includes(url.hostname)) {
      return originalFetch(input, options);
    }
    upstreamCalls.push({ path: url.pathname, token: options.headers.Authorization });
    if (url.hostname === "auth.openai.com") {
      return Response.json({
        chatgpt_account_id: "account-plugin-test",
        chatgpt_account_is_fedramp: false,
      });
    }
    assert.equal(options.headers["ChatGPT-Account-ID"], "account-plugin-test");
    assert.equal(options.headers["OAI-Product-Sku"], "codex");
    if (url.pathname.endsWith("/plugins/list")) {
      assert.equal(url.searchParams.get("scope"), "GLOBAL");
      if (holdList && options.headers.Authorization === "Bearer at-browser-plugin-one") {
        listStarted();
        await new Promise((resolve) => {
          releaseList = resolve;
        });
      }
      if (options.headers.Authorization === "Bearer at-browser-plugin-two") {
        return Response.json({
          plugins: [hosted("New-account-plugin")],
          pagination: { next_page_token: null },
        });
      }
      return Response.json({
        plugins: url.searchParams.has("pageToken")
          ? [hosted("Documents")]
          : [
              hosted("Admin-disabled", {
                status: "DISABLED_BY_ADMIN",
                disabled_reason: "disabled_by_admin",
              }),
              hosted("calendar"),
              ...Array.from({ length: 18 }, (_, index) => hosted(`plugin-${index}`)),
            ],
        pagination: { next_page_token: url.searchParams.has("pageToken") ? null : "page-two" },
      });
    }
    if (url.pathname.endsWith("/plugins/remote-Admin-disabled")) {
      return Response.json(
        hosted("Admin-disabled", {
          status: "DISABLED_BY_ADMIN",
          disabled_reason: "disabled_by_admin",
        }),
      );
    }
    if (url.pathname.endsWith("/plugins/remote-calendar")) {
      if (failTools) {
        detailStarted.resolve();
        await detailRelease.promise;
      }
      return Response.json(hosted("calendar"));
    }
    assert.equal(url.pathname, "/backend-api/ps/apps/batch");
    assert.deepEqual(JSON.parse(options.body), {
      app_ids: ["app_calendar", "app_shared"],
      include_tools: true,
    });
    if (failTools) {
      return new Response("private upstream response and token must not reach browser", {
        status: 403,
      });
    }
    return Response.json({
      apps: ["app_calendar", "app_shared"].map((id) => ({
        id,
        status: "ENABLED",
        tools: [
          {
            name: "events/list",
            title: "List events",
            description: "Read events",
            is_enabled: true,
            is_read_only: true,
          },
        ],
      })),
    });
  });
  t.after(() => releaseList?.());
  t.after(() => detailRelease.resolve());
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  const token = page.getByLabel("Service account token", { exact: true });
  await token.fill("at-browser-plugin-one");
  const brokenImageRequest = page.waitForRequest(brokenLogoUrl);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  const calendar = dialog.getByRole("button", { name: "Calendar", exact: true });
  await calendar.waitFor();
  const setup = dialog.locator(".plugin-access-help");
  await setup.getByText(/Service accounts/).waitFor();
  assert.match(await setup.textContent(), /App connection status is not verified/);
  for (const [name, href] of [
    ["Manage workspace plugins", "https://chatgpt.com/admin/plugins?catalog=GLOBAL"],
    ["Service account credentials", "https://admin.openai.com/"],
    [
      "OCE plugin setup",
      "https://github.com/openclaw/openclaw-enterprise/blob/main/docs/reference/drivers/plugin-bundled.md#selection-and-catalogs",
    ],
  ]) {
    const link = setup.getByRole("link", { name, exact: true });
    assert.equal(await link.getAttribute("href"), href);
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  }
  // Access guidance is visible before opening details, with a separate actionable link.
  const unavailableRow = dialog.locator(".plugin-list-row").filter({
    has: page.getByRole("button", { name: "Admin-disabled", exact: true }),
  });
  assert.match(
    await unavailableRow.locator(".plugin-unavailable").textContent(),
    /Disabled by a ChatGPT workspace administrator/,
  );
  const rowHelp = unavailableRow.getByRole("link", {
    name: "Manage workspace plugins",
    exact: true,
  });
  assert.equal(
    await rowHelp.getAttribute("href"),
    "https://chatgpt.com/admin/plugins?catalog=GLOBAL",
  );
  assert.equal(await rowHelp.evaluate((node) => node.closest("button") === null), true);
  const listLogo = calendar.locator(".plugin-logo img");
  await listLogo.evaluate((image) => image.decode());
  assert.ok(await listLogo.evaluate((image) => image.naturalWidth > 0));
  assert.equal(await listLogo.getAttribute("alt"), "");
  assert.equal(await listLogo.getAttribute("referrerpolicy"), "no-referrer");
  const missingLogo = dialog
    .getByRole("button", { name: "plugin-1", exact: true })
    .locator(".plugin-logo");
  assert.equal(await missingLogo.locator("img").count(), 0);
  assert.equal(await missingLogo.textContent(), "P");
  const brokenLogo = dialog
    .getByRole("button", { name: "plugin-0", exact: true })
    .locator(".plugin-logo");
  await brokenLogo.scrollIntoViewIfNeeded();
  await brokenImageRequest;
  await brokenLogo.locator("img").waitFor({ state: "detached" });
  assert.equal(await brokenLogo.textContent(), "P");
  assert.equal(
    await calendar.evaluate(
      (node, unavailable) =>
        Boolean(
          node.compareDocumentPosition(unavailable) &
          node.ownerDocument.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      await dialog.getByRole("button", { name: "Admin-disabled", exact: true }).elementHandle(),
    ),
    true,
  );

  const unavailableDetails = page.waitForResponse((response) =>
    response.url().endsWith("/agents/plugins/details"),
  );
  await unavailableRow.getByRole("button", { name: "Admin-disabled", exact: true }).click();
  await unavailableDetails;
  const disabledDetail = dialog.locator(".plugin-detail");
  assert.match(
    await disabledDetail.locator(".plugin-unavailable").textContent(),
    /Disabled by a ChatGPT workspace administrator/,
  );
  assert.equal(
    await disabledDetail
      .getByRole("link", { name: "Manage workspace plugins", exact: true })
      .getAttribute("href"),
    "https://chatgpt.com/admin/plugins?catalog=GLOBAL",
  );

  // Each navigation fetches a server page and replaces the available list.
  await dialog.getByRole("button", { name: "Next page", exact: true }).click();
  await dialog.getByRole("button", { name: "Documents", exact: true }).waitFor();
  assert.equal(await calendar.count(), 0);
  await dialog.getByRole("button", { name: "Previous page", exact: true }).click();
  await calendar.waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Documents", exact: true }).count(), 0);
  const filter = dialog.getByLabel("Filter this page", { exact: true });
  await filter.fill("Calendar");
  assert.equal(
    await dialog.getByRole("button", { name: "Admin-disabled", exact: true }).count(),
    0,
  );
  await filter.fill("");

  // Selecting a plugin loads its tools; a rejected upstream body stays private and is retryable.
  await calendar.click();
  await detailStarted.promise;
  const heading = dialog.getByRole("heading", { name: "Calendar", exact: true });
  // Loading and completion replace the detail pane without losing the keyboard entry point.
  try {
    assert.equal(await heading.evaluate((node) => node === node.ownerDocument.activeElement), true);
  } finally {
    detailRelease.resolve();
  }
  await dialog.getByText(/token was rejected or cannot access plugins/).waitFor();
  assert.equal(await heading.evaluate((node) => node === node.ownerDocument.activeElement), true);
  assert.equal((await dialog.textContent()).includes("private upstream response"), false);
  failTools = false;
  await dialog.getByRole("button", { name: "Retry tools for Calendar", exact: true }).click();
  await dialog.locator('details.plugin-tool-row[data-tool="app_calendar/events%2Flist"]').waitFor();
  assert.equal(
    await dialog.locator('details.plugin-tool-row[data-tool="app_shared/events%2Flist"]').count(),
    1,
  );
  assert.equal(await dialog.getByText(/token was rejected or cannot access plugins/).count(), 0);
  const detailLogo = dialog.locator(".plugin-detail-header .plugin-logo img");
  await detailLogo.evaluate((image) => image.decode());
  assert.ok(await detailLogo.evaluate((image) => image.naturalWidth > 0));
  assert.equal(await detailLogo.getAttribute("alt"), "");
  assert.equal(await detailLogo.getAttribute("referrerpolicy"), "no-referrer");
  for (const [name, href] of [
    ["Website", "https://calendar.example/"],
    ["Privacy policy", "https://calendar.example/privacy"],
    ["Terms of service", "https://calendar.example/terms"],
  ]) {
    const link = dialog.getByRole("link", { name, exact: true });
    assert.equal(await link.getAttribute("href"), href);
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  }
  await dialog.getByRole("button", { name: "Add Calendar", exact: true }).click();
  const selected = { "codex-plugin:calendar@openai-curated-remote": { enabled: true } };
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), selected);
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await dialog.getByRole("button", { name: "Calendar", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Available plugins", exact: true }).click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  const reminder = page.locator(".plugin-setup-reminder");
  assert.equal(await reminder.isVisible(), true);
  await reminder
    .getByText("Check plugin access and credentials before deployment", { exact: true })
    .click();
  await reminder.getByText(/App connection status is not verified/).waitFor();
  assert.equal(
    await reminder
      .getByRole("link", { name: "Service account credentials", exact: true })
      .getAttribute("href"),
    "https://admin.openai.com/",
  );
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), selected);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();

  // A credential change fences an older page response while preserving explicit selections.
  holdList = true;
  await dialog.getByRole("button", { name: "Next page", exact: true }).click();
  await listPending;
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await token.fill("");
  const clearedSetup = page.locator(".plugin-access-help");
  assert.equal(await clearedSetup.locator("a").count(), 0);
  assert.equal((await clearedSetup.textContent()).trim(), "");
  assert.equal(await reminder.isVisible(), false);
  assert.equal(await reminder.locator("a").count(), 0);
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), selected);
  await token.fill("at-browser-plugin-two");
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await dialog.getByRole("button", { name: "New-account-plugin", exact: true }).waitFor();
  const staleResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/agents/plugins") &&
      response.request().postDataJSON().cursor === "page-two",
  );
  releaseList();
  await staleResponse;
  await dialog.getByRole("button", { name: "New-account-plugin", exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Documents", exact: true }).count(), 0);
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), selected);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(await dialog.isVisible(), false);
  assert.equal(
    upstreamCalls.some((call) => call.token === "Bearer at-browser-plugin-two"),
    true,
  );
  assert.equal(
    requests.some((request) => /at-browser-plugin/.test(request.path)),
    false,
  );
  assert.ok(imageRequests.some((request) => request.url === logoUrl));
  assert.ok(imageRequests.some((request) => request.url === brokenLogoUrl));
  for (const { headers } of imageRequests) {
    for (const name of ["authorization", "referer", "chatgpt-account-id", "oai-product-sku"]) {
      assert.equal(headers[name], undefined);
    }
  }
  assert.doesNotMatch(JSON.stringify(imageRequests), /at-browser-plugin|account-plugin-test/);
  assert.equal(secretPostRequests(requests, namespace.id).length, 0);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  assert.equal(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }).includes("at-browser-plugin"),
    ),
    false,
  );
});

test("Agent creation edits Preset plugin policies through the modal and persists inherited fields independently", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const root = await mkdtemp(join(tmpdir(), "occ-plugin-policy-preset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const namespace = await fixture.createNamespace("Plugin policy authoring", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Model key", "preset-plugin-model-key");
  const pluginId = "codex-plugin:knowledge@openai-curated-remote";
  const removedPluginId = "codex-plugin:diffs@openai-curated-remote";
  const plugins = {
    [pluginId]: {
      enabled: false,
      toolDefaults: { enabled: true, approval: "native", reviewer: "human" },
      tools: {
        "app_knowledge/search": { enabled: false, approval: "native" },
        "app_knowledge/summarize": { enabled: true, approval: "approve" },
        "app_knowledge/unknown-tool": { approval: "native" },
      },
    },
    [removedPluginId]: { enabled: true },
  };
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Plugin policies",
      template: {
        agent: {
          name: "Plugin policy Agent",
          executionMode: "dedicated",
          harnessAuth: { method: "api_key", source: secret.ref },
          plugins,
        },
        configuration: { values: nativeValues("plugin-policies", { harnessId: "codex" }) },
      },
    },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page.locator("summary").filter({ hasText: "Plugin selections JSON" }).click();
  const json = page.getByLabel("Plugin selections JSON", { exact: true });
  assert.deepEqual(JSON.parse(await json.inputValue()), plugins);

  // Invalid manual input remains recoverable and cannot submit a different policy.
  requests.length = 0;
  await json.fill("{");
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal(await json.inputValue(), "{");
  assert.notEqual(await json.evaluate((node) => node.validationMessage), "");
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  await json.fill(JSON.stringify(plugins));
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await dialog.getByRole("button", { name: pluginId, exact: true }).click();
  const searchTool = dialog.locator('details.plugin-tool-row[data-tool="app_knowledge/search"]');
  await searchTool.locator("summary").click();
  const pluginEnabled = dialog.getByLabel(`Enable ${pluginId}`, { exact: true });
  const toolEnabled = dialog.getByLabel("Enable app_knowledge/search", { exact: true });
  const toolApproval = dialog.getByLabel("app_knowledge/search approval", { exact: true });
  const toolToggle = dialog.getByLabel("app_knowledge/search enabled override", { exact: true });
  assert.equal(await toolToggle.isDisabled(), true);
  assert.equal(await toolEnabled.isDisabled(), true);
  assert.equal(await toolApproval.isDisabled(), true);
  await pluginEnabled.check();
  await dialog.getByLabel(`${pluginId} tools enabled by default`, { exact: true }).selectOption("");
  assert.deepEqual(JSON.parse(await json.inputValue())[pluginId].toolDefaults, {
    approval: "native",
    reviewer: "human",
  });
  const reviewer = dialog.getByLabel(`${pluginId} default reviewer`, { exact: true });
  assert.deepEqual(
    (await optionValues(reviewer)).map(({ value }) => value),
    ["", "human", "auto"],
  );
  await reviewer.selectOption("");
  assert.deepEqual(JSON.parse(await json.inputValue())[pluginId].toolDefaults, {
    approval: "native",
  });
  await reviewer.selectOption("auto");
  await dialog.getByLabel(`${pluginId} default approval`, { exact: true }).selectOption("prompt");

  // Codex advertises default reviewers only; tool approval still inherits independently.
  const toolReviewer = dialog.getByLabel("app_knowledge/search reviewer", { exact: true });
  assert.equal(await toolReviewer.isDisabled(), true);
  assert.deepEqual(
    (await optionValues(toolReviewer)).map(({ value }) => value),
    [""],
  );
  await toolApproval.selectOption("approve");
  await toolEnabled.selectOption("");
  assert.deepEqual(JSON.parse(await json.inputValue())[pluginId].tools["app_knowledge/search"], {
    approval: "approve",
  });
  // The summary toggle edits only enablement; an omitted override remains visibly inherited.
  await searchTool.locator("summary").click();
  assert.equal(await toolToggle.evaluate((node) => node.indeterminate), true);
  await toolToggle.click();
  assert.deepEqual(JSON.parse(await json.inputValue())[pluginId].tools["app_knowledge/search"], {
    approval: "approve",
    enabled: true,
  });
  assert.equal(await searchTool.evaluate((node) => node.open), false);
  await toolToggle.click();
  assert.deepEqual(JSON.parse(await json.inputValue())[pluginId].tools["app_knowledge/search"], {
    approval: "approve",
    enabled: false,
  });
  await searchTool.locator("summary").click();
  await toolEnabled.selectOption("");
  assert.equal(await toolToggle.evaluate((node) => node.indeterminate), true);
  await toolToggle.click();
  await toolApproval.selectOption("");
  await dialog
    .locator('details.plugin-tool-row[data-tool="app_knowledge/summarize"] > summary')
    .click();
  await dialog.getByLabel("Enable app_knowledge/summarize", { exact: true }).selectOption("");
  await dialog.getByLabel("app_knowledge/summarize approval", { exact: true }).selectOption("");
  const expected = {
    [pluginId]: {
      enabled: true,
      toolDefaults: { approval: "prompt", reviewer: "auto" },
      tools: {
        "app_knowledge/search": { enabled: true },
        "app_knowledge/unknown-tool": { approval: "native" },
      },
    },
  };
  await pluginEnabled.uncheck();
  assert.equal(await toolToggle.isDisabled(), true);
  assert.equal(await toolEnabled.isDisabled(), true);
  assert.equal(await toolApproval.isDisabled(), true);
  assert.deepEqual(JSON.parse(await json.inputValue())[pluginId], {
    ...expected[pluginId],
    enabled: false,
  });
  await pluginEnabled.check();
  await dialog.getByRole("button", { name: removedPluginId, exact: true }).click();
  await dialog.getByRole("button", { name: `Remove ${removedPluginId}`, exact: true }).click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(await dialog.isVisible(), false);
  assert.deepEqual(JSON.parse(await json.inputValue()), expected);

  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  const created = (await response.json()).data;
  const saved = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${created.id}`);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.plugins, expected);
});

test("API-key Presets keep their credential provider fixed while allowing model and runtime changes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const root = await mkdtemp(join(tmpdir(), "occ-bound-provider-preset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const namespace = await fixture.createNamespace("Bound provider Preset", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "OpenAI model key", "preset-model-key");
  const harnessAuth = { method: "api_key", source: secret.ref };
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Saved OpenAI credential",
      template: {
        agent: { name: "Bound provider Agent", executionMode: "embedded", harnessAuth },
        configuration: { values: nativeValues("bound-provider") },
      },
    },
  });
  assert.equal(preset.status, 201);
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  await openAdvancedSettings(page);
  const configuration = page.getByLabel("Configuration JSON", { exact: true });
  const original = JSON.parse(await configuration.inputValue());
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "openclaw");
  assert.equal(await page.getByLabel("Harness", { exact: true }).isEnabled(), true);
  // Editing JSON must not silently retarget the saved OpenAI Secret to Anthropic.
  const changed = structuredClone(original);
  changed.agents.defaults.model = "anthropic/claude-account-model";
  await configuration.fill(JSON.stringify(changed));
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Configuration must use the selected provider" })
    .waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  const provider = page.getByLabel("Provider", { exact: true });
  assert.equal(await provider.inputValue(), "openai");
  assert.equal(await provider.isDisabled(), true);

  // Same-provider model and embedded-to-dedicated edits retain the original credential binding.
  await configuration.fill(JSON.stringify(original));
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  const dedicated = JSON.parse(await configuration.inputValue());
  assert.equal(dedicated.agents.defaults.model, "codex/gpt-5.1");
  // Existing dedicated Presets may also use the supported OpenAI model prefix.
  dedicated.agents.defaults.model = "openai/gpt-5.1";
  await configuration.fill(JSON.stringify(dedicated));
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  const created = (await response.json()).data;
  assert.deepEqual(created.harnessAuth, harnessAuth);
  assert.equal(created.executionMode, "dedicated");
  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${created.configurationId}`,
  );
  assert.equal(saved.data.values.agents.defaults.model, "openai/gpt-5.1");
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 0);
});

test("Presets render variables into independent Agent drafts and keep partial-save retries fixed", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const root = await mkdtemp(join(tmpdir(), "occ-preset-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Use production Configuration admission, including native credential restrictions.
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const namespace = await fixture.createNamespace("Preset authoring", { ready: true });
  const secret = await fixture.createSecret(
    namespace.id,
    "Preset channel token",
    "test-channel-token",
  );
  await fixture.createAgent(namespace.id, "Existing Agent");
  const values = nativeValues("{{ vars.marker }}", {
    harnessId: "codex",
    providerModel: "gpt-5.1",
  });
  values.plugins.entries.knowledge.config.enabled = "{{ vars.enabled }}";
  values.plugins.entries.knowledge.config.count = "{{ vars.count }}";
  const plugins = {
    "codex-plugin:linear@openai-curated-remote": {
      enabled: true,
      toolDefaults: { approval: "approve" },
    },
  };
  const secretBindings = { CHANNEL_TOKEN: { source: secret.ref, delivery: { type: "env" } } };
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Reusable Agent",
      template: {
        variables: {
          name: { type: "string" },
          execution: { type: "string", default: "dedicated" },
          marker: { type: "string", default: "initial" },
          enabled: { type: "boolean", default: false },
          count: { type: "number", default: 0 },
        },
        agent: {
          name: "{{ vars.name }}",
          executionMode: "{{ vars.execution }}",
          backendId: backendFixtures[0].id,
          harnessAuth: { method: "codex_pat", source: secret.ref },
          plugins,
          initialWorkspaceFiles: {
            "AGENTS.md": "# {{ vars.name }} workspace\n",
            "IDENTITY.md": "",
            "USER.md": "marker {{ vars.marker }}",
          },
        },
        configuration: { values, secretBindings },
      },
    },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Variable: name", { exact: true }).waitFor();
  const save = page.getByRole("button", { name: "Create Agent", exact: true });
  assert.equal(await save.count(), 0, "choose a starting point before editing the Agent draft");
  const apply = page.getByRole("button", { name: "Use Preset" });
  await apply.click();
  await page.getByRole("alert").filter({ hasText: /name/ }).waitFor();
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  await page.getByLabel("Variable: name", { exact: true }).fill("Existing Agent");
  await page.getByLabel("Variable: execution", { exact: true }).fill("invalid");
  await apply.click();
  await page
    .getByText("Rendered Preset contains invalid Agent fields or Secret bindings.")
    .waitFor();
  assert.equal(await save.count(), 0);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  await page.getByLabel("Variable: execution", { exact: true }).fill("dedicated");
  await page.getByLabel("Variable: marker", { exact: true }).fill("changed");
  await apply.click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Preset template").count(), 0);
  assert.equal(await page.getByLabel("Variable: marker", { exact: true }).count(), 0);
  await page
    .getByText("Preset authentication: Service Accounts · Secret configured", { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("Service account token", { exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "codex");
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
  assert.equal(
    (await page.getByLabel("Configuration JSON", { exact: true }).inputValue()).includes(
      "test-channel-token",
    ),
    false,
  );
  assert.equal(await save.isEnabled(), true);
  assert.equal(
    await page.getByLabel("AGENTS.md", { exact: true }).inputValue(),
    "# Existing Agent workspace\n",
  );
  assert.equal(await page.getByLabel("IDENTITY.md", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "marker changed");
  const rendered = JSON.parse(
    await page.getByLabel("Configuration JSON", { exact: true }).inputValue(),
  );
  assert.deepEqual(rendered.plugins.entries.knowledge.config, {
    marker: "changed",
    thresholds: [1, 2, 3],
    enabled: false,
    count: 0,
  });
  assert.deepEqual(rendered.gateway.controlUi, { enabled: false });
  assert.deepEqual(
    JSON.parse(await page.getByLabel("Plugin selections JSON").inputValue()),
    plugins,
  );
  // Deletion after selection must not invalidate this independent local copy.
  assert.equal(
    (
      await fixture.rawRequest("DELETE", `/namespaces/${namespace.id}/presets/${preset.data.id}`, {
        headers: authenticatedHeaders(await fixture.signIn()),
      })
    ).response.status,
    204,
  );
  await page.getByLabel("Agent name", { exact: true }).fill("Edited name");
  const edited = JSON.parse(
    await page.getByLabel("Configuration JSON", { exact: true }).inputValue(),
  );
  edited.plugins.entries.knowledge.config.thresholds = [5, 6];
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON", { exact: true }).fill(JSON.stringify(edited));
  await page.getByLabel("AGENTS.md", { exact: true }).fill("# Edited workspace\n");
  // Route reconstruction must retain the rendered copy even after its source Preset was deleted.
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "Edited name");
  assert.deepEqual(
    JSON.parse(await page.getByLabel("Configuration JSON", { exact: true }).inputValue()),
    edited,
  );
  assert.equal(
    await page.getByLabel("AGENTS.md", { exact: true }).inputValue(),
    "# Edited workspace\n",
  );
  assert.equal(await page.getByLabel("IDENTITY.md", { exact: true }).inputValue(), "");
  assert.deepEqual(
    JSON.parse(await page.getByLabel("Plugin selections JSON").inputValue()),
    plugins,
  );
  await page.goForward();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "Edited name");
  assert.deepEqual(nonAuthWriteRequests(requests), [], "navigation must not save the local draft");
  // Canceling Start over keeps the ordinary draft and its ability to save.
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Start over" }).click();
  assert.equal(await save.isEnabled(), true);
  assert.deepEqual(
    JSON.parse(await page.getByLabel("Configuration JSON", { exact: true }).inputValue()),
    edited,
  );
  await page.getByLabel("Agent name", { exact: true }).fill("Existing Agent");
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  assert.equal((await conflict).status(), 409);
  await page.getByText(/conflicts with the saved state/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Start over" }).isDisabled(), true);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  await page.getByLabel("Agent name", { exact: true }).fill("Preset Agent");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  const created = await (await createdResponse).json();
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).length,
    0,
  );
  assert.equal(created.data.name, "Preset Agent");
  const expectedWorkspaceFiles = {
    ...WORKSPACE_DEFAULTS,
    "AGENTS.md": "# Edited workspace\n",
    "IDENTITY.md": "",
    "USER.md": "marker changed",
  };
  assert.deepEqual(
    agentPostRequests(requests, namespace.id).map((request) => request.body.initialWorkspaceFiles),
    [expectedWorkspaceFiles, expectedWorkspaceFiles],
  );
  assert.deepEqual(
    agentPostRequests(requests, namespace.id).map((request) => request.body.workspaceDefaultsId),
    [WORKSPACE_DEFAULTS_ID, WORKSPACE_DEFAULTS_ID],
  );
  assert.deepEqual(created.data.plugins, plugins);
  assert.equal(created.data.backendId, backendFixtures[0].id);
  assert.deepEqual(created.data.harnessAuth, { method: "codex_pat", source: secret.ref });
  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${created.data.configurationId}`,
  );
  assert.deepEqual(saved.data.secretBindings, secretBindings);
  assert.deepEqual(saved.data.values.gateway.controlUi, { enabled: false });
  assert.equal(saved.data.values.plugins.entries.knowledge.config.marker, "changed");
  assert.deepEqual(saved.data.values.plugins.entries.knowledge.config.thresholds, [5, 6]);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(
    pathRequests(requests, "GET", `/namespaces/${namespace.id}/presets/${preset.data.id}`).length,
    1,
  );

  await page.waitForURL((url) => url.pathname === `/console/agents/${created.data.id}`);
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  await page.getByLabel("Service account token Secret").waitFor();
  assert.equal(await page.getByLabel("Authentication source").inputValue(), "codex_pat");
  assert.equal(await page.getByLabel("Service account token Secret").inputValue(), secret.id);
  const patched = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/agents/${created.data.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  assert.deepEqual((await (await patched).json()).data.harnessAuth, {
    method: "codex_pat",
    source: secret.ref,
  });

  // A Preset can supply an explicit model while requiring the operator to enter its key.
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.data.id}`);
  const keyEntryPreset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Preset requiring an API key",
      template: {
        agent: { name: "Preset key entry", executionMode: "embedded" },
        configuration: { values: nativeValues("preset-key-entry") },
      },
    },
  });
  assert.equal(keyEntryPreset.status, 201);
  await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(keyEntryPreset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  const presetKey = page.getByLabel("API key", { exact: true });
  assert.equal(await page.getByLabel("Model ID", { exact: true }).inputValue(), "gpt-4.1");
  await presetKey.fill("preset-openai-key");
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  assert.equal(await presetKey.inputValue(), "");
  await presetKey.fill("preset-anthropic-key");
  await openAdvancedSettings(page);
  const native = page.getByLabel("Configuration JSON");
  const changedProvider = JSON.parse(await native.inputValue());
  changedProvider.agents.defaults.model = "openai/gpt-4.1";
  await native.fill(JSON.stringify(changedProvider));
  assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "openai");
  assert.equal(await presetKey.inputValue(), "");
  const mode = page.getByLabel("Execution mode");
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await presetKey.fill("preset-dedicated-openai-key");
  const anthropicConfiguration = JSON.parse(await native.inputValue());
  anthropicConfiguration.agents.defaults.model = "anthropic/claude-account-model";
  await native.fill(JSON.stringify(anthropicConfiguration));
  assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "anthropic");
  assert.equal(await mode.inputValue(), "embedded");
  assert.equal(await mode.isDisabled(), true);
  assert.equal(await presetKey.inputValue(), "");
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).length,
    0,
  );
});

for (const [dmPolicy, groupPolicy, enterpriseOrgInstall] of [
  ["pairing", "allowlist"],
  ["open", "open"],
  ["disabled", "disabled"],
  [undefined, undefined],
  ["disabled", "allowlist", true],
]) {
  test(`Slack channel editing preserves ${dmPolicy ?? "omitted"} DM and ${groupPolicy ?? "omitted"} group policies${enterpriseOrgInstall ? " on an organization-wide install" : ""}`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Slack policy editing", { ready: true });
    const slack = {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      ...(enterpriseOrgInstall ? { enterpriseOrgInstall } : {}),
      ...(dmPolicy === undefined ? {} : { dmPolicy }),
      ...(groupPolicy === undefined ? {} : { groupPolicy }),
      allowFrom: dmPolicy === "open" ? ["*"] : ["UKEEP123"],
      channels: { CKEEP123: { requireMention: true, users: ["UKEEP123"] } },
    };
    const agent = await fixture.createAgent(
      namespace.id,
      "Slack policy Agent",
      nativeValues("policy-preservation", {
        harnessId: "codex",
        channels: { slack },
      }),
      { executionMode: "dedicated" },
    );
    const { page } = await newPage(t, fixture);
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");
    await login(page, fixture, url.pathname + url.search);
    const edit = page.getByRole("button", { name: "Edit Slack", exact: true });
    await edit.waitFor();
    assert.equal(await edit.isEnabled(), true);
    await edit.click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    if (enterpriseOrgInstall) {
      // Per-user DM authorization cannot be shared across organization workspaces.
      for (const unsupported of ["pairing", "allowlist"]) {
        await dialog.getByLabel("Direct-message policy").selectOption(unsupported);
        await dialog.getByRole("button", { name: "Save configuration", exact: true }).click();
        await dialog
          .getByText(
            "Choose Disabled or Open for direct messages on an organization-wide Slack install.",
          )
          .waitFor();
      }
      const unchanged = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
      );
      assert.deepEqual(unchanged.data.values.channels.slack, slack);
      await dialog.getByLabel("Direct-message policy").selectOption("disabled");
    }
    const allowedUsers = dialog.getByLabel("Allowed channel user IDs");
    const allowEveryone = dialog.getByLabel(
      "Allow everyone in these channels to mention the agent",
    );
    assert.equal(await allowedUsers.inputValue(), "UKEEP123");
    assert.equal(await allowEveryone.isDisabled(), true);
    await dialog.getByLabel("Slack channel IDs").fill("CKEEP123, CNEW123");
    await dialog.getByLabel("Require a mention", { exact: true }).uncheck();
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/configurations/${agent.configurationId}`),
    );
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    assert.equal((await saved).status(), 200);
    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    // Editing channels must neither widen nor narrow DM/group access, including implicit defaults.
    assert.deepEqual(configuration.data.values.channels.slack, {
      ...slack,
      channels: {
        CKEEP123: { requireMention: false, users: ["UKEEP123"] },
        CNEW123: { requireMention: false, users: ["UKEEP123"] },
      },
    });
    assert.equal(
      configuration.data.values.plugins.entries.knowledge.config.marker,
      "policy-preservation",
    );
  });
}

test("Agent tabs replace only their content and preserve surrounding panels and history", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Tab navigation", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Tab navigation Agent",
    nativeValues("tabs"),
  );
  const { page } = await newPage(t, fixture);
  await page.setViewportSize({ width: 1200, height: 650 });
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();
  await page.getByRole("button", { name: "Channels", exact: true }).scrollIntoViewIfNeeded();
  const panels = await page
    .locator("h1, .agent-toolbar, .native-admin-access, .revision-selector, .agent-tabs")
    .elementHandles();
  const top = await page.evaluate(() => globalThis.scrollY);
  requests.length = 0;

  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Configure Slack", exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("tab"), "channels");
  // The surrounding DOM must stay mounted; a fast full-page rerender still loses focus and scroll.
  for (const panel of panels) {
    assert.equal(await panel.evaluate((node) => node.isConnected), true);
  }
  assert.ok(Math.abs((await page.evaluate(() => globalThis.scrollY)) - top) < 2);
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  const secret = page.getByLabel("API key Secret");
  await secret.waitFor();
  const secretElement = await secret.elementHandle();
  await page.getByRole("button", { name: "Workspace files", exact: true }).click();
  await page
    .getByText(
      "Workspace files require a deployed Agent with an active revision and a reachable gateway.",
    )
    .waitFor();
  assert.equal(await secretElement.evaluate((node) => node.isConnected), false);
  await page.goBack();
  await page.getByLabel("API key Secret").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("tab"), "credentials");
  await page.goForward();
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  for (const panel of panels) {
    assert.equal(await panel.evaluate((node) => node.isConnected), true);
  }
  assert.deepEqual(
    requests.filter((request) =>
      [
        "/api/auth/session",
        "/namespaces",
        `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
      ].includes(request.path),
    ),
    [],
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  // Refresh is still explicit and rereads the page, unlike a tab change.
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  assert.equal(await panels[0].evaluate((node) => node.isConnected), false);
});

test("Agent tab switches ignore late configuration reads and keep direct workspace access independent", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Slow tabs", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Slow tab Agent",
    nativeValues("slow-tabs"),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "workspace");
  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  assert.equal(
    requests.some((request) => request.path === configurationPath),
    false,
  );
  assert.equal(
    requests.some((request) => request.path.endsWith("/revisions")),
    false,
  );
  const tabs = await page.locator(".agent-tabs").elementHandle();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let reached;
  const held = new Promise((resolve) => {
    reached = resolve;
  });
  // Delay a real authorized response to exercise navigation while the first panel read is pending.
  await page.route(`${fixture.origin}${configurationPath}`, async (route) => {
    const response = await route.fetch();
    reached();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await held;
  await page.getByRole("button", { name: "Workspace files", exact: true }).click();
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  const delivered = page.waitForResponse(`${fixture.origin}${configurationPath}`);
  release();
  await delivered;
  // Configuration completion may prepare shared controls, but must not replace the active tab.
  await page.getByRole("heading", { name: "New revision", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Workspace files", exact: true }).isVisible(),
    true,
  );
  assert.equal(await page.getByRole("button", { name: "Configure Slack", exact: true }).count(), 0);
  assert.equal(await tabs.evaluate((node) => node.isConnected), true);
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Configure Slack", exact: true }).waitFor();
  assert.equal(requests.filter((request) => request.path === configurationPath).length, 1);
});

test("standard Codex password Preset creates one scoped Secret and reuses it after an Agent conflict", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const root = await mkdtemp(join(tmpdir(), "occ-password-preset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const namespace = await fixture.createNamespace("Password Preset", { ready: true });
  await fixture.createAgent(namespace.id, "Existing Agent");
  const artifact = JSON.parse(
    await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
  );
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: artifact,
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Variable: name", { exact: true }).fill("Existing Agent");
  await page.getByLabel("Variable: model", { exact: true }).fill("gpt-5.1");
  const password = page.getByLabel("Variable: modelSecret", { exact: true });
  assert.equal(await password.getAttribute("type"), "password");
  await page.getByRole("button", { name: "Use Preset" }).click();
  assert.equal(await password.evaluate((input) => input.validity.valueMissing), true);
  const key = "synthetic-password-key-{{ vars.name }}";
  await password.fill(key);
  await page.getByRole("button", { name: "Use Preset" }).click();
  const apiKey = page.getByLabel("API key", { exact: true });
  assert.equal(await apiKey.getAttribute("type"), "password");
  assert.equal(await apiKey.inputValue(), key);
  assert.equal(
    (await page.getByLabel("Configuration JSON", { exact: true }).inputValue()).includes(key),
    false,
  );
  assert.equal(nonAuthWriteRequests(requests).length, 0);
  const save = page.getByRole("button", { name: "Create Agent", exact: true });
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  assert.equal((await conflict).status(), 409);
  await page.getByText(/conflicts with the saved state/).waitFor();
  assert.equal(await apiKey.inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Start over" }).isDisabled(), true);
  await page.getByLabel("Agent name", { exact: true }).fill("Password Agent");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  const created = await (await createdResponse).json();
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.data.id}`);
  const secretWrites = pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`);
  assert.equal(secretWrites.length, 1);
  assert.equal(secretWrites[0].body.value, key);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(
    JSON.stringify(requests.filter((request) => !request.path.endsWith("/secrets"))).includes(key),
    false,
  );
  assert.equal(created.data.executionMode, "dedicated");
  assert.equal(created.data.harnessAuth.source.namespaceId, namespace.id);
  const secrets = await fixture.request("GET", `/namespaces/${namespace.id}/secrets`);
  assert.ok(secrets.data.some((secret) => secret.id === created.data.harnessAuth.source.id));
  assert.equal(JSON.stringify(secrets.body).includes(key), false);
  const retained = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/presets/${preset.data.id}`,
  );
  assert.deepEqual(retained.data.template, artifact.template);
  const access = await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`);
  assert.ok(
    access.data.some(
      (binding) =>
        binding.subjectId === created.data.servicePrincipalId &&
        binding.resourceId === created.data.harnessAuth.source.id,
    ),
  );
});

test("Preset with a prebound model Secret grants the created draft access", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const root = await mkdtemp(join(tmpdir(), "occ-bound-secret-preset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const namespace = await fixture.createNamespace("Bound Secret Preset", { ready: true });
  const modelSecret = await fixture.createSecret(namespace.id, "Model token", "hidden-model-token");
  const artifact = JSON.parse(
    await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
  );
  delete artifact.template.variables.modelSecret;
  artifact.template.agent.harnessAuth = { method: "api_key", source: modelSecret.ref };
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: artifact,
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Variable: name", { exact: true }).fill("Bound Secret Agent");
  await page.getByLabel("Variable: model", { exact: true }).fill("gpt-5.1");
  await page.getByRole("button", { name: "Use Preset" }).click();
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = (await (await createdResponse).json()).data;
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.id}`);
  const bindings = await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`);
  const roles = await fixture.request("GET", `/namespaces/${namespace.id}/iam/roles`);
  const secretOperateRole = roles.data.find(
    (role) =>
      role.permissions.length === 1 &&
      role.permissions[0].resourceKind === "secret" &&
      role.permissions[0].action === "operate",
  );
  assert.ok(secretOperateRole);
  assert.ok(
    bindings.data.some(
      (binding) =>
        binding.subjectKind === "identity" &&
        binding.subjectId === created.servicePrincipalId &&
        binding.roleId === secretOperateRole.id &&
        binding.resourceKind === "secret" &&
        binding.resourceId === modelSecret.id,
    ),
  );
});

test("password Preset can reuse an existing Secret and retry an uncertain grant without duplicate writes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const root = await mkdtemp(join(tmpdir(), "occ-existing-secret-preset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const namespace = await fixture.createNamespace("Existing Secret Preset", { ready: true });
  const modelSecret = await fixture.createSecret(
    namespace.id,
    "Existing model token",
    "hidden-model-token",
  );
  const artifact = JSON.parse(
    await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
  );
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: artifact,
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  const bindingPath = `/namespaces/${namespace.id}/iam/access-bindings`;
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Variable: name", { exact: true }).fill("Existing Secret Agent");
  await page.getByLabel("Variable: model", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Secret source for modelSecret", { exact: true }).selectOption("existing");
  await page
    .getByLabel("Existing Secret for modelSecret", { exact: true })
    .selectOption(modelSecret.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page
    .getByText("Preset authentication: API key · Secret configured", { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("API key", { exact: true }).count(), 0);

  await page.route(`**${bindingPath}`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    await route.abort("failed");
  });
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = (await (await createdResponse).json()).data;
  await page
    .getByRole("alert")
    .filter({ hasText: /credential access is not confirmed.*interrupted/ })
    .waitFor();
  await page.unroute(`**${bindingPath}`);
  await page.getByRole("button", { name: "Retry credential access" }).click();
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.id}`);

  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  assert.deepEqual(agentPostRequests(requests, namespace.id)[0].body.harnessAuth, {
    method: "api_key",
    source: modelSecret.ref,
  });
  const bindings = await fixture.request("GET", bindingPath);
  assert.equal(bindings.status, 200);
  assert.equal(bindings.data.length, 1);
  assert.equal(bindings.data[0].subjectId, created.servicePrincipalId);
  assert.equal(bindings.data[0].resourceId, modelSecret.id);
  const retained = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/presets/${preset.data.id}`,
  );
  assert.deepEqual(retained.data.template, artifact.template);
});

test("codex_pat password Preset creates one Secret and reuses it after an Agent conflict", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const root = await mkdtemp(join(tmpdir(), "occ-codex-pat-preset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const namespace = await fixture.createNamespace("Codex PAT Preset", { ready: true });
  await fixture.createAgent(namespace.id, "Existing Codex Agent");
  const artifact = JSON.parse(
    await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
  );
  artifact.name = "standard-codex-pat";
  artifact.template.agent.harnessAuth.method = "codex_pat";
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: artifact,
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Variable: name", { exact: true }).fill("Existing Codex Agent");
  await page.getByLabel("Variable: model", { exact: true }).fill("gpt-6-astra");
  await page.getByLabel("Secret source for modelSecret", { exact: true }).selectOption("new");
  const password = page.getByLabel("Variable: modelSecret", { exact: true });
  await password.fill("at-codex-pat-preset-token");
  await page.getByRole("button", { name: "Use Preset" }).click();
  const token = page.getByLabel("Service account token", { exact: true });
  assert.equal(await token.inputValue(), "at-codex-pat-preset-token");
  const save = page.getByRole("button", { name: "Create Agent", exact: true });
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  assert.equal((await conflict).status(), 409);
  await page.getByText(/conflicts with the saved state/).waitFor();
  assert.equal(await token.inputValue(), "");
  await page.getByLabel("Agent name", { exact: true }).fill("Codex PAT Agent");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  const created = (await (await createdResponse).json()).data;
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.id}`);
  const secretWrites = pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`);
  assert.equal(secretWrites.length, 1);
  assert.equal(secretWrites[0].body.value, "at-codex-pat-preset-token");
  assert.equal(agentPostRequests(requests, namespace.id).length, 2);
  assert.equal(created.harnessAuth.method, "codex_pat");
});

test("Preset Secret picker preserves existing mode on catalog failure and can switch to new", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const root = await mkdtemp(join(tmpdir(), "occ-catalog-failure-preset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const namespace = await fixture.createNamespace("Preset secret catalog failure", { ready: true });
  const artifact = JSON.parse(
    await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
  );
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: artifact,
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  await page.route(`**/namespaces/${namespace.id}/secrets`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "DEPENDENCY_UNAVAILABLE", message: "Secret catalog unavailable." },
          meta: { requestId: "req_secret_catalog_unavailable" },
        }),
      });
      return;
    }
    await route.fallback();
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  const source = page.getByLabel("Secret source for modelSecret", { exact: true });
  await source.selectOption("existing");
  await page.getByText(/Choose create-new mode to enter a new token/).waitFor();
  assert.equal(await source.inputValue(), "existing");
  await page.getByLabel("Variable: name", { exact: true }).fill("Catalog fallback Agent");
  await page.getByLabel("Variable: model", { exact: true }).fill("gpt-5.1");
  await source.selectOption("new");
  await page
    .getByLabel("Variable: modelSecret", { exact: true })
    .fill("new-token-after-catalog-error");
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("API key", { exact: true }).inputValue(),
    "new-token-after-catalog-error",
  );
});

test("Preset picker ignores stale Preset responses after switching selection", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Preset picker race", { ready: true });
  const first = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "First delayed Preset",
      template: {
        variables: { firstName: { type: "string" } },
        agent: { name: "{{ vars.firstName }}", executionMode: "embedded" },
      },
    },
  });
  const second = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Second current Preset",
      template: {
        variables: { secondName: { type: "string" } },
        agent: { name: "{{ vars.secondName }}", executionMode: "embedded" },
      },
    },
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  await page.route(`**/namespaces/${namespace.id}/presets/${first.data.id}`, async (route) => {
    await firstBlocked;
    await route.fallback();
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(first.data.id);
  await page.getByLabel("Preset template").selectOption(second.data.id);
  await page.getByLabel("Variable: secondName", { exact: true }).waitFor();
  releaseFirst();
  await page.waitForTimeout(50);
  assert.equal(await page.getByLabel("Variable: firstName", { exact: true }).count(), 0);
  await page.getByLabel("Variable: secondName", { exact: true }).fill("Current Agent");
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "Current Agent");
});

for (const method of ["api_key", "codex_pat"]) {
  test(`Credentials grants exact Agent access when rebinding ${method}`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Model credential replacement", {
      ready: true,
    });
    const agent = await fixture.createAgent(
      namespace.id,
      "Credential Agent",
      createHarnessConfiguration("codex", "gpt-4.1"),
      { executionMode: "dedicated" },
    );
    const replacement = await fixture.createSecret(
      namespace.id,
      "Replacement model credential",
      "test-replacement-token",
    );
    const unrelated = await fixture.createSecret(
      namespace.id,
      "Unrelated credential",
      "test-unrelated-token",
    );
    const { page } = await newPage(t, fixture);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
    );
    await page.getByLabel("Authentication source").selectOption(method);
    await page
      .getByLabel(method === "api_key" ? "API key Secret" : "Service account token Secret")
      .selectOption(replacement.id);
    await page.getByRole("button", { name: "Save authentication source" }).click();
    // Wait for the real IAM write and the refreshed form, not just the earlier Agent PATCH.
    await page.waitForFunction(
      () => globalThis.document.querySelector("#harness-auth-method")?.disabled === false,
    );
    const bindings = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/iam/access-bindings`,
    );
    const roles = await fixture.request("GET", `/namespaces/${namespace.id}/iam/roles`);
    const grants = bindings.data.filter(
      (binding) =>
        binding.subjectId === agent.servicePrincipalId && binding.resourceId === replacement.id,
    );
    assert.equal(grants.length, 1);
    assert.deepEqual(grants[0], {
      id: grants[0].id,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: grants[0].roleId,
      resourceKind: "secret",
      resourceId: replacement.id,
    });
    assert.deepEqual(roles.data.find((role) => role.id === grants[0].roleId).permissions, [
      { action: "operate", resourceKind: "secret" },
    ]);
    assert.equal(
      bindings.data.some((binding) => binding.resourceId === unrelated.id),
      false,
    );
    const saved = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
    assert.deepEqual(saved.data.harnessAuth, { method, source: replacement.ref });
    // Saving the same source again repairs missing access and reuses an existing exact binding.
    await page.getByRole("button", { name: "Save authentication source" }).click();
    await page.waitForFunction(
      () => globalThis.document.querySelector("#harness-auth-method")?.disabled === false,
    );
    assert.deepEqual(
      (await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`)).data,
      bindings.data,
    );
  });
}

test("Credentials retries denied and interrupted grants without repeating the authentication save", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  const installation = await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Credential access recovery", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Recovery Agent",
    createHarnessConfiguration("codex", "gpt-4.1"),
    { executionMode: "dedicated" },
  );
  const replacement = await fixture.createSecret(
    namespace.id,
    "Replacement credential",
    "test-retry-token",
  );
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const bindingsPath = `/namespaces/${namespace.id}/iam/access-bindings`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  // Native IAM denies the actor's grant authority while the Agent update remains authorized.
  fixture.policy.restrictions.push({
    id: "deny-update-credential-grant",
    resourceKind: "installation",
    resourceId: installation.id,
    action: "administer",
    effect: "deny",
  });
  await page.getByLabel("Authentication source").selectOption("codex_pat");
  await page.getByLabel("Service account token Secret").selectOption(replacement.id);
  await page.getByRole("button", { name: "Save authentication source" }).click();
  await page
    .getByText(/Authentication source saved, but this Agent's Secret access could not be confirmed/)
    .waitFor();
  assert.equal(await page.getByLabel("Authentication source").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
  assert.equal(pathRequests(requests, "POST", bindingsPath).length, 0);
  assert.equal(
    (await fixture.request("GET", agentPath)).data.harnessAuth.source.id,
    replacement.id,
  );
  // A partial save survives navigation without repeating PATCH or enabling deployment.
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await page.getByRole("button", { name: "Retry credential access" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
  fixture.policy.restrictions.splice(
    fixture.policy.restrictions.findIndex((item) => item.id === "deny-update-credential-grant"),
    1,
  );
  // Commit the binding through the real API, then lose only its response. Read-before-create makes retry safe.
  await page.route(`**${bindingsPath}`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Retry credential access" }).click();
  await page.getByText(/Secret access could not be confirmed.*Request interrupted/).waitFor();
  await page.unroute(`**${bindingsPath}`);
  await page.getByRole("button", { name: "Retry credential access" }).click();
  await page.getByRole("button", { name: "Save authentication source" }).waitFor();
  const grants = (await fixture.request("GET", bindingsPath)).data.filter(
    (binding) => binding.resourceId === replacement.id,
  );
  assert.equal(grants.length, 1);
  assert.equal(grants[0].subjectId, agent.servicePrincipalId);
  assert.equal(pathRequests(requests, "PATCH", agentPath).length, 1);
  assert.equal(pathRequests(requests, "POST", bindingsPath).length, 1);
});

test("Credentials blocks repeat saves after losing an authentication PATCH response", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unknown credential save", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Unknown save Agent",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  const replacement = await fixture.createSecret(
    namespace.id,
    "Replacement credential",
    "test-unknown-token",
  );
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  await page.route(`**${agentPath}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    assert.equal((await route.fetch()).status(), 200);
    await route.abort("failed");
  });
  await page.getByLabel("Authentication source").selectOption("api_key");
  await page.getByLabel("API key Secret").selectOption(replacement.id);
  await page.getByRole("button", { name: "Save authentication source" }).click();
  await page
    .locator("form.agent-card")
    .getByText(/Outcome unknown/)
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Save authentication source" }).isDisabled(),
    true,
  );
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
  assert.equal(pathRequests(requests, "PATCH", agentPath).length, 1);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/iam/access-bindings`).length,
    0,
  );
  // Explicit reload recovers the committed source; saving it again confirms the missing grant.
  await page.unroute(`**${agentPath}`);
  await page.getByRole("button", { name: "Reload authentication source", exact: true }).click();
  await page.getByLabel("API key Secret").waitFor();
  assert.equal(
    await page.getByLabel("API key Secret").evaluate((node) => node.value),
    replacement.id,
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  await page.waitForFunction(
    () => globalThis.document.querySelector("#harness-auth-method")?.disabled === false,
  );
  assert.equal(
    (await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`)).data.some(
      (binding) =>
        binding.subjectId === agent.servicePrincipalId && binding.resourceId === replacement.id,
    ),
    true,
  );
});

test("unsaved Preset drafts retain unfinished edits across navigation until explicit discard", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const root = await mkdtemp(join(tmpdir(), "occ-preset-navigation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const namespace = await fixture.createNamespace("Draft navigation", { ready: true });
  const artifact = JSON.parse(
    await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
  );
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: artifact,
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Variable: name", { exact: true }).fill("Navigation draft");
  await page.getByLabel("Variable: model", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Variable: modelSecret", { exact: true }).fill("synthetic-navigation-key");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal(
    await page.getByLabel("Variable: name", { exact: true }).inputValue(),
    "Navigation draft",
  );
  assert.equal(await page.getByLabel("Variable: model", { exact: true }).inputValue(), "gpt-5.1");
  assert.equal(await page.getByLabel("Variable: modelSecret", { exact: true }).inputValue(), "");
  await page.getByLabel("Variable: modelSecret", { exact: true }).fill("synthetic-navigation-key");
  await page.getByRole("button", { name: "Use Preset" }).click();
  await openAdvancedSettings(page);
  const unfinished = '{"agents":';
  await page.getByLabel("Configuration JSON", { exact: true }).fill(unfinished);
  await page.getByLabel("USER.md", { exact: true }).fill("");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Agent name", { exact: true }).inputValue(),
    "Navigation draft",
  );
  assert.equal(
    await page.getByLabel("Configuration JSON", { exact: true }).inputValue(),
    unfinished,
  );
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "");
  // Navigation keeps the established credential-clearing rule, even though ordinary edits survive.
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  assert.deepEqual(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
    { local: {}, session: {} },
  );
  assert.equal(new URL(page.url()).search, `?namespace=${namespace.id}`);
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Start over" }).click();
  assert.equal(
    await page.getByLabel("Configuration JSON", { exact: true }).inputValue(),
    unfinished,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByLabel("Preset template").waitFor();
  assert.equal(await page.getByLabel("Preset template").inputValue(), "");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByLabel("Preset template").waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).count(), 0);

  // Reload ends the SPA session; a new form must not recover discarded or browser-stored inputs.
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Reload-only draft");
  await page.reload();
  await page.getByLabel("Preset template").waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).count(), 0);

  // Signing back in without reloading must not recover the previous session's in-memory draft.
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Private session draft");
  await page.getByRole("button", { name: "OpenClaw Enterprise", exact: true }).click();
  await page.getByRole("menuitem", { name: "Logout" }).click();
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByLabel("Preset template").waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).count(), 0);
});

test("live workspace drafts survive navigation, stay Agent-scoped, and clear on explicit reload or save", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "console-workspace-drafts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Exercise the real Console, Fastify, and IAM paths with disk-backed file transport.
  // This checks UI navigation and file requests, not a live Agent gateway.
  const fixture = await createConsoleAppFixture(t, {
    publicOrigin: true,
    workspaceFilesAccess: {
      async read({ revision, filename }) {
        return {
          status: "ok",
          file: {
            name: filename,
            content: await readFile(join(root, revision.agentId, filename), "utf8"),
          },
        };
      },
      async write({ revision, filename, content }) {
        await writeFile(join(root, revision.agentId, filename), content);
        return { status: "ok", file: { name: filename, size: Buffer.byteLength(content) } };
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Workspace navigation", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Workspace draft owner",
    nativeValues("workspace"),
  );
  const other = await fixture.createAgent(
    namespace.id,
    "Other workspace Agent",
    nativeValues("other"),
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await fixture.seedActiveAgentRevision(namespace.id, other.id);
  for (const owner of [agent, other]) {
    await mkdir(join(root, owner.id));
    for (const name of Object.keys(WORKSPACE_DEFAULTS)) {
      await writeFile(join(root, owner.id, name), `# Saved ${name}\n`);
    }
  }
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace");
  await login(page, fixture, url.pathname + url.search);
  const file = page.getByLabel("AGENTS.md", { exact: true });
  await file.fill("# Unsaved instructions\n");
  await page.getByLabel("USER.md", { exact: true }).fill("");
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Workspace files", exact: true }).click();
  await page.waitForFunction(() => {
    const editor = globalThis.document.getElementById("workspace-AGENTS.md");
    return editor && !editor.disabled;
  });
  assert.equal(await file.inputValue(), "# Unsaved instructions\n");
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("link", { name: "Other workspace Agent", exact: true }).click();
  await page.getByRole("button", { name: "Workspace files", exact: true }).click();
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  assert.equal(await file.inputValue(), "# Saved AGENTS.md\n");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByLabel("Search Agents").fill("Workspace draft owner");
  await page.getByRole("link", { name: "Workspace draft owner", exact: true }).click();
  await page.getByRole("button", { name: "Workspace files", exact: true }).click();
  await page.waitForFunction(() => {
    const editor = globalThis.document.getElementById("workspace-AGENTS.md");
    return editor && !editor.disabled;
  });
  assert.equal(await file.inputValue(), "# Unsaved instructions\n");
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/workspace/files/AGENTS.md"),
  );
  await page.getByRole("button", { name: "Save AGENTS.md", exact: true }).click();
  assert.equal((await saved).status(), 200);
  assert.equal(
    await readFile(join(root, agent.id, "AGENTS.md"), "utf8"),
    "# Unsaved instructions\n",
  );
  await page.getByRole("button", { name: "Reload USER.md", exact: true }).click();
  await page.getByText("USER.md loaded.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "# Saved USER.md\n");
  await page.getByRole("link", { name: "← Agents" }).click();
  assert.equal(await page.getByLabel("Search Agents").inputValue(), "Workspace draft owner");
  await page.goBack();
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Save AGENTS.md", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "# Saved USER.md\n");
});

test("authentication drafts retain Secret references and their original save baseline", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Authentication navigation", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Authentication draft",
    nativeValues("auth"),
  );
  const secret = await fixture.createSecret(namespace.id, "Replacement key", "synthetic-auth-key");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");
  await login(page, fixture, url.pathname + url.search);
  await page.getByLabel("Authentication source").selectOption("api_key");
  await page.getByLabel("API key Secret", { exact: true }).selectOption(secret.id);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  // A saved auth change must not rebase the retained local choice when the page is recreated.
  const changed = await fixture.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
    body: { configurationId: agent.configurationId, harnessAuth: null },
  });
  assert.equal(changed.status, 200);
  await page.goBack();
  assert.equal(
    await page.getByLabel("API key Secret", { exact: true }).evaluate((node) => node.value),
    secret.id,
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  await page
    .getByText("The Configuration changed. Reload authentication source before saving.")
    .waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  await page.getByRole("button", { name: "Reload authentication source" }).click();
  await page.getByLabel("Authentication source").waitFor();
  assert.equal(await page.getByLabel("Authentication source").inputValue(), "");
  await page.getByLabel("Authentication source").selectOption("api_key");
  assert.equal(
    await page.getByLabel("API key Secret", { exact: true }).evaluate((node) => node.value),
    "",
  );
});
