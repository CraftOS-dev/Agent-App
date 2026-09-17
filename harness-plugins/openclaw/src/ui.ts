/**
 * The Agent Apps manager page, served into OpenClaw's Control UI tab frame.
 *
 * One self-contained HTML document (inline CSS/JS, no external assets) styled
 * with OpenClaw's own design tokens (extracted from its Control UI source) so
 * the page reads as part of the host. Layout: a browser-style tab strip — one
 * tab per Agent App plus a "New +" tab — a content area that embeds the active
 * app (iframe), and a right sidebar rendering the app's dedicated OpenClaw
 * session (transcript + composer).
 *
 * All data flows through the plugin's own JSON API (`cfg.apiBase`), authorized
 * by the per-page token; the page polls (apps every 4s, transcript every 2.5s
 * while the sidebar is open) — no copy-pasting anywhere. DOM is built with
 * createElement/textContent, so app-provided strings never reach innerHTML.
 *
 * Embedding note: the app iframe needs a real origin, which OpenClaw grants
 * plugin frames only under `gateway.controlUi.embedSandbox: "trusted"`. The
 * page detects an opaque origin and shows that exact requirement instead of a
 * broken frame; everything else (tabs, build, lifecycle, session) works under
 * the default sandbox.
 */
export interface ManagerConfig {
  apiBase: string;
  token: string;
  blueprints: readonly string[];
}

