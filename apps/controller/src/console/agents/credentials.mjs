import { element, button } from "../dom.mjs";
import { namespacePath } from "./list.mjs";

const SLACK_SECRET_BINDINGS = [
  { key: "SLACK_APP_TOKEN", label: "Slack app token", secretName: "Slack app token" },
  { key: "SLACK_BOT_TOKEN", label: "Slack bot token", secretName: "Slack bot token" },
];

function slackEnabled(values) {
  const slack = values?.channels?.slack;
  return (
    slack !== null && typeof slack === "object" && !Array.isArray(slack) && slack.enabled !== false
  );
}

function teamsEnabled(values) {
  const teams = values?.channels?.msteams;
  return (
    teams !== null && typeof teams === "object" && !Array.isArray(teams) && teams.enabled !== false
  );
}

function servicePrincipalId(agent) {
  return typeof agent?.servicePrincipalId === "string" && agent.servicePrincipalId.trim().length
    ? agent.servicePrincipalId
    : null;
}

function secretIdForBinding(binding) {
  const source = binding?.source;
  return source?.kind === "secret" &&
    typeof source.namespaceId === "string" &&
    typeof source.id === "string"
    ? source.id
    : null;
}

function secretBinding(secret) {
  return {
    source: secret.ref,
    delivery: { type: "env" },
  };
}

function hasSlackBindings(configuration) {
  return SLACK_SECRET_BINDINGS.every((binding) =>
    secretIdForBinding(configuration?.secretBindings?.[binding.key]),
  );
}

export function runtimeCredentialBlockReason(values) {
  return teamsEnabled(values)
    ? "Microsoft Teams credentials and readiness are operator-managed and cannot be confirmed by this Credentials tab. Use the operator deployment workflow for Teams, or disable Teams to deploy here."
    : null;
}

export function missingRuntimeCredentialGroups(status, values, configuration) {
  const missing = [];
  if (status?.transportConfigured !== true) {
    missing.push("Generated runtime credentials");
  }
  if (slackEnabled(values) && !hasSlackBindings(configuration)) {
    missing.push("Slack Secret bindings");
  }
  return missing;
}

export function hasRequiredRuntimeCredentials(status, values, configuration) {
  return (
    runtimeCredentialBlockReason(values) === null &&
    missingRuntimeCredentialGroups(status, values, configuration).length === 0
  );
}

function normalizedStatus(data) {
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof data.transportConfigured !== "boolean"
  ) {
    throw new Error("Invalid credential status response");
  }
  return {
    transportConfigured: data.transportConfigured,
  };
}

function credentialError(error, mutation = false) {
  let text;
  if (error.status === 403) {
    text = "Access denied. You do not have permission for this credential operation.";
  } else if (error.status === 409) {
    text = "Credential metadata conflicts with the saved Agent state or selected Secrets.";
  } else if (error.status === 400) {
    text = "Check the entered credential fields and refresh status.";
  } else if (error.status === 429) {
    text = "Too many requests. Wait before trying again.";
  } else if (error.status === 404) {
    text = "Credential metadata is unavailable for this Agent. Check the ID and your access.";
  } else if (error.status === 503 || mutation) {
    text =
      "Outcome unknown. Credential storage could not be confirmed. Refresh status before trying again.";
  } else {
    text = "Credential metadata unavailable. Refresh status before trying again.";
  }
  return text + (error.requestId ? ` Request ID: ${error.requestId}` : "");
}

function roleHasSecretOperatePermission(role) {
  return (
    Array.isArray(role?.permissions) &&
    role.permissions.length === 1 &&
    role.permissions[0]?.action === "operate" &&
    role.permissions[0]?.resourceKind === "secret"
  );
}

async function secretOperateRole(context) {
  const rolesPath = `${namespacePath(context.namespaceId)}/iam/roles`;
  const roles = await context.request(rolesPath);
  const existing = Array.isArray(roles) ? roles.find(roleHasSecretOperatePermission) : null;
  if (existing) {
    return existing;
  }
  return context.request(rolesPath, {
    method: "POST",
    body: {
      name: "Agent Secret operate",
      permissions: [{ action: "operate", resourceKind: "secret" }],
    },
  });
}

