import { element, button } from "./dom.mjs";

const PROVIDERS = {
  slack: {
    name: "Slack",
    description: "Socket Mode with selected channels and user allowlists.",
    setup: "Operator projection must provide SLACK_APP_TOKEN and SLACK_BOT_TOKEN to the gateway.",
    plugin: "slack",
  },
  msteams: {
    name: "Microsoft Teams",
    description: "Application identity and password reference.",
    setup:
      "Requires operator credential projection and separately configured Bot Framework ingress.",
    plugin: "msteams",
  },
};

const STANDARD_REFS = {
  slack: {
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
  },
  msteams: {
    appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
  },
};

const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const uniqueList = (items) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];
const refText = (ref) =>
  isRecord(ref)
    ? `${ref.source ?? "unknown"} / ${ref.provider ?? "unknown"} / ${ref.id ?? "unknown"}`
    : "env / default";
const refsEqual = (left, right) =>
  isRecord(left) &&
  left.source === right.source &&
  left.provider === right.provider &&
  left.id === right.id;

function field(label, control, hint) {
  return element(
    "div",
    { className: "channel-field" },
    element("label", { for: control.id }, label),
    control,
    hint ? element("p", { className: "hint", id: `${control.id}-hint` }, hint) : null,
  );
}

function refField(label, ref) {
  return element(
    "div",
    { className: "channel-field" },
    element("span", { className: "channel-label" }, label),
    element("code", {}, refText(ref)),
  );
}

function checkbox(id, label, checked, disabled = false) {
  return element(
    "label",
    { className: "channel-check" },
    element("input", {
      id,
      type: "checkbox",
      ...(checked ? { checked: "" } : {}),
      ...(disabled ? { disabled: "" } : {}),
    }),
    label,
  );
}

function nativeDocument(label, value) {
  return element(
    "details",
    { className: "native-document channel-native" },
    element("summary", {}, label),
    element("pre", { tabindex: "0" }, JSON.stringify(value ?? null, null, 2)),
  );
}

function channelRoot(values) {
  return isRecord(values?.channels) ? values.channels : {};
}

function providerConfig(values, provider) {
  const config = channelRoot(values)[provider];
  return config === undefined ? undefined : config;
}

function statusOf(config) {
  if (config === undefined) return { label: "Not configured", enabled: false };
  if (isRecord(config) && config.enabled === false) return { label: "Disabled", enabled: false };
  return { label: "Configured (enabled)", enabled: true };
}

function pluginBlockReason(values, provider) {
  const plugins = values?.plugins;
  if (plugins === undefined) return null;
  if (!isRecord(plugins)) return "Plugin configuration is not an object.";
  if (plugins.enabled === false)
    return "Native plugins are disabled. Enable them through the Configuration API before configuring channels.";
  for (const key of ["deny"]) {
    const list = plugins[key];
    if (Array.isArray(list) && list.includes(PROVIDERS[provider].plugin)) {
      return `${PROVIDERS[provider].name} is explicitly blocked in native plugin configuration.`;
    }
  }
  if (plugins.allow !== undefined && !Array.isArray(plugins.allow)) {
    return "Plugin allow configuration is not an array.";
  }
  if (plugins.entries !== undefined && !isRecord(plugins.entries)) {
    return "Plugin entries configuration is not an object.";
  }
  const entry = plugins.entries?.[PROVIDERS[provider].plugin];
  if (entry !== undefined && !isRecord(entry)) {
    return `${PROVIDERS[provider].name} plugin entry is not an object.`;
  }
  return null;
}