export function appManagerHtml(cfg: ManagerConfig): string {
  const cfgJson = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Apps</title>
<style>
:root{
  color-scheme:dark;
  --bg:#0e1015; --surface:#161920; --elevated:#191c24; --bg-hover:#1f2330;
  --text:#bcbcc0; --text-strong:#f4f4f5; --muted:#8b8b94;
  --border:#1e2028; --border-strong:#2e3040;
  --accent:#ff5c5c; --accent-hover:#ff7070; --accent-subtle:rgba(255,92,92,0.10); --accent-glow:rgba(255,92,92,0.20);
  --primary:#d13c3c; --primary-hover:#c22e2e; --primary-fg:#ffffff;
  --ok:#22c55e; --warn:#f59e0b; --danger:#f87171; --danger-subtle:rgba(248,113,113,0.08);
  --radius-sm:6px; --radius-md:10px; --radius-lg:14px; --radius-full:9999px;
  --shadow-sm:0 1px 2px rgba(0,0,0,0.25);
  --overlay-border:rgba(46,48,64,0.64);
  --overlay-shadow:0 1px 2px rgb(0 0 0 / 0.18), 0 8px 24px rgb(0 0 0 / 0.24);
  --font:"Instrument Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,"SF Mono",Menlo,Monaco,Consolas,monospace;
  --ease:cubic-bezier(0.16,1,0.3,1);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;font:400 14px/1.55 var(--font);letter-spacing:-0.01em;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;overflow:hidden}
::selection{background:#005fcc;color:#fff}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button{font:inherit;letter-spacing:inherit;cursor:pointer}

/* ── Tab strip ─────────────────────────────────────────── */
.tabbar{display:flex;align-items:flex-end;gap:2px;padding:8px 10px 0;background:var(--bg);border-bottom:1px solid var(--border);flex:none;overflow-x:auto;scrollbar-width:none}
.tabbar::-webkit-scrollbar{display:none}
.tab{display:flex;align-items:center;gap:8px;max-width:220px;min-width:0;padding:7px 12px;border:1px solid transparent;border-bottom:none;border-radius:var(--radius-md) var(--radius-md) 0 0;background:transparent;color:var(--muted);font-size:13px;font-weight:550;white-space:nowrap}
.tab:hover{color:var(--text);background:color-mix(in srgb,var(--bg-hover) 60%,transparent)}
.tab.active{background:var(--surface);border-color:var(--border);color:var(--text-strong);box-shadow:0 1px 0 var(--surface)}
.tab.offline{color:var(--muted)}
.tab.offline .tab-name{opacity:0.55}
.tab.active.offline .tab-name{opacity:0.7}
.tab-name{overflow:hidden;text-overflow:ellipsis;min-width:0}
.tab .dot{flex:none;width:8px;height:8px;border-radius:var(--radius-full)}
.dot.ok{background:var(--ok);box-shadow:0 0 8px color-mix(in srgb,var(--ok) 50%,transparent)}
.dot.warn{background:var(--warn);box-shadow:0 0 8px color-mix(in srgb,var(--warn) 50%,transparent)}
.dot.off{background:var(--muted);opacity:0.5}
.dot.busy{background:var(--warn);animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.35}}
.tab-more{flex:none;display:none;align-items:center;justify-content:center;width:20px;height:20px;border:none;border-radius:var(--radius-sm);background:transparent;color:var(--muted);padding:0;line-height:1}
.tab.active .tab-more{display:inline-flex}
.tab-more:hover{background:var(--bg-hover);color:var(--text-strong)}
.tab.newtab{margin-left:auto;flex:none;color:var(--muted);font-weight:600}
.tab.newtab.active{color:var(--accent)}

/* ── Layout ────────────────────────────────────────────── */
main{flex:1;display:flex;min-height:0}
#view{flex:1;min-width:0;position:relative;background:var(--surface)}
#frames{position:absolute;inset:0}
#frames iframe{position:absolute;inset:0;width:100%;height:100%;border:none;background:#fff}
.center{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto}
.center[hidden]{display:none}
.card{width:100%;max-width:520px;border:1px solid var(--border);background:var(--elevated);border-radius:var(--radius-lg);padding:24px}
.card h2{margin:0 0 4px;font-size:15px;font-weight:600;letter-spacing:-0.02em;color:var(--text-strong)}
.card .sub{font-size:13px;color:var(--muted);margin:0 0 16px;line-height:1.5}
.card .meta{font:12px/1.6 var(--mono);color:var(--muted);word-break:break-all;margin:0 0 16px}
.row{display:flex;gap:10px;flex-wrap:wrap}

/* ── Buttons ───────────────────────────────────────────── */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--border);background:var(--elevated);color:var(--text);padding:8px 14px;border-radius:var(--radius-md);font-size:13px;font-weight:500}
.btn:hover{background:var(--bg-hover);border-color:var(--border-strong)}
.btn:disabled{opacity:0.55;cursor:default}
.btn.primary{border-color:var(--accent);background:var(--primary);color:var(--primary-fg);box-shadow:0 1px 3px var(--accent-subtle)}
.btn.primary:hover{background:var(--primary-hover);box-shadow:0 2px 12px var(--accent-glow)}
.btn.danger{border-color:transparent;background:var(--danger-subtle);color:var(--danger)}
.btn.danger:hover{border-color:var(--danger)}

/* ── Menu ──────────────────────────────────────────────── */
#menu{position:fixed;z-index:30;min-width:180px;padding:4px;border:1px solid var(--overlay-border);border-radius:var(--radius-md);background:var(--elevated);box-shadow:var(--overlay-shadow);animation:menu-in 140ms var(--ease)}
@keyframes menu-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
#menu button{display:flex;width:100%;align-items:center;min-height:28px;border:none;border-radius:var(--radius-sm);background:transparent;color:var(--text);padding:0 10px;font-size:13px;text-align:left}
#menu button:hover{background:var(--bg-hover)}
#menu button.danger{color:var(--danger)}
#menu button.danger:hover{background:var(--danger-subtle)}
#menu hr{border:none;border-top:1px solid var(--border);margin:4px 2px}

