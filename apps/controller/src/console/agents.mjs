import { element, button } from "./dom.mjs";
import { renderChannels } from "./channels.mjs";

const displayDate = (value) => new Date(value).toLocaleString();
const shortId = (value) => `${value.slice(0, 12)}…${value.slice(-6)}`;
const namespacePath = (id) => `/namespaces/${encodeURIComponent(id)}`;

function link(label, target, context) {
  const node = element("a", { href: context.pageUrl(target) }, label);
  node.addEventListener("click", (event) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    context.navigate(target);
  });
  return node;
}

function message(error, mutation = false) {
  if (error.status === 403) return "Access denied. You do not have permission for this operation.";
  if (error.status === 404)
    return "Resource unavailable in this Namespace. Check the ID and your access.";
  if (error.status === 409)
    return "The request conflicts with the saved state. Check for an existing Agent name or changed Configuration, then refresh.";
  if (error.status === 400) return "Check the entered values and resource IDs, then try again.";
  return mutation
    ? "The result could not be confirmed. Refresh and inspect the saved state before trying again."
    : "The request could not be completed. Please retry.";
}

function errorPanel(error, context, retry) {
  if (error.status === 401) {
    context.onExpired();
    return element("div");
  }
  return element(
    "section",
    { className: "state-panel", role: "alert" },
    element("h2", {}, "Configuration unavailable"),
    element("p", {}, message(error)),
    error.requestId
      ? element("p", { className: "request-id" }, `Request ID: ${error.requestId}`)
      : null,
    button("Retry", retry),
  );
}

function field(label, input, hint) {
  return element(
    "div",
    { className: "form-field" },
    element("label", { for: input.id }, label),
    input,
    hint ? element("p", { className: "hint", id: `${input.id}-hint` }, hint) : null,
  );
}

function summary(values, details) {
  const model = values?.agents?.defaults?.model;
  const primary = typeof model === "string" ? model : model?.primary;
  const list = element("dl", { className: "configuration-summary" });
  for (const [name, value] of [["Model", primary ?? "Not specified"], ...details])
    list.append(element("dt", {}, name), element("dd", {}, value ?? "None"));
  return list;
}

function nativeDocument(values, label) {
  return element(
    "details",
    { className: "native-document" },
    element("summary", {}, label),
    element("pre", { tabindex: "0" }, JSON.stringify(values, null, 2)),
  );
}

export function renderAgentList(context) {
  const { view, items } = context;
  const search = element("input", {
    type: "search",
    "aria-label": "Search Agents",
    placeholder: "Search Agents by name or ID",
  });
  const rows = element("div");
  const create = button("Create Agent", () => context.navigate("agents/new"), {
    className: "primary",
  });
  view.replaceChildren(element("div", { className: "agent-toolbar" }, search, create), rows);
  function render() {
    const query = search.value.trim().toLowerCase();
    const matches = items
      .filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (!matches.length) {
      rows.replaceChildren(
        element(
          "section",
          { className: "state-panel" },
          element("h2", {}, query ? "No matching Agents" : "No Agents yet"),
          element(
            "p",
            {},
            query
              ? "Try another name or ID."
              : "Create an Agent in this Namespace using an editable Configuration template.",
          ),
        ),
      );
      return;
    }
    const table = element("table", { className: "agent-table", "aria-label": "Agents" });
    table.append(
      element(
        "thead",
        {},
        element(
          "tr",
          {},
          ...["Agent", "Execution mode", "Active revision", "Created"].map((label) =>
            element("th", { scope: "col" }, label),
          ),
        ),
      ),
    );
    const body = element("tbody");
    for (const item of matches)
      body.append(
        element(
          "tr",
          {},
          element(
            "td",
            {},
            link(item.name, `agents/${item.id}`, context),
            element("span", { className: "resource-id" }, item.id),
          ),
          element("td", {}, item.executionMode === "dedicated" ? "Dedicated" : "Embedded"),
          element(
            "td",
            {},
            item.activeRevisionId
              ? link(
                  shortId(item.activeRevisionId),
                  `agents/${item.id}?revision=${item.activeRevisionId}`,
                  context,
                )
              : "No active revision",
          ),
          element("td", {}, displayDate(item.createdAt)),
        ),
      );
    table.append(body);
    rows.replaceChildren(element("div", { className: "table-scroll" }, table));
  }
  search.addEventListener("input", render);
  render();
}

