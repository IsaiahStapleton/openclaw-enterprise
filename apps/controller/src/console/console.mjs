import { element, button } from "./dom.mjs";
import { renderAgentList, renderCreateAgent, renderAgentDetail } from "./agents.mjs";

const app = document.querySelector("#app");
const pages = {
  agents: "Agents",
  providers: "Providers",
  namespaces: "Namespaces",
  settings: "Settings",
};
let generation = 0;
let reads = new AbortController();
let session = null;
let namespaces = [];
let namespaceId = null;
let previousCollection = "agents";
let loggingOut = false;
let menuControls = null;
let drawerControls = null;

function route() {
  const url = new URL(location.href);
  const path = url.pathname;
  const feature =
    path === "/console" || path === "/console/" ? "agents" : path.slice("/console/".length);
  const agentPath = /^agents\/(new|agt_[a-f0-9-]+)$/.exec(feature);
  return {
    feature: agentPath ? "agents" : feature,
    agentId: agentPath?.[1] === "new" ? null : agentPath?.[1],
    creating: agentPath?.[1] === "new",
    target: feature + url.search,
    namespace: url.searchParams.get("namespace"),
    url,
  };
}

function pageUrl(feature, selection = namespaceId) {
  const url = new URL(`/console/${feature}`, location.origin);
  if (selection !== null) url.searchParams.set("namespace", selection);
  return `${url.pathname}${url.search}`;
}

function safeReturn(value) {
  if (!value || !value.startsWith("/console/")) return null;
  try {
    const url = new URL(value, location.origin);
    const path = url.pathname.slice(9);
    if (
      url.origin !== location.origin ||
      (!Object.hasOwn(pages, path) && !/^agents\/(new|agt_[a-f0-9-]+)$/.test(path))
    )
      return null;
    return pageUrl(path + url.search, url.searchParams.get("namespace"));
  } catch {
    return null;
  }
}

function supportsDesktopHover() {
  return window.matchMedia("(min-width: 761px) and (hover: hover)").matches;
}

function navigate(feature, selection = namespaceId, replace = false) {
  if (loggingOut) return;
  const current = route().feature;
  if (feature === "settings" && ["agents", "providers", "namespaces"].includes(current))
    previousCollection = current;
  history[replace ? "replaceState" : "pushState"](
    { previousCollection },
    "",
    pageUrl(feature, selection),
  );
  void loadPage();
}

function resetReads() {
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  reads.abort();
  reads = new AbortController();
  generation += 1;
  menuControls = null;
  drawerControls = null;
  return generation;
}

async function request(path, { method = "GET", body, signal = reads.signal } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || payload === null || !Object.hasOwn(payload, "data")) {
    const error = new Error("The request could not be completed.");
    error.status = response.status;
    error.requestId = payload?.meta?.requestId;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload.data;
}

function publicPanel(title, description, actionLabel, action) {
  app.replaceChildren(
    element(
      "main",
      { className: "auth" },
      element("p", { className: "brand" }, "OpenClaw Enterprise"),
      element("h1", {}, title),
      element("p", { role: "status", className: "muted" }, description),
      action ? button(actionLabel, action) : null,
    ),
  );
}

function clearPrivate() {
  session = null;
  namespaces = [];
  namespaceId = null;
}

