/**
 * The Agent Apps tab: the page.
 *
 * A classic script, so no modules and no JSX. It runs in two hosts:
 *  - `hermes dashboard`, which loads it as a plugin entry: the registered
 *    component (React from the plugin SDK) only hosts a container that the
 *    manager mounts into, and calls go through the SDK's fetchJSON so the
 *    dashboard's session token rides along;
 *  - hermes-webui, whose extension (../webui/agent-apps.js) calls
 *    `window.__AGENT_APP_MANAGER__.mount(root, host)` with a fetchJSON bound to
 *    the plugin's loopback backend.
 *
 * Layout: a browser-style tab strip (one tab per Agent App plus "New +"), a
 * content area embedding the active app, and a resizable side panel rendering
 * that app's Hermes session with a composer. Data flows through the plugin's
 * API (`/api/plugins/agent-app/*`); apps are polled every 4s and the open
 * transcript every 2.5s, only while the page is visible. DOM is built with
 * createElement/textContent so app-provided strings never reach innerHTML.
 *
 * The New + tab has three panels: Build (the agent builds a new app), the
 * Marketplace (search, tag chips, a card per app, install), and Import (a zip,
 * a folder or a git URL: inspect, then install, or hand a source that is not a
 * package to the agent to convert or adopt). An install is a job on the
 * server; the page polls it every second and shows each pipeline step from
 * `install --events`, then opens the app in its tab. It never gives up on a
 * running install, so no client timeout is shorter than the CLI's own.
 *
 * An app runs on the Hermes machine's loopback interface, so it is embedded
 * only when the page itself is open over http on loopback; anywhere else the
 * frame would point at the viewer's own machine (or be blocked as mixed
 * content), and the page says so instead of showing a broken frame.
 */