function supportSlack(values) {
  if (values?.channels !== undefined && !isRecord(values.channels)) {
    return {
      supported: false,
      reason: "Native channels configuration is not an object.",
      config: values.channels,
    };
  }
  const config = providerConfig(values, "slack");
  if (config === undefined) return { supported: true, config: {} };
  if (!isRecord(config))
    return { supported: false, reason: "Slack configuration is not an object.", config };
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    return { supported: false, reason: "Slack enabled state is not boolean.", config };
  }
  if (config.account !== undefined || config.accounts !== undefined) {
    return {
      supported: false,
      reason: "Only the default Slack account is supported by this editor.",
      config,
    };
  }
  if (config.dmPolicy !== undefined && config.dmPolicy !== "allowlist") {
    return {
      supported: false,
      reason: "Slack direct message policy is not the supported allowlist policy.",
      config,
    };
  }
  if (config.groupPolicy !== undefined && config.groupPolicy !== "allowlist") {
    return {
      supported: false,
      reason: "Slack channel group policy is not the supported allowlist policy.",
      config,
    };
  }
  if (config.mode !== undefined && config.mode !== "socket") {
    return {
      supported: false,
      reason: "Only Slack Socket Mode is supported by this editor.",
      config,
    };
  }
  if (config.appToken !== undefined && !refsEqual(config.appToken, STANDARD_REFS.slack.appToken)) {
    return {
      supported: false,
      reason: "Slack app token uses a non-standard credential reference.",
      config,
    };
  }
  if (config.botToken !== undefined && !refsEqual(config.botToken, STANDARD_REFS.slack.botToken)) {
    return {
      supported: false,
      reason: "Slack bot token uses a non-standard credential reference.",
      config,
    };
  }
  if (config.channels !== undefined && !isRecord(config.channels)) {
    return { supported: false, reason: "Slack channels are not stored as a channel map.", config };
  }
  const channelEntries = Object.entries(config.channels ?? {});
  if (channelEntries.some(([, value]) => !isRecord(value))) {
    return {
      supported: false,
      reason: "At least one Slack channel entry is not an object.",
      config,
    };
  }
  if (config.allowFrom !== undefined && !arrayOfStrings(config.allowFrom)) {
    return {
      supported: false,
      reason: "Slack allowed users are not stored as string IDs.",
      config,
    };
  }
  if (
    channelEntries.some(
      ([, value]) =>
        (value.users !== undefined && !arrayOfStrings(value.users)) ||
        (value.requireMention !== undefined && typeof value.requireMention !== "boolean"),
    )
  ) {
    return {
      supported: false,
      reason: "Slack channel users or Require mention values use an unsupported native shape.",
      config,
    };
  }
  const mentions = [...new Set(channelEntries.map(([, value]) => value.requireMention))];
  if (mentions.length > 1) {
    return {
      supported: false,
      reason: "Existing Slack channels use mixed Require mention values.",
      config,
    };
  }
  return { supported: true, config };
}

function supportTeams(values) {
  if (values?.channels !== undefined && !isRecord(values.channels)) {
    return {
      supported: false,
      reason: "Native channels configuration is not an object.",
      config: values.channels,
    };
  }
  const config = providerConfig(values, "msteams");
  if (config === undefined) return { supported: true, config: {} };
  if (!isRecord(config))
    return { supported: false, reason: "Microsoft Teams configuration is not an object.", config };
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    return { supported: false, reason: "Microsoft Teams enabled state is not boolean.", config };
  }
  if (config.account !== undefined || config.accounts !== undefined) {
    return {
      supported: false,
      reason: "Only the default Microsoft Teams account is supported by this editor.",
      config,
    };
  }
  if (
    config.appPassword !== undefined &&
    !refsEqual(config.appPassword, STANDARD_REFS.msteams.appPassword)
  ) {
    return {
      supported: false,
      reason: "Microsoft Teams app password uses a non-standard credential reference.",
      config,
    };
  }
  if (config.appId !== undefined && typeof config.appId !== "string") {
    return { supported: false, reason: "Microsoft Teams application ID is not a string.", config };
  }
  if (config.tenantId !== undefined && typeof config.tenantId !== "string") {
    return { supported: false, reason: "Microsoft Teams tenant ID is not a string.", config };
  }
  if (config.requireMention !== undefined && typeof config.requireMention !== "boolean") {
    return {
      supported: false,
      reason: "Microsoft Teams Require mention value is not boolean.",
      config,
    };
  }
  return { supported: true, config };
}

function arrayOfStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function withProvider(values, provider, config) {
  const next = clone(values) ?? {};
  const channels = isRecord(next.channels) ? { ...next.channels } : {};
  channels[provider] = config;
  next.channels = channels;
  return next;
}

