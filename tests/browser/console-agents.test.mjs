import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";

import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/workspace-defaults.mjs";
import { GitHubRepoDriver } from "../../apps/controller/src/drivers/repo/github/driver.ts";

import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture, backendFixtures } from "../helpers/console-app.mjs";
import { createConsoleRepositoryLaunchFixture } from "../helpers/console-repository-launch.mjs";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.mjs";

import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

import {
  newPage,
  login,
  repositoryCheckbox,
  unusedPort,
  apiRequests,
  nonAuthWriteRequests,
  enterManualModel,
  openAdvancedSettings,
  revealNativeConfiguration,
  detailUrl,
  pathRequests,
  configurationPostRequests,
  agentProvisionPostRequests,
  secretPostRequests,
  routeInstallationProvisioning,
  routeInstallationWithoutProvisioning,
  agentPostRequests,
  accessBindingPostRequests,
  waitForCondition,
  createRuntimeAuthFixture,
  optionValues,
  nativeValues,
  createRepositoryLaunchFixture,
  STARTER_CONTROL_UI,
  repositoryBackendFixture,
} from "../helpers/console-agents-browser.mjs";

test("Agent creation stores its API key separately, grants exact access, and saves a draft without a revision", async (t) => {
  const audit = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink: audit });
  const secretDriver = createTestSecretDriver();
  const fixture = await createConsoleAppFixture(t, { state, secretDriver });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Agent authoring", { ready: true });
  const key = "at-explicit-api-key-not-auto-detected";
  const existingSlackAppSecret = await fixture.createSecret(
    namespace.id,
    "Existing Slack app token",
    "never-visible-existing-slack-app-token",
  );
  const replacementSlackAppSecret = await fixture.createSecret(
    namespace.id,
    "Replacement Slack app token",
    "never-visible-replacement-slack-app-token",
  );
  const createdSlackBotSecretValue = "never-visible-created-slack-bot-token";
  const values = nativeValues("create", { harnessId: "codex", providerModel: "gpt-5.1" });
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  assert.equal(await page.getByRole("link", { name: "Backends", exact: true }).count(), 0);
  assert.deepEqual(await optionValues(page.getByLabel("Provider", { exact: true })), [
    { value: "openai", text: "OpenAI" },
    { value: "anthropic", text: "Anthropic" },
  ]);
  const harness = page.getByLabel("Harness", { exact: true });
  assert.deepEqual(await optionValues(harness), [
    { value: "codex", text: "Codex" },
    { value: "openclaw", text: "OpenClaw" },
  ]);
  assert.equal(await harness.inputValue(), "codex");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  assert.deepEqual(await optionValues(page.getByLabel("Authentication method", { exact: true })), [
    { value: "api_key", text: "OpenAI API key" },
    { value: "codex_pat", text: "Service Accounts" },
  ]);
  const keyInput = page.getByLabel("API key", { exact: true });
  assert.equal(await keyInput.getAttribute("type"), "password");
  assert.equal(await keyInput.getAttribute("placeholder"), "sk-…");
  assert.equal(
    await page.getByRole("link", { name: "Create an API key", exact: true }).getAttribute("href"),
    "https://platform.openai.com/api-keys",
  );
  await keyInput.fill("discarded-api-key");
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  assert.equal(await page.getByLabel("Service account token", { exact: true }).inputValue(), "");
  assert.equal(
    await page.getByLabel("Service account token", { exact: true }).getAttribute("placeholder"),
    "at-…",
  );
  assert.equal(
    await page.getByRole("link", { name: "OpenAI admin", exact: true }).getAttribute("href"),
    "https://admin.openai.com/",
  );
  await page
    .getByText(
      "choose your workspace, open Service accounts, and create a token with Codex scope.",
      { exact: false },
    )
    .waitFor();
  assert.equal(await page.getByRole("link", { name: "Create an API key", exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  assert.equal(await page.getByLabel("Model", { exact: true }).isVisible(), true);
  await page.getByLabel("Authentication method", { exact: true }).selectOption("api_key");
  assert.equal(await page.getByLabel("Harness", { exact: true }).isEnabled(), true);
  assert.equal(await keyInput.getAttribute("placeholder"), "sk-…");
  assert.equal(await page.getByRole("link", { name: "OpenAI admin", exact: true }).count(), 0);
  await enterManualModel(page, key, "gpt-5.1");
  for (const [filename, content] of Object.entries(WORKSPACE_DEFAULTS)) {
    assert.equal(await page.getByLabel(filename, { exact: true }).inputValue(), content);
  }
  // Textareas preserve literal markup as content and normalize browser newlines to LF.
  const customIdentity = "# Identity\r\n<em>Workspace author</em>\r\n";
  await page.getByText("Advanced settings", { exact: true }).click();
  await page.getByLabel("IDENTITY.md", { exact: true }).fill(customIdentity);
  await page.getByLabel("USER.md", { exact: true }).fill("");
  await page.getByLabel("Agent name").fill("Console-created Agent");
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const createChannelDialog = page.getByRole("dialog", { name: /^(Configure|Edit) Slack$/ });
  await createChannelDialog.getByLabel("Direct-message policy").selectOption("disabled");
  await createChannelDialog
    .getByText("Choose existing Slack token Secrets or create them here before creating the Agent.")
    .waitFor();
  await createChannelDialog
    .getByText(
      "Channel settings and selected bindings are not persisted until you create the Agent. Secrets created from the modal are stored immediately in the Namespace.",
    )
    .waitFor();
  assert.equal(await createChannelDialog.getByRole("link").count(), 0);
  await createChannelDialog.getByLabel("Slack app token").selectOption(existingSlackAppSecret.id);
  await createChannelDialog.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  // Separate applications must retain grants for every final selected Secret.
  await createChannelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  await createChannelDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Edit Slack" }).click();
  await createChannelDialog
    .getByLabel("Slack bot token")
    .selectOption({ label: "Create new Secret..." });
  const createSecretDialog = page.getByRole("dialog", {
    name: "Create Slack bot token Secret",
  });
  await createSecretDialog
    .getByRole("heading", { name: "Create Slack bot token Secret" })
    .waitFor();
  assert.equal(await createSecretDialog.getByLabel("Binding key").inputValue(), "SLACK_BOT_TOKEN");
  assert.equal(await createSecretDialog.getByLabel("Binding key").getAttribute("readonly"), "");
  assert.equal(
    await createSecretDialog.getByLabel("Secret value").getAttribute("type"),
    "password",
  );
  await createSecretDialog.getByRole("button", { name: "Cancel" }).click();
  await createChannelDialog
    .getByLabel("Slack bot token")
    .selectOption({ label: "Create new Secret..." });
  await page
    .getByRole("dialog", { name: "Create Slack bot token Secret" })
    .getByLabel("Secret value")
    .fill(createdSlackBotSecretValue);
  const botSecretResponse = page.waitForResponse((response) => {
    if (
      response.url() !== `${fixture.origin}/namespaces/${namespace.id}/secrets` ||
      response.request().method() !== "POST"
    ) {
      return false;
    }
    return response.request().postDataJSON()?.name === "Console-created Agent Slack bot token";
  });
  await page
    .getByRole("dialog", { name: "Create Slack bot token Secret" })
    .getByRole("button", { name: "Create Secret" })
    .click();
  const createdSlackBotSecret = (await (await botSecretResponse).json()).data;
  await createChannelDialog.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  await createChannelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  await createChannelDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Edit Slack" }).click();
  // Replacing an earlier selection must not grant the superseded Secret to the Agent.
  await createChannelDialog
    .getByLabel("Slack app token")
    .selectOption(replacementSlackAppSecret.id);
  await createChannelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  const stagedSecretBindings = {
    SLACK_APP_TOKEN: {
      source: replacementSlackAppSecret.ref,
      delivery: { type: "env" },
    },
    SLACK_BOT_TOKEN: {
      source: createdSlackBotSecret.ref,
      delivery: { type: "env" },
    },
  };
  await openAdvancedSettings(page);
  const stagedValues = JSON.parse(await page.getByLabel("Configuration JSON").inputValue());
  await page.getByLabel("Agent name").fill("A".repeat(200));

  const secretResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/secrets` &&
      response.request().method() === "POST",
  );
  const configurationResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/configurations` &&
      response.request().method() === "POST",
  );
  const createResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const secret = (await (await secretResponse).json()).data;
  const configuration = await (await configurationResponse).json();
  const created = await (await createResponse).json();
  assert.equal(secretDriver.valueFor(secret), key);
  assert.equal(secretDriver.calls.filter((call) => call.operation === "create").length, 4);
  for (const payload of [secret, configuration, created]) {
    assert.equal(JSON.stringify(payload).includes(key), false);
  }
  assert.equal(configuration.data.kind, "agent");
  assert.deepEqual(configuration.data.values, stagedValues);
  assert.deepEqual(configuration.data.secretBindings, stagedSecretBindings);
  assert.equal(created.data.name, "A".repeat(200));
  assert.equal(created.data.namespaceId, namespace.id);
  assert.equal(created.data.configurationId, configuration.data.id);
  assert.equal(created.data.executionMode, "dedicated");
  assert.deepEqual(agentProvisionPostRequests(requests, namespace.id), []);
  assert.equal(created.data.backendId, null);
  assert.deepEqual(created.data.harnessAuth, { method: "api_key", source: secret.ref });
  assert.equal((await page.locator("body").textContent()).includes(key), false);
  assert.equal(
    (await page.locator("body").textContent()).includes("never-visible-existing-slack-app-token"),
    false,
  );
  assert.equal(
    (await page.locator("body").textContent()).includes(createdSlackBotSecretValue),
    false,
  );
  assert.equal(
    (await page.locator("body").textContent()).includes(
      "never-visible-replacement-slack-app-token",
    ),
    false,
  );
  assert.equal(created.data.activeRevisionId, undefined);
  const submittedWorkspace = agentPostRequests(requests, namespace.id)[0].body;
  assert.deepEqual(submittedWorkspace.initialWorkspaceFiles, {
    ...WORKSPACE_DEFAULTS,
    "IDENTITY.md": customIdentity.replaceAll("\r\n", "\n"),
    "USER.md": "",
  });
  assert.equal(submittedWorkspace.workspaceDefaultsId, WORKSPACE_DEFAULTS_ID);
  assert.equal(Object.hasOwn(created.data, "initialWorkspaceFiles"), false);
  assert.equal(Object.hasOwn(created.data, "workspaceDefaultsId"), false);

  await page.waitForURL((url) => {
    return (
      url.pathname === `/console/agents/${created.data.id}` &&
      url.searchParams.get("namespace") === namespace.id &&
      url.searchParams.get("revision") === "draft"
    );
  });
  await page.getByRole("heading", { name: "New revision" }).waitFor();
  await page.getByRole("button", { name: "Configuration", exact: true }).waitFor();
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "create"').waitFor();
  // Neither the summary nor expanded native Configuration reveals the credential or its ID.
  const visibleConfiguration = await page.locator("body").textContent();
  assert.equal(visibleConfiguration.includes(secret.id), false);
  assert.equal(visibleConfiguration.includes("never-visible-existing-slack-app-token"), false);
  assert.equal(visibleConfiguration.includes(createdSlackBotSecretValue), false);
  await page.getByText("API key · Secret configured", { exact: true }).waitFor();

  const savedConfiguration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${configuration.data.id}`,
  );
  assert.deepEqual(savedConfiguration.data.values, stagedValues);
  assert.deepEqual(savedConfiguration.data.secretBindings, stagedSecretBindings);
  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${created.data.id}/revisions`,
  );
  assert.equal(revisions.status, 200);
  assert.deepEqual(revisions.data, []);
  assert.deepEqual(
    nonAuthWriteRequests(requests).map((request) => [request.method, request.path]),
    [
      ["POST", `/namespaces/${namespace.id}/secrets`],
      ["POST", `/namespaces/${namespace.id}/secrets`],
      ["POST", `/namespaces/${namespace.id}/configurations`],
      ["POST", `/namespaces/${namespace.id}/agents`],
      ["POST", `/namespaces/${namespace.id}/iam/roles`],
      ["POST", `/namespaces/${namespace.id}/iam/access-bindings`],
      ["POST", `/namespaces/${namespace.id}/iam/access-bindings`],
      ["POST", `/namespaces/${namespace.id}/iam/access-bindings`],
    ],
  );
  assert.deepEqual(configurationPostRequests(requests, namespace.id)[0].body, {
    kind: "agent",
    values: stagedValues,
    secretBindings: stagedSecretBindings,
  });

  const roles = await fixture.request("GET", `/namespaces/${namespace.id}/iam/roles`);
  const access = await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`);
  assert.equal(roles.status, 200);
  assert.equal(access.status, 200);
  assert.equal(roles.data.length, 1);
  assert.deepEqual(roles.data[0].permissions, [{ action: "operate", resourceKind: "secret" }]);
  assert.deepEqual(
    access.data
      .map(({ id, ...binding }) => binding)
      .sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
    [secret.id, replacementSlackAppSecret.id, createdSlackBotSecret.id]
      .sort()
      .map((resourceId) => ({
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: created.data.servicePrincipalId,
        roleId: roles.data[0].id,
        resourceKind: "secret",
        resourceId,
      })),
  );
  assert.ok(audit.events.some((event) => event.resource.id === created.data.id));
  assert.equal(JSON.stringify(audit.events).includes(key), false);

  // The server still enforces the exact source grant when the form is saved.
  fixture.policy.restrictions.push({
    id: "deny-harness-secret-operate",
    namespaceId: namespace.id,
    resourceKind: "secret",
    resourceId: secret.id,
    action: "operate",
    effect: "deny",
  });
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  const savedSecretInput = page.getByLabel("API key Secret");
  assert.equal(await savedSecretInput.evaluate((node) => node.tagName), "SELECT");
  assert.equal(await savedSecretInput.inputValue(), secret.id);
  const deniedBinding = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${created.data.id}` &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  assert.equal((await deniedBinding).status(), 403);
  await page.getByText(/Access denied|not authorized|permission/i).waitFor();
  assert.deepEqual(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${created.data.id}`)).data
      .harnessAuth,
    created.data.harnessAuth,
  );

  fixture.policy.restrictions.push({
    id: "deny-agent-create",
    namespaceId: namespace.id,
    resourceKind: "agent",
    action: "create",
    effect: "deny",
  });
  requests.length = 0;
  await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText(/Repository choices are denied/).waitFor();
  await enterManualModel(page, "denied-agent-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Denied Agent");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  assert.match(page.url(), new RegExp(`/console/agents/new\\?namespace=${namespace.id}$`));
});

test("Agent repository access labels target the right repository when references overlap", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) =>
    ["app", "inherit-app"].map((repositoryRef, index) => ({
      repositoryRef,
      repositoryId: String(1700 + index),
      repository: `example/${repositoryRef}`,
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    })),
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await repositoryCheckbox(page, "example/app").click();
  await page.getByRole("button", { name: "Access for example/app", exact: true }).click();
  const settings = page.getByRole("group", { name: "Access for example/app", exact: true });
  assert.equal(await settings.locator('input[type="checkbox"]').isChecked(), true);
  // The label must change this repository, not add another whose reference shares its ID.
  await settings.getByText("Use Agent default", { exact: true }).click();
  assert.equal(await settings.locator('input[type="checkbox"]').first().isChecked(), false);
  assert.equal(await repositoryCheckbox(page, "example/inherit-app").isEnabled(), true);
  await page.locator("#repository-default-git-read").check();
  await page.getByText("Contributor · Custom", { exact: true }).waitFor();
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Repository label Agent");
  const createResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await (await createResponse).json();
  assert.deepEqual(created.data.repositoryAccess, {
    defaultProfile: "git-read",
    repositories: [{ repositoryRef: "app", profile: "git-full" }],
  });
});

test("Agent repository access preserves inheritance, custom overrides, and explicit repair through create and edit", async (t) => {
  const { fixture, namespace, replacePolicy } = await createRepositoryLaunchFixture(
    t,
    (namespaceId) => [
      {
        repositoryRef: "application",
        repositoryId: "789",
        repository: "example/application",
        namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
      },
      {
        repositoryRef: "documentation",
        repositoryId: "790",
        repository: "example/documentation",
        namespaces: [{ namespaceId, profiles: ["git-read", "git-write"] }],
      },
      {
        repositoryRef: "release",
        repositoryId: "791",
        repository: "example/release",
        namespaces: [{ namespaceId, profiles: ["git-full"] }],
      },
    ],
    { reloadablePolicy: true },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("Select repositories for this Agent.", { exact: false }).waitFor();
  const accessDetails = page.locator(".repository-access-details");
  const accessSummary = accessDetails.locator("summary");
  const apiScope = accessDetails.getByText(/GraphQL can also return public information/);
  assert.equal(await apiScope.isVisible(), false);
  await accessSummary.focus();
  await accessSummary.press("Enter");
  assert.equal(await apiScope.isVisible(), true);
  await accessSummary.press("Enter");
  assert.equal(await apiScope.isVisible(), false);
  const defaultAccess = page.locator(".repository-profile-group");
  const writeAccess = defaultAccess.locator(".repository-write-access");
  assert.equal(await writeAccess.isVisible(), false);
  await defaultAccess.getByText("Customize access", { exact: true }).click();
  assert.equal(await writeAccess.isVisible(), true);
  assert.match(await writeAccess.innerText(), /can permit merges and branch changes/);
  assert.match(await writeAccess.innerText(), /best effort and does not restrict GraphQL/);
  assert.match(await writeAccess.innerText(), /administration and workflow permissions/);
  await defaultAccess.getByText("Customize access", { exact: true }).click();
  assert.equal(await page.getByLabel("Find a repository").count(), 0);
  await repositoryCheckbox(page, "example/application").focus();
  await page.keyboard.press("Space");
  assert.equal(
    await repositoryCheckbox(page, "example/application").evaluate(
      (node) => node === node.ownerDocument.activeElement,
    ),
    true,
  );
  await page.getByText("Contributor · Agent default", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Access for example/application" }).click();
  await page.locator("#repository-inherit-application").uncheck();
  await page.locator("#repository-default-git-read").check();
  await page.getByText(/1 custom repository keeps broader access/).waitFor();
  await page.getByText("Contributor · Custom", { exact: true }).waitFor();
  await repositoryCheckbox(page, "example/documentation").click();
  await page.getByText("Read-only · Agent default", { exact: true }).waitFor();
  await page.locator("#repository-default-git-full").check();
  await page.getByText("Choose approved access", { exact: true }).waitFor();
  assert.equal(await page.locator("#repository-inherit-documentation").isVisible(), true);
  // Navigation and failed rediscovery must retain both the default and the explicit override.
  const optionsUrl = `**/namespaces/${namespace.id}/agents/repository-options`;
  for (const status of [503, 500]) {
    await page.route(optionsUrl, (route) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: status === 503 ? "REPOSITORY_OPTIONS_UNAVAILABLE" : "INTERNAL_ERROR",
            message: "Repository discovery is temporarily unavailable.",
          },
        }),
      }),
    );
    for (let navigation = 0; navigation < 2; navigation += 1) {
      await page.getByRole("link", { name: "← Agents" }).click();
      await page.getByRole("button", { name: "Create Agent", exact: true }).click();
      await page
        .getByRole("button", { name: "Retry repository choices" })
        .and(page.locator(":enabled"))
        .waitFor();
      assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
    }
    await page.unroute(optionsUrl);
    await page.getByRole("button", { name: "Retry repository choices" }).click();
    assert.equal(await repositoryCheckbox(page, "example/application").isChecked(), true);
    assert.equal(await repositoryCheckbox(page, "example/documentation").isChecked(), true);
    assert.equal(await page.locator("#repository-default-git-full").isChecked(), true);
    await page.getByText("Choose approved access", { exact: true }).waitFor();
  }
  await page.getByText("Contributor · Custom", { exact: true }).waitFor();
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Repository Agent");
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Choose approved access for each selected repository." })
    .waitFor();
  assert.equal(nonAuthWriteRequests(requests).length, 0);
  await page.locator("#repository-inherit-documentation").uncheck();
  await page.locator("#repository-override-documentation-git-read").check();
  await page.locator("#repository-default-git-read").check();
  // A checkbox round trip restores the original position and explicit access.
  const applicationChoice = repositoryCheckbox(page, "example/application");
  await applicationChoice.focus();
  await applicationChoice.press("Space");
  assert.equal(await applicationChoice.isChecked(), false);
  assert.equal(
    await applicationChoice.evaluate((node) => node === node.ownerDocument.activeElement),
    true,
  );
  await applicationChoice.press("Space");
  assert.equal(await applicationChoice.isChecked(), true);
  await page.getByText("Contributor · Custom", { exact: true }).waitFor();
  assert.deepEqual(
    await page.locator(".repository-card .repository-identity strong").allTextContents(),
    ["example/application", "example/documentation"],
  );
  await page.getByRole("button", { name: "Access for example/documentation" }).click();
  await page.getByRole("button", { name: "Remove example/documentation" }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByText("Read-only · Custom", { exact: true }).waitFor();
  const createResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await (await createResponse).json();
  assert.deepEqual(created.data.repositoryAccess, {
    defaultProfile: "git-read",
    repositories: [
      { repositoryRef: "application", profile: "git-full" },
      { repositoryRef: "documentation", profile: "git-read" },
    ],
  });
  assert.deepEqual(created.data.repositoryBindings, [
    { repositoryRef: "application", profile: "git-full" },
    { repositoryRef: "documentation", profile: "git-read" },
  ]);
  await page.getByRole("button", { name: "Repositories", exact: true }).click();
  await page.getByText("Contributor · Custom", { exact: true }).waitFor();
  // Reversing an edit restores the saved intent, including explicit overrides.
  await page.getByRole("button", { name: "Remove example/documentation" }).click();
  assert.equal(
    await page.getByRole("button", { name: "Save repository access" }).isEnabled(),
    true,
  );
  await page
    .getByText("Save or cancel repository access edits before deploying.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Save repository access" }).isDisabled(),
    true,
  );
  assert.equal(await page.getByRole("button", { name: "Channels", exact: true }).isEnabled(), true);
  await page.locator("#repository-default-git-full").check();
  await page.locator("#repository-default-git-read").check();
  assert.equal(
    await page.getByRole("button", { name: "Save repository access" }).isDisabled(),
    true,
  );
  await page.getByText("Read-only · Custom", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Access for example/application" }).click();
  await page.locator("#repository-inherit-application").check();
  assert.equal(
    await page.getByRole("button", { name: "Channels", exact: true }).isDisabled(),
    true,
  );
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/agents/${created.data.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save repository access" }).click();
  const saved = await (await savedResponse).json();
  assert.deepEqual(saved.data.repositoryAccess, {
    defaultProfile: "git-read",
    repositories: [
      { repositoryRef: "application" },
      { repositoryRef: "documentation", profile: "git-read" },
    ],
  });
  await page.getByText("Read-only · Agent default", { exact: true }).waitFor();
  await page.locator("#repository-default-git-full").check();
  await page.getByText("Contributor · Agent default", { exact: true }).waitFor();
  await page.getByText("Read-only · Custom", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText("Read-only · Agent default", { exact: true }).waitFor();
  replacePolicy([
    {
      repositoryRef: "application",
      repositoryId: "789",
      repository: "example/application",
      namespaces: [{ namespaceId: namespace.id, profiles: ["git-read", "git-write", "git-full"] }],
    },
    {
      repositoryRef: "documentation",
      repositoryId: "790",
      repository: "example/documentation",
      namespaces: [{ namespaceId: namespace.id, profiles: ["git-write"] }],
    },
  ]);
  await page.reload();
  await page.getByText("Choose approved access", { exact: true }).waitFor();
  assert.equal(await page.locator("#repository-inherit-documentation").isVisible(), true);
  await page.locator("#repository-override-documentation-git-full").check();
  const issues = page.locator("#repository-access-documentation .repository-customize summary");
  await issues.click();
  assert.equal(await page.locator("#repository-override-documentation-issues").isDisabled(), true);
  assert.equal(await page.locator("#repository-override-documentation-issues").isChecked(), false);
  const repairedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/agents/${created.data.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save repository access" }).click();
  assert.equal((await repairedResponse).status(), 200);
  const legacy = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "Legacy explicit repository access",
      configurationId: created.data.configurationId,
      repositoryBindings: [{ repositoryRef: "application", profile: "git-read" }],
    },
  });
  assert.equal(legacy.status, 201);
  await page.goto(
    `${fixture.origin}/console/agents/${legacy.data.id}?namespace=${namespace.id}&revision=draft&tab=repositories`,
  );
  await page.getByText("Read-only · Custom", { exact: true }).waitFor();
  const optionsPath = `**/namespaces/${namespace.id}/agents/${legacy.data.id}/repository-options`;
  await page.route(optionsPath, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "REPOSITORY_OPTIONS_UNAVAILABLE", message: "Discovery unavailable" },
      }),
    }),
  );
  await page.reload();
  await page.getByText(/Retry repository choices before saving repository access/).waitFor();
  await page.getByText("Access awaiting verification", { exact: true }).waitFor();
  assert.equal(await page.getByText(/This repository is no longer available/).count(), 0);
  assert.equal(
    await page
      .getByText("Repository availability cannot be verified. Retry repository choices.")
      .count(),
    1,
  );
  assert.equal(await page.getByText(/You can save a draft without repository access/).count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Save repository access" }).isDisabled(),
    true,
  );
  await page.unroute(optionsPath);
  replacePolicy([
    {
      repositoryRef: "documentation",
      repositoryId: "790",
      repository: "example/documentation",
      namespaces: [{ namespaceId: namespace.id, profiles: ["git-write"] }],
    },
  ]);
  await page.getByRole("button", { name: "Retry repository choices" }).click();
  await page
    .getByText("This repository is no longer available. Remove it or retry discovery.")
    .waitFor();
});

test("Preset repository access and plugin policies remain independent during Agent creation", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "project",
      repositoryId: "789",
      repository: "example/project",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-full"] }],
    },
  ]);
  const pluginDriver = new OCCPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const root = await mkdtemp(join(tmpdir(), "occ-repository-plugin-preset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const secret = await fixture.createSecret(namespace.id, "Model key", "preset-plugin-model-key");
  const pluginId = "occ-plugin:diffs";
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Repository and plugin",
      template: {
        agent: {
          name: "Repository and plugin Agent",
          executionMode: "embedded",
          harnessAuth: { method: "api_key", source: secret.ref },
          repositoryAccess: {
            defaultProfile: "git-read",
            repositories: [{ repositoryRef: "project" }],
          },
          plugins: { [pluginId]: { enabled: false } },
        },
        configuration: { values: nativeValues("repository-plugin") },
      },
    },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page.getByText("Read-only · Agent default", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await dialog.getByRole("button", { name: pluginId, exact: true }).click();
  await dialog.getByLabel(`Enable ${pluginId}`, { exact: true }).check();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.locator("#repository-default-git-full").check();
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), {
    [pluginId]: { enabled: true },
  });

  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  const created = (await response.json()).data;
  assert.deepEqual(created.plugins, { [pluginId]: { enabled: true } });
  assert.deepEqual(created.repositoryAccess, {
    defaultProfile: "git-full",
    repositories: [{ repositoryRef: "project" }],
  });
  assert.deepEqual(created.repositoryBindings, [{ repositoryRef: "project", profile: "git-full" }]);
});

test("Repository recovery preserves and updates hosted plugin policy before retry", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "project",
      repositoryId: "790",
      repository: "example/project",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-full"] }],
    },
  ]);
  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const root = await mkdtemp(join(tmpdir(), "occ-repository-plugin-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const secret = await fixture.createSecret(namespace.id, "Model key", "preset-plugin-model-key");
  const pluginId = "codex-plugin:knowledge@openai-curated-remote";
  const initialPlugins = { [pluginId]: { enabled: true, toolDefaults: { approval: "native" } } };
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Repository and hosted plugin recovery",
      template: {
        agent: {
          name: "Recovered repository and plugin Agent",
          executionMode: "embedded",
          harnessAuth: { method: "api_key", source: secret.ref },
          repositoryAccess: {
            defaultProfile: "git-read",
            repositories: [{ repositoryRef: "project" }],
          },
          plugins: initialPlugins,
        },
        configuration: { values: nativeValues("repository-plugin-recovery") },
      },
    },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page.getByText("Read-only · Agent default", { exact: true }).waitFor();
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), initialPlugins);

  fixture.policy.restrictions.push({
    id: "deny-repository-plugin-create",
    namespaceId: namespace.id,
    resourceKind: "agent",
    action: "create",
    effect: "deny",
  });
  const savedConfigurationResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/configurations` &&
      response.request().method() === "POST",
  );
  const rejectedResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const savedConfiguration = (await (await savedConfigurationResponse).json()).data;
  assert.equal((await rejectedResponse).status(), 403);
  await page.getByRole("heading", { name: "Recover from a rejected Agent save" }).waitFor();
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), initialPlugins);
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /could not be reloaded because Agent creation is denied/ })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);

  fixture.policy.restrictions.pop();
  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page.getByText(/Repository choices reloaded/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await dialog.getByRole("button", { name: pluginId, exact: true }).click();
  await dialog.getByLabel(`${pluginId} default approval`, { exact: true }).selectOption("approve");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  const updatedPlugins = { [pluginId]: { enabled: true, toolDefaults: { approval: "approve" } } };
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), updatedPlugins);
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);

  await repositoryCheckbox(page, "example/project").click();
  await page.locator("#repository-default-git-full").check();
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  const created = (await response.json()).data;
  assert.deepEqual(created.plugins, updatedPlugins);
  assert.deepEqual(created.repositoryAccess, {
    defaultProfile: "git-full",
    repositories: [{ repositoryRef: "project" }],
  });
  assert.deepEqual(created.repositoryBindings, [{ repositoryRef: "project", profile: "git-full" }]);
  assert.equal(created.configurationId, savedConfiguration.id);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 0);
  const agentRequests = agentPostRequests(requests, namespace.id);
  assert.equal(agentRequests.length, 2);
  assert.deepEqual(agentRequests[0].body.plugins, initialPlugins);
  assert.deepEqual(agentRequests[1].body.plugins, updatedPlugins);
  assert.deepEqual(agentRequests[1].body.repositoryAccess, created.repositoryAccess);
  assert.equal(agentRequests[1].body.configurationId, savedConfiguration.id);
});

