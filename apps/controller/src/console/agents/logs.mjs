import { element, button } from "../dom.mjs";
import { displayDate, namespacePath } from "./list.mjs";

const STATUS_POLL_MS = 10_000;
const FOLLOW_POLL_MS = 2_000;
const MAX_ROWS = 5_000;
const TAIL_LINES = 200;
// A 403 is audited; remember it for this page session instead of re-asking every poll.
const deniedLogViews = new Set();

const SOURCE_LABELS = { gateway: "Gateway", agent: "Agent (Harness)" };
const GAP_LABELS = {
  stream_replaced: "Container restarted",
  window_exceeded: "Lines skipped",
  cursor_expired: "View resumed",
  truncated: "Page limit reached",
};
const WITHHELD_LABELS = {
  unrecognised_structured: "structured output withheld",
  oversized: "oversized lines withheld",
  malformed: "malformed structured lines withheld",
};

function runtimeErrorText(error, tier) {
  if (error.status === 403) {
    return tier === "logs"
      ? "Log text requires Agent administer and read access plus read access to this version."
      : "Runtime status requires Agent operate and read access plus read access to this version.";
  }
  if (error.status === 501) {
    return "This Compute Driver does not expose runtime status or logs, or an operator turned them off.";
  }
  if (error.code === "RUNTIME_LOGS_CLUSTER_RBAC") {
    return "The cluster denied the read. Ask your platform operator to enable agentRuntimeLogs in the Helm chart (see the Agent logs guide).";
  }
  if (error.status === 429) {
    return "Too many requests. Waiting before the next read.";
  }
  if (error.status === 504) {
    return "The read timed out. Try again.";
  }
  if (error.code === "RUNTIME_LOGS_AUDIT_UNAVAILABLE") {
    return "The view could not be audited, so no output was read. Try again.";
  }
  if (error.status === 404) {
    return "This version is not available.";
  }
  return "Runtime status or logs are unavailable. Try again shortly.";
}

function withRequestId(text, error) {
  return error.requestId ? `${text} Request ID: ${error.requestId}` : text;
}