function configurationTemplate(mode) {
  const harnessId = mode === "dedicated" ? "codex" : "openclaw";
  const providerModel = "gpt-5.1";
  const modelReference = `${harnessId === "codex" ? "codex" : "openai"}/${providerModel}`;
  const provider =
    harnessId === "codex"
      ? {
          codex: {
            baseUrl: "http://127.0.0.1:9",
            api: "openai-responses",
            models: [{ id: providerModel, name: providerModel }],
          },
        }
      : {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            models: [{ id: providerModel, name: providerModel }],
          },
        };

  return {
    gateway: {
      mode: "local",
      bind: "lan",
      controlUi: { enabled: false },
      auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
      http: { endpoints: { chatCompletions: { enabled: true } } },
    },
    agents: {
      defaults: {
        model: modelReference,
        models: { [modelReference]: { agentRuntime: { id: harnessId } } },
      },
    },
    models: { providers: provider },
    ...(harnessId === "codex"
      ? {
          // Codex model transport must use its authenticated app server, never direct HTTP.
          plugins: {
            allow: ["codex"],
            entries: {
              codex: {
                enabled: true,
                config: {
                  appServer: {
                    mode: "guardian",
                    approvalPolicy: "on-request",
                    sandbox: "read-only",
                    transport: "websocket",
                    url: "${APP_SERVER_URL}",
                    authToken: "${APP_SERVER_TOKEN}",
                  },
                },
              },
            },
          },
        }
      : {}),
  };
}