test("Agent deployment requires a reload after repository access changes", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "1600",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  const agent = await fixture.createAgent(
    namespace.id,
    "Repository deploy review",
    nativeValues("repository-deploy-review"),
    { harnessAuth: { method: "runtime" } },
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const initial = await fixture.request("PATCH", path, {
    body: {
      configurationId: agent.configurationId,
      repositoryBindings: [{ repositoryRef: "application", profile: "git-read" }],
    },
  });
  assert.equal(initial.status, 200);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft`,
  );
  const deploy = page.getByRole("button", { name: "Deploy new revision" });
  await page.getByText("application · Read-only", { exact: true }).waitFor();
  assert.equal(await deploy.isEnabled(), true);

  // A second operator changes effective access after this draft was loaded.
  const bindingChange = await fixture.request("PATCH", path, {
    body: {
      configurationId: agent.configurationId,
      repositoryBindings: [{ repositoryRef: "application", profile: "git-full" }],
    },
  });
  assert.equal(bindingChange.status, 200);
  const staleMessage = "Repository access changed. Reload this draft before deploying.";
  const staleOutcome = Promise.race([
    page
      .getByText(staleMessage, { exact: true })
      .waitFor()
      .then(() => "blocked"),
    page
      .waitForRequest(
        (request) => request.method() === "POST" && request.url().endsWith(`${path}/deploy`),
      )
      .then(() => "deployed"),
  ]);
  await deploy.click();
  assert.equal(await staleOutcome, "blocked", "stale access must not be deployed");
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);

  await page.reload();
  await page.getByText("application · Contributor", { exact: true }).waitFor();
  assert.equal(await deploy.isEnabled(), true);
  // Intent can change even when the resolved permissions stay the same.
  const intentChange = await fixture.request("PATCH", path, {
    body: {
      configurationId: agent.configurationId,
      repositoryAccess: {
        defaultProfile: "git-full",
        repositories: [{ repositoryRef: "application" }],
      },
    },
  });
  assert.equal(intentChange.status, 200);
  assert.deepEqual(intentChange.data.repositoryBindings, bindingChange.data.repositoryBindings);
  await deploy.click();
  await page.getByText(staleMessage, { exact: true }).waitFor();
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);

  await page.reload();
  await page.getByText("application · Contributor", { exact: true }).waitFor();
  assert.equal(await deploy.isEnabled(), true);
});

test("Agent deployment reports preflight errors and requires reload for changed draft state", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Deployment preflight");
  const agent = await fixture.createAgent(
    namespace.id,
    "Deployment preflight",
    nativeValues("before-preflight"),
    { harnessAuth: { method: "runtime" } },
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft`,
  );
  const deploy = page.getByRole("button", { name: "Deploy new revision" });
  await page.getByText("Configured on the runtime host", { exact: false }).waitFor();
  await page.route(`${fixture.origin}${path}`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "Read unavailable" },
      }),
    }),
  );
  await deploy.click();
  await page
    .getByText("Service unavailable. The read could not be completed. Please retry.")
    .waitFor();
  assert.equal(await deploy.isEnabled(), true);
  assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);
  await page.unroute(`${fixture.origin}${path}`);

  // Changes to Configuration and authentication each require a fresh review.
  await fixture.updateConfiguration(namespace.id, agent.configurationId, nativeValues("changed"));
  await deploy.click();
  const stale = "Configuration or authentication changed. Reload this draft before deploying.";
  await page.getByText(stale, { exact: true }).waitFor();
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);
  await page.reload();
  await page.getByText(/generation 2/).waitFor();
  assert.equal(await deploy.isEnabled(), true);
  const authChange = await fixture.request("PATCH", path, {
    body: { configurationId: agent.configurationId, harnessAuth: null },
  });
  assert.equal(authChange.status, 200);
  await deploy.click();
  await page.getByText(stale, { exact: true }).waitFor();
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);
});