function showLogin(message = "", returnPath = null) {
  resetReads();
  clearPrivate();
  const url = new URL("/console/login", location.origin);
  const destination = safeReturn(returnPath);
  if (destination) url.searchParams.set("return", destination);
  history.replaceState(null, "", `${url.pathname}${url.search}`);
  const username = element("input", {
    id: "username",
    name: "username",
    type: "email",
    autocomplete: "username",
    required: "",
    "aria-describedby": "username-hint",
  });
  const password = element("input", {
    id: "password",
    name: "password",
    type: "password",
    autocomplete: "current-password",
    required: "",
  });
  const feedback = element("p", { className: "error", role: "alert" }, message);
  const submit = element("button", { type: "submit", className: "primary" }, "Login");
  const form = element(
    "form",
    {},
    element("label", { for: "username" }, "Username"),
    username,
    element("span", { id: "username-hint", className: "hint" }, "Use your account email"),
    element("label", { for: "password" }, "Password"),
    password,
    feedback,
    submit,
  );
  let pending = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    pending = true;
    submit.disabled = true;
    feedback.textContent = "";
    const active = generation;
    try {
      await request("/api/auth/sign-in/email", {
        method: "POST",
        body: { email: username.value, password: password.value },
      });
      if (active !== generation) return;
      password.value = "";
      history.replaceState(null, "", destination ?? "/console/agents");
      await loadPage();
    } catch (error) {
      if (active !== generation) return;
      feedback.textContent =
        error.status === 429
          ? "Too many attempts. Please try again later."
          : error.status === 400 || error.status === 401 || error.status === 403
            ? "Could not sign in. Check your username and password."
            : "Sign-in is unavailable. Please retry.";
    } finally {
      if (active === generation) {
        pending = false;
        submit.disabled = false;
      }
    }
  });
  app.replaceChildren(
    element(
      "main",
      { className: "auth" },
      element("p", { className: "brand" }, "OpenClaw Enterprise"),
      element("h1", {}, "Welcome back"),
      element("p", { className: "muted" }, "Sign in to your Installation."),
      form,
    ),
  );
}

function panel(target, title, description, actionLabel, action, requestId) {
  target.replaceChildren(
    element(
      "section",
      { className: "state-panel", role: "status" },
      element("h2", {}, title),
      element("p", {}, description),
      requestId ? element("p", { className: "request-id" }, `Request ID: ${requestId}`) : null,
      action ? button(actionLabel, action) : null,
    ),
  );
}

function menuItems(menu) {
  return [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].filter(
    (item) => item.closest('[role="menu"]') === menu && !item.closest("[hidden]"),
  );
}

function enableMenuKeys(menu, close, openChild) {
  menu.addEventListener("keydown", (event) => {
    if (event.target.closest('[role="menu"]') !== menu) return;
    const items = menuItems(menu);
    const index = items.indexOf(document.activeElement);
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (next !== undefined && items.length) {
      event.preventDefault();
      items[next].focus();
    }
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (event.key === "ArrowRight" && openChild) {
      event.preventDefault();
      openChild(event.target);
    }
  });
  menu.addEventListener("focusin", (event) => {
    for (const item of menuItems(menu)) item.tabIndex = item === event.target ? 0 : -1;
  });
}

function accountMenu() {
  const account = element("div", { className: "account" });
  const menu = element("div", {
    className: "menu",
    id: "account-menu",
    role: "menu",
    "aria-label": "Account",
    hidden: "",
  });
  const submenu = element("div", {
    className: "menu namespace-submenu",
    id: "namespace-menu",
    role: "menu",
    "aria-label": "Namespaces",
    hidden: "",
  });
  const selected = namespaces.find((item) => item.id === namespaceId);
  const namespaceButton = button(
    `Namespace: ${selected?.name ?? (namespaceId === null ? "None" : "Unavailable")}`,
    () => openNamespace(true),
    {
      role: "menuitem",
      tabindex: "-1",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-controls": "namespace-menu",
    },
  );
  for (const item of namespaces) {
    submenu.append(
      button(item.name, () => navigate(route().feature, item.id), {
        role: "menuitemradio",
        tabindex: "-1",
        "aria-checked": item.id === namespaceId,
      }),
    );
  }
  if (!namespaces.length)
    submenu.append(element("p", { className: "muted" }, "No readable Namespaces"));
  const toggle = button(
    "OpenClaw Enterprise",
    () => (menu.hidden ? openAccount() : closeAccount()),
    {
      className: "account-toggle",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-controls": "account-menu",
    },
  );
  toggle.replaceChildren(
    element("span", { className: "account-label" }, "OpenClaw Enterprise"),
    element("span", { className: "account-chevron", "aria-hidden": "true" }, "⌃"),
  );
  function closeNamespace(focus = true) {
    submenu.hidden = true;
    namespaceButton.setAttribute("aria-expanded", "false");
    if (focus) namespaceButton.focus();
  }
  function closeAccount(focus = true) {
    closeNamespace(false);
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (focus) toggle.focus();
  }
  function openAccount(focus = true) {
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    if (focus) menuItems(menu)[0]?.focus();
  }
  function openNamespace(focus) {
    submenu.hidden = false;
    namespaceButton.setAttribute("aria-expanded", "true");
    if (focus) menuItems(submenu)[0]?.focus();
  }
  toggle.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      openAccount();
    }
  });
  namespaceButton.addEventListener("pointerenter", () => {
    if (supportsDesktopHover()) openNamespace(false);
  });
  enableMenuKeys(menu, closeAccount, (target) => {
    if (target === namespaceButton) openNamespace(true);
  });
  enableMenuKeys(submenu, closeNamespace);
  menu.append(
    namespaceButton,
    button("Settings", () => navigate("settings"), { role: "menuitem", tabindex: "-1" }),
    button("Logout", () => void logout(), { role: "menuitem", tabindex: "-1" }),
    submenu,
  );
  account.append(menu, toggle);
  account.addEventListener("focusout", (event) => {
    if (event.relatedTarget && !account.contains(event.relatedTarget)) closeAccount(false);
  });
  menuControls = {
    account,
    close: () => closeAccount(false),
    openNamespace: () => {
      openAccount(false);
      openNamespace(true);
    },
  };
  return account;
}