async function ensureSecretOperateBinding(context, agent, secret) {
  const principal = servicePrincipalId(agent);
  if (principal === null) {
    throw new Error("The API did not return this Agent's service principal.");
  }
  const role = await secretOperateRole(context);
  const bindingsPath = `${namespacePath(context.namespaceId)}/iam/access-bindings`;
  const bindings = await context.request(bindingsPath);
  if (
    Array.isArray(bindings) &&
    bindings.some(
      (binding) =>
        binding?.subjectKind === "identity" &&
        binding?.subjectId === principal &&
        binding?.roleId === role.id &&
        binding?.resourceKind === "secret" &&
        binding?.resourceId === secret.id,
    )
  ) {
    return;
  }
  await context.request(bindingsPath, {
    method: "POST",
    body: {
      subjectKind: "identity",
      subjectId: principal,
      roleId: role.id,
      resourceKind: "secret",
      resourceId: secret.id,
    },
  });
}

async function storeChannelSecret(context, state, binding, value) {
  const currentSecretId = secretIdForBinding(state.configuration.secretBindings?.[binding.key]);
  if (currentSecretId) {
    return context.request(`${namespacePath(context.namespaceId)}/secrets/${currentSecretId}`, {
      method: "PATCH",
      body: { value },
    });
  }
  return context.request(`${namespacePath(context.namespaceId)}/secrets`, {
    method: "POST",
    body: { name: `${state.agent.name} ${binding.secretName}`, value },
  });
}

function renderRuntimeMetadata(state) {
  const list = element("dl", { className: "credential-status-list" });
  const transportStored = state.status?.transportConfigured === true;
  list.append(
    element("dt", {}, "Generated runtime credentials"),
    element(
      "dd",
      {},
      element(
        "span",
        { className: `credential-status ${transportStored ? "stored" : "missing"}` },
        transportStored ? "Stored" : "Missing",
      ),
    ),
  );
  if (slackEnabled(state.values)) {
    for (const binding of SLACK_SECRET_BINDINGS) {
      const stored = Boolean(secretIdForBinding(state.configuration.secretBindings?.[binding.key]));
      list.append(
        element("dt", {}, binding.label),
        element(
          "dd",
          {},
          element(
            "span",
            { className: `credential-status ${stored ? "stored" : "missing"}` },
            stored ? "Bound" : "Missing",
          ),
        ),
      );
    }
  }
  return list;
}