/* ── Form (New tab) ────────────────────────────────────── */
.form{width:100%;max-width:560px}
.form h1{font-size:22px;font-weight:650;letter-spacing:-0.03em;line-height:1.2;color:var(--accent);margin:0 0 4px}
.form .lead{font-size:12px;color:var(--muted);margin:0 0 20px}
label{display:block;margin:14px 0 6px;font-size:13px;font-weight:600;color:var(--text-strong)}
.input,select.input,textarea.input{width:100%;padding:7px 10px;border-radius:var(--radius-md);color:var(--text);border:1px solid var(--border);background:var(--elevated);font:inherit}
.input::placeholder{color:var(--muted)}
.input:focus-visible{outline:none;border-color:color-mix(in srgb,var(--accent) 55%,var(--border) 45%);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 18%,transparent)}
textarea.input{min-height:120px;resize:vertical}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form .btn.primary{width:100%;margin-top:20px;padding:11px 14px;font-weight:600}
.err{margin-top:12px;font-size:13px;font-weight:600;color:var(--danger)}

/* ── Session sidebar ───────────────────────────────────── */
#side{width:380px;flex:none;display:flex;flex-direction:column;border-left:1px solid var(--border);background:var(--bg)}
#side[hidden]{display:none}
.side-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border);flex:none}
.side-head .t{font-size:12px;font-weight:600;color:var(--text-strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.side-head .s{font-size:11px;color:var(--muted);flex:none}
.side-close{flex:none;border:none;background:transparent;color:var(--muted);width:22px;height:22px;border-radius:var(--radius-sm);padding:0;line-height:1}
.side-close:hover{background:var(--bg-hover);color:var(--text-strong)}
#log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:100%;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.msg .who{font-size:10px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:var(--muted);margin-bottom:2px}
.msg.user{border-left:2px solid var(--accent);padding-left:10px}
.msg.user .who{color:var(--accent)}
.msg.other{color:var(--muted);font-size:12px}
.log-empty{margin:auto;text-align:center;color:var(--muted);font-size:13px}
.composer{display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--border);flex:none}
.composer textarea{flex:1;min-height:38px;max-height:140px;resize:none;padding:8px 10px;border-radius:var(--radius-md);border:1px solid var(--border);background:var(--elevated);color:var(--text);font:inherit;font-size:13px}
.composer textarea:focus-visible{outline:none;border-color:color-mix(in srgb,var(--accent) 55%,var(--border) 45%)}
.composer .btn{flex:none;align-self:flex-end}
.spinner{width:22px;height:22px;border:2px solid var(--border-strong);border-top-color:var(--accent);border-radius:var(--radius-full);animation:spin 0.8s linear infinite;margin:0 auto 14px}
@keyframes spin{to{transform:rotate(360deg)}}
.cfgline{font:12px/1.6 var(--mono);background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;color:var(--text);user-select:all}
</style></head><body>
<header class="tabbar" id="tabbar"></header>
<main>
  <section id="view"><div id="frames"></div><div id="panel" class="center" hidden></div></section>
  <aside id="side" hidden>
    <div class="side-head"><span class="t" id="side-title"></span><span class="s">session</span><button class="side-close" id="side-close" title="Close">&#10005;</button></div>
    <div id="log"></div>
    <div class="composer"><textarea id="chat-in" placeholder="Ask for a change, a task, a report&hellip;"></textarea><button class="btn primary" id="chat-send">Send</button></div>
  </aside>
</main>
<div id="menu" hidden></div>
<script type="application/json" id="cfg">${cfgJson}</script>
<script>
"use strict";
const CFG = JSON.parse(document.getElementById("cfg").textContent);
const OPAQUE = self.origin === "null";
const S = { rows: [], active: null, side: false, sideRow: null, log: [], sending: false, busy: new Set(), confirmDelete: null };

function api(path, body) {
  const opts = { method: body ? "POST" : "GET", headers: { "x-a2app-token": CFG.token } };
  if (body) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
  return fetch(CFG.apiBase + path, opts).then((r) => r.json());
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* ── Data ──────────────────────────────────────────────── */
async function refresh() {
  const data = await api("/apps");
  S.rows = data.rows;
  if (S.active === null) S.active = S.rows.length ? S.rows[0].path : "new";
  if (S.active !== "new" && !S.rows.some((r) => r.path === S.active)) S.active = S.rows.length ? S.rows[0].path : "new";
  if (S.sideRow) { const cur = S.rows.find((r) => r.path === S.sideRow.path); if (cur) S.sideRow = cur; }
  render();
}
function activeRow() { return S.rows.find((r) => r.path === S.active) ?? null; }

/* ── Tab strip ─────────────────────────────────────────── */
function dotClass(r) {
  if (r.building) return "busy";
  if (r.status === "running") return "ok";
  if (r.status === "unreachable") return "warn";
  return "off";
}
function renderTabs() {
  const bar = document.getElementById("tabbar");
  bar.replaceChildren();
  for (const r of S.rows) {
    const t = el("button", "tab" + (r.path === S.active ? " active" : "") + (r.status !== "running" && !r.building ? " offline" : ""));
    t.appendChild(el("span", "dot " + dotClass(r)));
    t.appendChild(el("span", "tab-name", r.name));
    const more = el("button", "tab-more", "\\u22EF");
    more.title = "App actions";
    more.onclick = (e) => { e.stopPropagation(); openMenu(r, more); };
    t.appendChild(more);
    t.onclick = () => { S.active = r.path; S.confirmDelete = null; closeMenu(); render(); };
    bar.appendChild(t);
  }
  const nt = el("button", "tab newtab" + (S.active === "new" ? " active" : ""), "New +");
  nt.onclick = () => { S.active = "new"; closeMenu(); render(); };
  bar.appendChild(nt);
}

/* ── "..." menu ────────────────────────────────────────── */
function openMenu(r, anchor) {
  const m = document.getElementById("menu");
  m.replaceChildren();
  const item = (label, cls, fn) => { const b = el("button", cls, label); b.onclick = fn; m.appendChild(b); };
  if (r.status === "running") item("Pause", "", () => { closeMenu(); act(r, "stop"); });
  else if (!r.building) item("Launch", "", () => { closeMenu(); act(r, "serve"); });
  item(S.side && S.sideRow && S.sideRow.path === r.path ? "Hide session" : "Show session", "", () => { closeMenu(); toggleSide(r); });
  m.appendChild(el("hr"));
  if (S.confirmDelete === r.path) {
    item("Confirm delete \\u2014 removes files", "danger", () => { closeMenu(); removeApp(r); });
  } else {
    item("Delete\\u2026", "danger", () => { S.confirmDelete = r.path; openMenu(r, anchor); });
  }
  const rect = anchor.getBoundingClientRect();
  m.hidden = false;
  m.style.left = Math.min(rect.left, innerWidth - m.offsetWidth - 8) + "px";
  m.style.top = rect.bottom + 6 + "px";
}
function closeMenu() { document.getElementById("menu").hidden = true; S.confirmDelete = null; }
addEventListener("click", (e) => { if (!document.getElementById("menu").contains(e.target)) closeMenu(); });

/* ── Lifecycle actions ─────────────────────────────────── */
async function act(r, verb) {
  S.busy.add(r.path); render();
  try { await api("/app/" + verb, { path: r.path }); } finally { S.busy.delete(r.path); }
  await refresh();
}
async function removeApp(r) {
  S.busy.add(r.path); render();
  try { await api("/app/remove", { path: r.path }); } finally { S.busy.delete(r.path); }
  if (S.sideRow && S.sideRow.path === r.path) { S.side = false; S.sideRow = null; }
  S.active = null;
  await refresh();
}

/* ── Views ─────────────────────────────────────────────── */
const frames = new Map();
// The panel rebuilds only when what it shows changes (this key), so the poll
// loop never wipes in-progress form input or button state.
let viewKey = "";
function renderView() {
  const panel = document.getElementById("panel");
  const framesBox = document.getElementById("frames");
  const r = activeRow();
  const showFrame = r && r.status === "running" && !OPAQUE;
  for (const [path, f] of frames) {
    const row = S.rows.find((x) => x.path === path);
    if (!row || row.status !== "running") { f.remove(); frames.delete(path); }
    else f.style.display = showFrame && path === r.path ? "block" : "none";
  }
  if (showFrame && !frames.has(r.path)) {
    const f = document.createElement("iframe");
    f.src = r.url;
    f.title = r.name;
    frames.set(r.path, f);
    framesBox.appendChild(f);
  }
  panel.hidden = !!showFrame;
  const key = showFrame
    ? "frame:" + r.path
    : S.active === "new" || !r
      ? "new"
      : ["app", r.path, r.status, r.building, r.buildEnded, S.busy.has(r.path), S.side && S.sideRow ? S.sideRow.path : ""].join("|");
  if (key === viewKey) return;
  viewKey = key;
  if (showFrame) return;
  panel.replaceChildren();
  if (S.active === "new" || !r) { panel.appendChild(buildForm()); return; }
  panel.appendChild(appPanel(r));
}
function appPanel(r) {
  const c = el("div", "card");
  const busy = S.busy.has(r.path);
  if (r.building) {
    c.appendChild(el("div", "spinner"));
    c.appendChild(el("h2", null, "The agent is building \\u201C" + r.name + "\\u201D"));
    c.appendChild(el("p", "sub", "It scaffolds, builds feature by feature, validates, walk-verifies, and serves the app. Watch it work in the session panel \\u2014 the tab goes live the moment the app is up."));
    if (!S.side || !S.sideRow || S.sideRow.path !== r.path) {
      const b = el("button", "btn", "Show session");
      b.onclick = () => toggleSide(r);
      c.appendChild(b);
    }
    return c;
  }
  if (r.status === "running" && OPAQUE) {
    c.appendChild(el("h2", null, r.name + " is running"));
    c.appendChild(el("p", "sub", "Embedding an app needs a real browser origin inside this frame. Add this to your OpenClaw config, then restart the gateway:"));
    c.appendChild(el("div", "cfgline", 'gateway.controlUi.embedSandbox: "trusted"'));
    return c;
  }
  if (r.status === "unreachable") {
    c.appendChild(el("h2", null, r.name + " is unreachable"));
    c.appendChild(el("p", "sub", "Port " + r.port + " is answering, but not as this app. Stop whatever holds the port, or pause and relaunch."));
  } else if (r.buildEnded) {
    c.appendChild(el("h2", null, "Build session ended"));
    c.appendChild(el("p", "sub", "The agent's build run for \\u201C" + r.name + "\\u201D finished, but the app is not running. Check the session for what happened, or try launching it."));
  } else {
    c.appendChild(el("h2", null, r.name + " is offline"));
    c.appendChild(el("p", "sub", "The app is registered but not serving right now."));
  }
  c.appendChild(el("p", "meta", r.path));
  const row = el("div", "row");
  const launch = el("button", "btn primary", busy ? "Launching\\u2026" : "Launch");
  launch.disabled = busy;
  launch.onclick = () => act(r, "serve");
  row.appendChild(launch);
  const sess = el("button", "btn", "Show session");
  sess.onclick = () => toggleSide(r);
  row.appendChild(sess);
  c.appendChild(row);
  return c;
}

/* ── New-app form ──────────────────────────────────────── */
function buildForm() {
  const f = el("div", "form");
  f.appendChild(el("h1", null, "Agent Apps"));
  f.appendChild(el("p", "lead", "Describe the app; the agent builds, verifies, and serves it here."));
  f.appendChild(el("label", null, "App name"));
  const name = el("input", "input"); name.id = "f-name"; name.placeholder = "Acme CRM"; name.autocomplete = "off";
  f.appendChild(name);
  f.appendChild(el("label", null, "What should it do?"));
  const req = el("textarea", "input"); req.id = "f-req";
  req.placeholder = "Track contacts, companies, and deals. A pipeline board, per-contact activity log, and a weekly summary.";
  f.appendChild(req);
  const g = el("div", "grid2");
  const c1 = el("div"); c1.appendChild(el("label", null, "Stack"));
  const bp = el("select", "input"); bp.id = "f-bp";
  for (const b of CFG.blueprints) bp.appendChild(new Option(b, b));
  c1.appendChild(bp); g.appendChild(c1);
  const c2 = el("div"); c2.appendChild(el("label", null, "Port (optional)"));
  const port = el("input", "input"); port.id = "f-port"; port.type = "number"; port.placeholder = "auto"; port.autocomplete = "off";
  c2.appendChild(port); g.appendChild(c2);
  f.appendChild(g);
  const go = el("button", "btn primary", "Build it");
  go.onclick = () => submitBuild(go);
  f.appendChild(go);
  const err = el("div", "err"); err.id = "f-err";
  f.appendChild(err);
  return f;
}
async function submitBuild(btn) {
  const v = (id) => document.getElementById(id).value.trim();
  const err = document.getElementById("f-err");
  const body = { name: v("f-name"), requirement: v("f-req"), blueprint: v("f-bp"), port: v("f-port") };
  err.textContent = "";
  if (!body.name || !body.requirement) { err.textContent = "Give the app a name and describe what it should do."; return; }
  btn.disabled = true; btn.textContent = "Starting\\u2026";
  const out = await api("/build", body);
  if (!out.ok) { err.textContent = out.message; btn.disabled = false; btn.textContent = "Build it"; return; }
  S.active = out.path;
  await refresh();
  const row = activeRow();
  if (row) toggleSide(row, true);
}

/* ── Session sidebar ───────────────────────────────────── */
function toggleSide(r, forceOpen) {
  if (S.side && !forceOpen && S.sideRow && S.sideRow.path === r.path) { S.side = false; S.sideRow = null; }
  else { S.side = true; S.sideRow = r; S.log = []; pollLog(); }
  render();
}
document.getElementById("side-close").onclick = () => { S.side = false; S.sideRow = null; render(); };
async function pollLog() {
  if (!S.side || !S.sideRow) return;
  const out = await api("/session?app=" + encodeURIComponent(S.sideRow.path));
  if (out.ok && S.side) { S.log = out.messages; renderLog(); }
}
function renderLog() {
  const log = document.getElementById("log");
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
  log.replaceChildren();
  if (!S.log.length) { log.appendChild(el("div", "log-empty", "No session activity yet.")); return; }
  for (const m of S.log.slice(-200)) {
    const cls = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : "other";
    const d = el("div", "msg " + cls);
    d.appendChild(el("div", "who", m.role));
    d.appendChild(el("div", null, m.text));
    log.appendChild(d);
  }
  if (stick) log.scrollTop = log.scrollHeight;
}
async function sendChat() {
  const input = document.getElementById("chat-in");
  const text = input.value.trim();
  if (!text || !S.sideRow || S.sending) return;
  S.sending = true; input.value = "";
  S.log.push({ role: "user", text }); renderLog();
  try { await api("/session/send", { path: S.sideRow.path, name: S.sideRow.name, text }); }
  finally { S.sending = false; }
}
document.getElementById("chat-send").onclick = sendChat;
document.getElementById("chat-in").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

/* ── Render root ───────────────────────────────────────── */
function render() {
  renderTabs();
  renderView();
  const side = document.getElementById("side");
  side.hidden = !S.side;
  if (S.side && S.sideRow) document.getElementById("side-title").textContent = S.sideRow.name;
}

// Poll guards: a transient fetch failure (gateway restart, sleep/wake) must not
// kill the loops; the next tick retries.
const quiet = (fn) => () => fn().catch(() => {});
quiet(refresh)();
setInterval(quiet(refresh), 4000);
setInterval(quiet(pollLog), 2500);
</script></body></html>`;
}
