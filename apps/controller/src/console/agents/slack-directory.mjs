import { button, element } from "../dom.mjs";
import { namespacePath } from "./list.mjs";

const USER_ID = /^[UW][A-Z0-9]{1,31}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{1,31}$/;
const nameLookupCache = new WeakMap();

export function isSlackId(value, kind) {
  return (kind === "users" ? USER_ID : CHANNEL_ID).test(value);
}

export function isSlackConfigTarget(value, kind) {
  const qualified = /^team:(T[A-Z0-9]+):(user|channel):([A-Z][A-Z0-9]+)$/i.exec(value);
  if (qualified) {
    return (
      qualified[2].toLowerCase() === (kind === "users" ? "user" : "channel") &&
      (kind === "users" ? /^[BUW][A-Z0-9]+$/i : /^[CDG][A-Z0-9]+$/i).test(qualified[3])
    );
  }
  return kind === "users"
    ? /^(?:(?:user|slack):)?[BUW][A-Z0-9]+$/i.test(value) || /^<@[BUW][A-Z0-9]+>$/i.test(value)
    : /^(?:channel:)?[CDG][A-Z0-9]+$/i.test(value);
}

function directoryTarget(value, kind) {
  const qualified = /^team:(T[A-Z0-9]+):(user|channel):([A-Z][A-Z0-9]+)$/i.exec(value);
  if (qualified) {
    const id = qualified[3].toUpperCase();
    return qualified[2].toLowerCase() === (kind === "users" ? "user" : "channel") &&
      isSlackId(id, kind)
      ? { id, teamId: qualified[1].toUpperCase() }
      : null;
  }
  const unqualified =
    kind === "users"
      ? (/^(?:(?:user|slack):)?([UW][A-Z0-9]+)$/i.exec(value) ??
        /^<@([UW][A-Z0-9]+)>$/i.exec(value))
      : /^(?:channel:)?([CG][A-Z0-9]+)$/i.exec(value);
  const id = unqualified?.[1]?.toUpperCase();
  return id && isSlackId(id, kind) ? { id } : null;
}

function searchTarget(value, kind) {
  // Bare Slack IDs are canonical uppercase; native saved targets may use older casings.
  if (value.length >= 8 && isSlackId(value, kind)) {
    return directoryTarget(value, kind);
  }
  return /^(?:team:|user:|slack:|channel:|<@)/i.test(value) ? directoryTarget(value, kind) : null;
}

export function matchesSlackDirectoryCandidate(value, kind, candidate) {
  const target = directoryTarget(value, kind);
  return target?.id === candidate.id && (!target.teamId || target.teamId === candidate.workspaceId);
}

function lookupError(error) {
  const reason = {
    CHANNEL_DIRECTORY_CREDENTIALS_REJECTED:
      "Slack rejected this bot token. Check the selected Secret.",
    CHANNEL_DIRECTORY_MISSING_SCOPE:
      "The Slack bot token needs users:read for people and channel read scopes for channels.",
    CHANNEL_DIRECTORY_RATE_LIMITED: "Slack rate limited the directory. Try again shortly.",
    CHANNEL_DIRECTORY_UNAVAILABLE: "Slack directory is unavailable. Try again shortly.",
    CHANNEL_DIRECTORY_INVALID_RESPONSE: "Slack returned an unexpected directory response.",
  }[error.code];
  if (error.status === 403) {
    return "You need access to this Agent or Configuration and permission to use its selected Slack bot Secret.";
  }
  return reason ?? error.message ?? "Slack directory could not be loaded.";
}

// Names are a transient view of exact IDs; the selected Secret remains the authority for lookup.
export function createSlackNameResolver({
  context,
  kind,
  getSecretId,
  agentId,
  configurationId,
  onUpdate,
}) {
  let generation = 0;
  const invalidate = () => {
    generation += 1;
    onUpdate({ names: new Map() });
  };
  const refresh = async (ids) => {
    const active = ++generation;
    const secretId = getSecretId();
    const uniqueIds = [...new Set(ids.filter((id) => isSlackId(id, kind)))];
    const requestedIds = uniqueIds.slice(0, 20);
    const truncated = uniqueIds.length > requestedIds.length;
    onUpdate({ names: new Map(), truncated, loading: Boolean(secretId && requestedIds.length) });
    if (!secretId || requestedIds.length === 0) {
      return;
    }
    try {
      let cache = nameLookupCache.get(context);
      if (!cache) {
        cache = new Map();
        nameLookupCache.set(context, cache);
      }
      const key = JSON.stringify([
        secretId,
        kind,
        agentId ?? null,
        configurationId ?? null,
        [...requestedIds].sort(),
      ]);
      let request = cache.get(key);
      if (!request) {
        if (cache.size >= 100) {
          cache.delete(cache.keys().next().value);
        }
        request = context.request(
          `${namespacePath(context.namespaceId)}/channel-directory/lookup`,
          {
            method: "POST",
            body: {
              secretId,
              kind,
              ids: requestedIds,
              ...(agentId ? { agentId } : {}),
              ...(configurationId ? { configurationId } : {}),
            },
          },
        );
        cache.set(key, request);
        // Share simultaneous fields, then reread the Secret for later views of the same ID.
        const clear = () => {
          if (cache.get(key) === request) {
            cache.delete(key);
          }
        };
        request.then(clear, clear);
      }
      const page = await request;
      if (!context.isCurrent() || active !== generation || getSecretId() !== secretId) {
        return;
      }
      const names = new Map(
        page.candidates
          .filter((candidate) => requestedIds.includes(candidate.id))
          .map((candidate) => [candidate.id, candidate]),
      );
      onUpdate({
        names,
        workspaceId: page.workspaceId,
        workspaceName: page.workspaceName,
        truncated,
      });
    } catch (error) {
      if (!context.isCurrent() || active !== generation) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      onUpdate({ names: new Map(), truncated, error: lookupError(error) });
    }
  };
  return { refresh, invalidate };
}