for (const [field, change] of [
  ["execution mode", { executionMode: "dedicated" }],
  ["Backend", { backendId: backendFixtures[0].id }],
  [
    "plugin policy",
    {
      plugins: {
        "codex-plugin:linear@openai-curated-remote": {
          enabled: true,
          toolDefaults: { approval: "approve" },
        },
      },
    },
  ],
]) {
  test(`Agent deployment requires a reload after ${field} changes`, async (t) => {
    const { fixture, namespace } = await createRuntimeAuthFixture(t, `Deployment ${field}`);
    const pluginDriver = new CodexPluginDriver();
    fixture.controller.registerDriver(pluginDriver);
    fixture.controller.selectDriver("plugin", pluginDriver.id);
    const agent = await fixture.createAgent(
      namespace.id,
      `Deployment ${field}`,
      nativeValues("deployment-settings"),
      { harnessAuth: { method: "runtime" } },
    );
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const { page } = await newPage(t, fixture);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft`,
    );
    const deploy = page.getByRole("button", { name: "Deploy new revision" });
    await page.getByText("Configured on the runtime host", { exact: false }).waitFor();
    assert.equal(await deploy.isEnabled(), true);

    // A second operator changes the desired Agent state without editing its Configuration.
    const updated = await fixture.request("PATCH", path, {
      body: { configurationId: agent.configurationId, ...change },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const result = Promise.race([
      page
        .getByText("Agent settings changed. Reload this draft before deploying.", { exact: true })
        .waitFor()
        .then(() => "blocked"),
      page
        .waitForRequest(
          (request) => request.method() === "POST" && request.url().endsWith(`${path}/deploy`),
        )
        .then(() => "submitted"),
    ]);
    // Stop an unguarded candidate from creating a revision during the regression check.
    await page.route(`${fixture.origin}${path}/deploy`, (route) => route.abort());
    await deploy.click();
    assert.equal(await result, "blocked", `stale ${field} must not be submitted`);
    assert.equal(await deploy.isDisabled(), true);
    await page.reload();
    await page.getByText("Configured on the runtime host", { exact: false }).waitFor();
    assert.equal(await deploy.isEnabled(), true);
  });
}

for (const tab of ["configuration", "repositories"]) {
  test(`Agent deployment keeps ${tab} edits unavailable until the request finishes`, async (t) => {
    const { fixture, namespace, modelSecret, grantModelAccess } =
      await createConsoleRepositoryLaunchFixture(t);
    const configuration = await fixture.createConfiguration(
      namespace.id,
      createHarnessConfiguration("codex", "gpt-5.1"),
    );
    const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: `Deploying from ${tab}`,
        configurationId: configuration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "api_key", source: modelSecret.ref },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const agent = created.data;
    await grantModelAccess(agent);
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const provisioned = await fixture.request("POST", `${path}/runtime-credentials`, {
      headers: { origin: fixture.origin },
      body: {},
    });
    assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
    const { page } = await newPage(t, fixture);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=${tab}`,
    );
    const edit =
      tab === "configuration"
        ? page.getByRole("button", { name: "Edit Configuration", exact: true })
        : repositoryCheckbox(page, "example/application");
    await edit.waitFor();
    const deploy = page.getByRole("button", { name: "Deploy new revision" });
    assert.equal(await deploy.isEnabled(), true);
    const preflightStarted = Promise.withResolvers();
    const releasePreflight = Promise.withResolvers();
    const deployCommitted = Promise.withResolvers();
    const releaseResponse = Promise.withResolvers();
    t.after(() => releasePreflight.resolve());
    t.after(() => releaseResponse.resolve());
    await page.route(`${fixture.origin}${path}`, async (route) => {
      if (route.request().method() === "GET") {
        preflightStarted.resolve();
        await releasePreflight.promise;
      }
      await route.continue();
    });
    await page.route(`${fixture.origin}${path}/deploy`, async (route) => {
      const response = await route.fetch();
      deployCommitted.resolve({ status: response.status(), body: await response.json() });
      await releaseResponse.promise;
      await route.fulfill({ response });
    });
    const admitted = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}${path}/deploy` &&
        response.request().method() === "POST",
    );
    await deploy.click();
    await preflightStarted.promise;
    // Edits made during an admitted deployment would otherwise block its revision navigation.
    await assert.rejects(edit.click({ timeout: 500 }), /Timeout/);
    releasePreflight.resolve();
    const committed = await deployCommitted.promise;
    assert.equal(committed.status, 202, JSON.stringify(committed.body));
    await assert.rejects(edit.click({ timeout: 500 }), /Timeout/);
    releaseResponse.resolve();
    assert.equal((await admitted).status(), 202);
    await page.waitForURL(/revision=rev_/);
  });
}

for (const mutation of ["authentication", "generated credentials", "channel Secrets"]) {
  test(`Agent deployment waits for ${mutation} writes and their recovery`, async (t) => {
    const { fixture, namespace, modelSecret, grantModelAccess } =
      await createConsoleRepositoryLaunchFixture(
        t,
        mutation === "channel Secrets" ? { secretDriver: createTestSecretDriver() } : {},
      );
    const values = createHarnessConfiguration("codex", "gpt-5.1");
    let appSecret;
    let botSecret;
    let replacementSecret;
    let secretBindings;
    if (mutation === "channel Secrets") {
      appSecret = await fixture.createSecret(namespace.id, "Slack app", "xapp-original");
      botSecret = await fixture.createSecret(namespace.id, "Slack bot", "xoxb-original");
      replacementSecret = await fixture.createSecret(
        namespace.id,
        "Slack app replacement",
        "xapp-replacement",
      );
      values.channels = {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          allowFrom: ["U123"],
          channels: { C123: { requireMention: true } },
        },
      };
      secretBindings = {
        SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
      };
    }
    const configuration = await fixture.createConfiguration(namespace.id, values, {
      secretBindings,
    });
    const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: `Credential race ${mutation}`,
        configurationId: configuration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "api_key", source: modelSecret.ref },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const agent = created.data;
    await grantModelAccess(agent);
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const provisioned = await fixture.request("POST", `${path}/runtime-credentials`, {
      headers: { origin: fixture.origin },
      body: {},
    });
    assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
    if (mutation === "channel Secrets") {
      const role = await fixture.request("POST", `/namespaces/${namespace.id}/iam/roles`, {
        body: {
          name: "Channel access",
          permissions: [{ action: "operate", resourceKind: "secret" }],
        },
      });
      assert.equal(role.status, 201, JSON.stringify(role.body));
      for (const secret of [appSecret, botSecret]) {
        const binding = await fixture.request(
          "POST",
          `/namespaces/${namespace.id}/iam/access-bindings`,
          {
            body: {
              subjectKind: "identity",
              subjectId: agent.servicePrincipalId,
              roleId: role.data.id,
              resourceKind: "secret",
              resourceId: secret.id,
            },
          },
        );
        assert.equal(binding.status, 201, JSON.stringify(binding.body));
      }
      await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    }
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
    );
    await page
      .getByText(
        "Stored credential metadata is present. This does not confirm live channel readiness.",
      )
      .waitFor();
    const deploy = page.getByRole("button", { name: "Deploy new revision" });
    assert.equal(await deploy.isEnabled(), true);
    if (mutation === "authentication") {
      fixture.policy.restrictions.push({
        id: "deny-authentication-save",
        namespaceId: namespace.id,
        resourceKind: "agent",
        resourceId: agent.id,
        action: "update",
        effect: "deny",
      });
      await page.getByRole("button", { name: "Save authentication source" }).click();
      await page
        .getByText("Access denied. You do not have permission for this operation.")
        .waitFor();
      assert.equal(await deploy.isEnabled(), true);
      fixture.policy.restrictions.pop();
    }
    const mutationPath =
      mutation === "authentication"
        ? path
        : mutation === "generated credentials"
          ? `${path}/runtime-credentials`
          : `/namespaces/${namespace.id}/configurations/${configuration.id}`;
    const method = mutation === "generated credentials" ? "POST" : "PATCH";
    const committed = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route(`${fixture.origin}${mutationPath}`, async (route) => {
      if (route.request().method() !== method) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      committed.resolve({ status: response.status(), body: await response.json() });
      await release.promise;
      await route.abort("failed");
    });
    if (mutation === "authentication") {
      await page.getByRole("button", { name: "Save authentication source" }).click();
    } else if (mutation === "generated credentials") {
      await page.getByRole("button", { name: "Provision generated runtime credentials" }).click();
    } else {
      await page.getByLabel("Slack app token").selectOption(replacementSecret.id);
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
    }
    const result = await committed.promise;
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(
      await deploy.isDisabled(),
      true,
      "an in-flight credential write must block deployment",
    );
    if (mutation === "authentication") {
      assert.equal(
        await page.getByRole("button", { name: "Configuration", exact: true }).isDisabled(),
        true,
      );
      assert.equal(await page.locator(".runtime-credentials").evaluate((node) => node.inert), true);
    } else {
      assert.equal(
        await page
          .getByRole("button", { name: "Save authentication source" })
          .evaluate((node) => Boolean(node.closest("[inert]"))),
        true,
      );
      for (const label of ["Configuration", "Repositories", "Channels", "Workspace files"]) {
        assert.equal(
          await page.getByRole("button", { name: label, exact: true }).isDisabled(),
          true,
          `${label} must not be available while credentials are saving`,
        );
      }
      if (mutation === "channel Secrets") {
        assert.equal(await page.locator("#revision-selector").isDisabled(), true);
      }
    }
    assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);
    release.resolve();
    await page
      .getByText(/Outcome unknown/)
      .first()
      .waitFor();
    const credentialsPanel = page.locator(".runtime-credentials");
    const uncertaintyExplanation =
      "Credential changes may have been saved. Reload this draft and inspect the saved state before deploying.";
    if (mutation !== "authentication") {
      assert.equal(
        await credentialsPanel
          .getByText("Outcome unknown. Credential storage could not be confirmed.", {
            exact: false,
          })
          .count(),
        1,
      );
      assert.equal(
        await credentialsPanel.getByText(uncertaintyExplanation, { exact: true }).count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Save authentication source" })
          .evaluate((node) => node.ownerDocument.defaultView.getComputedStyle(node).opacity),
        "0.55",
      );
    }
    assert.equal(
      await deploy.isDisabled(),
      true,
      "an unconfirmed credential write must block deployment",
    );
    await page.unroute(`${fixture.origin}${mutationPath}`);
    if (mutation !== "authentication") {
      await page.getByRole("button", { name: "Refresh status" }).click();
      assert.equal(await deploy.isDisabled(), true);
      await credentialsPanel.getByText(uncertaintyExplanation, { exact: true }).waitFor();
    }
    if (mutation === "channel Secrets") {
      assert.equal(await page.locator("#revision-selector").isEnabled(), true);
    }
    await page.getByRole("button", { name: "Configuration", exact: true }).click();
    await page.getByRole("button", { name: "Credentials", exact: true }).click();
    assert.equal(await deploy.isDisabled(), true);
    if (mutation === "authentication") {
      await page.getByRole("button", { name: "Reload authentication source" }).click();
      await page
        .getByText("Outcome unknown. Reload authentication source before saving again.")
        .waitFor({ state: "hidden" });
    } else {
      await page.getByRole("button", { name: "Reload draft", exact: true }).click();
    }
    await page
      .getByRole("button", { name: "Reload draft", exact: true })
      .waitFor({ state: "hidden" });
    await page
      .getByText(
        "Stored credential metadata is present. This does not confirm live channel readiness.",
      )
      .waitFor();
    await page.waitForFunction(() =>
      [...globalThis.document.querySelectorAll("button")].some(
        (button) => button.textContent === "Deploy new revision" && !button.disabled,
      ),
    );
    assert.equal(await deploy.isEnabled(), true);
    assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);
    if (mutation === "channel Secrets") {
      const configurationPath = `/namespaces/${namespace.id}/configurations/${configuration.id}`;
      const previousConfigurationWrites = pathRequests(requests, "PATCH", configurationPath).length;
      await page.route(`${fixture.origin}${configurationPath}`, (route) =>
        route.request().method() === "PATCH"
          ? route.fulfill({
              status: 403,
              contentType: "application/json",
              body: JSON.stringify({
                error: { code: "FORBIDDEN", message: "denied" },
                meta: { requestId: "req_00000000-0000-4000-8000-000000000433" },
              }),
            })
          : route.continue(),
      );
      await page.getByLabel("Slack app token").selectOption(appSecret.id);
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
      const denial = credentialsPanel.getByText(
        "Access denied. You do not have permission for this credential operation. Request ID: req_00000000-0000-4000-8000-000000000433",
        { exact: true },
      );
      await denial.first().waitFor();
      assert.equal(await denial.count(), 1);
      assert.equal(
        pathRequests(requests, "PATCH", configurationPath).length,
        previousConfigurationWrites + 1,
      );
      assert.equal(await deploy.isEnabled(), true);
      await page.getByRole("button", { name: "Refresh status" }).click();
      await denial.waitFor({ state: "hidden" });
      assert.equal(await deploy.isEnabled(), true);
    }
  });
}

for (const changed of ["generation", "identity"]) {
  test(`Channel Secret save rejects a stale Configuration ${changed} before writing`, async (t) => {
    const { fixture, namespace, modelSecret, grantModelAccess } =
      await createConsoleRepositoryLaunchFixture(t, { secretDriver: createTestSecretDriver() });
    const appSecret = await fixture.createSecret(namespace.id, "Slack app", "xapp-original");
    const botSecret = await fixture.createSecret(namespace.id, "Slack bot", "xoxb-original");
    const replacementSecret = await fixture.createSecret(
      namespace.id,
      "Slack app replacement",
      "xapp-replacement",
    );
    const values = createHarnessConfiguration("codex", "gpt-5.1");
    values.channels = {
      slack: { enabled: true, mode: "socket", channels: { COLD: { requireMention: true } } },
    };
    const configuration = await fixture.createConfiguration(namespace.id, values, {
      secretBindings: {
        SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
      },
    });
    const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "Stale channel Secret",
        configurationId: configuration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "api_key", source: modelSecret.ref },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const agent = created.data;
    await grantModelAccess(agent);
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    assert.equal(
      (
        await fixture.request("POST", `${path}/runtime-credentials`, {
          headers: { origin: fixture.origin },
          body: {},
        })
      ).status,
      200,
    );
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
    );
    await page.getByText("Stored credential metadata is present.", { exact: false }).waitFor();
    const deploy = page.getByRole("button", { name: "Deploy new revision" });
    assert.equal(await deploy.isEnabled(), true);
    await page.getByLabel("Slack app token").selectOption(replacementSecret.id);

    const configurationPath = `/namespaces/${namespace.id}/configurations/${configuration.id}`;
    const secretPath = `/namespaces/${namespace.id}/secrets/${appSecret.id}`;
    if (changed === "generation") {
      await page.route(`${fixture.origin}${configurationPath}`, (route) =>
        route.fulfill({ status: 503, body: "Unavailable" }),
      );
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
      await page
        .getByText(
          "Could not check the saved Configuration. Try again before saving channel Secrets.",
        )
        .first()
        .waitFor();
      assert.equal(pathRequests(requests, "PATCH", secretPath).length, 0);
      assert.equal(await page.getByLabel("Slack app token").inputValue(), appSecret.id);
      assert.equal(await deploy.isEnabled(), true);
      await page.unroute(`${fixture.origin}${configurationPath}`);
      await page.getByLabel("Slack app token").selectOption(replacementSecret.id);
    }

    // Another operator changes the shared Configuration after this page was opened.
    const newerValues = structuredClone(values);
    newerValues.channels.slack.channels = { CNEW: { requireMention: false } };
    if (changed === "generation") {
      const updated = await fixture.request("PATCH", configurationPath, {
        body: { values: newerValues },
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
    } else {
      const replacement = await fixture.createConfiguration(namespace.id, newerValues, {
        secretBindings: configuration.secretBindings,
      });
      const updated = await fixture.request("PATCH", path, {
        body: { configurationId: replacement.id },
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
    }
    await page.getByRole("button", { name: "Save channel Secrets" }).click();
    await page
      .getByText("Configuration changed. Reload this draft before saving channel Secrets.", {
        exact: true,
      })
      .waitFor();
    assert.equal(pathRequests(requests, "PATCH", secretPath).length, 0);
    assert.equal(pathRequests(requests, "PATCH", configurationPath).length, 0);
    assert.deepEqual(
      (await fixture.request("GET", configurationPath)).data.values,
      changed === "generation" ? newerValues : values,
    );
    assert.equal(await page.getByLabel("Slack app token").inputValue(), appSecret.id);
    assert.equal(accessBindingPostRequests(requests, namespace.id).length, 0);
    assert.equal(await deploy.isDisabled(), true);
    assert.equal(
      await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "Refresh status" }).click();
    assert.equal(await deploy.isDisabled(), true);
    await page.getByRole("button", { name: "Configuration", exact: true }).click();
    assert.equal(await deploy.isDisabled(), true);
    await page.getByRole("button", { name: "Credentials", exact: true }).click();
    await page.getByRole("button", { name: "Reload draft", exact: true }).click();
    await page.getByText("Stored credential metadata is present.", { exact: false }).waitFor();
    assert.equal(await deploy.isEnabled(), true);
  });
}

test("Agent repository editor distinguishes stale, rejected, and uncertain saves", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "1600",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  const agent = await fixture.createAgent(
    namespace.id,
    "Repository save lifecycle",
    nativeValues("repository-save"),
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const access = (defaultProfile) => ({
    defaultProfile,
    repositories: [{ repositoryRef: "application" }],
  });
  const initial = await fixture.request("PATCH", path, {
    body: { configurationId: agent.configurationId, repositoryAccess: access("git-full") },
  });
  assert.equal(initial.status, 200);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=repositories`,
  );
  await page.getByText("Contributor · Agent default", { exact: true }).waitFor();
  await page.locator("#repository-default-git-read").check();

  // A changed saved baseline must be detected before this browser sends a PATCH.
  const concurrent = await fixture.request("PATCH", path, {
    body: { configurationId: agent.configurationId, repositoryAccess: access("git-write") },
  });
  assert.equal(concurrent.status, 200);
  const save = page.getByRole("button", { name: "Save repository access" });
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await save.click();
  await page
    .getByText("Repository access changed while you were editing. Reload this draft before saving.")
    .waitFor();
  assert.equal(pathRequests(requests, "PATCH", path).length, 0);
  assert.equal(await save.isDisabled(), true);
  assert.equal(await cancel.isDisabled(), true);
  await page.getByRole("button", { name: "Reload draft", exact: true }).click();
  await page
    .getByText("Contributor · no issue management · Agent default", { exact: true })
    .waitFor();
  assert.equal(await save.isDisabled(), true);

  // A known denial preserves edits and allows correction; it is not an uncertain write.
  await page.locator(".repository-profile-group .repository-customize summary").click();
  await page.locator("#repository-default-issues").check();
  fixture.policy.restrictions.push({
    id: "deny-repository-update",
    namespaceId: namespace.id,
    resourceKind: "agent",
    action: "update",
    effect: "deny",
  });
  await save.click();
  await page
    .getByText("Access denied. You do not have permission for this operation.", { exact: true })
    .waitFor();
  assert.equal(await save.isEnabled(), true);
  assert.equal(await cancel.isEnabled(), true);
  assert.equal(await page.locator("#repository-default-issues").isChecked(), true);
  fixture.policy.restrictions.pop();

  // Commit through the real API, then lose its response. Hold completion long enough
  // to verify pending controls before proving that readback is required after loss.
  const committed = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  await page.route(`${fixture.origin}${path}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    committed.resolve(response.status());
    await release.promise;
    await route.abort("failed");
  });
  await save.click();
  assert.equal(await committed.promise, 200);
  assert.equal(await save.isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Remove example/application" }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "Channels", exact: true }).isDisabled(),
    true,
  );
  release.resolve();
  await page
    .getByText(
      "Outcome unknown. The result could not be confirmed. Refresh and inspect the saved state before trying again.",
    )
    .waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(await cancel.isDisabled(), true);
  const persisted = await fixture.request("GET", path);
  assert.deepEqual(persisted.data.repositoryAccess, access("git-full"));
  assert.equal(pathRequests(requests, "PATCH", path).length, 2);
  const reload = page.getByRole("button", { name: "Reload draft", exact: true });
  await reload.click();
  await reload.waitFor({ state: "hidden" });
  await page.getByText("Contributor · Agent default", { exact: true }).waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(await cancel.isEnabled(), true);
  assert.equal(await page.getByRole("button", { name: "Channels", exact: true }).isEnabled(), true);
  assert.equal(pathRequests(requests, "PATCH", path).length, 2);
});

test("Agent creation keeps loading and empty repository discovery safe for an ordinary Agent", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, () => [
    {
      repositoryRef: "other-team",
      repositoryId: "801",
      repository: "example/other-team",
      namespaces: [{ namespaceId: `ns_${randomUUID()}`, profiles: ["git-read", "git-write"] }],
    },
  ]);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  let releaseOptions;
  const optionsGate = new Promise((resolve) => {
    releaseOptions = resolve;
  });
  t.after(() => releaseOptions());
  await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, async (route) => {
    await optionsGate;
    await route.continue();
  });

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("Loading approved repositories…").waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  releaseOptions();
  await page.getByText(/No approved repositories are available/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isEnabled(), true);

  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Ordinary Agent");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const created = await (await createdResponse).json();
  assert.equal(Object.hasOwn(created.data, "repositoryBindings"), false);
  assert.equal(
    Object.hasOwn(agentPostRequests(requests, namespace.id).at(-1).body, "repositoryBindings"),
    false,
  );
});

test("Dedicated repository Agent keeps its bindings through Slack save and the deployment credential gate", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "807",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const modelSecret = await fixture.createSecret(
    namespace.id,
    "Dedicated model",
    "fixture-model-key",
  );
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Dedicated repository Agent");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  await repositoryCheckbox(page, "example/application").click();
  await page.locator("#repository-default-git-full").check();
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  const agent = (await response.json()).data;
  assert.equal(agent.executionMode, "dedicated");
  assert.deepEqual(agent.repositoryBindings, [
    { repositoryRef: "application", profile: "git-full" },
  ]);
  assert.equal(agent.harnessAuth.method, "api_key");
  assert.equal(agent.harnessAuth.source.namespaceId, namespace.id);
  assert.notEqual(agent.harnessAuth.source.id, modelSecret.id);
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Configure Slack", exact: true }).click();
  await page.getByLabel("Direct-message policy").selectOption("disabled");
  await page.getByLabel("Slack channel IDs").fill("CREPOSITORY123");
  await page.getByLabel("Allow everyone in these channels to mention the agent").check();
  const savedResponse = page.waitForResponse(
    (result) =>
      result.url().endsWith(`/configurations/${agent.configurationId}`) &&
      result.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  assert.equal((await savedResponse).status(), 200);
  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(saved.data.values.channels.slack.enabled, true);
  assert.deepEqual(saved.data.values.channels.slack.channels.CREPOSITORY123, {
    requireMention: true,
    users: ["*"],
  });
  assert.equal(Object.hasOwn(saved.data.values.channels.slack, "allowFrom"), false);
  assert.equal(saved.data.values.plugins.entries.codex.enabled, true);
  const sameAgent = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.deepEqual(sameAgent.data.repositoryBindings, agent.repositoryBindings);

  // This fixture has no Kubernetes API client: real credential discovery must block deployment.
  const credentialsResponse = page.waitForResponse((result) =>
    result.url().endsWith(`/agents/${agent.id}/runtime-credentials`),
  );
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  assert.equal((await credentialsResponse).status(), 503);
  await page
    .getByText("Credential metadata unavailable. Refresh status before deploying.")
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
  assert.equal(await page.getByLabel("Slack app token").isDisabled(), true);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`).length,
    0,
  );
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
});

