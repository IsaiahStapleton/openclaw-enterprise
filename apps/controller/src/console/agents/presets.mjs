import { element, button } from "../dom.mjs";
import { renderPresetTemplate } from "../preset-variables.mjs";
import { message, namespacePath } from "./list.mjs";

export function createPresetFields(context, { apply, confirmDiscard, onChange }) {
  const selector = element(
    "select",
    { id: "agent-preset", disabled: true },
    element("option", { value: "" }, "No Preset"),
  );
  const status = element("p", { className: "hint", role: "status" }, "Loading Presets…");
  const feedback = element("p", { className: "error", role: "alert" });
  const inputs = element("div");
  let selectedId = "";
  let selected;
  let fields = [];
  let loaded = false;
  let loading = false;
  let locked = false;
  let appliedInputs;
  let selectionVersion = 0;
  const snapshot = () =>
    JSON.stringify(fields.map(({ input }) => [input.value, input.dataset.supplied]));
  const ready = () => !selectedId || (selected && appliedInputs === snapshot());
  const applyButton = button("Apply Preset", () => {
    if (locked || loading || !selected) {
      return;
    }
    const previousAppliedInputs = appliedInputs;
    appliedInputs = undefined;
    onChange();
    try {
      const values = Object.create(null);
      for (const { name, definition, input } of fields) {
        if (!input.reportValidity()) {
          return;
        }
        if (input.dataset.supplied !== "true") {
          continue;
        }
        if (input.value === "" && definition.type !== "string") {
          continue;
        }
        values[name] =
          definition.type === "number"
            ? Number(input.value)
            : definition.type === "boolean"
              ? input.value === "true"
              : input.value;
      }
      const rendered = renderPresetTemplate(selected.template, values);
      if (!confirmDiscard()) {
        appliedInputs = previousAppliedInputs;
        onChange();
        return;
      }
      apply(rendered);
      appliedInputs = snapshot();
      feedback.textContent = "";
      status.textContent = "Preset applied. You can edit the launch settings below.";
    } catch (error) {
      feedback.textContent = error.message;
    }
    onChange();
  });
  const section = element(
    "fieldset",
    {},
    element("legend", {}, "Preset"),
    element("label", { for: selector.id }, "Preset template"),
    selector,
    status,
    inputs,
    applyButton,
    feedback,
  );
  function update() {
    selector.disabled = locked || loading || !loaded;
    applyButton.disabled = locked || loading || !selected;
    for (const { input } of fields) {
      input.disabled = locked;
    }
  }
  selector.addEventListener("change", async () => {
    if (locked || !confirmDiscard()) {
      selector.value = selectedId;
      return;
    }
    selectedId = selector.value;
    selected = undefined;
    appliedInputs = undefined;
    fields = [];
    inputs.replaceChildren();
    feedback.textContent = "";
    const version = ++selectionVersion;
    if (!selectedId) {
      apply({});
      status.textContent = "Using the standard Agent defaults.";
      onChange();
      return;
    }
    loading = true;
    status.textContent = "Loading Preset…";
    onChange();
    try {
      const preset = await context.request(
        `${namespacePath(context.namespaceId)}/presets/${encodeURIComponent(selectedId)}`,
      );
      if (!context.isCurrent() || version !== selectionVersion) {
        return;
      }
      selected = preset;
      fields = Object.entries(preset.template.variables ?? {}).map(([name, definition]) => {
        const input =
          definition.type === "boolean"
            ? element(
                "select",
                { id: `preset-variable-${name}` },
                element("option", { value: "" }, "Choose a value"),
                element("option", { value: "true" }, "True"),
                element("option", { value: "false" }, "False"),
              )
            : element("input", {
                id: `preset-variable-${name}`,
                type: definition.type === "number" ? "number" : "text",
                ...(definition.type === "number" ? { step: "any" } : {}),
                autocomplete: "off",
              });
        input.dataset.supplied = String(Object.hasOwn(definition, "default"));
        input.value = definition.default === undefined ? "" : String(definition.default);
        input.addEventListener("input", () => {
          input.dataset.supplied = "true";
          feedback.textContent = "";
          onChange();
        });
        input.addEventListener("change", () => {
          input.dataset.supplied = "true";
          onChange();
        });
        inputs.append(
          element(
            "div",
            { className: "form-field" },
            element("label", { for: input.id }, `Variable: ${name}`),
            input,
            definition.description
              ? element("p", { className: "hint" }, definition.description)
              : null,
          ),
        );
        return { name, definition, input };
      });
      status.textContent = "Fill in the variables, then apply this Preset.";
    } catch (error) {
      if (!context.isCurrent() || version !== selectionVersion) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
      } else {
        feedback.textContent = message(error);
      }
    } finally {
      if (context.isCurrent() && version === selectionVersion) {
        loading = false;
        onChange();
      }
    }
  });
  context
    .request(`${namespacePath(context.namespaceId)}/presets`)
    .then((presets) => {
      if (!context.isCurrent()) {
        return;
      }
      selector.append(
        ...presets.map((preset) => element("option", { value: preset.id }, preset.name)),
      );
      loaded = true;
      status.textContent = presets.length
        ? "Choose a Preset or start with the standard defaults."
        : "No Presets in this Namespace.";
      onChange();
    })
    .catch((error) => {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
      } else {
        status.textContent = `Presets unavailable. ${message(error)} You can continue without one.`;
      }
    });
  return {
    section,
    ready,
    setDisabled(value) {
      locked = value;
      update();
    },
  };
}