function withPlugin(values, provider) {
  const next = clone(values) ?? {};
  if (providerConfig(next, provider)?.enabled === false) return next;
  const plugin = PROVIDERS[provider].plugin;
  const plugins = isRecord(next.plugins) ? { ...next.plugins } : {};
  const entries = isRecord(plugins.entries) ? { ...plugins.entries } : {};
  const entry = isRecord(entries[plugin]) ? { ...entries[plugin] } : {};
  // An omitted allowlist must stay omitted; introducing one can exclude another Harness plugin.
  if (Array.isArray(plugins.allow)) plugins.allow = [...new Set([...plugins.allow, plugin])];
  entries[plugin] = { ...entry, enabled: true };
  plugins.entries = entries;
  next.plugins = plugins;
  return next;
}

function channelSummary(provider, values, status, support) {
  if (!support.supported) return PROVIDERS[provider].description;
  const config = support.config;
  if (provider === "slack" && isRecord(config)) {
    const ids = Object.keys(config.channels ?? {});
    const users = uniqueList(Array.isArray(config.allowFrom) ? config.allowFrom : []);
    return [
      config.mode === "socket" || status.label === "Not configured"
        ? "Socket Mode"
        : "Native Slack",
      ids.length
        ? `${ids.length} selected channel${ids.length === 1 ? "" : "s"}`
        : "No selected channels",
      users.length
        ? `${users.length} allowed user${users.length === 1 ? "" : "s"}`
        : "No allowed users",
    ].join(" · ");
  }
  if (provider === "msteams" && isRecord(config)) {
    const pieces = [];
    pieces.push(config.appId ? "Application ID set" : "Application ID missing");
    pieces.push(config.tenantId ? "Tenant ID set" : "Tenant ID missing");
    pieces.push(
      isRecord(config.appPassword)
        ? "Credential reference configured"
        : "Default credential reference",
    );
    return pieces.join(" · ");
  }
  return PROVIDERS[provider].description;
}

function errorText(error) {
  return error?.message + (error?.requestId ? ` Request ID: ${error.requestId}` : "");
}

function renderCard(section, state, provider) {
  const status = statusOf(providerConfig(state.values, provider));
  const support = provider === "slack" ? supportSlack(state.values) : supportTeams(state.values);
  const blockReason = pluginBlockReason(state.values, provider);
  const disabledByMode = state.executionMode === "embedded" && !status.enabled;
  const canOpen = !state.readOnly && !disabledByMode && !blockReason && support.supported;
  const canDisable =
    !state.readOnly && status.enabled && isRecord(providerConfig(state.values, provider));
  const action =
    status.label === "Not configured"
      ? `Configure ${PROVIDERS[provider].name}`
      : `Edit ${PROVIDERS[provider].name}`;
  const actionAttrs = canOpen ? {} : { disabled: "" };
  const card = element(
    "section",
    { className: "agent-card channel-card" },
    element(
      "div",
      { className: "channel-card-row" },
      element(
        "div",
        {},
        element(
          "h2",
          {},
          PROVIDERS[provider].name,
          element("span", { className: "badge" }, status.label),
        ),
        element("p", {}, channelSummary(provider, state.values, status, support)),
        element("p", { className: "hint" }, PROVIDERS[provider].setup),
      ),
      element(
        "div",
        { className: "channel-actions" },
        state.readOnly
          ? null
          : button(action, () => openDrawer(section, state, provider), actionAttrs),
        canDisable
          ? button(
              `Disable ${PROVIDERS[provider].name}`,
              () => void disableProvider(state, provider),
              { className: "danger" },
            )
          : null,
      ),
    ),
  );
  if (state.readOnly)
    card.append(
      element("p", { className: "hint" }, "Read-only AgentRevision values cannot be edited."),
    );
  else if (disabledByMode)
    card.append(
      element(
        "p",
        { className: "error" },
        "Channels require Dedicated execution. Embedded Agents can only keep channels disabled.",
      ),
    );
  else if (blockReason) card.append(element("p", { className: "error" }, blockReason));
  else if (!support.supported)
    card.append(
      element("p", { className: "error" }, support.reason),
      nativeDocument(`${PROVIDERS[provider].name} native configuration`, support.config),
    );
  return card;
}