function renderShell(feature) {
  const nav = element("nav", { className: "nav", "aria-label": "Main navigation" });
  const icons = { agents: "◇", providers: "◈", namespaces: "▤" };
  for (const name of ["agents", "providers", "namespaces"]) {
    const link = element(
      "a",
      { href: pageUrl(name), ...(feature === name ? { "aria-current": "page" } : {}) },
      element("span", { className: "nav-icon", "aria-hidden": "true" }, icons[name]),
      pages[name],
    );
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      navigate(name);
    });
    nav.append(link);
  }
  const sidebar = element(
    "aside",
    { className: "sidebar", id: "navigation-drawer" },
    element("p", { className: "brand" }, "Control Center"),
    nav,
    session ? accountMenu() : null,
  );
  const main = element("main", { className: "content", id: "main" });
  const selected = namespaces.find((item) => item.id === namespaceId);
  const scope =
    feature === "agents"
      ? `Namespace · ${session ? (selected?.name ?? "No available selection") : "Checking access"}`
      : feature === "settings"
        ? "Your account"
        : "Installation-wide";
  const refresh = button("Refresh", () => void loadPage());
  refresh.disabled = true;
  const header = element(
    "header",
    { className: "page-header" },
    element(
      "div",
      {},
      element("h1", {}, pages[feature]),
      element("p", { className: "scope" }, scope),
    ),
    feature === "settings" ? null : refresh,
  );
  const view = element("div", { "aria-live": "polite", "aria-busy": "true" });
  main.append(header);
  if (session && feature !== "agents" && namespaceId !== null && !selected) {
    main.append(
      element(
        "p",
        { className: "scope" },
        "Namespace unavailable. ",
        button("Switch Namespace", switchNamespace),
      ),
    );
  }
  main.append(view);
  const mobileToggle = button("Open navigation", () => openDrawer(), {
    className: "mobile-toggle",
    "aria-controls": "navigation-drawer",
    "aria-expanded": "false",
  });
  const wrapper = element("div", {}, mobileToggle, main);
  const shell = element("div", { className: "shell" }, sidebar, wrapper);
  function closeDrawer(focus = true) {
    shell.classList.remove("drawer-open");
    main.inert = false;
    mobileToggle.setAttribute("aria-expanded", "false");
    if (focus) mobileToggle.focus();
  }
  function openDrawer() {
    shell.classList.add("drawer-open");
    main.inert = true;
    mobileToggle.setAttribute("aria-expanded", "true");
    nav.querySelector("a").focus();
  }
  sidebar.prepend(button("Close navigation", () => closeDrawer(), { className: "drawer-close" }));
  shell.append(
    button("Close navigation overlay", () => closeDrawer(), { className: "scrim", tabindex: "-1" }),
  );
  drawerControls = { shell, sidebar, close: closeDrawer, open: openDrawer };
  app.replaceChildren(shell);
  return { view, refresh };
}

function sorted(items) {
  return [...items].sort(
    (a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id),
  );
}