export function renderCreateAgent(context) {
  const { view, request, namespaceId } = context;
  context.setTitle("Create Agent");
  const name = element("input", {
    id: "agent-name",
    name: "name",
    required: "",
    maxlength: "200",
    autocomplete: "off",
  });
  const mode = element(
    "select",
    { id: "execution-mode" },
    element("option", { value: "dedicated" }, "Dedicated"),
    element("option", { value: "embedded" }, "Embedded"),
  );
  const configuration = element("textarea", {
    id: "configuration-json",
    name: "configuration",
    required: "",
    rows: "18",
    className: "configuration-editor",
    spellcheck: "false",
    "aria-describedby": "configuration-json-hint",
  });
  let template = JSON.stringify(configurationTemplate(mode.value), null, 2);
  configuration.value = template;
  const reset = button("Reset template", () => {
    template = JSON.stringify(configurationTemplate(mode.value), null, 2);
    configuration.value = template;
    configuration.setCustomValidity("");
  });
  mode.addEventListener("change", () => {
    const untouched = configuration.value === template;
    template = JSON.stringify(configurationTemplate(mode.value), null, 2);
    if (untouched) configuration.value = template;
  });
  configuration.addEventListener("input", () => configuration.setCustomValidity(""));

  const provider = element(
    "select",
    { id: "provider-id", disabled: true },
    element("option", { value: "" }, "None"),
  );
  const account = element(
    "select",
    { id: "service-account-id", disabled: true },
    element("option", { value: "" }, "None"),
  );
  const providerStatus = element("p", { className: "hint", role: "status" }, "Loading Providers…");
  const accountStatus = element(
    "p",
    { className: "hint", role: "status" },
    "Loading service accounts…",
  );
  let providersLoaded = false;
  let accountsLoaded = false;
  let pending = false;
  let savedConfiguration;
  const feedback = element("p", { className: "error", role: "alert" });
  const savedStatus = element("p", { className: "hint", role: "status" });
  const submit = element("button", { type: "submit", className: "primary" }, "Create Agent");
  const form = element(
    "form",
    { className: "agent-form agent-card" },
    field("Agent name", name, "Unique within this Namespace."),
    field(
      "Execution mode",
      mode,
      "Slack and Microsoft Teams require Dedicated execution. Changing the mode keeps any edited JSON; use Reset template to start again.",
    ),
    field("Provider (optional)", provider),
    providerStatus,
    field("Service account (optional)", account),
    accountStatus,
    field(
      "Configuration JSON",
      configuration,
      "Starter template applied. Edit the sample model and settings before saving. Your operator must provision the referenced credentials.",
    ),
    reset,
    savedStatus,
    feedback,
    element(
      "div",
      { className: "form-actions" },
      button("Cancel", () => context.navigate("agents")),
      submit,
    ),
  );
  const updateControls = () => {
    for (const node of form.querySelectorAll("button, input, select, textarea"))
      node.disabled = pending;
    provider.disabled = pending || !providersLoaded;
    account.disabled = pending || !accountsLoaded;
    reset.disabled = pending || Boolean(savedConfiguration);
    mode.disabled = pending || Boolean(savedConfiguration);
    configuration.readOnly = Boolean(savedConfiguration);
  };
  for (const [path, control, status, label] of [
    ["/providers", provider, providerStatus, "Providers"],
    [`${namespacePath(namespaceId)}/service-accounts`, account, accountStatus, "Service accounts"],
  ]) {
    request(path)
      .then((items) => {
        if (!context.isCurrent()) return;
        if (control === provider) {
          provider.append(
            ...items.map((item) =>
              element("option", { value: item.id }, `${item.id} · ${item.type}`),
            ),
          );
          providersLoaded = true;
          status.textContent = items.length
            ? "Choose an installed Provider."
            : "No Providers configured.";
        } else {
          account.append(
            ...items.map((item) =>
              element("option", { value: item.id }, `${item.name} · ${item.id}`),
            ),
          );
          accountsLoaded = true;
          status.textContent = items.length
            ? "Choose an existing account in this Namespace."
            : "No service accounts available in this Namespace.";
        }
        updateControls();
      })
      .catch((error) => {
        if (!context.isCurrent()) return;
        if (error.status === 401) {
          context.onExpired();
          return;
        }
        status.textContent = `${label} unavailable. ${message(error)} You can continue with None.`;
      });
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    let values;
    try {
      values = JSON.parse(configuration.value);
      if (values === null || Array.isArray(values) || typeof values !== "object") throw new Error();
    } catch {
      configuration.setCustomValidity("Enter a valid JSON object.");
      configuration.reportValidity();
      return;
    }
    const body = {
      name: name.value.trim(),
      executionMode: mode.value,
      ...(provider.value ? { providerId: provider.value } : {}),
      ...(account.value ? { serviceAccountId: account.value } : {}),
    };
    pending = true;
    updateControls();
    feedback.textContent = "";
    try {
      if (!savedConfiguration) {
        savedConfiguration = await request(`${namespacePath(namespaceId)}/configurations`, {
          method: "POST",
          body: { kind: "agent", values },
        });
        if (!context.isCurrent()) return;
        savedStatus.textContent = `Configuration saved: ${savedConfiguration.id}. Its JSON and execution mode are now fixed for this form; retrying Agent creation will reuse it.`;
      }
      const created = await request(`${namespacePath(namespaceId)}/agents`, {
        method: "POST",
        body: { ...body, configurationId: savedConfiguration.id },
      });
      if (context.isCurrent()) context.navigate(`agents/${created.id}?revision=draft`);
    } catch (error) {
      if (!context.isCurrent()) return;
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      const detail =
        error.status === 409 && savedConfiguration
          ? "Agent creation conflicts with the saved state. Check the Agent name and selections, then try again."
          : message(error, true);
      feedback.textContent = detail + (error.requestId ? ` Request ID: ${error.requestId}` : "");
    } finally {
      if (context.isCurrent()) {
        pending = false;
        updateControls();
      }
    }
  });
  view.replaceChildren(
    link("← Agents", "agents", context),
    element(
      "p",
      { className: "muted" },
      "Save a Configuration and an Agent in this Namespace. Creation does not deploy it or create an AgentRevision.",
    ),
    form,
  );
}