export function createSlackIdLabels({ context, kind, getSecretId, configurationId, control }) {
  const ids = element("div", { className: "slack-directory-saved-ids" });
  const status = element("p", { className: "hint", role: "status" });
  let nameState = { names: new Map() };
  const values = () => [
    ...new Set(
      control.value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  const render = () => {
    const saved = values();
    ids.replaceChildren(
      ...saved.map((id) => {
        const target = directoryTarget(id, kind);
        const candidate =
          target && (!target.teamId || target.teamId === nameState.workspaceId)
            ? nameState.names.get(target.id)
            : null;
        return element(
          "span",
          { className: "slack-directory-saved-id" },
          candidate
            ? element(
                "strong",
                {},
                kind === "channels"
                  ? `#${candidate.name}`
                  : candidate.displayName || candidate.name,
              )
            : null,
          element("code", {}, id),
        );
      }),
    );
    const mismatchedWorkspace = saved.some((value) => {
      const target = directoryTarget(value, kind);
      return target?.teamId && nameState.workspaceId && target.teamId !== nameState.workspaceId;
    });
    status.textContent = nameState.error
      ? `${nameState.error} Saved IDs remain available.`
      : nameState.loading
        ? "Resolving saved Slack names…"
        : nameState.workspaceId
          ? `Workspace: ${nameState.workspaceName ? `${nameState.workspaceName} · ` : ""}${nameState.workspaceId}${mismatchedWorkspace ? ". Some saved targets belong to another workspace." : ""}`
          : saved.length && !getSecretId()
            ? "Select a Slack bot token Secret to show names."
            : "";
    if (nameState.truncated) {
      status.textContent += " Only the first 20 IDs are resolved; all IDs remain visible.";
    }
  };
  const resolver = createSlackNameResolver({
    context,
    kind,
    getSecretId,
    configurationId,
    onUpdate: (state) => {
      nameState = state;
      render();
    },
  });
  const refresh = () =>
    void resolver.refresh(
      values()
        .map((value) => directoryTarget(value, kind)?.id)
        .filter(Boolean),
    );
  control.addEventListener("input", () => resolver.invalidate());
  control.addEventListener("change", refresh);
  refresh();
  const field = element("div", { className: "slack-directory-labels" }, ids, status);
  field.refreshNames = refresh;
  return field;
}

// A lookup uses the staged Secret on each request. A changed binding cannot reuse old pages.
export function createSlackDirectoryPicker({
  context,
  kind,
  getSecretId,
  agentId,
  configurationId,
  onSelect,
  onWorkspace,
  label = kind === "users" ? "Find Slack user" : "Find Slack channel",
  saveDescription = "Only its Slack ID is saved.",
}) {
  const search = element("input", {
    type: "search",
    "aria-label": kind === "users" ? "Search Slack people" : "Search Slack channels",
    placeholder: kind === "users" ? "Name, display name, or user ID" : "Name or channel ID",
  });
  const status = element("p", { className: "hint", role: "status" });
  const errorText = element("p", { className: "error", role: "alert" });
  const workspace = element("p", { className: "hint" });
  const results = element("div", { className: "slack-directory-results" });
  const previous = button("Previous page", () => void load(pageIndex - 1));
  const next = button("Next page", () => void load(pageIndex + 1));
  const pagination = element("div", { className: "slack-directory-pagination" }, previous, next);
  const dialog = element(
    "dialog",
    { className: "slack-directory-dialog", "aria-label": label },
    element(
      "div",
      { className: "slack-directory-heading" },
      element("h3", {}, label),
      button("Close", () => dialog.close()),
    ),
    element("p", { className: "hint" }, `Choose a result by its name and ID. ${saveDescription}`),
    element(
      "div",
      { className: "slack-directory-search" },
      search,
      button("Search", () => void startSearch()),
    ),
    workspace,
    status,
    errorText,
    results,
    pagination,
  );
  const open = button(label, () => {
    const secretId = getSecretId();
    if (!secretId) {
      status.textContent = "Select a Slack bot token Secret under Channels first.";
      errorText.textContent = "";
      workspace.textContent = "";
      results.replaceChildren();
      pagination.hidden = true;
      dialog.showModal();
      return;
    }
    dialog.showModal();
    search.focus();
    void startSearch();
  });
  let generation = 0;
  let pageIndex = 0;
  let cursors = [null];
  let query = "";
  let nextCursor = null;
  let busy = false;
  let workspaceIdentity = null;
  let workspaceSecretId = null;

  dialog.addEventListener("close", () => {
    generation += 1;
    busy = false;
    open.focus();
  });
  search.addEventListener("input", () => {
    generation += 1;
    busy = false;
    results.replaceChildren();
    pagination.hidden = true;
    status.textContent = "Choose Search to find matches for this text.";
    errorText.textContent = "";
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void startSearch();
    }
  });

  function startSearch() {
    // An explicit new search supersedes an older in-flight page.
    generation += 1;
    busy = false;
    query = search.value.trim();
    workspaceIdentity = null;
    workspaceSecretId = null;
    onWorkspace?.(null, getSecretId());
    cursors = [null];
    pageIndex = 0;
    nextCursor = null;
    return load(0);
  }

  async function load(index) {
    const secretId = getSecretId();
    if (busy || !secretId || (index > pageIndex && !nextCursor)) {
      return;
    }
    const cursor = index > pageIndex ? nextCursor : cursors[index];
    const exactTarget = searchTarget(query, kind);
    const active = ++generation;
    busy = true;
    status.textContent = "Searching Slack directory…";
    errorText.textContent = "";
    workspace.textContent = "";
    results.replaceChildren();
    pagination.hidden = true;
    previous.disabled = true;
    next.disabled = true;
    try {
      const requestPage = (selection) =>
        context.request(`${namespacePath(context.namespaceId)}/channel-directory/lookup`, {
          method: "POST",
          body: {
            secretId,
            kind,
            ...selection,
            ...(agentId ? { agentId } : {}),
            ...(configurationId ? { configurationId } : {}),
          },
        });
      let page = await requestPage(
        exactTarget
          ? { ids: [exactTarget.id] }
          : { ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) },
      );
      if (
        exactTarget &&
        query.length >= 8 &&
        isSlackId(query, kind) &&
        page.candidates.length === 0 &&
        dialog.open &&
        context.isCurrent() &&
        active === generation &&
        getSecretId() === secretId
      ) {
        const exactWorkspaceId = page.workspaceId;
        page = await requestPage({ query });
        if (page.workspaceId !== exactWorkspaceId) {
          status.textContent =
            "The Slack bot workspace changed during this search. Start a new search.";
          return;
        }
      }
      if (!dialog.open || !context.isCurrent() || active !== generation) {
        return;
      }
      if (getSecretId() !== secretId) {
        status.textContent = "The selected Slack bot Secret changed. Search again.";
        return;
      }
      if (
        workspaceSecretId === secretId &&
        workspaceIdentity !== null &&
        workspaceIdentity !== page.workspaceId
      ) {
        status.textContent =
          "The Slack bot workspace changed during this search. Start a new search.";
        return;
      }
      workspaceSecretId = secretId;
      workspaceIdentity = page.workspaceId;
      onWorkspace?.(page.workspaceId, secretId);
      pageIndex = index;
      cursors[index] = cursor;
      nextCursor = page.nextCursor ?? null;
      workspace.textContent = `Workspace: ${page.workspaceName ? `${page.workspaceName} · ` : ""}${page.workspaceId}`;
      const wrongWorkspace = exactTarget?.teamId && exactTarget.teamId !== page.workspaceId;
      const candidates = page.candidates.filter(
        (candidate) => isSlackId(candidate.id, kind) && !wrongWorkspace,
      );
      results.replaceChildren(
        ...candidates.map((candidate) =>
          button(
            element(
              "span",
              {},
              element("strong", {}, candidate.displayName || candidate.name),
              candidate.displayName && candidate.name !== candidate.displayName
                ? element("span", { className: "hint" }, ` ${candidate.name}`)
                : null,
              element("code", {}, candidate.id),
            ),
            () => {
              dialog.close();
              onSelect({
                ...candidate,
                workspaceId: page.workspaceId,
                workspaceName: page.workspaceName,
              });
            },
            { className: "slack-directory-result" },
          ),
        ),
      );
      status.textContent = wrongWorkspace
        ? `That ID belongs to workspace ${exactTarget.teamId}; this bot belongs to ${page.workspaceId}.`
        : candidates.length
          ? `Page ${index + 1} · ${candidates.length} result${candidates.length === 1 ? "" : "s"}${page.complete ? "" : " · more results may be available"}`
          : page.complete
            ? "No matches found. Try another name or exact ID."
            : "No results on this page. More results may be available.";
      pagination.hidden = index === 0 && !nextCursor;
      previous.disabled = index === 0;
      next.disabled = !nextCursor;
    } catch (error) {
      if (!dialog.open || !context.isCurrent() || active !== generation) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      errorText.textContent = lookupError(error);
      status.textContent = "Search failed. Retry or use the exact-ID field.";
    } finally {
      if (active === generation) {
        busy = false;
      }
    }
  }

  return element("div", { className: "slack-directory-picker" }, open, dialog);
}