function renderRows(view, feature, items) {
  if (!items.length) {
    panel(
      view,
      feature === "providers"
        ? "No providers configured"
        : `No accessible ${pages[feature].toLowerCase()}`,
      feature === "providers"
        ? "No Providers are configured for this Installation."
        : "Ask an administrator to provision resources or grant access, then refresh.",
      "Refresh",
      () => void loadPage(),
    );
    return;
  }
  const list = element("ul", { className: "collection", "aria-label": pages[feature] });
  for (const item of sorted(items)) {
    list.append(
      element(
        "li",
        { className: "resource" },
        element(
          "div",
          {},
          element("p", { className: "resource-name" }, item.name ?? item.id),
          feature === "providers" ? null : element("span", { className: "resource-id" }, item.id),
        ),
        feature === "agents"
          ? null
          : element(
              "span",
              { className: "badge" },
              feature === "providers" ? item.type : item.status,
            ),
      ),
    );
  }
  view.replaceChildren(list);
}

function switchNamespace() {
  if (window.matchMedia("(max-width: 760px)").matches) drawerControls?.open();
  menuControls?.openNamespace();
}

async function loadPage() {
  if (loggingOut) return;
  const current = route();
  const active = resetReads();
  clearPrivate();
  document.querySelectorAll('input[type="password"]').forEach((input) => {
    input.value = "";
  });
  publicPanel("Loading…", "Checking your session.");
  if (!Object.hasOwn(pages, current.feature) && current.feature !== "login") {
    publicPanel("Page not found", "This console page is unavailable.", "Go to Agents", () =>
      navigate("agents", current.namespace),
    );
    return;
  }
  let shell;
  if (current.feature !== "login") {
    namespaceId = current.namespace;
    shell = renderShell(current.feature);
    panel(shell.view, "Loading…", "Checking your session and Namespace access.");
  }
  try {
    const resolvedSession = await request("/api/auth/session");
    if (active !== generation) return;
    session = resolvedSession;
    if (session === null) {
      const destination =
        current.feature === "login"
          ? current.url.searchParams.get("return")
          : pageUrl(current.target, current.namespace);
      showLogin(
        current.feature !== "login" &&
          current.url.pathname !== "/console/" &&
          current.url.pathname !== "/console"
          ? "Your session has expired."
          : "",
        destination,
      );
      return;
    }
    if (current.feature === "login") {
      history.replaceState(
        null,
        "",
        safeReturn(current.url.searchParams.get("return")) ?? "/console/agents",
      );
      void loadPage();
      return;
    }
    const readable = await request("/namespaces");
    if (active !== generation) return;
    if (!Array.isArray(readable)) throw new Error("Invalid collection response");
    namespaces = sorted(readable);
    namespaceId =
      current.namespace ??
      (namespaces.find((item) => item.status === "ready") ?? namespaces[0])?.id ??
      null;
    if (["agents", "providers", "namespaces"].includes(history.state?.previousCollection))
      previousCollection = history.state.previousCollection;
    history.replaceState({ previousCollection }, "", pageUrl(current.target));
    shell = renderShell(current.feature);
    if (current.feature === "settings") {
      shell.view.append(
        element(
          "section",
          { className: "state-panel" },
          element("h2", {}, "Signed-in account"),
          element(
            "dl",
            { className: "settings" },
            element("dt", {}, "Name"),
            element("dd", {}, session.user.name),
            element("dt", {}, "Email"),
            element("dd", {}, session.user.email),
          ),
          element("p", {}, "No configurable settings in this release."),
          button("Back", () => navigate(previousCollection)),
        ),
      );
      return;
    }
    if (current.feature === "agents" && !namespaces.some((item) => item.id === namespaceId)) {
      panel(
        shell.view,
        namespaceId === null ? "No readable Namespaces" : "Namespace unavailable",
        namespaceId === null
          ? "Ask an administrator to provision a Namespace or grant access. Providers and Namespaces remain available in navigation."
          : "This Namespace is missing or you no longer have access. Choose another Namespace.",
        namespaces.length ? "Switch Namespace" : "Refresh",
        () => (namespaces.length ? switchNamespace() : void loadPage()),
      );
      return;
    }
    const agentContext = {
      view: shell.view,
      namespaceId,
      request,
      navigate,
      pageUrl,
      isCurrent: () => active === generation,
      onExpired: () =>
        showLogin("Your session has expired.", pageUrl(current.target, current.namespace)),
      setTitle: (title) => {
        app.querySelector("h1").textContent = title;
      },
      url: current.url,
    };
    if (current.creating) {
      renderCreateAgent(agentContext);
      return;
    }
    if (current.agentId) {
      await renderAgentDetail({ ...agentContext, agentId: current.agentId });
      return;
    }
    panel(shell.view, "Loading…", `Reading ${pages[current.feature].toLowerCase()}.`);
    const items =
      current.feature === "namespaces"
        ? namespaces
        : await request(
            current.feature === "providers"
              ? "/providers"
              : `/namespaces/${encodeURIComponent(namespaceId)}/agents`,
          );
    if (active !== generation) return;
    if (!Array.isArray(items)) throw new Error("Invalid collection response");
    if (current.feature === "agents") renderAgentList({ ...agentContext, items });
    else renderRows(shell.view, current.feature, items);
  } catch (error) {
    if (active !== generation || error.name === "AbortError") return;
    if (error.status === 401) {
      showLogin("Your session has expired.", pageUrl(current.target, current.namespace));
      return;
    }
    if (!session) {
      clearPrivate();
      publicPanel(
        "Session unavailable",
        "Could not check your session. Please retry.",
        "Retry",
        () => void loadPage(),
      );
      return;
    }
    shell = renderShell(current.feature);
    const title =
      error.status === 403
        ? "Access denied"
        : error.status === 404
          ? "Resource unavailable"
          : error.status === 400
            ? "Namespace unavailable"
            : current.feature === "providers"
              ? "Provider discovery unavailable"
              : "Request unavailable";
    panel(
      shell.view,
      title,
      error.status === 403
        ? "You do not have permission to read this collection."
        : "The collection could not be loaded. Try again or choose another page.",
      "Retry",
      () => void loadPage(),
      error.requestId,
    );
  } finally {
    if (active === generation && shell) {
      shell.refresh.disabled = false;
      shell.view.setAttribute("aria-busy", "false");
    }
  }
}