export async function renderAgentDetail(context) {
  const { view, namespaceId, agentId, request, url } = context;
  const path = `${namespacePath(namespaceId)}/agents/${encodeURIComponent(agentId)}`;
  const agent = await request(path);
  if (!context.isCurrent()) return;
  context.setTitle(agent.name);
  const selected = url.searchParams.get("revision") ?? agent.activeRevisionId ?? "draft";
  const selectedTab = url.searchParams.get("tab") === "channels" ? "channels" : "configuration";
  const target = (revision = selected, tab = selectedTab) =>
    `agents/${agentId}?revision=${encodeURIComponent(revision)}&tab=${tab}`;
  const change = (revision, tab) => context.navigate(target(revision, tab));
  const header = element(
    "div",
    { className: "agent-toolbar" },
    link("← Agents", "agents", context),
    element(
      "span",
      { className: "badge" },
      agent.activeRevisionId
        ? `Active revision · ${shortId(agent.activeRevisionId)}`
        : "No active revision",
    ),
  );
  const identity = element("p", { className: "resource-id" }, agent.id);
  const selector = element("section", { className: "agent-card revision-selector" });
  const content = element("div");
  const tabs = element("nav", {
    className: "agent-tabs",
    "aria-label": "Agent configuration views",
  });
  for (const [id, label] of [
    ["configuration", "Configuration"],
    ["channels", "Channels"],
  ])
    tabs.append(
      button(label, () => change(selected, id), {
        ...(id === selectedTab ? { "aria-current": "page" } : {}),
      }),
    );
  view.replaceChildren(header, identity, selector, tabs, content);
  const results = await Promise.allSettled([
    request(`${path}/revisions`),
    request(
      selected === "draft"
        ? `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(agent.configurationId)}`
        : `${path}/revisions/${encodeURIComponent(selected)}`,
    ),
  ]);
  if (!context.isCurrent()) return;
  if (results.some((result) => result.status === "rejected" && result.reason.status === 401)) {
    context.onExpired();
    return;
  }
  const revisionResult = results[0];
  const revisions =
    revisionResult.status === "fulfilled"
      ? [...revisionResult.value].sort((a, b) => b.revision - a.revision)
      : [];
  const snapshot = results[1].status === "fulfilled" ? results[1].value : null;
  const activeRevision = revisions.find((revision) => revision.id === agent.activeRevisionId);
  if (activeRevision)
    header.lastChild.textContent = `Active revision · v${activeRevision.revision}`;
  const chooser = element(
    "select",
    { id: "revision-selector", "aria-label": "AgentRevision" },
    element("option", { value: "draft" }, "Saved draft · editable Configuration"),
  );
  for (const revision of revisions)
    chooser.append(
      element(
        "option",
        { value: revision.id },
        `v${revision.revision} · ${displayDate(revision.createdAt)} · ${revision.id === agent.activeRevisionId ? "Active" : "Not active"}`,
      ),
    );
  if (selected !== "draft" && !revisions.some((revision) => revision.id === selected))
    chooser.append(
      element(
        "option",
        { value: selected },
        snapshot ? `v${snapshot.revision} · Selected revision` : "Selected revision unavailable",
      ),
    );
  chooser.value = selected;
  chooser.addEventListener("change", () => change(chooser.value));
  const position = revisions.findIndex((revision) => revision.id === selected);
  const older = button("Older revision", () => change(revisions[position + 1].id));
  older.disabled = position < 0 || position >= revisions.length - 1;
  const newer = button("Newer revision", () => change(revisions[position - 1].id));
  newer.disabled = position <= 0;
  selector.append(
    ...[
      element(
        "h2",
        {},
        selected === "draft"
          ? "Saved draft"
          : snapshot
            ? `AgentRevision v${snapshot.revision}`
            : "AgentRevision unavailable",
      ),
      revisions.length || selected !== "draft"
        ? element("label", { for: "revision-selector" }, "AgentRevision")
        : null,
      revisions.length || selected !== "draft" ? chooser : null,
      element(
        "div",
        { className: "form-actions" },
        selected !== "draft" && revisions.length > 1 ? older : null,
        selected !== "draft" && revisions.length > 1 ? newer : null,
        selected !== "draft" ? button("Saved draft", () => change("draft")) : null,
        agent.activeRevisionId && selected !== agent.activeRevisionId
          ? button("Return to active revision", () => change(agent.activeRevisionId))
          : null,
      ),
    ].filter(Boolean),
  );
  if (revisionResult.status === "rejected")
    selector.append(
      element(
        "p",
        { className: "error", role: "alert" },
        `Revision history unavailable. ${message(revisionResult.reason)}`,
      ),
    );
  else if (!revisions.length)
    selector.append(
      element(
        "p",
        { className: "muted" },
        "No readable AgentRevisions. Creation alone does not create a revision.",
      ),
    );
  if (!snapshot) {
    content.replaceChildren(errorPanel(results[1].reason, context, () => change(selected)));
    return;
  }
  const draft = selected === "draft";
  const values = draft ? snapshot.values : snapshot.configuration;
  const executionMode = draft ? agent.executionMode : snapshot.harness.mode;
  if (!draft) selector.append(element("p", { className: "resource-id" }, snapshot.id));
  selector.append(
    element(
      "p",
      { className: "muted" },
      `${draft ? "Configuration" : "Source Configuration"} ${draft ? snapshot.id : snapshot.configurationId} · generation ${draft ? snapshot.generation : snapshot.configurationGeneration}`,
    ),
  );
  content.append(
    element(
      "p",
      { className: "notice", role: "status" },
      draft
        ? "Saved draft. Changes affect future deployments using this Configuration. Active and historical AgentRevisions stay unchanged."
        : selected === agent.activeRevisionId
          ? "Active AgentRevision · read-only. These values are the admitted snapshot; activation does not confirm live runtime health."
          : "Historical / non-active AgentRevision · read-only. All values below belong to this selected snapshot. Browsing does not change the Agent.",
    ),
  );
  if (selectedTab === "channels") {
    const channels = renderChannels({
      values,
      executionMode,
      readOnly: !draft,
      onSave: async (updatedValues) => {
        try {
          const [freshAgent, freshConfig] = await Promise.all([
            request(path),
            request(
              `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(snapshot.id)}`,
            ),
          ]);
          if (!context.isCurrent())
            throw new Error("This view has changed. Reopen the Configuration before saving.");
          if (
            freshAgent.configurationId !== snapshot.id ||
            freshConfig.generation !== snapshot.generation
          )
            throw new Error(
              "The saved Configuration changed while you were editing. Close this editor and refresh before saving.",
            );
          await request(
            `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(snapshot.id)}`,
            { method: "PATCH", body: { values: updatedValues } },
          );
          if (context.isCurrent()) change("draft", "channels");
        } catch (error) {
          if (error.status === 401) {
            context.onExpired();
            throw new Error("Your session has expired.");
          }
          if (
            error.status !== undefined ||
            error.name === "TimeoutError" ||
            error.name === "TypeError"
          )
            error.message = message(error, true);
          throw error;
        }
      },
    });
    content.append(channels);
  } else {
    const details = [
      ["Execution mode", executionMode === "dedicated" ? "Dedicated" : "Embedded"],
      ["Provider", draft ? agent.providerId : snapshot.providerId],
      ["Service account", draft ? agent.serviceAccountId : snapshot.serviceAccount?.id],
      ["Created", displayDate(snapshot.createdAt)],
    ];
    if (!draft)
      details.push(
        ["Harness", `${snapshot.harness.id} · ${snapshot.harness.version}`],
        ["Compute", `${snapshot.compute.id} · ${snapshot.compute.implementation}`],
      );
    content.append(
      element(
        "section",
        { className: "agent-card" },
        element("h2", {}, draft ? "Editable Configuration" : "Configuration snapshot"),
        summary(values, details),
        nativeDocument(
          values,
          draft ? "View native Configuration" : "View admitted native configuration",
        ),
      ),
    );
  }
  const deletion = element(
    "section",
    { className: "agent-card deletion-note" },
    element("h2", {}, "Delete Agent"),
    element(
      "p",
      { className: "muted" },
      "Agent deletion is unavailable in the current API. This Agent and its revision history cannot be deleted from the console.",
    ),
  );
  view.append(deletion);
}