test("Agent creation distinguishes unavailable repository choices from denied Agent creation", async (t) => {
  const unavailableFixture = await createConsoleAppFixture(t);
  await unavailableFixture.bootstrap();
  const unavailableNamespace = await unavailableFixture.createNamespace("No Repo Driver", {
    ready: true,
  });
  const { page: unavailablePage } = await newPage(t, unavailableFixture);
  await login(
    unavailablePage,
    unavailableFixture,
    `/console/agents/new?namespace=${unavailableNamespace.id}`,
  );
  const optionsResponse = unavailablePage.waitForResponse((response) =>
    response.url().endsWith("/agents/repository-options"),
  );
  await unavailablePage.getByRole("button", { name: "Start without Preset" }).click();
  const options = await optionsResponse;
  assert.equal(options.status(), 503);
  assert.equal((await options.json()).error.code, "REPOSITORY_OPTIONS_UNAVAILABLE");
  await unavailablePage.getByText(/Repository choices are unavailable/).waitFor();
  assert.match(
    await unavailablePage
      .getByRole("status")
      .filter({ hasText: "Repository choices are unavailable" })
      .innerText(),
    /You can save a draft without repositories/,
  );
  const setupGuide = unavailablePage.getByRole("link", { name: "Set up repository access" });
  assert.equal(
    await setupGuide.getAttribute("href"),
    "https://github.com/openclaw/openclaw-enterprise/blob/main/docs/guides/repository-credentials/team-runbook.md",
  );
  assert.equal(
    await unavailablePage.getByRole("button", { name: "Create Agent" }).isEnabled(),
    true,
  );
  const unavailableRequests = apiRequests(unavailablePage, unavailableFixture.origin);
  await enterManualModel(unavailablePage, "repository-fixture-model-key", "gpt-5.1");
  await unavailablePage.getByLabel("Agent name").fill("Authorized ordinary Agent");
  const ordinaryResponse = unavailablePage.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${unavailableNamespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await unavailablePage.getByRole("button", { name: "Create Agent" }).click();
  const ordinary = await ordinaryResponse;
  assert.equal(ordinary.status(), 201);
  assert.equal(Object.hasOwn((await ordinary.json()).data, "repositoryBindings"), false);
  assert.equal(configurationPostRequests(unavailableRequests, unavailableNamespace.id).length, 1);

  const { fixture: deniedFixture, namespace: deniedNamespace } =
    await createRepositoryLaunchFixture(t, (namespaceId) => [
      {
        repositoryRef: "application",
        repositoryId: "802",
        repository: "example/application",
        namespaces: [{ namespaceId, profiles: ["git-read"] }],
      },
    ]);
  deniedFixture.policy.restrictions.push({
    id: "deny-repository-discovery",
    namespaceId: deniedNamespace.id,
    resourceKind: "agent",
    action: "create",
    effect: "deny",
  });
  const { page: deniedPage } = await newPage(t, deniedFixture);
  const deniedRequests = apiRequests(deniedPage, deniedFixture.origin);
  await login(deniedPage, deniedFixture, `/console/agents/new?namespace=${deniedNamespace.id}`);
  await deniedPage.getByRole("button", { name: "Start without Preset" }).click();
  await deniedPage.getByText(/Repository choices are denied/).waitFor();
  assert.equal(await deniedPage.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await deniedPage.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  assert.equal(configurationPostRequests(deniedRequests, deniedNamespace.id).length, 0);
  assert.equal(agentPostRequests(deniedRequests, deniedNamespace.id).length, 0);
});

test("Agent creation blocks a repository-options Namespace conflict before any write", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Conflicted repository options", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "RESOURCE_CONFLICT", message: "Namespace lifecycle conflict" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
      }),
    }),
  );

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("This Namespace no longer accepts new Agents.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
});

test("Agent creation blocks selective Agent-create IAM unavailability even when Configuration creation is allowed", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "808",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read"] }],
    },
  ]);
  const originalIAM = fixture.controller.selectedDriver("iam");
  const id = "selective-native-state-iam";
  const healthyIAM = new NativeIAMDriver(
    { loadNativeIAMState: async () => fixture.policy },
    { id },
  );
  const unavailableIAM = new NativeIAMDriver(
    {
      loadNativeIAMState: async () => {
        throw new Error("Native IAM state unavailable");
      },
    },
    { id },
  );
  // Fault only the state dependency for Agent-create authorization. Every actual decision and
  // identity lookup still runs Native IAM, so a healthy Configuration write is independently proved.
  fixture.controller.registerDriver({
    id,
    capability: "iam",
    implementation: "test-selective-native-state",
    lookupIdentity: (input) => healthyIAM.lookupIdentity(input),
    authorize: (request) =>
      request.action === "create" && request.resource.kind === "agent"
        ? unavailableIAM.authorize(request)
        : healthyIAM.authorize(request),
  });
  fixture.controller.selectDriver("iam", id);
  const allowed = await fixture.request("POST", `/namespaces/${namespace.id}/configurations`, {
    body: { kind: "agent", values: nativeValues("independent-configuration") },
  });
  assert.equal(allowed.status, 201);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  const optionsResponse = page.waitForResponse((response) =>
    response.url().endsWith("/agents/repository-options"),
  );
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const options = await optionsResponse;
  assert.equal(options.status(), 503);
  assert.equal((await options.json()).error.code, "DEPENDENCY_UNAVAILABLE");
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Authorization unavailable Agent");
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(100);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  fixture.controller.selectDriver("iam", originalIAM.id);
  await page.getByRole("button", { name: "Retry repository choices", exact: true }).click();
  await page.getByText("Select repositories for this Agent.", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isEnabled(), true);
});

for (const failure of [
  { name: "not found", status: 404, code: "NOT_FOUND" },
  { name: "rate limited", status: 429, code: "RATE_LIMITED" },
  { name: "internal error", status: 500, code: "INTERNAL_ERROR" },
  { name: "dependency unavailable", status: 503, code: "DEPENDENCY_UNAVAILABLE" },
  { name: "missing error code", status: 503 },
  { name: "unknown error code", status: 503, code: "UNKNOWN_FAILURE" },
  { name: "optional code with wrong status", status: 500, code: "REPOSITORY_OPTIONS_UNAVAILABLE" },
  { name: "malformed envelope", status: 200, body: {} },
  { name: "malformed options", status: 200, body: { data: {} } },
  { name: "unexpected success status", status: 201, body: { data: [] } },
  {
    name: "malformed option fields",
    status: 200,
    body: { data: [{ repositoryRef: "application" }] },
  },
  { name: "transport failure" },
]) {
  test(`Agent creation blocks ${failure.name} discovery and retries before any write`, async (t) => {
    const { fixture, namespace } = await createRepositoryLaunchFixture(t, () => [
      {
        repositoryRef: "other-team",
        repositoryId: "805",
        repository: "example/other-team",
        namespaces: [{ namespaceId: `ns_${randomUUID()}`, profiles: ["git-read"] }],
      },
    ]);
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    const path = `**/namespaces/${namespace.id}/agents/repository-options`;
    // These responses exercise the browser's HTTP boundary, not server authorization decisions.
    const failDiscovery = (route) =>
      failure.status === undefined
        ? route.abort("failed")
        : route.fulfill({
            status: failure.status,
            contentType: "application/json",
            body: JSON.stringify(
              failure.body ?? {
                error: { code: failure.code, message: "untrusted-server-detail" },
              },
            ),
          });
    await page.route(path, failDiscovery);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start without Preset" }).click();
    await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
    await page.getByLabel("Agent name").fill("Discovery retry Agent");
    await page.locator('.repository-options[aria-busy="false"]').waitFor({ state: "attached" });
    assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
    await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
    await page.waitForTimeout(100);
    assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
    assert.equal(agentPostRequests(requests, namespace.id).length, 0);
    assert.doesNotMatch(await page.locator("body").innerText(), /untrusted-server-detail/);

    await page.unroute(path, failDiscovery);
    await page.getByRole("button", { name: "Retry repository choices", exact: true }).click();
    await page.getByText(/No approved repositories are available/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Create Agent" }).isEnabled(), true);
    const createdResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create Agent" }).click();
    assert.equal((await createdResponse).status(), 201);
    assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
    assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  });
}

for (const count of [1, 5, 25, 140]) {
  test(`Agent repository discovery adapts to ${count} choices with bounded, keyboard-accessible results`, async (t) => {
    const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) =>
      Array.from({ length: count }, (_, index) => ({
        repositoryRef: `repository-${String(index + 1).padStart(3, "0")}`,
        repositoryId: String(1100 + index),
        repository: `example/repository-${String(index + 1).padStart(3, "0")}`,
        namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
      })),
    );
    const { page } = await newPage(t, fixture);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start without Preset" }).click();
    await repositoryCheckbox(page, "example/repository-001").waitFor();
    await page.getByRole("heading", { name: "Approved repositories" }).waitFor();
    assert.equal(await page.getByText("Reference: repository-001", { exact: true }).count(), 0);
    assert.equal(
      await page.locator('#repository-results input[type="checkbox"]').count(),
      Math.min(count, 6),
    );
    const search = page.getByLabel("Find a repository");
    assert.equal(await search.count(), count > 5 ? 1 : 0);
    if (count > 5) {
      await page.getByRole("button", { name: "Browse all repositories" }).click();
      assert.equal(await page.locator('#repository-results input[type="checkbox"]').count(), 20);
      await page.getByRole("button", { name: "Next repositories" }).click();
      assert.equal(
        await page.locator('#repository-results input[type="checkbox"]').count(),
        Math.min(count - 20, 20),
      );
      await search.fill("repository-025");
      await search.press("Escape");
      assert.equal(await search.inputValue(), "repository-025");
      assert.equal(await page.locator("#repository-results").isVisible(), false);
      await search.press("ArrowDown");
      assert.equal(
        await repositoryCheckbox(page, "example/repository-025").evaluate(
          (node) => node === node.ownerDocument.activeElement,
        ),
        true,
      );
      await page.keyboard.press("Space");
      assert.equal(await search.inputValue(), "repository-025");
      assert.equal(
        await repositoryCheckbox(page, "example/repository-025").evaluate(
          (node) => node === node.ownerDocument.activeElement,
        ),
        true,
      );
      assert.equal(await repositoryCheckbox(page, "example/repository-025").isChecked(), true);
      await page.getByRole("button", { name: "Remove example/repository-025" }).click();
      await search.fill("");
    }
    await page.setViewportSize({ width: 320, height: 800 });
    assert.equal(
      await page.locator("html").evaluate((node) => node.scrollWidth <= node.clientWidth),
      true,
    );
    if (count === 140) {
      await search.fill("repository-140");
      await search.press("Enter");
      await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
      await page.getByLabel("Agent name").fill("Recent repository Agent");
      const saved = page.waitForResponse(
        (response) =>
          response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Create Agent", exact: true }).click();
      assert.equal((await saved).status(), 201);
      await page.getByRole("heading", { name: "New revision" }).waitFor();
      await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
      await page.getByRole("button", { name: "Start without Preset" }).click();
      await page.getByText(/Recently used/).waitFor();
      assert.equal(
        await page.locator("#repository-results .repository-result-row strong").first().innerText(),
        "example/repository-140",
      );
      await search.fill("repository-139");
      await search.press("Enter");
      await page.reload();
      await page.getByRole("button", { name: "Start without Preset" }).click();
      await page.getByText(/Recently used/).waitFor();
      assert.equal(
        await page.locator("#repository-results .repository-result-row strong").first().innerText(),
        "example/repository-140",
      );
    }
  });
}