async function disableProvider(state, provider) {
  state.error.replaceChildren();
  const current = providerConfig(state.values, provider);
  if (!isRecord(current)) return;
  const config = { ...current, enabled: false };
  await save(state, withProvider(state.values, provider, config));
}

async function save(state, values, dialog, targetError) {
  if (state.pending) return;
  state.pending = true;
  const controlsRoot = dialog ?? state.section;
  const errorNode = targetError ?? state.error;
  errorNode.replaceChildren();
  if (!dialog) state.error.replaceChildren();
  for (const node of controlsRoot.querySelectorAll("button, input, select")) node.disabled = true;
  let succeeded = false;
  try {
    await state.onSave(values);
    succeeded = true;
    dialog?.close();
    dialog?.remove();
  } catch (error) {
    errorNode.replaceChildren(
      element("p", { className: "error", role: "alert" }, errorText(error)),
    );
  } finally {
    state.pending = false;
    if (succeeded || !dialog) state.rerender();
    else {
      for (const node of controlsRoot.querySelectorAll("button, input, select"))
        node.disabled = false;
    }
  }
}

function input(id, value, attrs = {}) {
  return element("input", { id, value: value ?? "", autocomplete: "off", ...attrs });
}

function openDrawer(section, state, provider) {
  const support = provider === "slack" ? supportSlack(state.values) : supportTeams(state.values);
  if (!support.supported || pluginBlockReason(state.values, provider)) return;
  section.querySelector("dialog")?.remove();
  const dialog = element("dialog", {
    className: "channel-dialog",
    "aria-label": `${statusOf(providerConfig(state.values, provider)).label === "Not configured" ? "Configure" : "Edit"} ${PROVIDERS[provider].name}`,
  });
  const config = isRecord(support.config) ? support.config : {};
  const enabled = checkbox(
    `${provider}-enabled`,
    `Enable ${PROVIDERS[provider].name}`,
    config.enabled !== false,
  );
  const body = element("form", { method: "dialog", className: "channel-drawer-form" });
  const feedback = element("div", { "aria-live": "polite" });
  const cancel = button("Cancel", () => {
    dialog.close();
    dialog.remove();
  });
  const submit = element("button", { type: "submit", className: "primary" }, "Save configuration");
  body.append(
    element(
      "div",
      { className: "channel-drawer-head" },
      element(
        "h2",
        {},
        `${statusOf(providerConfig(state.values, provider)).label === "Not configured" ? "Configure" : "Edit"} ${PROVIDERS[provider].name}`,
      ),
      button("Close", () => {
        dialog.close();
        dialog.remove();
      }),
    ),
    element(
      "p",
      { className: "notice", role: "status" },
      "Saved draft. Changes affect future deployments using this Configuration. Credentials must be provisioned by your operator.",
    ),
    enabled,
  );
  if (provider === "slack") {
    const channelIds = Object.keys(config.channels ?? {});
    const users = uniqueList(Array.isArray(config.allowFrom) ? config.allowFrom : []);
    const mention = Object.values(config.channels ?? {})[0]?.requireMention ?? true;
    body.append(
      field(
        "Slack channel IDs",
        input("slack-channel-ids", channelIds.join(", ")),
        "Comma-separated channel IDs; existing per-channel properties are preserved.",
      ),
      field(
        "Allowed user IDs",
        input("slack-allowed-user-ids", users.join(", ")),
        "Comma-separated direct-message allowFrom user IDs.",
      ),
      checkbox("slack-require-mention", "Require a mention", Boolean(mention)),
      element("h2", {}, "Credential references"),
      element(
        "p",
        { className: "hint" },
        "Fixed unresolved references only. No token values are entered here.",
      ),
      refField("App token reference", config.appToken ?? STANDARD_REFS.slack.appToken),
      refField("Bot token reference", config.botToken ?? STANDARD_REFS.slack.botToken),
    );
  } else {
    body.append(
      field(
        "Application (client) ID",
        input("msteams-app-id", config.appId),
        "The Microsoft Teams application ID.",
      ),
      field(
        "Directory (tenant) ID",
        input("msteams-tenant-id", config.tenantId),
        "The Microsoft Entra tenant ID.",
      ),
      checkbox("msteams-require-mention", "Require a mention", config.requireMention !== false),
      element("h2", {}, "Credential references"),
      element(
        "p",
        { className: "hint" },
        "Fixed unresolved references only. No password value is entered here.",
      ),
      refField("App password reference", config.appPassword ?? STANDARD_REFS.msteams.appPassword),
    );
  }
  body.append(
    element("p", { className: "muted" }, "This Configuration may be shared by other Agents."),
    feedback,
    element("div", { className: "form-actions" }, cancel, submit),
  );
  body.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.pending) return;
    if (state.executionMode === "embedded" && body.querySelector(`#${provider}-enabled`).checked) {
      feedback.replaceChildren(
        element(
          "p",
          { className: "error", role: "alert" },
          "Channels require Dedicated execution.",
        ),
      );
      return;
    }
    if (
      provider === "msteams" &&
      body.querySelector("#msteams-enabled").checked &&
      (!body.querySelector("#msteams-app-id").value.trim() ||
        !body.querySelector("#msteams-tenant-id").value.trim())
    ) {
      feedback.replaceChildren(
        element(
          "p",
          { className: "error", role: "alert" },
          "Microsoft Teams requires Application ID and Directory tenant ID before enabling.",
        ),
      );
      return;
    }
    const nextValues =
      provider === "slack" ? updatedSlack(state.values, body) : updatedTeams(state.values, body);
    void save(state, withPlugin(nextValues, provider), dialog, feedback);
  });
  dialog.addEventListener("cancel", (event) => {
    if (state.pending) event.preventDefault();
  });
  dialog.append(body);
  section.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
  dialog.querySelector("input, button")?.focus();
}

