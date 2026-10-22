/**
 * Agent Apps in hermes-webui: the extension's glue.
 *
 * hermes-webui hosts a dashboard plugin's tab only as a sandboxed iframe and
 * never mounts its API, and an Agent App framed inside that sandbox loses its
 * own origin (no cookies or storage, its requests to itself refused). So the
 * tab runs here instead, in the web UI's main page, as an extension:
 *
 *  - an "Agent Apps" rail button opens the web UI's own plugin page view, and
 *    this script fills that view with the manager (manager.js, loaded just
 *    before it) rather than an iframe. Settings > Plugins > Open for the
 *    agent-app plugin lands in the same place, since the path is its tab.path;
 *  - the manager's API calls go to the plugin's loopback backend, which the
 *    plugin starts inside the web UI process and which publishes its address
 *    and token in runtime.json beside this file.
 *
 * Running apps embed only if the web UI's CSP allows framing them:
 * HERMES_WEBUI_CSP_FRAME_EXTRA="http://127.0.0.1:* http://localhost:*". When a
 * frame is refused, the manager switches to linking to the app instead.
 *
 * It hooks only what a plugin page already uses: switchPluginPage and
 * _loadPluginPage, both globals of the web UI's panels.js.
 */
(function () {
  "use strict";
  if (window.__AGENT_APPS_WEBUI__) return;
  window.__AGENT_APPS_WEBUI__ = true;

  var TAB_PATH = "/agent-apps"; // the dashboard manifest's tab.path
  var PANEL = "agent-apps";
  var LABEL = "Agent Apps";
  var RUNTIME_URL = "/extensions/agent-app/runtime.json";
  var UNREACHABLE =
    "The agent-app plugin serves this tab from inside hermes-webui. If you just installed or enabled it, restart hermes-webui (./ctl.sh restart).";
  var NO_FRAME =
    "hermes-webui's Content-Security-Policy does not allow framing local apps. To embed them, set HERMES_WEBUI_CSP_FRAME_EXTRA=\"http://127.0.0.1:* http://localhost:*\" and restart hermes-webui.";

  var manager = window.__AGENT_APP_MANAGER__;
  var originalLoad = window._loadPluginPage;
  if (!manager || typeof originalLoad !== "function" || typeof window.switchPluginPage !== "function") {
    console.warn("[agent-app] this hermes-webui has no plugin page view to host Agent Apps in");
    return;
  }

  /* ── The backend ── */
  var runtime = null;
  function loadRuntime() {
    return fetch(RUNTIME_URL, { cache: "no-store", credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("The Agent Apps backend is not running.");
        return res.json();
      })
      .then(function (rt) {
        if (!rt || typeof rt.base !== "string" || typeof rt.token !== "string") throw new Error("runtime.json is malformed.");
        runtime = rt;
        return rt;
      });
  }

  /** fetchJSON for the manager: the backend, with its token. A backend that
   *  restarted since the page loaded may have a new port or token, so a
   *  network failure or a 401 re-reads runtime.json once. Errors carry the
   *  body on `.body`, as the dashboard SDK's do. */
  function fetchJSON(url, init) {
    var retried = false;
    function attempt(rt) {
      var opts = Object.assign({}, init || {});
      opts.headers = Object.assign({}, (init && init.headers) || {}, { Authorization: "Bearer " + rt.token });
      opts.credentials = "omit";
      opts.cache = "no-store";
      return fetch(rt.base + url, opts).then(
        function (res) {
          if (res.status === 401 && !retried) {
            retried = true;
            return loadRuntime().then(attempt);
          }
          return res.text().then(function (text) {
            if (!res.ok) {
              var err = new Error(res.status + ": " + text);
              err.status = res.status;
              err.body = text;
              throw err;
            }
            return text ? JSON.parse(text) : {};
          });
        },
        function (err) {
          if (retried) throw err;
          retried = true;
          return loadRuntime().then(attempt);
        }
      );
    }
    return (runtime ? Promise.resolve(runtime) : loadRuntime()).then(attempt);
  }

  /* ── The view ── */
  var mounted = null; // { root, dispose }
  var layout = document.querySelector(".layout");
  var mainEl = document.querySelector("main.main");

  // Whether the Agent Apps view is the one on screen. Read from the page, not
  // from our own navigation, so leaving by any route (a rail button, a
  // keyboard shortcut, another plugin page) counts.
  function showing() {
    return !!(mounted && mounted.root.isConnected && mainEl && mainEl.classList.contains("showing-plugin"));
  }

  // `.layout.aa-active` while it shows, so agent-apps.css can give it the
  // whole main area (no left sidebar, no plugin header, no padding); and the
  // app title bar says "Agent Apps" rather than the previous view's name.
  var wasShowing = false;
  function syncChrome() {
    var on = showing();
    if (layout) layout.classList.toggle("aa-active", on);
    if (on !== wasShowing) {
      wasShowing = on;
      if (typeof window.syncAppTitlebar === "function") window.syncAppTitlebar();
    }
  }
  if (mainEl) new MutationObserver(syncChrome).observe(mainEl, { attributes: true, attributeFilter: ["class"] });

  // The web UI names the title bar after its current panel, which for any
  // plugin page is just "plugin", and it does not refresh the bar when a
  // plugin page opens. Every refresh goes through this global, so the
  // Agent Apps view answers it and every other view gets the original.
  var originalTitlebar = window.syncAppTitlebar;
  if (typeof originalTitlebar === "function") {
    window.syncAppTitlebar = function () {
      if (!showing()) return originalTitlebar.apply(this, arguments);
      var titleEl = document.getElementById("appTitlebarTitle");
      var subEl = document.getElementById("appTitlebarSub");
      if (titleEl) {
        titleEl.textContent = LABEL;
        titleEl.ondblclick = null; // the bar's rename gesture is for chat sessions
      }
      if (subEl) {
        subEl.textContent = "";
        subEl.hidden = true;
      }
      var bot = typeof window.assistantDisplayName === "function" ? window.assistantDisplayName() : "";
      document.title = bot ? LABEL + " — " + bot : LABEL;
    };
  }

  function unmount() {
    if (!mounted) return;
    mounted.dispose();
    mounted.root.remove();
    mounted = null;
    var container = document.getElementById("pluginPageContainer");
    if (container) container.classList.remove("aa-host");
    syncChrome();
  }
  function mountInto(container) {
    unmount();
    container.replaceChildren();
    container.classList.add("aa-host");
    var root = document.createElement("div");
    root.className = "aa aa-webui";
    container.appendChild(root);
    mounted = { root: root, dispose: manager.mount(root, { fetchJSON: fetchJSON, fill: true, unreachableHint: UNREACHABLE }) };
    syncChrome();
  }

  // The web UI loads a plugin page into #pluginPageContainer through this
  // global; the Agent Apps path gets the manager, every other path the
  // original iframe (which empties the container, so the manager goes first).
  window._loadPluginPage = async function (path, label) {
    if (path !== TAB_PATH) {
      unmount();
      return originalLoad.apply(this, arguments);
    }
    var container = document.getElementById("pluginPageContainer");
    if (!container) return;
    var title = document.getElementById("pluginPageTitle");
    if (title) title.textContent = LABEL;
    if (!mounted || !mounted.root.isConnected) mountInto(container);
    try {
      // panels.js's own record of the loaded page (a shared global binding),
      // so switching back and forth does not reload it.
      _currentPluginPage = { path: path, label: LABEL }; // eslint-disable-line no-undef
    } catch (_) { /* an older web UI without it */ }
  };

  function open(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    return Promise.resolve(window.switchPluginPage(null, TAB_PATH, LABEL)).then(function () {
      document.querySelectorAll("[data-panel]").forEach(function (tab) {
        tab.classList.toggle("active", tab.dataset.panel === PANEL);
      });
      syncChrome();
      if (mounted) mounted.dispose.refresh();
    });
  }

  /* ── The rail button (desktop) and the sidebar nav entry (mobile) ── */
  var ICON =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>' +
    '<path d="M3.27 6.96 12 12.01l8.73-5.05"/><path d="M12 22.08V12"/></svg>';
  function addButton(bar, className) {
    if (!bar || bar.querySelector('[data-panel="' + PANEL + '"]')) return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.dataset.panel = PANEL;
    button.dataset.label = LABEL;
    button.dataset.tooltip = LABEL;
    button.setAttribute("aria-label", LABEL);
    button.innerHTML = ICON;
    button.addEventListener("click", open);
    // Before the spacer, the dashboard link, or Settings, where the web UI's
    // own tab-order code anchors movable tabs.
    var anchor = Array.prototype.find.call(bar.children, function (child) {
      return (
        child.classList.contains("rail-spacer") ||
        child.classList.contains("dashboard-link") ||
        child.hasAttribute("data-dashboard-link") ||
        child.dataset.panel === "settings"
      );
    });
    bar.insertBefore(button, anchor || null);
  }
  addButton(document.querySelector(".rail"), "rail-btn nav-tab has-tooltip");
  addButton(document.querySelector(".sidebar-nav"), "nav-tab has-tooltip has-tooltip--bottom");

  // A refused frame of a local app means the CSP has no frame-src for it.
  document.addEventListener("securitypolicyviolation", function (e) {
    if (!mounted || e.disposition !== "enforce") return;
    var directive = e.effectiveDirective || e.violatedDirective || "";
    if (!/^(frame|child)-src/.test(directive)) return;
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(e.blockedURI || "")) return;
    mounted.dispose.setEmbeddable(false, NO_FRAME);
  });
})();