test("Repository descriptions arrive without interrupting a selection", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    backends: [...backendFixtures, repositoryBackendFixture],
    repositoryCredentials: true,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Repository metadata", { ready: true });
  const metadataRequested = Promise.withResolvers();
  const releaseMetadata = Promise.withResolvers();
  t.after(() => releaseMetadata.resolve());
  const description = 'Application <img src=x onerror="alert(1)"> & services';
  // The actual credential service talks to a controlled GitHub TLS endpoint.
  // Delay the provider response to verify that discovery and selection do not block.
  const credentials = await startRegistryCredentialServiceFixture(t, {
    namespaceId: namespace.id,
    backendId: repositoryBackendFixture.id,
    autoOpen: false,
    gateway: { listen: `127.0.0.1:${await unusedPort()}` },
    repositories: [
      {
        repositoryRef: "application",
        repository: "example/application",
        repositoryId: "789",
        description,
        async beforeMetadataResponse() {
          metadataRequested.resolve();
          await releaseMetadata.promise;
        },
      },
      { repositoryRef: "documentation", repository: "example/documentation", repositoryId: "790" },
      { repositoryRef: "examples", repository: "example/examples", repositoryId: "791" },
      {
        repositoryRef: "infrastructure",
        repository: "example/infrastructure",
        repositoryId: "792",
      },
      { repositoryRef: "libraries", repository: "example/libraries", repositoryId: "793" },
      { repositoryRef: "tools", repository: "example/tools", repositoryId: "794" },
    ],
  });
  const driver = new GitHubRepoDriver(
    {
      id: repositoryBackendFixture.id,
      client: new UnixRepositoryCredentialControlClient({
        controlSocket: credentials.config.gateway.controlSocket,
      }),
      drivers: repositoryBackendFixture.drivers,
    },
    credentials.registry,
    { sessionDurationSeconds: 600 },
  );
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("repo", driver.id);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const search = page.getByLabel("Find a repository");
  await search.fill("application");
  const choice = repositoryCheckbox(page, "example/application");
  await choice.check();
  await choice.focus();
  await Promise.race([
    metadataRequested.promise,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("GitHub metadata request was not started")),
        10000,
      );
      timer.unref();
    }),
  ]);
  releaseMetadata.resolve();
  await page.getByText(description, { exact: true }).waitFor();
  assert.equal(await choice.isChecked(), true);
  assert.equal(await choice.evaluate((node) => node === node.ownerDocument.activeElement), true);
  assert.equal(await search.inputValue(), "application");
  const result = page.locator(".repository-result-row").filter({ hasText: "example/application" });
  assert.equal(await result.locator("img").count(), 0);
  // Clearing the filter starts optional metadata lookups for the full page. Let
  // those lookups and their credential revocations finish before fixture teardown.
  const metadataSettled = page.waitForResponse(async (response) => {
    const url = new URL(response.url());
    const refs = url.searchParams.get("descriptionRefs")?.split(",") ?? [];
    if (response.status() !== 200 || refs.length !== 6 || !refs.includes("documentation")) {
      return false;
    }
    return (await response.json()).meta?.descriptionsPending === false;
  });
  await search.fill("");
  assert.equal(
    await page
      .locator(".repository-result-row")
      .filter({ hasText: "example/documentation" })
      .locator(".repository-description")
      .count(),
    0,
  );
  await metadataSettled;
  await waitForCondition(
    () =>
      credentials.repositories.every((entry) =>
        entry.github.tokenState().every((token) => token.revoked),
      ),
    "metadata credentials were not revoked",
    10_000,
  );
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Repository metadata Agent");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  assert.deepEqual((await response.json()).data.repositoryBindings, [
    { repositoryRef: "application", profile: "git-full" },
  ]);
});

test("Repository choices distinguish names, references, and restricted access", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "1900",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
    {
      repositoryRef: "handbook-alias",
      repositoryId: "1901",
      repository: "example/handbook",
      namespaces: [{ namespaceId, profiles: ["git-read"] }],
    },
  ]);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const application = page
    .locator(".repository-result-row")
    .filter({ hasText: "example/application" });
  const handbook = page.locator(".repository-result-row").filter({ hasText: "example/handbook" });
  await application.getByRole("checkbox").waitFor();
  assert.equal(await application.getByText(/Reference:/).count(), 0);
  await application.getByText("example/application", { exact: true }).click();
  await page.getByRole("button", { name: "Access for example/application" }).waitFor();
  await handbook.getByText("Reference: handbook-alias", { exact: true }).waitFor();
  await handbook.getByText("Read-only approved", { exact: true }).waitFor();
  const addHandbook = handbook.getByRole("checkbox", { name: /Read-only approved/ });
  await addHandbook.click();
  await page.getByText("Choose approved access", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Access for example/handbook" })
      .getAttribute("aria-expanded"),
    "true",
  );
});

test("Agent repository pagination keeps focus when every result on a page is selected", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) =>
    Array.from({ length: 21 }, (_, index) => ({
      repositoryRef: `repository-${String(index + 1).padStart(3, "0")}`,
      repositoryId: String(1800 + index),
      repository: `example/repository-${String(index + 1).padStart(3, "0")}`,
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    })),
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const search = page.getByLabel("Find a repository");
  await search.fill("repository-021");
  await repositoryCheckbox(page, "example/repository-021").click();
  await search.fill("");
  await page.getByRole("button", { name: "Browse all repositories" }).click();
  // Selected choices remain interactive, including when they are alone on a page.
  await page.getByRole("button", { name: "Next repositories" }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await repositoryCheckbox(page, "example/repository-021").isChecked(), true);
  assert.equal(await repositoryCheckbox(page, "example/repository-021").isEnabled(), true);
  assert.equal(
    await repositoryCheckbox(page, "example/repository-021").evaluate(
      (node) => node === node.ownerDocument.activeElement,
    ),
    true,
  );
});

test("Agent repository search prioritizes exact names before prefix matches", async (t) => {
  const repositories = [
    "alpha/application-api",
    "beta/my-application",
    "omega/application",
    "zeta/application",
    "tools/cli",
    "docs/handbook",
    "ops/infrastructure",
  ];
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) =>
    repositories.map((repository, index) => ({
      repositoryRef: `catalog-${index}`,
      repositoryId: String(1400 + index),
      repository,
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    })),
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const search = page.getByLabel("Find a repository");
  await search.fill("ApPlIcAtIoN");
  // Enter adds the first match, so exact short names must outrank a different owner's prefix.
  assert.deepEqual(
    await page.locator("#repository-results .repository-identity strong").allTextContents(),
    ["omega/application", "zeta/application", "alpha/application-api", "beta/my-application"],
  );
  await search.press("Enter");
  assert.equal(await repositoryCheckbox(page, "omega/application").isChecked(), true);
  assert.equal(
    await page.locator(".repository-card .repository-identity strong").innerText(),
    "omega/application",
  );
  assert.equal(await search.inputValue(), "ApPlIcAtIoN");
  // Repeated Enter skips the already checked choice and selects the next match.
  await search.press("Enter");
  assert.equal(await repositoryCheckbox(page, "omega/application").isChecked(), true);
  assert.equal(await repositoryCheckbox(page, "zeta/application").isChecked(), true);
});

test("Agent repository selection enforces the 16-item limit without narrow viewport overflow", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) =>
    Array.from({ length: 17 }, (_, index) => ({
      repositoryRef: `repository-${index + 1}`,
      repositoryId: String(900 + index),
      repository: `example/repository-${index + 1}`,
      namespaces: [{ namespaceId, profiles: ["git-read"] }],
    })),
  );
  const { page } = await newPage(t, fixture);
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("Select repositories for this Agent.", { exact: false }).waitFor();

  await page.locator("#repository-default-git-read").check();
  for (let index = 1; index <= 16; index += 1) {
    await page.getByLabel("Find a repository").fill(`example/repository-${index}`);
    await repositoryCheckbox(page, `example/repository-${index}`).check();
  }
  await page.getByLabel("Find a repository").fill("example/repository-17");
  assert.equal(await page.locator(".repository-card").count(), 5);
  await page.getByRole("button", { name: "Show all 16 selected" }).click();
  assert.equal(await page.locator(".repository-card").count(), 16);
  assert.equal(await repositoryCheckbox(page, "example/repository-17").isDisabled(), true);
  await page.getByLabel("Find a repository").fill("example/repository-1");
  const selected = repositoryCheckbox(page, "example/repository-1");
  assert.equal(await selected.isEnabled(), true);
  await selected.uncheck();
  assert.equal(await selected.isChecked(), false);
  await page.getByLabel("Find a repository").fill("example/repository-17");
  await repositoryCheckbox(page, "example/repository-17").check();
  assert.deepEqual(
    await page.locator("html").evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
    })),
    { clientWidth: 360, scrollWidth: 360 },
  );
});

for (const discoveryState of ["later page", "search filter", "dismissed results"]) {
  test(`Agent repository recovery clears ${discoveryState} when the catalog shrinks`, async (t) => {
    const { fixture, namespace, replacePolicy } = await createRepositoryLaunchFixture(
      t,
      (namespaceId) =>
        Array.from({ length: 25 }, (_, index) => ({
          repositoryRef: `repository-${String(index + 1).padStart(3, "0")}`,
          repositoryId: String(1500 + index),
          repository: `example/repository-${String(index + 1).padStart(3, "0")}`,
          namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
        })),
      { reloadablePolicy: true },
    );
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start without Preset" }).click();
    const search = page.getByLabel("Find a repository");
    await search.fill("repository-025");
    await search.press("Enter");
    if (discoveryState === "later page") {
      await search.fill("");
      await page.getByRole("button", { name: "Browse all repositories" }).click();
      await page.getByRole("button", { name: "Next repositories" }).click();
    } else if (discoveryState === "dismissed results") {
      await search.fill("");
      await search.press("Escape");
    }
    await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
    await page.getByLabel("Agent name").fill("Recovered repository selection");

    // Admission sees the new policy after discovery. Recovery must reuse the saved
    // Configuration and expose the smaller catalog without an inaccessible filter.
    replacePolicy([
      {
        repositoryRef: "repository-001",
        repositoryId: "1500",
        repository: "example/repository-001",
        namespaces: [
          { namespaceId: namespace.id, profiles: ["git-read", "git-write", "git-full"] },
        ],
      },
    ]);
    const rejected = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    assert.equal((await rejected).status(), 404);
    await page.getByRole("button", { name: "Reload repository choices" }).click();
    await page.getByText(/Repository choices reloaded/).waitFor();
    assert.equal(await search.count(), 0);
    assert.equal(await page.locator(".repository-card").count(), 0);
    assert.equal(await page.locator("#repository-results").isVisible(), true);
    const add = repositoryCheckbox(page, "example/repository-001");
    assert.equal(await add.count(), 1);
    assert.equal(await add.isEnabled(), true);
    assert.equal(
      await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
      true,
    );
    await add.click();
    const saved = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    const response = await saved;
    assert.equal(response.status(), 201);
    const agent = (await response.json()).data;
    assert.deepEqual(agent.repositoryAccess, {
      defaultProfile: "git-full",
      repositories: [{ repositoryRef: "repository-001" }],
    });
    assert.deepEqual(agent.repositoryBindings, [
      { repositoryRef: "repository-001", profile: "git-full" },
    ]);
    assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
    const attempts = agentPostRequests(requests, namespace.id);
    assert.equal(attempts.length, 2);
    assert.equal(agent.configurationId, attempts[0].body.configurationId);
  });
}

test("Agent creation recovers from stale authoritative admission without replacing its Configuration", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "803",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write"] }],
    },
  ]);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("Select repositories for this Agent.", { exact: false }).waitFor();
  await repositoryCheckbox(page, "example/application").click();
  await page.locator("#repository-default-git-read").check();
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Recovered Repository Agent");

  fixture.policy.restrictions.push({
    id: "stale-agent-create-authorization",
    namespaceId: namespace.id,
    resourceKind: "agent",
    action: "create",
    effect: "deny",
  });
  const savedConfigurationResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/configurations` &&
      response.request().method() === "POST",
  );
  const rejected = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const savedConfiguration = await (await savedConfigurationResponse).json();
  assert.equal((await rejected).status(), 403);
  await page.getByRole("heading", { name: "Recover from a rejected Agent save" }).waitFor();
  await page
    .getByText(
      /Repository-scoped Agent creation returned a known rejection.*Configuration .* remains saved/,
    )
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Remove example/application" }).isDisabled(),
    true,
  );
  assert.equal(await page.getByRole("button", { name: "Start a new draft" }).isEnabled(), true);

  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /could not be reloaded because Agent creation is denied/ })
    .waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Recover from a rejected Agent save" }).isVisible(),
    true,
  );
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Start a new draft" }).isEnabled(), true);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);

  fixture.policy.restrictions.pop();
  const repositoryOptionsPath = `**/namespaces/${namespace.id}/agents/repository-options`;
  const failRepositoryReload = (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "repository policy unavailable" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
      }),
    });
  await page.route(repositoryOptionsPath, failRepositoryReload);

  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /Repository choices could not be reloaded/ })
    .waitFor();
  await page.unroute(repositoryOptionsPath, failRepositoryReload);
  assert.equal(
    await page.getByRole("heading", { name: "Recover from a rejected Agent save" }).isVisible(),
    true,
  );
  await page
    .getByText(`Configuration saved: ${savedConfiguration.data.id}.`, { exact: false })
    .waitFor();
  assert.equal(await page.locator(".repository-options input").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Start a new draft" }).isEnabled(), true);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);

  // Even a post-authorization optional outage cannot satisfy a repository-scoped retry.
  const optionalRepositoryOutage = (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "REPOSITORY_OPTIONS_UNAVAILABLE",
          message: "Repository choices are unavailable.",
        },
      }),
    });
  await page.route(repositoryOptionsPath, optionalRepositoryOutage);
  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /Repository choices could not be reloaded/ })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(100);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  await page.unroute(repositoryOptionsPath, optionalRepositoryOutage);

  const conflictRepositoryReload = (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "RESOURCE_CONFLICT", message: "Namespace lifecycle conflict" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
      }),
    });
  await page.route(repositoryOptionsPath, conflictRepositoryReload);
  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /Namespace no longer accepts new Agents/ })
    .waitFor();
  await page
    .getByRole("status")
    .getByText("This Namespace no longer accepts new Agents.", { exact: true })
    .waitFor();
  await page.unroute(repositoryOptionsPath, conflictRepositoryReload);
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);

  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page.getByText(/Repository choices reloaded/).waitFor();
  assert.equal(await repositoryCheckbox(page, "example/application").isEnabled(), true);
  assert.equal(await page.locator(".repository-card").count(), 0);
  // Refreshing policy permits editing; it must not turn this saved attempt into an ordinary Agent.
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Start a new draft" }).isVisible(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(100);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  await repositoryCheckbox(page, "example/application").click();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#repository-default-git-read").check();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isEnabled(), true);
  await page.getByRole("button", { name: "Remove example/application" }).click();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(100);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  await repositoryCheckbox(page, "example/application").click();
  await page.locator("#repository-default-git-read").check();
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const created = await (await createdResponse).json();
  assert.deepEqual(created.data.repositoryBindings, [
    { repositoryRef: "application", profile: "git-read" },
  ]);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(agentPostRequests(requests, namespace.id).length, 2);
  assert.equal(created.data.configurationId, savedConfiguration.data.id);
});

test("Agent creation does not expose recovery actions after an unknown admission outcome", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "804",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read"] }],
    },
  ]);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.route(`**/namespaces/${namespace.id}/agents`, async (route) => {
    if (route.request().method() === "POST") {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("Select repositories for this Agent.", { exact: false }).waitFor();
  await repositoryCheckbox(page, "example/application").click();
  await page.locator("#repository-default-git-read").check();
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Unknown Outcome Agent");

  await page.getByRole("button", { name: "Create Agent" }).click();
  await page.getByText(/Outcome unknown/).waitFor();
  assert.equal(
    await page
      .getByRole("heading", {
        name: "Recover from a rejected Agent save",
        includeHidden: true,
      })
      .isVisible(),
    false,
  );
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Start over" }).isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Start a new draft", includeHidden: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "Remove example/application" }).isDisabled(),
    true,
  );
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(100);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
});

test("Agent repository recovery with empty current policy requires an explicit new draft", async (t) => {
  const { fixture, namespace, replacePolicy } = await createRepositoryLaunchFixture(
    t,
    (namespaceId) => [
      {
        repositoryRef: "application",
        repositoryId: "806",
        repository: "example/application",
        namespaces: [{ namespaceId, profiles: ["git-read"] }],
      },
    ],
    { reloadablePolicy: true },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await repositoryCheckbox(page, "example/application").click();
  await page.locator("#repository-default-git-read").check();
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Repository policy removed");
  fixture.policy.restrictions.push({
    id: "reject-before-policy-refresh",
    namespaceId: namespace.id,
    resourceKind: "agent",
    action: "create",
    effect: "deny",
  });
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/configurations`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const saved = (await (await savedResponse).json()).data;
  await page.getByRole("heading", { name: "Recover from a rejected Agent save" }).waitFor();
  fixture.policy.restrictions.pop();
  // The real registry policy now approves only another Namespace.
  replacePolicy([
    {
      repositoryRef: "application",
      repositoryId: "806",
      repository: "example/application",
      namespaces: [{ namespaceId: `ns_${randomUUID()}`, profiles: ["git-read"] }],
    },
  ]);
  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page.getByText(/Repository choices reloaded/).waitFor();
  assert.equal(await page.locator(".repository-options input").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(100);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start a new draft" }).click();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText(/No approved repositories are available/).waitFor();
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Explicit ordinary draft");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const created = (await (await createdResponse).json()).data;
  assert.equal(Object.hasOwn(created, "repositoryBindings"), false);
  assert.notEqual(created.configurationId, saved.id);
  assert.equal(
    (await fixture.request("GET", `/namespaces/${namespace.id}/configurations/${saved.id}`)).status,
    200,
  );
});