function updatedSlack(values, body) {
  const current = supportSlack(values).config;
  const existingConfig = providerConfig(values, "slack");
  const ids = uniqueList(body.querySelector("#slack-channel-ids").value.split(","));
  const users = uniqueList(body.querySelector("#slack-allowed-user-ids").value.split(","));
  const requireMention = body.querySelector("#slack-require-mention").checked;
  const existing = isRecord(current.channels) ? current.channels : {};
  const channels = {};
  for (const id of ids) {
    const entry = isRecord(existing[id]) ? { ...existing[id] } : {};
    channels[id] = { ...entry, requireMention };
  }
  const config = {
    ...current,
    enabled: body.querySelector("#slack-enabled").checked,
    mode: "socket",
    appToken: STANDARD_REFS.slack.appToken,
    botToken: STANDARD_REFS.slack.botToken,
    allowFrom: users,
    channels,
  };
  if (isRecord(existingConfig)) {
    if (current.dmPolicy !== undefined) config.dmPolicy = current.dmPolicy;
    if (current.groupPolicy !== undefined) config.groupPolicy = current.groupPolicy;
  } else {
    config.dmPolicy = "allowlist";
    config.groupPolicy = "allowlist";
  }
  return withProvider(values, "slack", config);
}

function updatedTeams(values, body) {
  const current = supportTeams(values).config;
  return withProvider(values, "msteams", {
    ...current,
    enabled: body.querySelector("#msteams-enabled").checked,
    appId: body.querySelector("#msteams-app-id").value.trim(),
    tenantId: body.querySelector("#msteams-tenant-id").value.trim(),
    appPassword: STANDARD_REFS.msteams.appPassword,
    requireMention: body.querySelector("#msteams-require-mention").checked,
  });
}

export function renderChannels({ values, executionMode, readOnly, onSave }) {
  const section = element("section", { className: "channels-section" });
  const state = {
    values,
    executionMode,
    readOnly,
    onSave,
    section,
    pending: false,
    error: element("div", { "aria-live": "polite" }),
    rerender: () => render(),
  };
  function render() {
    section.replaceChildren(
      element(
        "div",
        { className: "channel-heading" },
        element(
          "div",
          {},
          element("h2", {}, "Channels"),
          element(
            "p",
            { className: "muted" },
            readOnly
              ? "Live connection status unavailable. These are the selected AgentRevision’s immutable channel settings."
              : "Live connection status unavailable. Save updates the shared Configuration draft, not any active AgentRevision.",
          ),
        ),
      ),
      state.error,
      renderCard(section, state, "slack"),
      renderCard(section, state, "msteams"),
    );
  }
  render();
  return section;
}
