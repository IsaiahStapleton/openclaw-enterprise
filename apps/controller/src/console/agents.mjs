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
              : "Create an Agent in this Namespace using an existing Configuration.",
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
  const configuration = element("input", {
    id: "configuration-id",
    name: "configurationId",
    required: "",
    placeholder: "cfg_…",
    autocomplete: "off",
  });
  const mode = element(
    "select",
    { id: "execution-mode" },
    element("option", { value: "dedicated" }, "Dedicated"),
    element("option", { value: "embedded" }, "Embedded"),
  );
  const provider = element("input", { id: "provider-id", autocomplete: "off" });
  const account = element("input", {
    id: "service-account-id",
    placeholder: "sa_…",
    autocomplete: "off",
  });
  const feedback = element("p", { className: "error", role: "alert" });
  const preview = element("div", { "aria-live": "polite" });
  const submit = element("button", { type: "submit", className: "primary" }, "Create Agent");
  let previewGeneration = 0;
  const previewButton = button("Preview configuration", async () => {
    const selected = configuration.value.trim();
    if (!selected) {
      configuration.reportValidity();
      return;
    }
    const token = ++previewGeneration;
    previewButton.disabled = true;
    preview.replaceChildren(element("p", {}, "Reading Configuration…"));
    try {
      const result = await request(
        `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(selected)}`,
      );
      if (
        !context.isCurrent() ||
        token !== previewGeneration ||
        configuration.value.trim() !== selected
      )
        return;
      preview.replaceChildren(
        element(
          "section",
          { className: "agent-card" },
          element("h2", {}, `Configuration · generation ${result.generation}`),
          element("p", { className: "resource-id" }, result.id),
          summary(result.values, [["Kind", result.kind]]),
        ),
      );
    } catch (error) {
      if (!context.isCurrent() || token !== previewGeneration) return;
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      preview.replaceChildren(element("p", { className: "error", role: "alert" }, message(error)));
    } finally {
      if (token === previewGeneration) previewButton.disabled = false;
    }
  });
  configuration.addEventListener("input", () => {
    previewGeneration += 1;
    preview.replaceChildren();
    previewButton.disabled = false;
  });
  const form = element(
    "form",
    { className: "agent-form agent-card" },
    field("Agent name", name, "Unique within this Namespace."),
    field(
      "Configuration ID",
      configuration,
      "Use an existing Agent Configuration from this Namespace.",
    ),
    previewButton,
    preview,
    field(
      "Execution mode",
      mode,
      "Choose the mode matching your Configuration. Slack and Microsoft Teams require Dedicated execution.",
    ),
    field("Provider ID (optional)", provider, "Leave blank for no Provider association."),
    field(
      "Service account ID (optional)",
      account,
      "Use an existing service account when required.",
    ),
    feedback,
    element(
      "div",
      { className: "form-actions" },
      button("Cancel", () => context.navigate("agents")),
      submit,
    ),
  );
  let pending = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    const body = {
      name: name.value.trim(),
      configurationId: configuration.value.trim(),
      executionMode: mode.value,
      ...(provider.value.trim() ? { providerId: provider.value.trim() } : {}),
      ...(account.value.trim() ? { serviceAccountId: account.value.trim() } : {}),
    };
    pending = true;
    for (const node of form.querySelectorAll("button, input, select")) node.disabled = true;
    feedback.textContent = "";
    let sent = false;
    try {
      await request(
        `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(body.configurationId)}`,
      );
      if (!context.isCurrent()) return;
      sent = true;
      const created = await request(`${namespacePath(namespaceId)}/agents`, {
        method: "POST",
        body,
      });
      if (context.isCurrent()) context.navigate(`agents/${created.id}?revision=draft`);
    } catch (error) {
      if (!context.isCurrent()) return;
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      feedback.textContent =
        message(error, sent) + (error.requestId ? ` Request ID: ${error.requestId}` : "");
    } finally {
      if (context.isCurrent()) {
        pending = false;
        for (const node of form.querySelectorAll("button, input, select")) node.disabled = false;
      }
    }
  });
  view.replaceChildren(
    link("← Agents", "agents", context),
    element(
      "p",
      { className: "muted" },
      "Save an Agent in this Namespace. Creation does not deploy it or create an AgentRevision.",
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
