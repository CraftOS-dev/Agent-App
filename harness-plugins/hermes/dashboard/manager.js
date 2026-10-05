/**
 * The Agent Apps dashboard tab: the page.
 *
 * A classic script (the dashboard loads plugin entries with a plain <script>
 * tag), so no modules and no JSX: React comes from the plugin SDK, and the
 * registered component only hosts a container that the manager mounts into.
 *
 * Layout: a browser-style tab strip (one tab per Agent App plus "New +"), a
 * content area embedding the active app, and a resizable side panel rendering
 * that app's Hermes session with a composer. Data flows through the plugin's
 * API (`/api/plugins/agent-app/*`, called with the SDK's fetchJSON so the
 * dashboard's session token rides along); apps are polled every 4s and the
 * open transcript every 2.5s. DOM is built with createElement/textContent so
 * app-provided strings never reach innerHTML.
 *
 * An app runs on the Hermes machine's loopback interface, so it is embedded
 * only when the dashboard itself is open over http on loopback; anywhere else
 * the frame would point at the viewer's own machine (or be blocked as mixed
 * content), and the page says so instead of showing a broken frame.
 */
(function () {
  "use strict";
  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !window.__HERMES_PLUGINS__) return;
  var React = SDK.React;

  var NAME = "agent-app";
  var API = "/api/plugins/" + NAME;
  var EMBEDDABLE = location.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** One API call. Failures resolve to `{ ok: false, message }` rather than
   *  throwing: fetchJSON throws "<status>: <body>" on a non-2xx, and the body
   *  is this API's own JSON. */
  function api(path, body) {
    var init = body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : undefined;
    return SDK.fetchJSON(API + path, init).catch(function (e) {
      var text = String((e && e.message) || e);
      var m = /^\d+: ([\s\S]*)$/.exec(text);
      try {
        var j = JSON.parse(m ? m[1] : "");
        if (j && typeof j === "object") return { ok: false, message: j.message || j.detail || text };
      } catch (_) { /* not JSON */ }
      return { ok: false, message: text };
    });
  }

  function mount(root) {
    var S = {
      meta: { blueprints: [], build: "dev" },
      rows: [], active: null, side: false,
      log: [], busy: false, error: null, sending: false,
      acting: new Set(), confirmDelete: null,
    };
    var timers = [];
    var disposers = [];
    function on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      disposers.push(function () { target.removeEventListener(type, fn, opts); });
    }

    /* ── Skeleton ── */
    var tabbar = el("div", "aa-tabbar");
    var main = el("div", "aa-main");
    var view = el("section", "aa-view");
    var framesBox = el("div", "aa-frames");
    var panel = el("div", "aa-center");
    panel.hidden = true;
    view.append(framesBox, panel);
    var resizer = el("div", "aa-resizer");
    resizer.hidden = true;
    var side = el("aside", "aa-side");
    side.hidden = true;
    var sideHead = el("div", "aa-side-head");
    var sideTitle = el("span", "aa-side-title");
    var sideClose = el("button", "aa-side-close", "✕");
    sideClose.title = "Close";
    sideHead.append(sideTitle, el("span", "aa-side-sub", "session"), sideClose);
    var logBox = el("div", "aa-log");
    var status = el("div", "aa-status");
    status.hidden = true;
    var composer = el("div", "aa-composer");
    var box = el("div", "aa-composer-box");
    var chatIn = el("textarea");
    chatIn.rows = 1;
    chatIn.placeholder = "Ask for a change, a task, a report…";
    var chatSend = el("button", "aa-send");
    chatSend.title = "Send";
    chatSend.disabled = true;
    chatSend.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>';
    box.append(chatIn, chatSend);
    composer.append(box);
    side.append(sideHead, logBox, status, composer);
    main.append(view, resizer, side);
    var menu = el("div", "aa-menu");
    menu.hidden = true;
    root.append(tabbar, main, menu);

    /* ── Size: fill the viewport below the dashboard's page header ── */
    function fit() {
      var top = root.getBoundingClientRect().top;
      root.style.height = Math.max(420, Math.floor(window.innerHeight - top - 24)) + "px";
    }
    on(window, "resize", fit);
    requestAnimationFrame(fit);

    /* ── Data ── */
    function refresh() {
      return api("/apps").then(function (data) {
        if (!data.ok) {
          S.apiError = data.message || "no response";
          if (S.active === null) S.active = "new";
          render();
          return;
        }
        if (S.apiError || !S.meta.loaded) loadMeta().then(render);
        S.apiError = null;
        S.rows = data.rows;
        if (S.active === null) S.active = S.rows.length ? S.rows[0].path : "new";
        if (S.active !== "new" && !S.rows.some(function (r) { return r.path === S.active; })) {
          S.active = S.rows.length ? S.rows[0].path : "new";
        }
        render();
      });
    }
    function activeRow() {
      return S.rows.find(function (r) { return r.path === S.active; }) || null;
    }

    /* ── Tab strip ── */
    function dotClass(r) {
      if (r.building) return "busy";
      if (r.status === "running") return "ok";
      if (r.status === "unreachable") return "warn";
      return "off";
    }
    function renderTabs() {
      tabbar.replaceChildren();
      S.rows.forEach(function (r) {
        var t = el("button", "aa-tab" + (r.path === S.active ? " active" : "") + (r.status !== "running" && !r.building ? " offline" : ""));
        t.appendChild(el("span", "aa-dot " + dotClass(r)));
        t.appendChild(el("span", "aa-tab-name", r.name));
        var more = el("span", "aa-tab-more", "⋯");
        more.title = "App actions";
        more.setAttribute("role", "button");
        more.onclick = function (e) { e.stopPropagation(); openMenu(r, more); };
        t.appendChild(more);
        t.onclick = function () { S.active = r.path; S.confirmDelete = null; closeMenu(); render(); };
        tabbar.appendChild(t);
      });
      var nt = el("button", "aa-tab aa-newtab" + (S.active === "new" ? " active" : ""), "New +");
      nt.onclick = function () { S.active = "new"; closeMenu(); render(); };
      tabbar.appendChild(nt);
    }

    /* ── "⋯" menu ── */
    function openMenu(r, anchor) {
      menu.replaceChildren();
      function item(label, cls, fn) { var b = el("button", cls, label); b.onclick = fn; menu.appendChild(b); }
      if (r.status === "running") {
        item("Pause", "", function () { closeMenu(); act(r, "stop"); });
        if (r.url) item("Open in browser", "", function () { closeMenu(); window.open(r.url, "_blank", "noopener"); });
      } else if (!r.building) {
        item("Launch", "", function () { closeMenu(); act(r, "serve"); });
      }
      item(S.side ? "Hide session" : "Show session", "", function () { closeMenu(); toggleSide(); });
      menu.appendChild(el("hr"));
      if (S.confirmDelete === r.path) {
        item("Confirm delete — removes files", "danger", function () { closeMenu(); removeApp(r); });
      } else {
        item("Delete…", "danger", function () { S.confirmDelete = r.path; openMenu(r, anchor); });
      }
      var rect = anchor.getBoundingClientRect();
      menu.hidden = false;
      menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)) + "px";
      menu.style.top = rect.bottom + 6 + "px";
    }
    function closeMenu() { menu.hidden = true; S.confirmDelete = null; }
    on(document, "click", function (e) { if (!menu.contains(e.target)) closeMenu(); });

    /* ── Lifecycle actions ── */
    function act(r, verb) {
      S.acting.add(r.path); render();
      return api("/app/" + verb, { path: r.path }).then(function (out) {
        S.acting.delete(r.path);
        if (!out.ok && out.message) S.notice = { path: r.path, text: out.message };
        return refresh();
      });
    }
    function removeApp(r) {
      S.acting.add(r.path); render();
      return api("/app/remove", { path: r.path }).then(function (out) {
        S.acting.delete(r.path);
        if (!out.ok && out.message) S.notice = { path: r.path, text: out.message };
        else S.active = null;
        return refresh();
      });
    }

    /* ── Views ── */
    var frames = new Map();
    // Rebuild the panel only when its content key changes, so polling never
    // wipes in-progress form input.
    var viewKey = "";
    function renderView() {
      var r = activeRow();
      var showFrame = !!(r && r.status === "running" && r.url && EMBEDDABLE);
      frames.forEach(function (f, path) {
        var row = S.rows.find(function (x) { return x.path === path; });
        if (!row || row.status !== "running") { f.remove(); frames.delete(path); }
        else f.style.display = showFrame && path === r.path ? "block" : "none";
      });
      if (showFrame && !frames.has(r.path)) {
        var f = document.createElement("iframe");
        f.src = r.url;
        f.title = r.name;
        frames.set(r.path, f);
        framesBox.appendChild(f);
      }
      panel.hidden = showFrame;
      var notice = S.notice && r && S.notice.path === r.path ? S.notice.text : "";
      var key = showFrame
        ? "frame:" + r.path
        : S.apiError && !S.rows.length
          ? "apierror:" + S.apiError
          : S.active === "new" || !r
            ? "new"
            : ["app", r.path, r.status, r.building, r.buildEnded, S.acting.has(r.path), S.side, notice].join("|");
      if (key === viewKey) return;
      viewKey = key;
      if (showFrame) return;
      panel.replaceChildren();
      if (S.apiError && !S.rows.length) { panel.appendChild(apiErrorPanel()); return; }
      if (S.active === "new" || !r) { panel.appendChild(buildForm()); return; }
      panel.appendChild(appPanel(r, notice));
    }
    // The dashboard shows an enabled plugin's tab at once but mounts its API
    // only at startup, so a fresh enable answers 404 until a restart.
    function apiErrorPanel() {
      var c = el("div", "aa-card");
      c.appendChild(el("h2", null, "The Agent Apps API is not reachable"));
      c.appendChild(el("p", "aa-sub", "If you just enabled the plugin, restart `hermes dashboard`: it mounts plugin APIs at startup. The page retries every few seconds."));
      c.appendChild(el("p", "aa-meta", S.apiError));
      return c;
    }
    function appPanel(r, notice) {
      var c = el("div", "aa-card");
      var acting = S.acting.has(r.path);
      if (r.building) {
        c.appendChild(el("div", "aa-spinner"));
        c.appendChild(el("h2", null, "The agent is building “" + r.name + "”"));
        c.appendChild(el("p", "aa-sub", "It scaffolds, builds feature by feature, validates, walk-verifies, and serves the app. Watch it work in the session panel; the tab goes live the moment the app is up."));
        if (!S.side) {
          var b = el("button", "aa-btn", "Show session");
          b.onclick = function () { toggleSide(true); };
          c.appendChild(b);
        }
        return c;
      }
      if (r.status === "running") {
        c.appendChild(el("h2", null, r.name + " is running"));
        c.appendChild(el("p", "aa-sub", "The app listens on the Hermes machine's loopback interface, so it can only be embedded when this dashboard is open over http on that machine (http://127.0.0.1 or http://localhost). Open it directly from there:"));
        var link = el("a", "aa-btn primary", r.url);
        link.href = r.url;
        link.target = "_blank";
        link.rel = "noopener";
        c.appendChild(link);
        return c;
      }
      if (r.status === "unreachable") {
        c.appendChild(el("h2", null, r.name + " is unreachable"));
        c.appendChild(el("p", "aa-sub", "Port " + r.port + " is answering, but not as this app. Stop whatever holds the port, or pause and relaunch."));
      } else if (r.buildEnded) {
        c.appendChild(el("h2", null, "Build session ended"));
        c.appendChild(el("p", "aa-sub", "The agent's build run for “" + r.name + "” finished, but the app is not running. Check the session for what happened, or try launching it."));
      } else {
        c.appendChild(el("h2", null, r.name + " is offline"));
        c.appendChild(el("p", "aa-sub", "The app is registered but not serving right now."));
      }
      c.appendChild(el("p", "aa-meta", r.path));
      if (notice) c.appendChild(el("p", "aa-err", notice));
      var row = el("div", "aa-row");
      var launch = el("button", "aa-btn primary", acting ? "Launching…" : "Launch");
      launch.disabled = acting;
      launch.onclick = function () { S.notice = null; act(r, "serve"); };
      row.appendChild(launch);
      var sess = el("button", "aa-btn", "Show session");
      sess.onclick = function () { toggleSide(true); };
      row.appendChild(sess);
      c.appendChild(row);
      return c;
    }

    /* ── New-app form ── */
    var form = {};
    function buildForm() {
      var f = el("div", "aa-form");
      f.appendChild(el("h1", null, "Agent Apps"));
      f.appendChild(el("p", "aa-lead", "Describe the app; the agent builds, verifies, and serves it here."));
      f.appendChild(el("label", null, "App name"));
      form.name = el("input", "aa-input");
      form.name.placeholder = "Acme CRM";
      form.name.autocomplete = "off";
      f.appendChild(form.name);
      f.appendChild(el("label", null, "What should it do?"));
      form.req = el("textarea", "aa-input");
      form.req.placeholder = "Track contacts, companies, and deals. A pipeline board, per-contact activity log, and a weekly summary.";
      f.appendChild(form.req);
      var g = el("div", "aa-grid2");
      var c1 = el("div");
      c1.appendChild(el("label", null, "Stack"));
      form.bp = el("select", "aa-input");
      S.meta.blueprints.forEach(function (b) { form.bp.appendChild(new Option(b, b)); });
      c1.appendChild(form.bp);
      g.appendChild(c1);
      var c2 = el("div");
      c2.appendChild(el("label", null, "Port (optional)"));
      form.port = el("input", "aa-input");
      form.port.type = "number";
      form.port.placeholder = "auto";
      form.port.autocomplete = "off";
      c2.appendChild(form.port);
      g.appendChild(c2);
      f.appendChild(g);
      var go = el("button", "aa-btn primary aa-go", "Build it");
      go.onclick = function () { submitBuild(go); };
      f.appendChild(go);
      form.err = el("div", "aa-err");
      f.appendChild(form.err);
      f.appendChild(el("p", "aa-buildstamp", "plugin build " + S.meta.build));
      return f;
    }
    function submitBuild(btn) {
      var body = {
        name: form.name.value.trim(), requirement: form.req.value.trim(),
        blueprint: form.bp.value, port: form.port.value.trim(),
      };
      form.err.textContent = "";
      if (!body.name || !body.requirement) { form.err.textContent = "Give the app a name and describe what it should do."; return; }
      btn.disabled = true;
      btn.textContent = "Starting…";
      api("/build", body).then(function (out) {
        if (!out.ok) { form.err.textContent = out.message; btn.disabled = false; btn.textContent = "Build it"; return; }
        S.active = out.path;
        return refresh().then(function () { toggleSide(true); });
      });
    }

    /* ── Session panel ── */
    function toggleSide(force) {
      S.side = force === true ? true : !S.side;
      render();
    }
    sideClose.onclick = function () { S.side = false; render(); };
    function pollLog() {
      var row = S.side ? activeRow() : null;
      if (!row) return Promise.resolve();
      return api("/session?app=" + encodeURIComponent(row.path)).then(function (out) {
        // A late response for a tab the user already left is discarded.
        if (!out.ok || !S.side || !activeRow() || activeRow().path !== row.path) return;
        S.log = out.messages;
        S.busy = !!out.busy;
        S.error = out.error || null;
        renderLog();
      });
    }
    function prettify(text) {
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch (_) { return text; }
    }
    function nodesFor(m, i) {
      var tools = m.tools || [];
      var out = [];
      if (m.role === "user") {
        out.push(el("div", "aa-msg user", m.text));
      } else if (m.role === "assistant") {
        if (tools.length) out.push(el("div", "aa-toolsline", "Used " + tools.join(", ")));
        if (m.text) out.push(el("div", "aa-msg assistant", m.text));
      } else {
        var d = document.createElement("details");
        d.className = "aa-toolrow";
        d.dataset.i = String(i);
        d.appendChild(el("summary", null, tools[0] || (m.role === "system" ? "System" : "Tool result")));
        d.appendChild(el("pre", null, prettify(m.text)));
        out.push(d);
      }
      return out;
    }
    // The transcript is append-only: an unchanged render touches nothing,
    // growth appends only (so expanded tool rows and text selection survive),
    // and a rare rewrite rebuilds while restoring expanded rows by position.
    var logKeys = [];
    function itemKey(m) { return m.role + "\u001f" + m.text + "\u001f" + (m.tools || []).join(","); }
    function resetLogView() { logKeys = []; logBox.replaceChildren(); }
    function renderStatus() {
      status.replaceChildren();
      if (S.error) {
        status.className = "aa-status error";
        status.appendChild(el("div", "aa-status-title", "The last turn failed"));
        status.appendChild(el("pre", null, S.error));
        status.hidden = false;
      } else if (S.busy) {
        status.className = "aa-status";
        status.appendChild(el("span", "aa-dot busy"));
        status.appendChild(el("span", null, "The agent is working…"));
        status.hidden = false;
      } else {
        status.hidden = true;
      }
    }
    function renderLog() {
      renderStatus();
      var items = S.log.slice(-200);
      if (!items.length) {
        if (logKeys.length || !logBox.childElementCount) {
          logKeys = [];
          logBox.replaceChildren(el("div", "aa-log-empty", "No session activity yet."));
        }
        return;
      }
      var keys = items.map(itemKey);
      var grown = keys.length >= logKeys.length && logKeys.every(function (k, i) { return k === keys[i]; });
      if (grown && keys.length === logKeys.length) return;
      var stick = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 40;
      if (grown) {
        if (!logKeys.length) logBox.replaceChildren();
        for (var i = logKeys.length; i < items.length; i++) nodesFor(items[i], i).forEach(function (n) { logBox.appendChild(n); });
      } else {
        var open = new Set(Array.prototype.map.call(logBox.querySelectorAll("details[open]"), function (d) { return d.dataset.i; }));
        logBox.replaceChildren();
        items.forEach(function (m, i) {
          nodesFor(m, i).forEach(function (n) { if (n.tagName === "DETAILS" && open.has(n.dataset.i)) n.open = true; logBox.appendChild(n); });
        });
      }
      logKeys = keys;
      if (stick) logBox.scrollTop = logBox.scrollHeight;
    }
    function sendChat() {
      var text = chatIn.value.trim();
      var row = activeRow();
      if (!text || !row || S.sending) return;
      S.sending = true;
      chatIn.value = "";
      chatIn.style.height = "auto";
      chatSend.disabled = true;
      S.log.push({ role: "user", text: text, tools: [] });
      S.busy = true;
      S.error = null;
      renderLog();
      api("/session/send", { path: row.path, name: row.name, text: text }).then(function (out) {
        S.sending = false;
        if (!out.ok) { S.error = out.message; S.busy = false; renderStatus(); }
      });
    }
    chatSend.onclick = sendChat;
    on(chatIn, "keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    on(chatIn, "input", function () {
      chatSend.disabled = !chatIn.value.trim();
      chatIn.style.height = "auto";
      chatIn.style.height = Math.min(chatIn.scrollHeight, 122) + "px";
    });

    /* ── Session panel resize ── */
    on(resizer, "pointerdown", function (e) {
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      resizer.classList.add("dragging");
      var startX = e.clientX;
      var startW = side.getBoundingClientRect().width;
      var mainW = main.getBoundingClientRect().width;
      function move(ev) {
        side.style.width = Math.min(mainW * 0.7, Math.max(280, startW + (startX - ev.clientX))) + "px";
      }
      function up() {
        resizer.classList.remove("dragging");
        resizer.removeEventListener("pointermove", move);
        resizer.removeEventListener("pointerup", up);
      }
      resizer.addEventListener("pointermove", move);
      resizer.addEventListener("pointerup", up);
    });

    /* ── Render root ── */
    // The session panel is bound to the active tab, so switching tabs
    // switches the session and the New + tab shows none.
    var sidePath = null;
    function render() {
      renderTabs();
      renderView();
      var row = activeRow();
      var showSide = S.side && row != null;
      side.hidden = !showSide;
      resizer.hidden = !showSide;
      if (showSide) {
        sideTitle.textContent = row.name;
        if (sidePath !== row.path) {
          sidePath = row.path;
          S.log = [];
          S.busy = false;
          S.error = null;
          resetLogView();
          renderStatus();
          pollLog().catch(function () {});
        }
      } else {
        sidePath = null;
      }
    }

    // A transient failure must not kill the poll loops; the next tick retries.
    function quiet(fn) { return function () { fn().catch(function () {}); }; }
    function loadMeta() {
      return api("/meta").then(function (meta) {
        if (!meta.ok) return;
        S.meta = { blueprints: meta.blueprints || [], build: meta.build || "dev", loaded: true };
        viewKey = "";
      });
    }
    loadMeta().then(refresh).catch(function () {});
    timers.push(setInterval(quiet(refresh), 4000));
    timers.push(setInterval(quiet(pollLog), 2500));

    return function dispose() {
      timers.forEach(clearInterval);
      disposers.forEach(function (d) { d(); });
      root.replaceChildren();
    };
  }

  function AgentAppsPage() {
    var ref = SDK.hooks.useRef(null);
    SDK.hooks.useEffect(function () { return mount(ref.current); }, []);
    return React.createElement("div", { ref: ref, className: "aa" });
  }

  window.__HERMES_PLUGINS__.register(NAME, AgentAppsPage);
})();