export function createRuntimeCredentialsPanel({
  context,
  path,
  agent,
  configuration,
  values,
  revisionsLoaded,
  revisionCount,
  onConfigurationChange,
  onStatusChange,
}) {
  const endpoint = `${path}/runtime-credentials`;
  const state = {
    agent,
    configuration,
    values,
    status: null,
    loaded: false,
    loading: false,
    error: null,
    saving: false,
    saveError: null,
    saveMessage: "",
    outcomeUnknown: false,
  };
  const section = element("section", { className: "agent-card runtime-credentials" });

  function canMutateGeneratedCredentials() {
    return revisionsLoaded && revisionCount === 0 && state.loaded && state.error === null;
  }

  function canEnterChannelCredentials() {
    return (
      revisionsLoaded &&
      state.loaded &&
      state.error === null &&
      slackEnabled(state.values) &&
      servicePrincipalId(state.agent) !== null
    );
  }

  function canDeploy() {
    return (
      revisionsLoaded &&
      state.loaded &&
      state.error === null &&
      hasRequiredRuntimeCredentials(state.status, state.values, state.configuration)
    );
  }

  function deployGateMessage() {
    if (!revisionsLoaded) {
      return "Revision history is required before deploying this saved draft.";
    }
    if (state.loading || (!state.loaded && state.error === null)) {
      return "Loading runtime credential metadata before deployment.";
    }
    if (state.error !== null) {
      return "Credential metadata unavailable. Refresh status before deploying.";
    }
    const blockReason = runtimeCredentialBlockReason(state.values);
    if (blockReason !== null) {
      return blockReason;
    }
    const missing = missingRuntimeCredentialGroups(state.status, state.values, state.configuration);
    if (missing.length) {
      return `Deploy requires stored credential metadata: ${missing.join(", ")}.`;
    }
    return "Stored credential metadata is present. This does not confirm live channel readiness.";
  }

  async function loadStatus() {
    if (state.loading || !context.isCurrent()) {
      return;
    }
    state.loading = true;
    state.error = null;
    state.saveError = null;
    state.saveMessage = "";
    state.outcomeUnknown = false;
    render();
    onStatusChange();
    try {
      state.status = normalizedStatus(await context.request(endpoint));
      if (!context.isCurrent()) {
        return;
      }
      state.loaded = true;
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      state.status = null;
      state.loaded = false;
      state.error = error;
    } finally {
      if (context.isCurrent()) {
        state.loading = false;
        render();
        onStatusChange();
      }
    }
  }

  async function saveGeneratedCredentials() {
    if (state.saving || !canMutateGeneratedCredentials()) {
      return;
    }
    state.saving = true;
    state.saveError = null;
    state.saveMessage = "";
    state.outcomeUnknown = false;
    render();
    onStatusChange();
    try {
      state.status = normalizedStatus(
        await context.request(endpoint, { method: "POST", body: {} }),
      );
      if (!context.isCurrent()) {
        return;
      }
      state.loaded = true;
      state.saveMessage = "Generated runtime credential metadata refreshed.";
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      if (cause.status === 401) {
        context.onExpired();
        return;
      }
      state.saveError = cause;
      state.outcomeUnknown =
        cause.status === undefined || ![400, 403, 404, 409, 429].includes(cause.status);
    } finally {
      if (context.isCurrent()) {
        state.saving = false;
        render();
        onStatusChange();
      }
    }
  }

  function renderChannelForm() {
    if (!slackEnabled(state.values)) {
      return null;
    }
    const formId = "runtime-channel-secrets-form";
    const appToken = element("input", {
      id: "runtime-slack-app-token",
      name: "runtime-slack-app-token",
      type: "password",
      autocomplete: "off",
      disabled: !canEnterChannelCredentials(),
      "aria-describedby": "runtime-slack-app-token-hint",
    });
    const botToken = element("input", {
      id: "runtime-slack-bot-token",
      name: "runtime-slack-bot-token",
      type: "password",
      autocomplete: "off",
      disabled: !canEnterChannelCredentials(),
      "aria-describedby": "runtime-slack-bot-token-hint",
    });
    const status = element("p", { className: "hint", role: "status" });
    const error = element(
      "p",
      { className: "error", role: "alert" },
      state.saveError === null ? "" : credentialError(state.saveError, true),
    );
    const save = element(
      "button",
      { type: "submit", form: formId, className: "primary" },
      "Save channel Secrets",
    );
    const updateControls = () => {
      const appEntered = appToken.value.length > 0;
      const botEntered = botToken.value.length > 0;
      const partial = appEntered !== botEntered;
      const existingBound = hasSlackBindings(state.configuration);
      appToken.setCustomValidity(partial ? "Enter both Slack tokens." : "");
      botToken.setCustomValidity(partial ? "Enter both Slack tokens." : "");
      save.disabled =
        state.saving ||
        !canEnterChannelCredentials() ||
        state.outcomeUnknown ||
        partial ||
        (!existingBound && (!appEntered || !botEntered)) ||
        (existingBound && !appEntered && !botEntered);
    };
    for (const input of [appToken, botToken]) {
      input.addEventListener("input", () => {
        state.saveError = null;
        state.saveMessage = "";
        error.textContent = "";
        status.textContent = "";
        updateControls();
      });
    }
    const form = element(
      "form",
      { id: formId, className: "credential-form" },
      element(
        "div",
        { className: "form-field" },
        element("label", { for: appToken.id }, "Slack app token"),
        appToken,
        element(
          "p",
          { id: "runtime-slack-app-token-hint", className: "hint" },
          "Stored as a Namespace Secret and delivered to the runtime gateway.",
        ),
      ),
      element(
        "div",
        { className: "form-field" },
        element("label", { for: botToken.id }, "Slack bot token"),
        botToken,
        element(
          "p",
          { id: "runtime-slack-bot-token-hint", className: "hint" },
          "Stored as a Namespace Secret and delivered to the runtime gateway.",
        ),
      ),
      status,
      error,
      element("div", { className: "form-actions" }, save),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.saving || !canEnterChannelCredentials() || state.outcomeUnknown) {
        return;
      }
      if (!form.reportValidity()) {
        return;
      }
      const valuesByKey = new Map([
        ["SLACK_APP_TOKEN", appToken.value],
        ["SLACK_BOT_TOKEN", botToken.value],
      ]);
      if ([...valuesByKey.values()].some((value) => value.length === 0)) {
        return;
      }
      state.saving = true;
      state.saveError = null;
      state.saveMessage = "";
      status.textContent = "Saving channel Secrets...";
      error.textContent = "";
      updateControls();
      let mutationStarted = false;
      try {
        const bindings = { ...(state.configuration.secretBindings ?? {}) };
        for (const binding of SLACK_SECRET_BINDINGS) {
          mutationStarted = true;
          const secret = await storeChannelSecret(
            context,
            state,
            binding,
            valuesByKey.get(binding.key),
          );
          await ensureSecretOperateBinding(context, state.agent, secret);
          bindings[binding.key] = secretBinding(secret);
        }
        state.configuration = await context.request(
          `${namespacePath(context.namespaceId)}/configurations/${encodeURIComponent(
            state.configuration.id,
          )}`,
          {
            method: "PATCH",
            body: { values: state.values, secretBindings: bindings },
          },
        );
        if (!context.isCurrent()) {
          return;
        }
        state.values = state.configuration.values;
        onConfigurationChange?.(state.configuration);
        state.outcomeUnknown = false;
        state.saveMessage =
          "Channel Secrets saved. Deploy the saved draft to deliver the new bindings.";
        status.textContent = state.saveMessage;
      } catch (cause) {
        if (!context.isCurrent()) {
          return;
        }
        if (cause.status === 401) {
          context.onExpired();
          return;
        }
        state.saveError = cause;
        state.saveMessage = "";
        state.outcomeUnknown = mutationStarted && ![400, 403, 404, 409, 429].includes(cause.status);
        status.textContent = "";
        error.textContent = credentialError(cause, true);
      } finally {
        appToken.value = "";
        botToken.value = "";
        if (context.isCurrent()) {
          state.saving = false;
          updateControls();
          render();
          onStatusChange();
        }
      }
    });
    updateControls();
    return form;
  }

  function renderUnavailableReason() {
    if (!revisionsLoaded) {
      return element(
        "p",
        { className: "muted", role: "status" },
        "Credential entry requires readable revision history.",
      );
    }
    if (state.error !== null) {
      return element(
        "p",
        { className: "error", role: "alert" },
        `Credential metadata unavailable. ${credentialError(state.error)}`,
      );
    }
    if (slackEnabled(state.values) && servicePrincipalId(state.agent) === null) {
      return element(
        "p",
        { className: "error", role: "alert" },
        "The API did not return this Agent's service principal, so the console cannot bind Secrets.",
      );
    }
    if (revisionCount > 0) {
      return element(
        "p",
        { className: "muted", role: "status" },
        "Generated runtime credentials are locked after the first AgentRevision exists.",
      );
    }
    return null;
  }

  function render() {
    section.replaceChildren(
      ...[
        element("h2", {}, "Runtime credentials"),
        element(
          "p",
          { className: "muted" },
          "Generate connection credentials, store channel tokens, then deploy the saved draft to apply them. Stored status does not confirm live readiness.",
        ),
        renderRuntimeMetadata(state),
        state.saveMessage
          ? element("p", { className: "hint", role: "status" }, state.saveMessage)
          : null,
        state.saveError
          ? element(
              "p",
              { className: "error", role: "alert" },
              credentialError(state.saveError, true),
            )
          : null,
        element(
          "div",
          { className: "form-actions credential-actions" },
          button(state.loading ? "Refreshing..." : "Refresh status", () => void loadStatus(), {
            disabled: state.loading || state.saving,
          }),
          button("Provision generated runtime credentials", () => void saveGeneratedCredentials(), {
            disabled: state.loading || state.saving || !canMutateGeneratedCredentials(),
          }),
        ),
        renderUnavailableReason(),
        renderChannelForm(),
      ].filter(Boolean),
    );
  }

  render();
  return {
    section,
    loadStatus,
    canDeploy,
    deployGateMessage,
  };
}