async function logout() {
  loggingOut = true;
  const active = resetReads();
  clearPrivate();
  publicPanel("Signing out…", "Confirming that your session has ended.");
  let confirmed = false;
  try {
    await request("/api/auth/sign-out", { method: "POST" });
    confirmed = true;
  } catch {
    try {
      confirmed = (await request("/api/auth/session")) === null;
    } catch {
      /* Keep the blocking view until the server can confirm revocation. */
    }
  }
  if (active !== generation) return;
  if (confirmed) {
    loggingOut = false;
    previousCollection = "agents";
    showLogin();
  } else
    publicPanel(
      "Could not confirm logout",
      "Private content is hidden. Retry to end your session.",
      "Retry",
      () => void logout(),
    );
}

document.addEventListener("pointerdown", (event) => {
  if (menuControls && !menuControls.account.contains(event.target)) menuControls.close();
});
document.addEventListener("keydown", (event) => {
  if (!drawerControls?.shell.classList.contains("drawer-open")) return;
  if (event.key === "Escape" && !event.defaultPrevented) {
    event.preventDefault();
    drawerControls.close();
  }
  if (event.key === "Tab") {
    const items = [...drawerControls.sidebar.querySelectorAll("a,button")].filter(
      (node) => !node.closest("[hidden]") && node.getClientRects().length,
    );
    if (event.shiftKey && document.activeElement === items[0]) {
      event.preventDefault();
      items.at(-1)?.focus();
    }
    if (!event.shiftKey && document.activeElement === items.at(-1)) {
      event.preventDefault();
      items[0]?.focus();
    }
  }
});
window.addEventListener("popstate", () => {
  if (!loggingOut) void loadPage();
});
window.addEventListener("focus", () => {
  if (session && !loggingOut && !app.querySelector("form, dialog[open]")) void loadPage();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && session && !loggingOut && !app.querySelector("form, dialog[open]"))
    void loadPage();
});
window.addEventListener("pagehide", () => {
  resetReads();
  clearPrivate();
  document.querySelectorAll('input[type="password"]').forEach((input) => {
    input.value = "";
  });
  app.replaceChildren();
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  if (loggingOut) {
    publicPanel(
      "Could not confirm logout",
      "Private content is hidden. Retry to end your session.",
      "Retry",
      () => void logout(),
    );
  } else void loadPage();
});
void loadPage();