function age(timestamp) {
  const started = Date.parse(timestamp ?? "");
  if (!Number.isFinite(started)) {
    return "Unknown age";
  }
  const minutes = Math.max(0, Math.round((Date.now() - started) / 60_000));
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

function podCard(pod) {
  const container = pod.containers.find(({ name }) => name === pod.role) ?? pod.containers[0];
  const termination = container?.lastTermination;
  const details = element("dl", { className: "credential-status-list" });
  const add = (name, value) => details.append(element("dt", {}, name), element("dd", {}, value));
  add("Phase", pod.phase);
  add("Ready", pod.ready ? "Yes" : "No");
  add("Restarts", String(container?.restartCount ?? 0));
  if (container && container.state !== "running") {
    add("State", `${container.state}${container.reason ? ` · ${container.reason}` : ""}`);
  }
  if (termination) {
    add(
      "Last termination",
      [
        termination.reason ?? "Unknown reason",
        termination.exitCode === null ? null : `exit ${termination.exitCode}`,
        termination.finishedAt ? displayDate(termination.finishedAt) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  add("Age", age(pod.createdAt));
  const warnings = pod.events.filter(({ type }) => type === "Warning").slice(0, 5);
  return element(
    "article",
    { className: "runtime-pod", "aria-label": `${SOURCE_LABELS[pod.role]} Pod ${pod.name}` },
    element(
      "h4",
      {},
      `${SOURCE_LABELS[pod.role] ?? pod.role}${pod.cluster === "execution" ? " · execution cluster" : ""}`,
    ),
    element("p", { className: "muted" }, pod.name),
    details,
    warnings.length
      ? element(
          "ul",
          { className: "runtime-events", "aria-label": "Recent warning Events" },
          ...warnings.map((event) =>
            element(
              "li",
              {},
              `${event.reason}${event.count > 1 ? ` ×${event.count}` : ""}: ${event.message}`,
            ),
          ),
        )
      : null,
  );
}

function recordRow(record) {
  if (record.type === "gap") {
    return element(
      "div",
      { className: "log-row log-row-gap", role: "note" },
      element("strong", {}, GAP_LABELS[record.reason] ?? record.reason),
      element("span", {}, ` ${record.remedy}`),
    );
  }
  if (record.type === "withheld") {
    return element(
      "div",
      { className: "log-row log-row-withheld", role: "note" },
      `${record.count} ${WITHHELD_LABELS[record.reason] ?? "lines withheld"}`,
    );
  }
  const summary = element(
    "span",
    { className: "log-line" },
    element("span", { className: "log-time" }, record.time ? displayDate(record.time) : "—"),
    element("span", { className: `log-level log-level-${record.level}` }, record.level),
    element("span", { className: "log-kind" }, record.kind),
    record.subsystem ? element("span", { className: "log-subsystem" }, record.subsystem) : null,
    element("span", { className: "log-message" }, record.message),
  );
  if (!record.fields || Object.keys(record.fields).length === 0) {
    return element("div", { className: "log-row" }, summary);
  }
  const fields = element("dl", { className: "log-fields" });
  for (const [name, value] of Object.entries(record.fields)) {
    fields.append(element("dt", {}, name), element("dd", {}, String(value)));
  }
  return element("details", { className: "log-row" }, element("summary", {}, summary), fields);
}

/** Logs tab: runtime status strip, source picker, bounded log pane and follow. */
export function renderAgentLogs(context, { agent, revisionId }) {
  const base = `${namespacePath(context.namespaceId)}/agents/${encodeURIComponent(agent.id)}/deployments/${encodeURIComponent(revisionId)}/runtime`;
  const deniedKey = `${context.namespaceId}/${agent.id}`;
  const section = element("section", { className: "agent-logs" });
  const strip = element("div", { className: "runtime-strip", "aria-live": "polite" });
  const stripStatus = element(
    "p",
    { className: "muted", role: "status" },
    "Loading runtime status…",
  );
  const sourceSelect = element("select", { id: "runtime-log-source", disabled: true });
  const podSelect = element("select", { id: "runtime-log-pod", hidden: true });
  const podLabel = element("label", { for: "runtime-log-pod", hidden: true }, "Pod");
  const previous = element("input", {
    type: "checkbox",
    id: "runtime-log-previous",
    disabled: true,
  });
  const followButton = button("Follow", () => setFollow(!following), {
    "aria-pressed": "false",
    disabled: true,
  });
  const refreshButton = button("Refresh logs", () => void readLogs({ restart: true }), {
    disabled: true,
  });
  const retention = element("p", { className: "hint" });
  const logStatus = element("p", { className: "muted", role: "status" });
  const logError = element("p", { className: "error", role: "alert", hidden: true });
  const pane = element("div", {
    className: "log-pane",
    role: "log",
    tabindex: "0",
    "aria-label": "Runtime log output",
  });

  let description = null;
  let cursor = null;
  let following = false;
  let followTimer;
  let statusTimer;
  let reading = false;
  let rows = 0;
  let logsDenied = deniedLogViews.has(deniedKey);

  const current = () => context.isCurrent();

  function selectedSource() {
    return description?.sources.find(({ id }) => id === sourceSelect.value);
  }

  function selectedPod() {
    const source = selectedSource();
    return source?.pods.find(({ name }) => name === podSelect.value) ?? source?.pods[0];
  }

  function showLogError(text) {
    logError.hidden = text === null;
    logError.textContent = text ?? "";
  }

  function renderStrip() {
    if (!description) {
      return;
    }
    stripStatus.textContent = `Observed ${displayDate(description.observedAt)}`;
    strip.replaceChildren(
      ...(description.pods.length
        ? description.pods.map(podCard)
        : [
            element(
              "p",
              { className: "muted" },
              "This version has no running Pod. See Deployment activity.",
            ),
          ]),
    );
  }

  function renderPickers() {
    const chosen = sourceSelect.value;
    sourceSelect.replaceChildren(
      ...description.sources.map((source) =>
        element(
          "option",
          { value: source.id, disabled: !source.available },
          `${SOURCE_LABELS[source.id] ?? source.id}${source.available ? "" : " (no Pod)"}`,
        ),
      ),
    );
    const available = description.sources.find(({ available }) => available);
    sourceSelect.value = description.sources.some(({ id, available: ok }) => id === chosen && ok)
      ? chosen
      : (available?.id ?? description.sources[0]?.id ?? "");
    const source = selectedSource();
    const chosenPod = podSelect.value;
    podSelect.replaceChildren(
      ...(source?.pods ?? []).map((pod) => element("option", { value: pod.name }, pod.name)),
    );
    podSelect.hidden = (source?.pods.length ?? 0) <= 1;
    podLabel.hidden = podSelect.hidden;
    if (source?.pods.some(({ name }) => name === chosenPod)) {
      podSelect.value = chosenPod;
    }
    retention.textContent = source?.retention ?? "";
    const pod = selectedPod();
    previous.disabled = logsDenied || !pod || pod.restartCount === 0;
    if (previous.disabled) {
      previous.checked = false;
    }
    const readable = !logsDenied && Boolean(pod);
    sourceSelect.disabled = logsDenied || description.sources.length === 0;
    refreshButton.disabled = !readable;
    followButton.disabled = !readable || previous.checked;
  }

  async function loadStatus() {
    clearTimeout(statusTimer);
    if (!current()) {
      return;
    }
    if (!document.hidden) {
      try {
        const first = description === null;
        description = await context.request(base);
        if (!current()) {
          return;
        }
        renderStrip();
        renderPickers();
        if (first && !logsDenied) {
          void readLogs({ restart: true });
        }
      } catch (error) {
        if (!current()) {
          return;
        }
        if (error.status === 401) {
          context.onExpired();
          return;
        }
        stripStatus.textContent = withRequestId(runtimeErrorText(error, "status"), error);
        // Authorization and support failures do not change on their own.
        if ([403, 404, 501].includes(error.status)) {
          return;
        }
      }
    }
    statusTimer = setTimeout(() => void loadStatus(), STATUS_POLL_MS);
  }

  function appendRecords(records) {
    const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 24;
    for (const record of records) {
      pane.append(recordRow(record));
      rows += 1;
    }
    while (rows > MAX_ROWS && pane.firstChild) {
      pane.firstChild.remove();
      rows -= 1;
    }
    if (atBottom) {
      pane.scrollTop = pane.scrollHeight;
    }
  }

  function setFollow(next) {
    following = next && !logsDenied && !previous.checked;
    followButton.setAttribute("aria-pressed", String(following));
    followButton.textContent = following ? "Following" : "Follow";
    clearTimeout(followTimer);
    if (following) {
      scheduleFollow(FOLLOW_POLL_MS);
    }
  }

  function scheduleFollow(delay) {
    clearTimeout(followTimer);
    followTimer = setTimeout(() => {
      if (!current() || !following) {
        return;
      }
      // Pause while hidden or while the reader scrolled up; resume on the next tick.
      const scrolledUp = pane.scrollTop + pane.clientHeight < pane.scrollHeight - 24;
      if (document.hidden || scrolledUp) {
        scheduleFollow(FOLLOW_POLL_MS);
        return;
      }
      void readLogs({ restart: false });
    }, delay);
  }

  async function readLogs({ restart }) {
    const source = selectedSource();
    const pod = selectedPod();
    if (!current() || reading || logsDenied || !source || !pod) {
      if (source && !pod) {
        logStatus.textContent = "This version has no running Pod for this source.";
      }
      return;
    }
    reading = true;
    if (restart) {
      cursor = null;
      pane.replaceChildren();
      rows = 0;
      logStatus.textContent = "Reading output…";
    }
    const query = new URLSearchParams({ source: source.id, pod: pod.name });
    if (previous.checked) {
      query.set("previous", "true");
    }
    if (restart) {
      query.set("tailLines", String(TAIL_LINES));
    }
    if (cursor) {
      query.set("cursor", cursor);
    }
    let retryAfter = FOLLOW_POLL_MS;
    try {
      const page = await context.request(`${base}/logs?${query}`);
      if (!current()) {
        return;
      }
      showLogError(null);
      cursor = page.cursor;
      appendRecords(page.records);
      const lines = page.records.filter(({ type }) => type === "line").length;
      if (restart) {
        logStatus.textContent =
          page.stream === null
            ? "This version has no running Pod for this source."
            : lines === 0 && page.withheld > 0
              ? `Only withheld output in the last ${TAIL_LINES} lines.`
              : lines === 0
                ? `No output in the last ${TAIL_LINES} lines.`
                : `Showing ${previous.checked ? "the previous instance of " : ""}${pod.container} in ${pod.name}.`;
      }
    } catch (error) {
      if (!current()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      if (error.code === "RUNTIME_LOGS_CURSOR_INVALID") {
        // A new audited view replaces a rejected cursor.
        cursor = null;
        reading = false;
        void readLogs({ restart: true });
        return;
      }
      if (restart) {
        logStatus.textContent = "";
      }
      showLogError(withRequestId(runtimeErrorText(error, "logs"), error));
      if (error.status === 403) {
        // Never re-poll after a denial; the view needs new grants.
        logsDenied = true;
        deniedLogViews.add(deniedKey);
        setFollow(false);
        renderPickers();
      } else if (error.status === 501) {
        setFollow(false);
      } else {
        retryAfter = Math.max(FOLLOW_POLL_MS, (error.retryAfterSeconds ?? 10) * 1000);
      }
    } finally {
      reading = false;
    }
    if (following && current()) {
      scheduleFollow(retryAfter);
    }
  }

  sourceSelect.addEventListener("change", () => {
    podSelect.value = "";
    renderPickers();
    void readLogs({ restart: true });
  });
  podSelect.addEventListener("change", () => {
    renderPickers();
    void readLogs({ restart: true });
  });
  previous.addEventListener("change", () => {
    if (previous.checked) {
      setFollow(false);
    }
    renderPickers();
    void readLogs({ restart: true });
  });

  section.append(
    element("h3", {}, "Runtime"),
    stripStatus,
    strip,
    element("h3", {}, "Logs"),
    element(
      "p",
      { className: "muted" },
      "Operational output only: credential-shaped text is masked and structured payloads, prompts and protocol traffic are withheld. Nothing here is stored.",
    ),
    element(
      "div",
      { className: "log-toolbar" },
      element("label", { for: "runtime-log-source" }, "Source"),
      sourceSelect,
      podLabel,
      podSelect,
      element("label", { className: "checkbox" }, previous, " Previous instance"),
      followButton,
      refreshButton,
    ),
    retention,
    logStatus,
    logError,
    pane,
  );
  if (logsDenied) {
    showLogError(runtimeErrorText({ status: 403 }, "logs"));
  }
  void loadStatus();
  return section;
}