(function () {
  "use strict";
  var SDK = window.__HERMES_PLUGIN_SDK__;

  var NAME = "agent-app";
  var API = "/api/plugins/" + NAME;
  var LOOPBACK_HTTP = location.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** A failed call as this API's own `{ ok: false, message }`. On a non-2xx,
   *  fetchJSON throws an ApiError whose message is already the body's
   *  `message`/`detail` and which keeps the raw body on `.body`; older
   *  dashboards threw "<status>: <body>". Either way the body is this API's
   *  own JSON. */
  function failure(e) {
    var text = String((e && e.message) || e);
    var legacy = /^(\d+): ([\s\S]*)$/.exec(text);
    var raw = e && typeof e.body === "string" ? e.body : legacy ? legacy[2] : "";
    // The HTTP status, when there was one (0: the request never got an answer).
    var status = e && typeof e.status === "number" ? e.status : legacy ? Number(legacy[1]) : 0;
    try {
      var j = JSON.parse(raw);
      if (j && typeof j === "object" && (j.message || j.detail)) return { ok: false, message: j.message || j.detail, status: status };
    } catch (_) { /* not JSON */ }
    return { ok: false, message: text, status: status };
  }

  /** One API call. Failures resolve to `{ ok: false, message }` rather than throwing. */
  function makeApi(fetchJSON) {
    return function api(path, body) {
      var init = body
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : undefined;
      return Promise.resolve().then(function () { return fetchJSON(API + path, init); }).catch(failure);
    };
  }

  /** Send a zip as it is (no JSON, no encoding); the server keeps it for --from. */
  function makeUpload(fetchJSON) {
    return function upload(file) {
      var init = { method: "POST", headers: { "Content-Type": "application/zip" }, body: file };
      return Promise.resolve().then(function () { return fetchJSON(API + "/upload", init); }).catch(failure);
    };
  }

  /**
   * Mount the manager into `root`. `host`:
   *  - fetchJSON(url, init): required; resolves the parsed body, throws on a non-2xx
   *  - embeddable: whether running apps may be framed (default: page is http on loopback)
   *  - fill: size from CSS instead of fitting the viewport below `root`
   *  - unreachableHint: what to tell the user when the API does not answer
   * Returns a dispose function, which also carries refresh() and setEmbeddable(bool).
   */
  function mount(root, host) {
    host = host || {};
    var api = makeApi(host.fetchJSON);
    var upload = makeUpload(host.fetchJSON);
    var EMBEDDABLE = host.embeddable != null ? !!host.embeddable : LOOPBACK_HTTP;
    var noFrameReason = "";
    var S = {
      meta: { blueprints: [], steps: [], build: "dev" },
      rows: [], active: null, side: false,
      log: [], busy: false, error: null, sending: false,
      acting: new Set(), confirmDelete: null,
      // The New + tab: which panel, the marketplace, the import, and an install in progress.
      newMode: "build",
      market: { q: "", tag: null, tags: [], data: null, error: null, loading: false, seq: 0, open: null },
      imp: { kind: "zip", from: "", file: null, origin: null, label: "", uploaded: false, report: null, error: null, busy: false },
      job: null,
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

    /* ── Size: fill the viewport below the dashboard's page header (or let the host's CSS size it) ── */
    function fit() {
      var top = root.getBoundingClientRect().top;
      root.style.height = Math.max(420, Math.floor(window.innerHeight - top - 24)) + "px";
    }
    if (!host.fill) {
      on(window, "resize", fit);
      requestAnimationFrame(fit);
    }

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
    // The event's own path, not menu.contains(target): "Delete…" re-renders the
    // menu, which detaches the clicked button before this listener runs, and a
    // detached target would read as an outside click and close the confirm step.
    on(document, "click", function (e) { if (e.composedPath().indexOf(menu) < 0) closeMenu(); });

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
      var isNew = S.active === "new" || !r;
      var key = showFrame
        ? "frame:" + r.path
        : S.apiError && !S.rows.length
          ? "apierror:" + S.apiError
          : isNew
            ? "new:" + S.newMode + (S.job ? ":job" : "")
            : ["app", r.path, r.status, r.building, r.buildEnded, S.acting.has(r.path), S.side, notice].join("|");
      if (key === viewKey) return;
      viewKey = key;
      if (showFrame) return;
      panel.replaceChildren();
      panel.classList.toggle("aa-top", isNew && !(S.apiError && !S.rows.length));
      if (S.apiError && !S.rows.length) { panel.appendChild(apiErrorPanel()); return; }
      if (isNew) { panel.appendChild(newPanel()); return; }
      panel.appendChild(appPanel(r, notice));
    }
    // The dashboard shows an enabled plugin's tab at once but mounts its API
    // only at startup, so a fresh enable answers 404 until a restart.
    function apiErrorPanel() {
      var c = el("div", "aa-card");
      c.appendChild(el("h2", null, "The Agent Apps API is not reachable"));
      c.appendChild(el("p", "aa-sub", (host.unreachableHint || "If you just enabled the plugin, restart `hermes dashboard`: it mounts plugin APIs at startup.") + " The page retries every few seconds."));
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
        c.appendChild(el("p", "aa-sub", (noFrameReason || "The app listens on the Hermes machine's loopback interface, so it can only be embedded when this page is open over http on that machine (http://127.0.0.1 or http://localhost).") + " Open it directly:"));
        var link = el("a", "aa-btn primary", r.url);
        link.href = r.url;
        link.target = "_blank";
        link.rel = "noopener";
        c.appendChild(link);
        return c;
      }
      if (r.status === "unreachable") {
        c.appendChild(el("h2", null, r.name + " is unreachable"));
        c.appendChild(el("p", "aa-sub", (r.port ? "Port " + r.port : "Its port") + " is answering, but not as this app. Stop whatever holds the port, or pause and relaunch."));
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
      f.appendChild(el("h1", null, "Build an app"));
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

    /* ── New tab: build · marketplace · import ── */
    var MODES = [["build", "Build"], ["market", "Marketplace"], ["import", "Import"]];
    var KINDS = { "agent-app": "Agent App package", "living-ui": "CraftBot Living UI app", foreign: "Not an Agent App" };
    var ROUTES = {
      convert: "Convert: the agent rebuilds it as a new Agent App, with the original source kept read-only in reference/source/. Nothing of the original code runs afterward.",
      adopt: "Adopt: the app runs unchanged behind the framework’s sidecar adapter. Agents operate it through the operations the agent maps; its own UI stays at its own address.",
    };
    var STEP_ICONS = { pending: "○", start: "●", done: "✓", skipped: "–", failed: "✗" };
    function message(e) { return String((e && e.message) || e); }

    function newPanel() {
      var wide = S.job || S.newMode !== "build";
      var wrap = el("div", "aa-newpane" + (wide ? " wide" : ""));
      if (S.job) { wrap.appendChild(jobView()); return wrap; }
      var modes = el("div", "aa-modes");
      MODES.forEach(function (m) {
        var b = el("button", S.newMode === m[0] ? "on" : "", m[1]);
        b.onclick = function () { S.newMode = m[0]; render(); };
        modes.appendChild(b);
      });
      wrap.appendChild(modes);
      wrap.appendChild(S.newMode === "market" ? marketView() : S.newMode === "import" ? importView() : buildForm());
      return wrap;
    }
    function errorBox(text, retry) {
      var box = el("div", "aa-errbox");
      box.appendChild(el("pre", "aa-code", text));
      if (retry) { var b = el("button", "aa-btn small", "Retry"); b.onclick = retry; box.appendChild(b); }
      return box;
    }
    function section(parent, title, body) {
      var s = el("div", "aa-section");
      s.appendChild(el("h3", null, title));
      s.appendChild(body);
      parent.appendChild(s);
    }
    function list(items, cls) {
      var ul = el("ul", cls);
      items.forEach(function (item) { ul.appendChild(el("li", null, item)); });
      return ul;
    }
    function find(items, pred) { for (var i = 0; i < items.length; i++) if (pred(items[i])) return items[i]; return null; }

    /* Marketplace: the catalogue (searched by the CLI), filtered by tag, one card per app. */
    var marketEls = null;
    function tagsOf(apps) {
      var seen = new Set();
      apps.forEach(function (a) { (Array.isArray(a.tags) ? a.tags : []).forEach(function (t) { seen.add(t); }); });
      return Array.from(seen).sort();
    }
    function marketView() {
      var v = el("div", "aa-pane");
      v.appendChild(el("h1", null, "Marketplace"));
      v.appendChild(el("p", "aa-lead", "Apps ready to install. A marketplace app is catalogued: once it runs there is nothing more to verify."));
      var q = el("input", "aa-input");
      q.type = "search";
      q.placeholder = "Search apps";
      q.value = S.market.q;
      q.autocomplete = "off";
      var timer = 0;
      q.oninput = function () { clearTimeout(timer); timer = setTimeout(function () { loadCatalogue(q.value.trim()); }, 300); };
      var row = el("div", "aa-searchrow");
      row.appendChild(q);
      v.appendChild(row);
      marketEls = { chips: el("div", "aa-chips"), status: el("div"), grid: el("div", "aa-grid") };
      v.append(marketEls.chips, marketEls.status, marketEls.grid);
      if (S.market.data === null && !S.market.loading && S.market.error === null) loadCatalogue(S.market.q);
      else renderMarket();
      return v;
    }
    function loadCatalogue(q) {
      var m = S.market;
      var seq = ++m.seq;
      m.q = q;
      m.loading = true;
      m.error = null;
      renderMarket();
      return api("/catalogue?search=" + encodeURIComponent(q)).then(function (out) {
        if (seq !== m.seq) return; // a newer search answered meanwhile
        m.loading = false;
        if (out.ok) {
          m.data = out;
          if (q === "") m.tags = tagsOf(out.apps);
        } else {
          m.data = null;
          m.error = out.message || "The marketplace did not answer.";
        }
        renderMarket();
      });
    }
    function renderMarket() {
      if (!marketEls) return;
      var m = S.market;
      marketEls.chips.replaceChildren();
      (m.tags.length ? m.tags : m.data ? tagsOf(m.data.apps) : []).forEach(function (t) {
        var c = el("button", "aa-chip" + (m.tag === t ? " on" : ""), t);
        c.onclick = function () { m.tag = m.tag === t ? null : t; renderMarket(); };
        marketEls.chips.appendChild(c);
      });
      marketEls.status.replaceChildren();
      marketEls.grid.replaceChildren();
      if (m.error) { marketEls.status.appendChild(errorBox(m.error, function () { loadCatalogue(m.q); })); return; }
      if (!m.data) { marketEls.status.appendChild(el("div", "aa-empty", "Reading the marketplace…")); return; }
      var src = m.data.source || {};
      var from = "From " + (src.repository || src.location || "the marketplace") + (src.fallbackFrom ? " (" + src.fallbackFrom.location + " is unavailable)" : "");
      marketEls.status.appendChild(el("p", "aa-note", m.loading ? "Searching…" : from));
      var apps = m.data.apps.filter(function (a) { return !m.tag || (Array.isArray(a.tags) && a.tags.indexOf(m.tag) >= 0); });
      if (!apps.length) { marketEls.grid.appendChild(el("div", "aa-empty", m.q || m.tag ? "No app matches." : "The marketplace lists no apps.")); return; }
      apps.forEach(function (a) { marketEls.grid.appendChild(appCard(a, src.location)); });
    }
    function thumb(a) {
      var t = el("div", "aa-thumb");
      function initial() { t.replaceChildren(document.createTextNode((a.name || a.id || "?").slice(0, 1).toUpperCase())); }
      // A local marketplace's preview is a file: URL, which a page cannot load.
      if (typeof a.preview === "string" && /^https?:/i.test(a.preview)) {
        var img = document.createElement("img");
        img.alt = "";
        img.loading = "lazy";
        img.onerror = initial;
        img.src = a.preview;
        t.appendChild(img);
      } else initial();
      return t;
    }
    function appCard(a, source) {
      var card = el("div", "aa-app");
      card.appendChild(thumb(a));
      var body = el("div", "aa-app-body");
      var h = el("h3", null, a.name || a.id);
      if (a.version) h.appendChild(el("span", "aa-ver", "v" + a.version));
      body.appendChild(h);
      if (Array.isArray(a.tags) && a.tags.length) {
        var tags = el("div", "aa-tags");
        a.tags.forEach(function (t) { tags.appendChild(el("span", "aa-tag", t)); });
        body.appendChild(tags);
      }
      if (a.description) body.appendChild(el("p", "aa-desc", a.description));
      body.appendChild(a.compatible === true ? el("div", "aa-compat yes", "✓ Runs here")
        : a.compatible === false ? el("div", "aa-compat no", "Not installable here: " + (a.reason || "no reason given"))
          : el("div", "aa-compat", "Its requirements are not listed"));
      var fields = Array.isArray(a.customizable) ? a.customizable : [];
      var label = a.name || a.id;
      var actions = el("div", "aa-actions");
      if (a.compatible === false) {
        var what = el("button", "aa-btn small", "What can be done?");
        what.onclick = function () { inspectSource({ id: a.id, source: source }, label); };
        actions.appendChild(what);
      } else if (S.market.open === a.id) {
        var form = el("div", "aa-fields");
        var inputs = {};
        fields.forEach(function (f) {
          form.appendChild(el("label", null, f.label || f.key));
          var i = el("input", "aa-input");
          i.value = f.default || "";
          i.placeholder = f.placeholder || "";
          i.autocomplete = "off";
          inputs[f.key] = i;
          form.appendChild(i);
        });
        body.appendChild(form);
        var go = el("button", "aa-btn primary small", "Install");
        go.onclick = function () {
          var set = {};
          Object.keys(inputs).forEach(function (k) { set[k] = inputs[k].value; });
          startInstall({ id: a.id, source: source, set: set }, label);
        };
        var cancel = el("button", "aa-btn small", "Cancel");
        cancel.onclick = function () { S.market.open = null; renderMarket(); };
        actions.append(go, cancel);
      } else {
        var install = el("button", "aa-btn primary small", "Install");
        install.onclick = function () {
          if (fields.length) { S.market.open = a.id; renderMarket(); }
          else startInstall({ id: a.id, source: source }, label);
        };
        actions.appendChild(install);
      }
      body.appendChild(actions);
      card.appendChild(body);
      return card;
    }

    /* Import: a zip, a folder or a git URL; inspect first, then install or hand it to the agent. */
    var importEls = null;
    var SOURCES = [
      ["zip", "Zip file", ""],
      ["folder", "Folder", "A folder on the machine running Hermes, e.g. /home/me/apps/board"],
      ["git", "Git or GitHub", "https://github.com/owner/repo, github:owner/repo@main/path, or git+https://host/repo.git#ref"],
    ];
    function importView() {
      var v = el("div", "aa-pane");
      v.appendChild(el("h1", null, "Import"));
      v.appendChild(el("p", "aa-lead", "Bring in an app from a zip, a folder or a git repository. Inspect it first: nothing from it runs until you install it."));
      var kinds = el("div", "aa-modes");
      var input = el("div");
      var go = el("button", "aa-btn primary", "Inspect");
      function drawInput() {
        kinds.replaceChildren();
        SOURCES.forEach(function (spec) {
          var b = el("button", S.imp.kind === spec[0] ? "on" : "", spec[1]);
          b.onclick = function () { S.imp.kind = spec[0]; drawInput(); };
          kinds.appendChild(b);
        });
        input.replaceChildren();
        if (S.imp.kind === "zip") {
          var f = el("input", "aa-input");
          f.type = "file";
          f.accept = ".zip,application/zip";
          f.onchange = function () { S.imp.file = f.files && f.files[0] ? f.files[0] : null; };
          input.appendChild(f);
          if (S.imp.file) input.appendChild(el("p", "aa-note", "Chosen: " + S.imp.file.name));
        } else {
          var t = el("input", "aa-input");
          t.placeholder = find(SOURCES, function (x) { return x[0] === S.imp.kind; })[2];
          t.value = S.imp.from;
          t.autocomplete = "off";
          t.oninput = function () { S.imp.from = t.value; };
          t.onkeydown = function (e) { if (e.key === "Enter") go.click(); };
          input.appendChild(t);
        }
      }
      go.onclick = function () {
        S.imp.error = null;
        if (S.imp.kind === "zip") {
          if (!S.imp.file) { S.imp.error = "Choose a .zip file."; renderReport(); return; }
          inspectZip(S.imp.file);
        } else {
          var from = S.imp.from.trim();
          if (!from) { S.imp.error = S.imp.kind === "git" ? "Give a git or GitHub URL." : "Give a folder path."; renderReport(); return; }
          runInspect({ from: from }, from);
        }
      };
      drawInput();
      var row = el("div", "aa-row aa-gap");
      row.appendChild(go);
      importEls = { go: go, report: el("div") };
      v.append(kinds, input, row, importEls.report);
      renderReport();
      return v;
    }
    function runInspect(origin, label, uploaded) {
      var m = S.imp;
      m.busy = true;
      m.error = null;
      m.report = null;
      m.origin = origin;
      m.label = label;
      m.uploaded = !!uploaded;
      renderReport();
      return api("/inspect", origin).then(function (out) {
        if (m.origin !== origin) return;
        m.busy = false;
        if (out.ok) m.report = out.report;
        else m.error = out.message || "The source could not be inspected.";
        renderReport();
      });
    }
    function inspectZip(file) {
      S.imp.busy = true;
      S.imp.report = null;
      S.imp.error = null;
      renderReport();
      return upload(file).then(function (out) {
        if (!out.ok) { S.imp.busy = false; S.imp.error = out.message || "The upload was refused."; renderReport(); return; }
        return runInspect({ from: out.file }, file.name, true);
      });
    }
    /** From a marketplace card: show what an app is, and what can be done with it, in the Import panel. */
    function inspectSource(origin, label) {
      S.newMode = "import";
      render();
      runInspect(origin, label);
    }
    function renderReport() {
      if (!importEls) return;
      var m = S.imp;
      var box = importEls.report;
      importEls.go.disabled = m.busy;
      box.replaceChildren();
      if (m.busy) { box.appendChild(el("div", "aa-empty", "Inspecting… it is staged and read; nothing from it runs.")); return; }
      if (m.error) { box.appendChild(errorBox(m.error)); return; }
      var r = m.report;
      if (!r) return;
      var card = el("div", "aa-report");
      var badges = el("div", "aa-badges");
      badges.appendChild(el("span", "aa-badge", KINDS[r.kind] || r.kind));
      badges.appendChild(el("span", "aa-badge " + (r.installable ? "ok" : "no"), r.installable ? "Installable" : "Not installable"));
      card.appendChild(badges);
      var name = (r.app && r.app.name) || (r.source && r.source.name) || "";
      card.appendChild(el("h2", null, name || m.label));
      if (!r.installable && r.reason) card.appendChild(el("p", "aa-sub", r.reason));
      var kv = el("dl", "aa-kv");
      function row(k, v) { if (v) { kv.appendChild(el("dt", null, k)); kv.appendChild(el("dd", null, v)); } }
      var src = r.source || {};
      // An upload's location is the manager's private copy: name the file that was chosen.
      row("Source", m.uploaded ? m.label + " (uploaded)"
        : (src.catalogueId ? "marketplace app " + src.catalogueId + " in " : "") + (src.location || m.label) + (src.ref ? " @ " + src.ref : ""));
      row("Commit", src.commit);
      row("SHA-256", src.sha256);
      if (r.app) { row("Sign-in", r.app.authMode); row("Modules", (r.app.modules || []).join(", ")); }
      if (r.toolkit) {
        var av = r.toolkit.adapterVersion || {};
        row("Toolkit", (r.toolkit.id || "none named") + (r.toolkit.installed ? " (installed here)" : " (not installed here)") +
          (av.package && av.current && av.package !== av.current ? "; adapter " + av.package + " → " + av.current : ""));
      }
      if (r.integrity && r.kind === "agent-app") {
        row("System files", r.integrity.canon === "drifted" ? "changed: " + (r.integrity.changed || []).join(", ") + " (install replaces them)"
          : r.integrity.canon === "intact" ? "as its own record says" : "no record (install makes one)");
      }
      card.appendChild(kv);
      if (r.pipeline) {
        var lines = Object.keys(r.pipeline).map(function (k) { return k + ": " + (typeof r.pipeline[k] === "string" ? r.pipeline[k] : JSON.stringify(r.pipeline[k])); });
        section(card, "What it will run (from the toolkit installed here, not from the package)", el("pre", "aa-code", lines.join("\n")));
      }
      if (r.capabilities && Object.keys(r.capabilities).length) section(card, "What it declares", el("pre", "aa-code", JSON.stringify(r.capabilities, null, 2)));
      if (r.strips && r.strips.length) section(card, "What install removes", list(r.strips));
      if (r.placeholders && r.placeholders.length) section(card, "Placeholders filled at install", list(r.placeholders));
      if (r.warnings && r.warnings.length) section(card, "Warnings", list(r.warnings, "warn"));
      if (r.installable) card.appendChild(installForm(m.origin, name || m.label));
      else if (r.routes && r.routes.length) card.appendChild(handoff(m.origin, r.routes, name));
      box.appendChild(card);
    }
    function installForm(origin, name) {
      var v = el("div", "aa-section");
      v.appendChild(el("label", null, "Name"));
      var n = el("input", "aa-input");
      n.value = name;
      n.autocomplete = "off";
      v.appendChild(n);
      var go = el("button", "aa-btn primary aa-gap", "Install");
      go.onclick = function () {
        var chosen = n.value.trim();
        startInstall(Object.assign({}, origin, chosen ? { name: chosen } : {}), chosen || name);
      };
      v.appendChild(go);
      v.appendChild(el("p", "aa-note", origin.id
        ? "A marketplace app: once it runs there is nothing more to verify."
        : "Not from the marketplace: once it runs, have a separate agent walk-verify it before it is used for real work."));
      return v;
    }
    /** A source that is not a package: say what can be done, and start the agent on it in a new app's session. */
    function handoff(origin, routes, name) {
      var v = el("div", "aa-section");
      v.appendChild(el("h3", null, "What can be done instead"));
      routes.forEach(function (route) { v.appendChild(el("div", "aa-route", ROUTES[route] || route)); });
      v.appendChild(el("label", null, "Name for the new app"));
      var n = el("input", "aa-input");
      n.value = name || "";
      n.autocomplete = "off";
      v.appendChild(n);
      var row = el("div", "aa-row aa-gap");
      var err = el("div", "aa-err");
      routes.forEach(function (route, i) {
        var b = el("button", "aa-btn" + (i === 0 ? " primary" : ""), route === "adopt" ? "Adopt it with the agent" : "Convert it with the agent");
        b.onclick = function () {
          err.textContent = "";
          var appName = n.value.trim();
          if (!appName) { err.textContent = "Give the new app a name."; return; }
          b.disabled = true;
          api("/import/agent", Object.assign({ action: route === "adopt" ? "adopt" : "import", name: appName }, origin)).then(function (out) {
            b.disabled = false;
            if (!out.ok) { err.textContent = out.message; return; }
            S.job = null;
            S.active = out.path;
            return refresh().then(function () { toggleSide(true); });
          });
        };
        row.appendChild(b);
      });
      v.append(row, err);
      v.appendChild(el("p", "aa-note", "The agent works in the new app’s session, in the side panel, and settles the details with you there through the importer skill."));
      return v;
    }

    /* An install: a job on the server, polled until it ends, then the app opens in its tab. */
    var jobEls = null;
    var jobTimer = 0;
    function startInstall(request, label) {
      S.market.open = null;
      S.job = { label: label, request: request, data: null, error: null };
      render();
      var job = S.job;
      return api("/install", request).then(function (out) {
        if (S.job !== job) return;
        if (out.ok) job.data = out.job;
        else job.error = out.message || "The install did not start.";
        renderJob();
        pollJob();
      });
    }
    function pollJob() {
      clearTimeout(jobTimer);
      var job = S.job;
      if (!job || !job.data || job.data.done) return;
      jobTimer = setTimeout(function () {
        api("/install?job=" + encodeURIComponent(job.data.id)).then(function (out) {
          if (S.job !== job) return;
          if (!out.ok) {
            // A dropped poll is retried; a job the server no longer knows is reported.
            if (out.status === 404) { job.error = out.message; renderJob(); }
            else pollJob();
            return;
          }
          job.data = out.job;
          renderJob();
          if (job.data.done) finished(job);
          else pollJob();
        });
      }, 1000);
    }
    function finished(job) {
      var r = job.data.result;
      if (!job.data.ok || !r || S.active !== "new") return;
      // Installed and serving: show it in its own tab.
      refresh().then(function () {
        if (S.job !== job || S.active !== "new") return;
        S.job = null;
        S.active = r.dir;
        render();
      });
    }
    function jobView() {
      var v = el("div", "aa-pane");
      jobEls = { box: v };
      renderJob();
      return v;
    }
    function renderJob() {
      if (!jobEls || !S.job) return;
      var job = S.job;
      var d = job.data;
      var r = d && d.result;
      var box = jobEls.box;
      box.replaceChildren();
      var ended = !!(d && d.done) || !!job.error;
      var installed = !!(r && r.dir);
      box.appendChild(el("h1", null, !ended ? "Installing “" + job.label + "”"
        : d && d.ok ? "Installed “" + job.label + "”"
          : installed ? "“" + job.label + "” needs fixing" : "The install of “" + job.label + "” stopped"));
      var steps = new Map(((d && d.steps) || []).map(function (s) { return [s.step, s]; }));
      var ol = el("ol", "aa-steps");
      S.meta.steps.forEach(function (name) {
        var s = steps.get(name);
        var state = s ? s.status : "pending";
        var li = el("li", state);
        li.appendChild(el("span", "aa-ic", STEP_ICONS[state] || ""));
        li.appendChild(el("span", "aa-nm", name));
        var detail = s ? s.error || s.reason || "" : "";
        if (detail) li.appendChild(el("span", "aa-dt", detail));
        ol.appendChild(li);
      });
      box.appendChild(ol);
      if (!ended) {
        box.appendChild(el("p", "aa-note", "A download and the app’s dependencies can take several minutes. This page follows the install until it ends; leaving it does not stop it."));
        return;
      }
      var row = el("div", "aa-row");
      var back = el("button", "aa-btn", "Back");
      back.onclick = function () { S.job = null; render(); };
      var open = el("button", "aa-btn primary", "Open it");
      open.onclick = function () { S.job = null; S.active = r.dir; render(); };
      if (d && d.ok) {
        box.appendChild(el("p", "aa-sub", r.url ? "It is serving at " + r.url + "." : "It is installed."));
        if (r.next && r.next.length) section(box, "Still to do", list(r.next));
        row.append(open, back);
      } else if (installed) {
        box.appendChild(el("p", "aa-sub", "It is installed but does not pass its gate, so it stays registered to be fixed."));
        var failures = (r.gate && r.gate.failures) || [];
        if (failures.length) section(box, "What the gate found", list(failures.map(function (f) { return (f.step ? f.step + ": " : "") + (f.message || ""); })));
        row.append(open, back);
      } else {
        box.appendChild(errorBox(job.error || (d && d.error) || "The install failed."));
        if (r && r.routes && r.routes.length) {
          var origin = {};
          ["id", "from", "source"].forEach(function (k) { if (job.request[k]) origin[k] = job.request[k]; });
          box.appendChild(handoff(origin, r.routes, job.request.name || ""));
        }
        var retry = el("button", "aa-btn primary", "Retry");
        retry.onclick = function () { startInstall(job.request, job.label); };
        row.append(retry, back);
      }
      box.appendChild(row);
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
    // A hidden page does not poll: every /apps poll runs `agent-app list`, and a
    // host may keep the page mounted while showing another view.
    function visible() { return root.isConnected && root.getClientRects().length > 0; }
    function quiet(fn) { return function () { if (visible()) fn().catch(function () {}); }; }
    function loadMeta() {
      return api("/meta").then(function (meta) {
        if (!meta.ok) return;
        S.meta = { blueprints: meta.blueprints || [], steps: meta.steps || [], build: meta.build || "dev", loaded: true };
        viewKey = "";
      });
    }
    loadMeta().then(refresh).catch(function () {});
    timers.push(setInterval(quiet(refresh), 4000));
    timers.push(setInterval(quiet(pollLog), 2500));

    function dispose() {
      timers.forEach(clearInterval);
      clearTimeout(jobTimer);
      disposers.forEach(function (d) { d(); });
      root.replaceChildren();
    }
    dispose.refresh = function () { return refresh().catch(function () {}); };
    // A host that learns frames are blocked (a CSP frame-src refusal) turns
    // embedding off; the page then links to the app instead.
    dispose.setEmbeddable = function (value, reason) {
      if (EMBEDDABLE === !!value) return;
      EMBEDDABLE = !!value;
      noFrameReason = value ? "" : String(reason || "");
      frames.forEach(function (f) { f.remove(); });
      frames.clear();
      viewKey = "";
      render();
    };
    return dispose;
  }

  window.__AGENT_APP_MANAGER__ = { mount: mount };

  if (SDK && window.__HERMES_PLUGINS__) {
    var React = SDK.React;
    var AgentAppsPage = function () {
      var ref = SDK.hooks.useRef(null);
      SDK.hooks.useEffect(function () { return mount(ref.current, { fetchJSON: SDK.fetchJSON }); }, []);
      return React.createElement("div", { ref: ref, className: "aa" });
    };
    window.__HERMES_PLUGINS__.register(NAME, AgentAppsPage);
  }
})();