test("Dedicated Agent creation provisions inline Configuration and masked new Secrets", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provisioned create", { ready: true });
  const values = nativeValues("provision", { harnessId: "codex", providerModel: "gpt-5.1" });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const agentId = "agt_00000000-0000-4000-8000-00000000feed";
  const revisionId = "rev_00000000-0000-4000-8000-00000000feed";
  let allowProvisioningSuccess = false;
  let provisioningReads = 0;
  let deploymentReads = 0;
  let provisionBody;
  const savedSecrets = new Map();
  await routeInstallationProvisioning(page, fixture);
  await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            repositoryRef: "application",
            displayName: "example/application",
            allowedProfiles: ["git-write"],
          },
        ],
        meta: { requestId: "req_repository_choices" },
      }),
    }),
  );

  const agent = {
    id: agentId,
    namespaceId: namespace.id,
    name: "Provisioned Agent",
    status: "active",
    desiredRuntimeState: "running",
    configurationId: "cfg_00000000-0000-4000-8000-00000000feed",
    executionMode: "dedicated",
    harnessAuth: {
      method: "api_key",
      source: null,
    },
    servicePrincipalId: "identity_provisioned_agent",
    createdAt: new Date().toISOString(),
    activeRevisionId: revisionId,
  };
  const revision = {
    id: revisionId,
    namespaceId: namespace.id,
    agentId,
    revision: 1,
    backendId: null,
    configurationId: agent.configurationId,
    configurationKind: "agent",
    configurationGeneration: 2,
    createdAt: agent.createdAt,
    configuration: values,
    harnessAuth: agent.harnessAuth,
    harness: { id: "codex", version: "test", mode: "dedicated" },
    compute: { id: "kubernetes-test", implementation: "kubernetes" },
    servicePrincipalId: agent.servicePrincipalId,
  };
  const workspacePreset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Provision workspace preset",
      template: {
        agent: {
          name: agent.name,
          executionMode: "dedicated",
          initialWorkspaceFiles: {
            "AGENTS.md": "# Provision preset\n",
            "USER.md": "Provision user",
          },
        },
      },
    },
  });
  assert.equal(workspacePreset.status, 201, JSON.stringify(workspacePreset.body));

  const json = (data, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify({
      data,
      meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
    }),
  });

  await page.route(`**/namespaces/${namespace.id}/secrets`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = request.postDataJSON();
    // Secrets use the real API; only provisioning and deployment progression are simulated.
    const response = await route.fetch();
    const saved = (await response.json()).data;
    savedSecrets.set(body.name, saved);
    if (!body.name.endsWith("Slack app token") && !body.name.endsWith("Slack bot token")) {
      agent.harnessAuth.source = saved.ref;
    }
    await route.fulfill({ response });
  });
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, async (route, request) => {
    provisionBody = request.postDataJSON();
    await route.fulfill(
      json(
        {
          provisioning: {
            workId: "work_create",
            status: "queued",
            phase: "admitted",
            attemptCount: 1,
            updatedAt: agent.createdAt,
            url: `/namespaces/${namespace.id}/agents/provision/work_create`,
          },
        },
        202,
      ),
    );
  });
  await page.route(`**/namespaces/${namespace.id}/agents/${agentId}`, async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill(json(agent));
      return;
    }
    await route.fallback();
  });
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_create`, async (route) => {
    provisioningReads += 1;
    await route.fulfill(
      json({
        provisioning: {
          workId: "work_create",
          status: allowProvisioningSuccess ? "succeeded" : "running",
          phase: allowProvisioningSuccess ? "handoff" : "configuration",
          attemptCount: 1,
          updatedAt: agent.createdAt,
          url: `/namespaces/${namespace.id}/agents/provision/work_create`,
          ...(allowProvisioningSuccess
            ? { configurationId: agent.configurationId, agentId, revisionId }
            : {}),
        },
      }),
    );
  });
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/deployments/${revisionId}`,
    async (route) => {
      deploymentReads += 1;
      await route.fulfill(
        json({
          deploymentId: `dep_${revisionId}`,
          revisionId,
          status: deploymentReads > 1 ? "succeeded" : "queued",
          error: null,
        }),
      );
    },
  );
  await page.route(`**/namespaces/${namespace.id}/agents/${agentId}/revisions`, async (route) => {
    await route.fulfill(json([revision]));
  });
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/revisions/${revisionId}`,
    async (route) => {
      await route.fulfill(json(revision));
    },
  );
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/native-admin`,
    async (route) => {
      await route.fulfill(json({ status: "unsupported" }));
    },
  );
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/workspace/files/*`,
    async (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1));
      await route.fulfill(json({ name, content: `# ${name}\n` }));
    },
  );

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByLabel("Preset template").selectOption(workspacePreset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  await repositoryCheckbox(page, "example/application").click();
  await page.locator(".repository-profile-group .repository-customize summary").click();
  await page.locator("#repository-default-issues").uncheck();
  await page.getByLabel("API key", { exact: true }).fill("model-secret-value");
  await openAdvancedSettings(page);
  assert.equal(
    await page.getByLabel("AGENTS.md", { exact: true }).inputValue(),
    "# Provision preset\n",
  );
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "Provision user");
  await page.getByLabel("AGENTS.md", { exact: true }).fill("# Provision edited\n");
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const channelDialog = page.getByRole("dialog", { name: "Configure Slack" });
  await channelDialog.getByLabel("Direct-message policy").selectOption("disabled");
  await channelDialog
    .getByText("Choose existing Slack token Secrets or create them here before creating the Agent.")
    .waitFor();
  await channelDialog.getByLabel("Slack app token").selectOption("__openclaw_create_secret__");
  const appSecretDialog = page.getByRole("dialog", { name: "Create Slack app token Secret" });
  await appSecretDialog.getByLabel("Secret value").fill("slack-app-secret");
  await appSecretDialog.getByRole("button", { name: "Create Secret" }).click();
  await appSecretDialog.waitFor({ state: "hidden" });
  await channelDialog.getByLabel("Slack bot token").selectOption("__openclaw_create_secret__");
  const botSecretDialog = page.getByRole("dialog", { name: "Create Slack bot token Secret" });
  await botSecretDialog.getByLabel("Secret value").fill("slack-bot-secret");
  await botSecretDialog.getByRole("button", { name: "Create Secret" }).click();
  await botSecretDialog.waitFor({ state: "hidden" });
  await channelDialog.getByLabel("Allow everyone in these channels to mention the agent").check();
  await channelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  await channelDialog
    .getByText("Enter at least one Slack channel ID for these access settings.")
    .waitFor();
  await channelDialog.getByLabel("Slack channel IDs").fill("C0123456789");
  await channelDialog.getByLabel("Allow everyone in these channels to mention the agent").uncheck();
  await channelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  await channelDialog
    .getByText("Enter allowed channel user IDs or allow everyone in these channels.")
    .waitFor();
  await channelDialog.getByLabel("Allow everyone in these channels to mention the agent").check();
  await channelDialog.getByRole("button", { name: "Apply channel settings" }).click();

  const provisionResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/provision` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await provisionResponse).status(), 202);
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
  allowProvisioningSuccess = true;
  await page.waitForURL((url) => {
    return (
      url.pathname === `/console/agents/${agentId}` &&
      url.searchParams.get("namespace") === namespace.id &&
      url.searchParams.get("revision") === revisionId &&
      url.searchParams.get("tab") === "workspace"
    );
  });

  assert.match(provisionBody.requestId, /^req_[0-9a-f-]{36}$/);
  assert.equal(provisionBody.name, agent.name);
  assert.deepEqual(provisionBody.repositoryAccess, {
    defaultProfile: "git-write",
    repositories: [{ repositoryRef: "application" }],
  });
  assert.equal(provisionBody.executionMode, "dedicated");
  assert.deepEqual(provisionBody.initialWorkspaceFiles, {
    ...WORKSPACE_DEFAULTS,
    "AGENTS.md": "# Provision edited\n",
    "USER.md": "Provision user",
  });
  assert.equal(provisionBody.workspaceDefaultsId, WORKSPACE_DEFAULTS_ID);
  assert.deepEqual(provisionBody.harnessAuth, agent.harnessAuth);
  assert.deepEqual(provisionBody.configuration.values.channels.slack, {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { C0123456789: { requireMention: true, users: ["*"] } },
    dmPolicy: "disabled",
    groupPolicy: "allowlist",
    replyToModeByChatType: { channel: "all" },
  });
  assert.deepEqual(provisionBody.configuration, {
    kind: "agent",
    values: provisionBody.configuration.values,
    secretBindings: {
      SLACK_APP_TOKEN: {
        source: savedSecrets.get("Provisioned Agent Slack app token").ref,
        delivery: { type: "env" },
      },
      SLACK_BOT_TOKEN: {
        source: savedSecrets.get("Provisioned Agent Slack bot token").ref,
        delivery: { type: "env" },
      },
    },
  });
  assert.equal(Object.hasOwn(provisionBody, "secrets"), false);
  assert.deepEqual(
    secretPostRequests(requests, namespace.id).map((request) => request.body),
    [
      { name: "Provisioned Agent Slack app token", value: "slack-app-secret" },
      { name: "Provisioned Agent Slack bot token", value: "slack-bot-secret" },
      { name: "Provisioned Agent", value: "model-secret-value" },
    ],
  );
  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 1);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  assert.ok(provisioningReads >= 1);
  assert.ok(deploymentReads >= 2);
});

test("Dedicated Agent creation uses regular create when provisioning is unsupported", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unsupported provision", { ready: true });
  const values = nativeValues("unsupported-provision", {
    harnessId: "codex",
    providerModel: "gpt-5.1",
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await routeInstallationWithoutProvisioning(page, fixture);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("This installation creates draft Agents for later deployment.").waitFor();
  await assert.rejects(
    page.getByRole("heading", { name: "Secrets" }).waitFor({ state: "visible", timeout: 300 }),
    /Timeout/,
  );

  await page.getByLabel("Agent name").fill("Unsupported Dedicated Agent");
  await page.getByLabel("API key", { exact: true }).fill("unsupported-model-key");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const channelDialog = page.getByRole("dialog", { name: "Configure Slack" });
  await channelDialog.getByLabel("Direct-message policy").selectOption("disabled");
  await channelDialog.getByLabel("Slack channel IDs").fill("CUNSUPPORTED123");
  await channelDialog.getByLabel("Allow everyone in these channels to mention the agent").check();
  await channelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await createdResponse).status(), 201);
  // Navigation follows the model Secret grant; the Agent POST alone does not finish creation.
  await page.waitForURL((url) => url.pathname.startsWith("/console/agents/agt_"));

  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 0);
  const configurationWrites = configurationPostRequests(requests, namespace.id);
  assert.equal(configurationWrites.length, 1);
  assert.deepEqual(configurationWrites[0].body.values.channels.slack.channels, {
    CUNSUPPORTED123: { requireMention: true, users: ["*"] },
  });
  assert.equal(Object.hasOwn(configurationWrites[0].body, "secretBindings"), false);
  assert.equal(accessBindingPostRequests(requests, namespace.id).length, 1);
  assert.deepEqual(
    agentPostRequests(requests, namespace.id).map((request) => request.body),
    [
      {
        name: "Unsupported Dedicated Agent",
        executionMode: "dedicated",
        initialWorkspaceFiles: WORKSPACE_DEFAULTS,
        workspaceDefaultsId: WORKSPACE_DEFAULTS_ID,
        repositoryAccess: { defaultProfile: "git-full", repositories: [] },
        harnessAuth: agentPostRequests(requests, namespace.id)[0].body.harnessAuth,
        configurationId: requests.find(
          (request) =>
            request.method === "POST" && request.path === `/namespaces/${namespace.id}/agents`,
        )?.body.configurationId,
      },
    ],
  );
  // Read the created draft through the real API, then verify both access choices
  // survive a new page load rather than only remaining in the create form.
  const createdAgent = (await (await createdResponse).json()).data;
  await page.goto(detailUrl(fixture, namespace.id, createdAgent.id, "draft", "channels").href);
  await page.getByRole("button", { name: "Edit Slack", exact: true }).click();
  let savedDialog = page.getByRole("dialog", { name: "Edit Slack" });
  const everyone = savedDialog.getByLabel("Allow everyone in these channels to mention the agent");
  assert.equal(await everyone.isChecked(), true);
  assert.equal(await savedDialog.getByLabel("Allowed channel user IDs").isDisabled(), true);
  await everyone.uncheck();
  await savedDialog.getByLabel("Allowed channel user IDs").fill("USENDER123");
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(`/configurations/${createdAgent.configurationId}`),
  );
  await savedDialog.getByRole("button", { name: "Save configuration", exact: true }).click();
  assert.equal((await saved).status(), 200);
  await page.reload();
  await page.getByRole("button", { name: "Edit Slack", exact: true }).click();
  savedDialog = page.getByRole("dialog", { name: "Edit Slack" });
  assert.equal(await savedDialog.getByLabel("Allowed channel user IDs").inputValue(), "USENDER123");
  assert.equal(
    await savedDialog
      .getByLabel("Allow everyone in these channels to mention the agent")
      .isDisabled(),
    true,
  );
  const savedConfiguration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${createdAgent.configurationId}`,
  );
  assert.deepEqual(savedConfiguration.data.values.channels.slack.channels, {
    CUNSUPPORTED123: { requireMention: true, users: ["USENDER123"] },
  });
  assert.equal(savedConfiguration.data.values.channels.slack.replyToMode, undefined);
  assert.deepEqual(savedConfiguration.data.values.channels.slack.replyToModeByChatType, {
    channel: "all",
  });
  assert.equal(savedConfiguration.data.values.channels.slack.groupPolicy, "allowlist");
  assert.equal(savedConfiguration.data.values.channels.slack.dmPolicy, "disabled");
  assert.equal(Object.hasOwn(savedConfiguration.data.values.channels.slack, "allowFrom"), false);

  // Exercise DM policy changes through the normal Agent editor and real Configuration API.
  // An empty or wildcard allowlist must not produce a write or broaden channel access.
  await savedDialog.getByLabel("Direct-message policy").selectOption("allowlist");
  for (const invalid of ["", "*"]) {
    await savedDialog.getByLabel("Allowed DM user IDs").fill(invalid);
    requests.length = 0;
    await savedDialog.getByRole("button", { name: "Save configuration", exact: true }).click();
    await savedDialog
      .getByText("Enter specific allowed DM user IDs, or choose a different direct-message policy.")
      .waitFor();
    assert.equal(nonAuthWriteRequests(requests).length, 0);
  }
  for (const [policy, senders] of [
    ["allowlist", ["UDIRECT123"]],
    ["open", ["*"]],
    ["disabled", ["*"]],
    ["pairing", ["UPREAPPROVED123"]],
  ]) {
    await savedDialog.getByLabel("Direct-message policy").selectOption(policy);
    if (policy === "allowlist" || policy === "pairing") {
      if (policy === "pairing") {
        assert.equal(await savedDialog.getByLabel("Allowed DM user IDs").inputValue(), "");
      }
      await savedDialog.getByLabel("Allowed DM user IDs").fill(senders.join(", "));
    }
    const policySaved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/configurations/${createdAgent.configurationId}`),
    );
    await savedDialog.getByRole("button", { name: "Save configuration", exact: true }).click();
    assert.equal((await policySaved).status(), 200);
    await page.reload();
    await page.getByRole("button", { name: "Edit Slack", exact: true }).click();
    savedDialog = page.getByRole("dialog", { name: "Edit Slack" });
    assert.equal(await savedDialog.getByLabel("Direct-message policy").inputValue(), policy);
    const persisted = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${createdAgent.configurationId}`,
    );
    assert.deepEqual(persisted.data.values.channels.slack, {
      ...savedConfiguration.data.values.channels.slack,
      dmPolicy: policy,
      allowFrom: senders,
    });
  }
});

test("Dedicated Agent creation reuses separately saved Secret references after provisioning failure", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision retry", { ready: true });
  const values = nativeValues("provision-retry", {
    harnessId: "codex",
    providerModel: "gpt-5.1",
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await routeInstallationProvisioning(page, fixture);
  await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], meta: { requestId: "req_repository_choices" } }),
    }),
  );
  const agentId = "agt_00000000-0000-4000-8000-00000000babe";
  const revisionId = "rev_00000000-0000-4000-8000-00000000babe";
  const createdAt = new Date().toISOString();
  const bodies = [];
  const savedSecrets = new Map();
  const agent = {
    id: agentId,
    namespaceId: namespace.id,
    name: "Retried Agent",
    status: "active",
    desiredRuntimeState: "running",
    configurationId: "cfg_00000000-0000-4000-8000-00000000babe",
    executionMode: "dedicated",
    harnessAuth: {
      method: "codex_pat",
      source: null,
    },
    servicePrincipalId: "identity_retried_agent",
    createdAt,
    activeRevisionId: revisionId,
  };
  const revision = {
    id: revisionId,
    namespaceId: namespace.id,
    agentId,
    revision: 1,
    backendId: null,
    configurationId: agent.configurationId,
    configurationKind: "agent",
    configurationGeneration: 1,
    createdAt,
    configuration: values,
    harnessAuth: agent.harnessAuth,
    harness: { id: "codex", version: "test", mode: "dedicated" },
    compute: { id: "kubernetes-test", implementation: "kubernetes" },
    servicePrincipalId: agent.servicePrincipalId,
  };
  const json = (data, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify({
      data,
      meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
    }),
  });

  await page.route(`**/namespaces/${namespace.id}/secrets`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = request.postDataJSON();
    // Keep Secret persistence real while simulating an uncertain provisioning response.
    const response = await route.fetch();
    const saved = (await response.json()).data;
    savedSecrets.set(body.name, saved);
    if (!body.name.endsWith("Slack app token") && !body.name.endsWith("Slack bot token")) {
      agent.harnessAuth.source = saved.ref;
    }
    await route.fulfill({ response });
  });
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, async (route, request) => {
    bodies.push(request.postDataJSON());
    if (bodies.length === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "DEPENDENCY_UNAVAILABLE",
            message: "masked provisioning response",
          },
          meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
        }),
      });
      return;
    }
    await route.fulfill(
      json(
        {
          provisioning: {
            workId: "work_retry",
            status: "succeeded",
            phase: "handoff",
            attemptCount: 1,
            updatedAt: createdAt,
            configurationId: agent.configurationId,
            agentId,
            revisionId,
            url: `/namespaces/${namespace.id}/agents/provision/work_retry`,
          },
        },
        202,
      ),
    );
  });
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/deployments/${revisionId}`,
    async (route) => {
      await route.fulfill(
        json({ deploymentId: `dep_${revisionId}`, revisionId, status: "succeeded" }),
      );
    },
  );
  await page.route(`**/namespaces/${namespace.id}/agents/${agentId}`, async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill(json(agent));
      return;
    }
    await route.fallback();
  });
  await page.route(`**/namespaces/${namespace.id}/agents/${agentId}/revisions`, async (route) => {
    await route.fulfill(json([revision]));
  });
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/revisions/${revisionId}`,
    async (route) => {
      await route.fulfill(json(revision));
    },
  );
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/native-admin`,
    async (route) => {
      await route.fulfill(json({ status: "unsupported" }));
    },
  );
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/workspace/files/*`,
    async (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1));
      await route.fulfill(json({ name, content: `# ${name}\n` }));
    },
  );

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill(agent.name);
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await page.getByLabel("Service account token", { exact: true }).fill("model-secret-value");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const channelDialog = page.getByRole("dialog", { name: "Configure Slack" });
  await channelDialog.getByLabel("Direct-message policy").selectOption("disabled");
  await channelDialog.getByLabel("Slack app token").selectOption("__openclaw_create_secret__");
  const appSecretDialog = page.getByRole("dialog", { name: "Create Slack app token Secret" });
  await appSecretDialog.getByLabel("Secret value").fill("retry-slack-app-secret");
  await appSecretDialog.getByRole("button", { name: "Create Secret" }).click();
  await appSecretDialog.waitFor({ state: "hidden" });
  await channelDialog.getByLabel("Slack bot token").selectOption("__openclaw_create_secret__");
  const botSecretDialog = page.getByRole("dialog", { name: "Create Slack bot token Secret" });
  await botSecretDialog.getByLabel("Secret value").fill("retry-slack-bot-secret");
  await botSecretDialog.getByRole("button", { name: "Create Secret" }).click();
  await botSecretDialog.waitFor({ state: "hidden" });
  await channelDialog.getByLabel("Slack channel IDs").fill("CRETRY123");
  await channelDialog.getByLabel("Allow everyone in these channels to mention the agent").check();
  await channelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  const firstProvisionResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/provision` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await firstProvisionResponse).status(), 503);
  await page
    .getByText("Outcome unknown. Retry resubmits the same request ID and saved references")
    .waitFor();
  assert.equal(await page.getByLabel("Agent name").isDisabled(), true);
  assert.equal(await page.getByLabel("Configuration JSON").isDisabled(), true);
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "codex");
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Retry provisioning request" }).click();

  await page.waitForURL((url) => {
    return (
      url.pathname === `/console/agents/${agentId}` &&
      url.searchParams.get("namespace") === namespace.id &&
      url.searchParams.get("revision") === revisionId &&
      url.searchParams.get("tab") === "workspace"
    );
  });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1], bodies[0]);
  assert.equal(bodies[0].requestId, bodies[1].requestId);
  assert.equal(bodies[0].name, agent.name);
  assert.deepEqual(bodies[0].configuration.values.channels.slack.channels, {
    CRETRY123: { requireMention: true, users: ["*"] },
  });
  assert.deepEqual(bodies[0].harnessAuth, agent.harnessAuth);
  assert.equal(Object.hasOwn(bodies[0], "secrets"), false);
  assert.deepEqual(bodies[0].configuration.secretBindings, {
    SLACK_APP_TOKEN: {
      source: savedSecrets.get("Retried Agent Slack app token").ref,
      delivery: { type: "env" },
    },
    SLACK_BOT_TOKEN: {
      source: savedSecrets.get("Retried Agent Slack bot token").ref,
      delivery: { type: "env" },
    },
  });
  assert.deepEqual(
    secretPostRequests(requests, namespace.id).map((request) => request.body),
    [
      { name: "Retried Agent Slack app token", value: "retry-slack-app-secret" },
      { name: "Retried Agent Slack bot token", value: "retry-slack-bot-secret" },
      { name: "Retried Agent", value: "model-secret-value" },
    ],
  );
});

test("Agent creation rejects non-object native Configuration JSON before any write request", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Invalid JSON", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  requests.length = 0;

  await enterManualModel(page, "unused-invalid-config-key", "gpt-4.1");
  await page.getByLabel("Agent name").fill("Broken Agent");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill("[]");
  await page.getByText("Advanced settings", { exact: true }).click();
  await page.getByRole("button", { name: "Create Agent" }).click();

  const validation = await page
    .getByLabel("Configuration JSON")
    .evaluate((node) => node.validationMessage);
  assert.equal(validation, "Enter a valid JSON object.");
  assert.equal(await page.getByLabel("Configuration JSON").isVisible(), true);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

test("Agent creation offers mainline Anthropic models before credentials and saves an explicit selection", async (t) => {
  const audit = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink: audit });
  const secretDriver = createTestSecretDriver();
  const fixture = await createConsoleAppFixture(t, {
    state,
    secretDriver,
    backendSummaries: undefined,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Anthropic authoring", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  await page
    .getByLabel("Service account token", { exact: true })
    .fill("at-discarded-before-anthropic");
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "openclaw");
  assert.deepEqual(
    await page
      .getByLabel("Harness", { exact: true })
      .locator("option:not([disabled])")
      .evaluateAll((options) => options.map((option) => option.value)),
    ["openclaw"],
  );
  assert.equal(
    await page.getByLabel("API key", { exact: true }).getAttribute("placeholder"),
    "sk-ant-…",
  );
  assert.equal(await page.getByRole("link", { name: "OpenAI admin", exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
  assert.equal(
    await page.getByLabel("Authentication method", { exact: true }).inputValue(),
    "api_key",
  );
  assert.equal(await page.getByLabel("Authentication method", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  assert.equal(await page.getByLabel("Authentication source").count(), 0);
  assert.equal(await page.getByLabel("Model", { exact: true }).isVisible(), true);
  assert.equal(await page.getByLabel("Model ID", { exact: true }).isVisible(), false);
  assert.equal(
    JSON.parse(await page.getByLabel("Configuration JSON").inputValue()).agents?.defaults?.model,
    undefined,
  );
  const choice = page.getByLabel("Model", { exact: true });
  assert.deepEqual(
    (await optionValues(choice)).map(({ value }) => value),
    [
      "",
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-mythos-5-1",
      "claude-opus-5",
      "claude-fable-5",
      "claude-mythos-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-mythos-preview",
    ],
  );
  assert.equal(await choice.inputValue(), "");
  await choice.selectOption("claude-fable-5-1");
  const selectedConfiguration = await page.getByLabel("Configuration JSON").inputValue();
  await page.getByLabel("Agent name").fill("Anthropic Agent");
  await page.getByLabel("API key", { exact: true }).fill("test-anthropic-api-key");
  await page.getByLabel("API key", { exact: true }).press("Tab");
  assert.equal(await choice.inputValue(), "claude-fable-5-1");
  assert.equal(await page.getByLabel("Configuration JSON").inputValue(), selectedConfiguration);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  assert.equal(secretDriver.calls.length, 0);
  assert.equal(JSON.stringify(audit.events).includes("test-anthropic-api-key"), false);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).length,
    0,
  );
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const agent = (await response.json()).data;
  await page.waitForURL((url) => url.pathname === `/console/agents/${agent.id}`);
  assert.equal(agent.executionMode, "embedded");
  assert.equal(agent.backendId, null);
  assert.equal(agent.harnessAuth.method, "api_key");
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(configuration.data.values.agents.defaults.model, "anthropic/claude-fable-5-1");
  assert.deepEqual(configuration.data.values.models.providers.anthropic, {
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: [{ id: "claude-fable-5-1", name: "claude-fable-5-1" }],
  });
  assert.equal(
    configuration.data.values.agents.defaults.models["anthropic/claude-fable-5-1"].agentRuntime.id,
    "openclaw",
  );
  assert.equal(pathRequests(requests, "GET", "/backends").length, 0);
  assert.equal(
    pathRequests(requests, "GET", `/namespaces/${namespace.id}/service-accounts`).length,
    0,
  );
  assert.equal(JSON.stringify(configuration.data).includes("test-anthropic-api-key"), false);
});

test("Static model selection survives credential edits and resets for provider or authentication changes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Static model choices", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const key = page.getByLabel("API key", { exact: true });
  const choice = page.getByLabel("Model", { exact: true });
  const configuration = page.getByLabel("Configuration JSON");
  assert.equal(await key.inputValue(), "");
  assert.equal(await choice.isVisible(), true);
  assert.equal(await choice.isEnabled(), true);
  assert.deepEqual(
    (await optionValues(choice)).map(({ value }) => value),
    ["", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  );
  assert.equal(await choice.locator('option[value=""]').textContent(), "Choose a model");
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents?.defaults?.model, undefined);
  await choice.selectOption("gpt-6-astra");
  const selectedConfiguration = await configuration.inputValue();
  assert.equal(JSON.parse(selectedConfiguration).agents.defaults.model, "codex/gpt-6-astra");
  for (const credential of ["first-openai-key", "replacement-openai-key", ""]) {
    await key.fill(credential);
    await key.press("Tab");
    assert.equal(await choice.inputValue(), "gpt-6-astra");
    assert.equal(await configuration.inputValue(), selectedConfiguration);
  }

  // Switching compatible harnesses changes the native transport without clearing the model.
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  assert.equal(await choice.inputValue(), "gpt-6-astra");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "openai/gpt-6-astra",
  );
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  assert.equal(await choice.inputValue(), "gpt-6-astra");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "codex/gpt-6-astra",
  );

  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  assert.equal(await page.getByLabel("Service account token", { exact: true }).inputValue(), "");
  assert.equal(await choice.isVisible(), true);
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents.defaults.model, undefined);
  await choice.selectOption("gpt-5.6-terra");
  await page.getByLabel("Service account token", { exact: true }).fill("at-static-model-token");
  await page.getByLabel("Service account token", { exact: true }).press("Tab");
  assert.equal(await choice.inputValue(), "gpt-5.6-terra");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "codex/gpt-5.6-terra",
  );
  await page.getByLabel("Authentication method", { exact: true }).selectOption("api_key");
  assert.equal(await key.inputValue(), "");
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents.defaults.model, undefined);

  await choice.selectOption("gpt-5.6-luna");
  await key.fill("discarded-openai-key");
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  assert.equal(await key.inputValue(), "");
  assert.equal(await choice.isVisible(), true);
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents.defaults.model, undefined);
  await choice.selectOption("claude-opus-5-5");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "anthropic/claude-opus-5-5",
  );
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents.defaults.model, undefined);
  await choice.selectOption("gpt-5.6-luna");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "codex/gpt-5.6-luna",
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).length,
    0,
  );
});

test("Agent creation accepts a manual model outside the static list and saves through the real Agent API", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Manual model override", { ready: true });
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Manual model Agent");
  await enterManualModel(page, "manual-model-key", "gpt-manual-account-model");
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const agent = (await response.json()).data;
  await page.waitForURL((url) => url.pathname === `/console/agents/${agent.id}`);
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(configuration.data.values.agents.defaults.model, "codex/gpt-manual-account-model");
  assert.equal(JSON.stringify(configuration.data).includes("manual-model-key"), false);
});

test("Agent creation reports unavailable Secret storage before creating Configuration or Agent", async (t) => {
  const fixture = await createConsoleAppFixture(t, { secretDriver: null });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Missing Secret storage", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Unavailable Agent");
  await enterManualModel(page, "unused-no-driver-key", "gpt-4.1");
  const failed = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/secrets` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await failed).status(), 503);
  await page
    .getByRole("alert")
    .filter({ hasText: /unavailable|unknown|configured/i })
    .waitFor();
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
});

test("Agent creation reuses its saved Secret and Configuration after an Agent creation conflict", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const namespace = await fixture.createNamespace("Partial save retry", { ready: true });
  await fixture.createAgent(namespace.id, "Retry Agent");
  const values = nativeValues("partial-save", { harnessId: "codex", providerModel: "gpt-5.1" });
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  await page.getByLabel("Service account token", { exact: true }).fill("at-discarded-pat");
  await page.getByLabel("Service account token", { exact: true }).press("Tab");
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("discarded-pat-model");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  // OpenClaw requires a new API key, never the previous service account token.
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
  assert.equal(
    await page.getByLabel("Authentication method", { exact: true }).inputValue(),
    "api_key",
  );
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("Model ID", { exact: true }).isVisible(), false);
  assert.equal(
    JSON.parse(await page.getByLabel("Configuration JSON").inputValue()).agents.defaults.model,
    undefined,
  );
  assert.equal(
    await page
      .getByLabel("Authentication method", { exact: true })
      .locator('[value="codex_pat"]')
      .isDisabled(),
    true,
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  assert.deepEqual(pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`), []);
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  const credential = page.getByLabel("Service account token", { exact: true });
  await credential.fill("at-browser-pat");
  await credential.press("Tab");
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  assert.deepEqual(pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`), []);
  requests.length = 0;
  await page.getByText("Advanced settings", { exact: true }).click();
  await page.getByLabel("SOUL.md", { exact: true }).fill("# Keep this draft\n");
  await page.getByLabel("Agent name").fill("Retry Agent");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));

  const configurationResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/configurations` &&
      response.request().method() === "POST",
  );
  const deniedAgentResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const savedConfiguration = await (await configurationResponse).json();
  assert.equal((await deniedAgentResponse).status(), 409);
  await page
    .getByText(`Configuration saved: ${savedConfiguration.data.id}.`, { exact: false })
    .waitFor();
  await page.getByText(/conflicts with the saved state/i).waitFor();
  assert.equal(
    await page
      .getByRole("heading", {
        name: "Recover from a rejected Agent save",
        includeHidden: true,
      })
      .isVisible(),
    false,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Reload repository choices", includeHidden: true })
      .isVisible(),
    false,
  );
  assert.equal(await page.getByLabel("Configuration JSON").isDisabled(), true);
  assert.equal(await page.getByLabel("Service account token", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("Service account token", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "codex");
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("Authentication method", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Reset template" }).isDisabled(), true);
  assert.deepEqual(
    configurationPostRequests(requests, namespace.id).map((request) => request.body),
    [{ kind: "agent", values }],
  );
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);

  assert.equal(
    await page.getByLabel("SOUL.md", { exact: true }).inputValue(),
    "# Keep this draft\n",
  );
  assert.equal(await page.getByLabel("SOUL.md", { exact: true }).isEnabled(), true);
  assert.equal(await page.getByLabel("Plugin selections JSON").isEnabled(), true);
  await page.getByLabel("SOUL.md", { exact: true }).fill("# Corrected draft\n");
  await openAdvancedSettings(page);
  await page.locator("summary").filter({ hasText: "Plugin selections JSON" }).click();
  await page.getByLabel("Plugin selections JSON").fill(
    JSON.stringify({
      "codex-plugin:linear@openai-curated-remote": {
        enabled: true,
        toolDefaults: { approval: "approve" },
      },
    }),
  );
  await page.getByLabel("Agent name").fill("Retry Agent Corrected");
  const retryResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const retried = await (await retryResponse).json();
  assert.equal(retried.data.name, "Retry Agent Corrected");
  assert.equal(retried.data.harnessAuth.method, "codex_pat");
  assert.equal(retried.data.configurationId, savedConfiguration.data.id);
  assert.equal(retried.data.activeRevisionId, undefined);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.deepEqual(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).map(
      ({ body }) => body.value,
    ),
    ["at-browser-pat"],
  );
  assert.equal(agentPostRequests(requests, namespace.id).length, 2);
  assert.deepEqual(
    agentPostRequests(requests, namespace.id)[0].body.harnessAuth,
    retried.data.harnessAuth,
  );
  const attempts = agentPostRequests(requests, namespace.id);
  assert.equal(attempts[0].body.initialWorkspaceFiles["SOUL.md"], "# Keep this draft\n");
  assert.equal(attempts[1].body.initialWorkspaceFiles["SOUL.md"], "# Corrected draft\n");
  assert.deepEqual(retried.data.plugins, {
    "codex-plugin:linear@openai-curated-remote": {
      enabled: true,
      toolDefaults: { approval: "approve" },
    },
  });
  for (const request of attempts) {
    assert.equal(request.body.workspaceDefaultsId, WORKSPACE_DEFAULTS_ID);
  }
});

test("Agent creation retries a denied credential grant without duplicating its saved resources", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  const installation = await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Credential grant retry", { ready: true });
  fixture.policy.restrictions.push({
    id: "deny-credential-grant",
    resourceKind: "installation",
    resourceId: installation.id,
    action: "administer",
    effect: "deny",
  });
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Grant retry Agent");
  await enterManualModel(page, "grant-retry-key", "gpt-4.1");
  const created = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await created;
  assert.equal(response.status(), 201);
  const agent = (await response.json()).data;
  await page
    .getByRole("alert")
    .filter({ hasText: /Agent was created, but credential access is not confirmed/ })
    .waitFor();
  assert.match(
    await page.getByRole("link", { name: "Open saved Agent" }).getAttribute("href"),
    new RegExp(agent.id),
  );
  assert.equal(await page.getByLabel("Agent name").isDisabled(), true);
  const bindingPath = `/namespaces/${namespace.id}/iam/access-bindings`;
  assert.equal(pathRequests(requests, "POST", bindingPath).length, 0);
  fixture.policy.restrictions.splice(
    fixture.policy.restrictions.findIndex((item) => item.id === "deny-credential-grant"),
    1,
  );

  // The binding is really committed; only its response is lost before the browser sees it.
  await page.route(`**${bindingPath}`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Retry credential access" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /credential access is not confirmed.*interrupted/ })
    .waitFor();
  await page.unroute(`**${bindingPath}`);
  await page.getByRole("button", { name: "Retry credential access" }).click();
  await page.waitForURL((url) => url.pathname === `/console/agents/${agent.id}`);
  const bindings = await fixture.request("GET", bindingPath);
  assert.equal(bindings.status, 200);
  assert.equal(bindings.data.length, 1);
  assert.equal(bindings.data[0].subjectId, agent.servicePrincipalId);
  assert.equal(bindings.data[0].resourceId, agent.harnessAuth.source.id);
  assert.equal(pathRequests(requests, "POST", bindingPath).length, 1);
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/iam/roles`).length, 1);
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 1);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
});

for (const collection of ["secrets", "configurations", "agents"]) {
  test(`Agent creation blocks duplicate writes after losing the committed ${collection} response`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace(`Uncertain ${collection}`, { ready: true });
    const { page } = await newPage(t, fixture);
    // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
    await routeInstallationWithoutProvisioning(page, fixture);
    const requests = apiRequests(page, fixture.origin);
    const path = `/namespaces/${namespace.id}/${collection}`;
    let committed;
    await page.route(`**${path}`, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      committed = (await response.json()).data;
      await route.abort("failed");
    });
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start without Preset" }).click();
    await page.getByLabel("Agent name").fill(`Uncertain ${collection} Agent`);
    await enterManualModel(page, "uncertain-artifact-key", "gpt-4.1");
    await page.getByRole("button", { name: "Create Agent" }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: /Outcome unknown/ })
      .waitFor();
    assert.ok(committed?.id);
    assert.equal((await fixture.request("GET", `${path}/${committed.id}`)).status, 200);
    assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Start over" }).isDisabled(), true);
    // Even programmatic form resubmission must respect the unknown-commit boundary.
    await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
    assert.equal(pathRequests(requests, "POST", path).length, 1);
    const sequence = ["secrets", "configurations", "agents"];
    for (const later of sequence.slice(sequence.indexOf(collection) + 1)) {
      assert.equal(
        pathRequests(requests, "POST", `/namespaces/${namespace.id}/${later}`).length,
        0,
      );
    }
  });
}

test("Agent creation preserves unrelated edited JSON across model changes and resets to the selected template", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Template edits", { ready: true });
  const { page } = await newPage(t, fixture);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const harness = page.getByLabel("Harness", { exact: true });
  await openAdvancedSettings(page);
  const configuration = page.getByLabel("Configuration JSON");
  assert.equal(JSON.parse(await configuration.inputValue()).agents?.defaults?.model, undefined);
  await enterManualModel(page, "template-edit-key", "gpt-5.1");
  const dedicatedTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(dedicatedTemplate.agents.defaults.model, "codex/gpt-5.1");
  assert.deepEqual(dedicatedTemplate.models.providers.codex.models, [
    { id: "gpt-5.1", name: "gpt-5.1" },
  ]);
  assert.ok(dedicatedTemplate.plugins.entries.codex);

  await harness.selectOption("openclaw");
  const embeddedTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(embeddedTemplate.agents.defaults.model, "openai/gpt-5.1");
  assert.deepEqual(embeddedTemplate.models.providers.openai.models, [
    { id: "gpt-5.1", name: "gpt-5.1" },
  ]);
  assert.equal(embeddedTemplate.plugins?.entries?.codex, undefined);

  const custom = nativeValues("manual-edit");
  custom.agents.defaults.models["openai/gpt-4.1"].alias = "Primary assistant";
  custom.agents.defaults.models["openai/gpt-4.1"].params = { temperature: 0.4 };
  const extraModel = { id: "additional-model", name: "Additional model", contextWindow: 64000 };
  Object.assign(custom.models.providers.openai, {
    baseUrl: "https://models.example.test/v1",
    api: "openai-completions",
    headers: { "X-Custom-Transport": "enterprise-route" },
    models: [...custom.models.providers.openai.models, extraModel],
  });
  custom.gateway.controlUi = {
    enabled: false,
    allowedOrigins: ["https://custom-control.example.test"],
  };
  const edited = JSON.stringify(custom, null, 2);
  await configuration.fill(edited);
  const modelInput = page.getByLabel("Model ID", { exact: true });
  await modelInput.fill("gpt-4.1-updated");
  await modelInput.press("Tab");
  const assertCustomTransport = async () => {
    const provider = JSON.parse(await configuration.inputValue()).models.providers.openai;
    assert.equal(provider.baseUrl, custom.models.providers.openai.baseUrl);
    assert.equal(provider.api, custom.models.providers.openai.api);
    assert.deepEqual(provider.headers, custom.models.providers.openai.headers);
    assert.deepEqual(
      provider.models.find((entry) => entry.id === extraModel.id),
      extraModel,
    );
  };
  await assertCustomTransport();
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "openai/gpt-4.1-updated",
  );

  await page.getByLabel("API key", { exact: true }).fill("same-provider-replacement-key");
  await page.getByLabel("API key", { exact: true }).press("Tab");
  await modelInput.waitFor();
  assert.equal(await modelInput.inputValue(), "gpt-4.1-updated");
  await assertCustomTransport();
  await modelInput.fill("gpt-4.1");
  await modelInput.press("Tab");
  await assertCustomTransport();
  assert.equal(await harness.inputValue(), "openclaw");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.models["openai/gpt-4.1"]
      .agentRuntime.id,
    "openclaw",
  );

  await harness.selectOption("codex");
  const retained = JSON.parse(await configuration.inputValue());
  assert.equal(retained.agents.defaults.model, "codex/gpt-4.1");
  assert.deepEqual(retained.models.providers.codex, {
    baseUrl: "http://127.0.0.1:9",
    api: "openai-responses",
    models: [{ id: "gpt-4.1", name: "gpt-4.1" }],
  });
  assert.equal(retained.models.providers.openai, undefined);
  assert.equal(retained.plugins.entries.knowledge.config.marker, "manual-edit");
  assert.deepEqual(retained.agents.defaults.models["codex/gpt-4.1"], {
    alias: "Primary assistant",
    params: { temperature: 0.4 },
    agentRuntime: { id: "codex" },
  });

  // Model and key edits must preserve the operator's existing Codex execution policy.
  const customCodex = structuredClone(retained.plugins.entries.codex);
  Object.assign(customCodex.config.appServer, {
    sandbox: "workspace-write",
    approvalPolicy: "never",
    remoteWorkspaceRoot: "/workspace/custom-agent",
  });
  retained.plugins.entries.codex = customCodex;
  await configuration.fill(JSON.stringify(retained));
  await modelInput.fill("gpt-4.1-codex-updated");
  await modelInput.press("Tab");
  assert.deepEqual(JSON.parse(await configuration.inputValue()).plugins.entries.codex, customCodex);

  // Replacing the credential preserves the selected model and custom execution policy.
  await page.getByLabel("API key", { exact: true }).fill("replacement-template-key");
  await page.getByLabel("API key", { exact: true }).press("Tab");
  const nextModel = page.getByLabel("Model ID", { exact: true });
  await nextModel.waitFor();
  assert.equal(await nextModel.inputValue(), "gpt-4.1-codex-updated");
  assert.deepEqual(JSON.parse(await configuration.inputValue()).plugins.entries.codex, customCodex);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset template" }).click();
  const resetTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(resetTemplate.agents.defaults.model, "codex/gpt-4.1-codex-updated");
  assert.ok(resetTemplate.plugins.entries.codex);
  await nextModel.fill("gpt-reset-model");
  await nextModel.press("Tab");
  assert.deepEqual(
    JSON.parse(await configuration.inputValue()).agents.defaults.models["codex/gpt-reset-model"],
    {
      agentRuntime: { id: "codex" },
    },
  );
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  await enterManualModel(page, "anthropic-template-key", "claude-template-model");
  const anthropicTemplate = JSON.parse(await configuration.inputValue());
  assert.deepEqual(anthropicTemplate.models.providers.anthropic, {
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: [{ id: "claude-template-model", name: "claude-template-model" }],
  });
  assert.equal(anthropicTemplate.models.providers.codex, undefined);
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  assert.equal(await harness.inputValue(), "codex");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents.defaults.model, undefined);
  await enterManualModel(page, "returned-openai-key", "gpt-returned-model");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "codex/gpt-returned-model",
  );
  await page.getByLabel("Agent name").fill("Discarded draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  assert.equal(await page.getByLabel("Agent name").inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents?.defaults?.model, undefined);
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
});

test("Agent creation blocks an incompatible fallback after changing provider until the configuration is corrected", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provider fallback change", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await enterManualModel(page, "fallback-openai-key", "gpt-5.1");
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await openAdvancedSettings(page);
  const configuration = page.getByLabel("Configuration JSON");
  const values = JSON.parse(await configuration.inputValue());
  values.agents.defaults.model = {
    primary: "openai/gpt-5.1",
    fallbacks: ["openai/gpt-4.1"],
  };
  await configuration.fill(JSON.stringify(values));
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  await enterManualModel(page, "test-fallback-anthropic-key", "claude-sonnet-4-6");
  assert.deepEqual(JSON.parse(await configuration.inputValue()).agents.defaults.model, {
    primary: "anthropic/claude-sonnet-4-6",
    fallbacks: ["openai/gpt-4.1"],
  });
  await page.getByLabel("Agent name").fill("Corrected fallback Agent");
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /fallback.*provider|provider.*fallback/i })
    .waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  // A provider change preserves edited fallbacks; resetting is an explicit correction.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset template" }).click();
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "anthropic/claude-sonnet-4-6",
  );
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const agent = (await response.json()).data;
  await page.waitForURL((url) => url.pathname === `/console/agents/${agent.id}`);
  assert.equal(agent.executionMode, "embedded");
  const persisted = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(persisted.data.values.agents.defaults.model, "anthropic/claude-sonnet-4-6");
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 1);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
});

test("Agent creation saves explicitly selected models for both harnesses", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Starter model", { ready: true });
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);

  for (const [mode, provider, harness, selectedModel] of [
    ["dedicated", "codex", "codex", "gpt-6-astra"],
    ["embedded", "openai", "openclaw", "gpt-5.6-luna"],
  ]) {
    await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("heading", { name: "Create Agent" }).waitFor();
    await page.getByRole("button", { name: "Start without Preset" }).click();
    await page.getByLabel("Harness", { exact: true }).selectOption(harness);
    await page.getByLabel("Model", { exact: true }).selectOption(selectedModel);
    await page.getByLabel("API key", { exact: true }).fill(`test-${mode}-${selectedModel}-key`);
    await page.getByLabel("Agent name").fill(`${mode}-${selectedModel}`);
    const saved = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create Agent" }).click();
    const response = await saved;
    assert.equal(response.status(), 201);
    const agent = (await response.json()).data;
    assert.equal(agent.executionMode, mode);
    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    // Starters leave gateway authentication to the selected Compute Driver while
    // preserving the separate credentials for dedicated Codex execution.
    assert.equal(Object.hasOwn(configuration.data.values.gateway, "auth"), false);
    assert.deepEqual(configuration.data.values.gateway.controlUi, STARTER_CONTROL_UI);
    if (mode === "dedicated") {
      assert.equal(
        configuration.data.values.plugins.entries.codex.config.appServer.authToken,
        "${APP_SERVER_TOKEN}",
      );
    }
    const modelReference = `${provider}/${selectedModel}`;
    assert.equal(configuration.data.values.agents.defaults.model, modelReference);
    assert.deepEqual(configuration.data.values.agents.defaults.models, {
      [modelReference]: { agentRuntime: { id: harness } },
    });
    assert.deepEqual(configuration.data.values.models.providers[provider].models, [
      { id: selectedModel, name: selectedModel },
    ]);
  }
});
