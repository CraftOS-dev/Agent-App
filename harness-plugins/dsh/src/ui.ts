/**
 * The Agent Apps manager page, served over dsh's web server and shown inside the
 * dsh UI through a client slot iframe. One self-contained HTML document styled
 * with dsh's own design tokens (light + dark, selected by `cfg.dark` since an
 * iframe does not inherit the host's theme variables).
 *
 * Layout: a browser-style tab strip (one tab per Agent App plus a "New +" tab),
 * a content area embedding the active app, and a resizable side panel rendering
 * that app's dsh session. The page is same-origin with the dsh server, so its
 * JSON calls need no CORS; DOM is built with createElement/textContent so
 * app-provided strings never reach innerHTML.
 *
 * The New + tab has three panels: Build (the agent builds a new app), the
 * Marketplace (search, tag chips, a card per app, install), and Import (a zip,
 * a folder or a git URL: inspect, then install, or hand a source that is not a
 * package to the agent to convert or adopt). An install is a job on the
 * server; the page polls it every second and shows each pipeline step from
 * `install --events`, then opens the app in its tab. It never gives up on a
 * running install, so no client timeout is shorter than the CLI's own.
 */
export interface ManagerConfig {
  apiBase: string;
  /** dsh web route for transcript reads (same-origin GET). */
  homeBase: string;
  token: string;
  blueprints: readonly string[];
  /** The install pipeline's steps, in order: the rows of the progress view. */
  steps: readonly string[];
  /** Whether the host is in dark mode (the iframe cannot read the parent theme). */
  dark: boolean;
  /** Bundle build stamp, shown in the footer to flag a stale installed copy. */
  build: string;
}

export function appManagerHtml(cfg: ManagerConfig): string {
  const cfgJson = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Apps</title>
<style>
:root{
  color-scheme:light;
  --font:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif;
  --mono:'SF Mono','JetBrains Mono','Fira Code',Consolas,'Liberation Mono',Menlo,Courier,'PingFang SC','Microsoft YaHei';
  --ease:cubic-bezier(0.4,0,0.2,1);
  --shadow-lv2:0 4px 12px 0 rgba(0,0,0,.02),0 2px 8px 0 rgba(0,0,0,.04);
  --shadow-lv3:0 0 1px 0 rgba(0,0,0,.2),0 0 4px 0 rgba(0,0,0,.02),0 12px 32px 0 rgba(0,0,0,.08);
  /* Light (dsh design-platform.css body{}) */
  --bg:rgb(255,255,255); --surface:rgb(255,255,255); --elevated:rgb(255,255,255); --layer:rgb(235,238,242);
  --sidebar:rgb(249,250,251); --input-bg:rgb(255,255,255);
  --text:rgb(15,17,21); --text-2:rgb(97,102,107); --text-3:rgb(129,133,140); --text-dim:rgb(173,178,184);
  --border-1:rgba(0,0,0,.04); --border-2:rgba(0,0,0,.10); --border-3:rgba(0,0,0,.16);
  --primary:rgb(15,17,21); --primary-hover:rgb(67,69,74); --primary-fg:rgb(255,255,255);
  --accent:rgb(65,118,230); --accent-hover:rgb(103,158,254);
  --hover:rgba(38,49,72,.06); --active:rgba(38,49,72,.10); --hover-danger:rgba(236,19,19,.05);
  --success:rgb(34,197,94); --warn:rgb(245,158,11); --danger:rgb(236,19,19);
}
:root[data-dark]{
  color-scheme:dark;
  /* Dark (dsh body[data-ds-dark-theme]{}) */
  --bg:rgb(21,21,23); --surface:rgb(35,35,36); --elevated:rgb(44,44,46); --layer:rgb(53,54,56);
  --sidebar:rgb(27,27,28); --input-bg:rgb(44,44,46);
  --text:rgb(249,250,251); --text-2:rgb(207,211,214); --text-3:rgb(173,178,184); --text-dim:rgb(67,69,74);
  --border-1:rgba(255,255,255,.06); --border-2:rgba(255,255,255,.12); --border-3:rgba(255,255,255,.20);
  --primary:rgb(249,250,251); --primary-hover:rgb(235,238,242); --primary-fg:rgb(15,17,21);
  --accent:rgb(103,158,254); --accent-hover:rgb(65,118,230);
  --hover:rgba(255,255,255,.08); --active:rgba(255,255,255,.14); --hover-danger:rgba(242,90,90,.15);
  --success:rgb(34,197,94); --warn:rgb(245,158,11); --danger:rgb(242,90,90);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;font:14px/1.6 var(--font);background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;overflow:hidden}
::selection{background:var(--accent);color:#fff}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button{font:inherit;cursor:pointer}

/* ── Tab strip ── */
.tabbar{display:flex;align-items:flex-end;gap:0;padding:6px 8px 0;background:var(--sidebar);border-bottom:1px solid var(--border-2);flex:none;overflow-x:auto;scrollbar-width:none}
.tabbar::-webkit-scrollbar{display:none}
.tab{position:relative;display:flex;align-items:center;gap:7px;max-width:200px;min-width:0;height:32px;padding:0 12px;border:1px solid transparent;border-bottom:none;border-radius:10px 10px 0 0;background:transparent;color:var(--text-3);font-size:13px;font-weight:500;white-space:nowrap}
.tab:not(.active):not(:hover)+.tab:not(.active):not(:hover)::before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:1px;background:var(--border-2)}
.tab:hover{color:var(--text);background:var(--hover)}
.tab.active{background:var(--surface);border-color:var(--border-2);color:var(--text);box-shadow:0 1px 0 var(--surface)}
.tab.offline .tab-name{opacity:0.55}
.tab.active.offline .tab-name{opacity:0.7}
.tab-name{overflow:hidden;text-overflow:ellipsis;min-width:0}
.tab .dot{flex:none;width:6px;height:6px;border-radius:9999px}
.dot.ok{background:var(--success);box-shadow:0 0 0 3px color-mix(in srgb,var(--success) 15%,transparent)}
.dot.warn{background:var(--warn);box-shadow:0 0 0 3px color-mix(in srgb,var(--warn) 15%,transparent)}
.dot.off{background:var(--text-3);opacity:0.5}
.dot.busy{background:var(--warn);animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.35}}
.tab-more{flex:none;display:none;align-items:center;justify-content:center;width:18px;height:18px;border:none;border-radius:6px;background:transparent;color:var(--text-3);padding:0;line-height:1;font-size:12px}
.tab.active .tab-more{display:inline-flex}
.tab-more:hover{background:var(--hover);color:var(--text)}
.tab.newtab{margin-left:auto;flex:none;color:var(--text-3);font-weight:600}
.tab.newtab.active{color:var(--accent)}

/* ── Layout ── */
main{flex:1;display:flex;min-height:0}
#view{flex:1;min-width:0;position:relative;background:var(--surface)}
#frames{position:absolute;inset:0}
#frames iframe{position:absolute;inset:0;width:100%;height:100%;border:none;background:#fff}
.center{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto}
.center[hidden]{display:none}
.card{width:100%;max-width:520px;border:1px solid var(--border-2);background:var(--surface);border-radius:12px;padding:24px;box-shadow:var(--shadow-lv2)}
.card h2{margin:0 0 4px;font-size:16px;font-weight:600;color:var(--text)}
.card .sub{font-size:13px;color:var(--text-2);margin:0 0 16px;line-height:1.5}
.card .meta{font:12px/1.6 var(--mono);color:var(--text-3);word-break:break-all;margin:0 0 16px}
.row{display:flex;gap:10px;flex-wrap:wrap}

/* ── Buttons ── */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;border:1px solid var(--border-2);background:transparent;color:var(--text);padding:0 14px;border-radius:18px;font-size:14px;font-weight:500}
.btn:hover{background:var(--hover)}
.btn:disabled{opacity:0.55;cursor:default}
.btn.primary{border-color:transparent;background:var(--primary);color:var(--primary-fg)}
.btn.primary:hover{background:var(--primary-hover)}
.btn.danger{border-color:transparent;background:transparent;color:var(--danger)}
.btn.danger:hover{background:var(--hover-danger)}

/* ── Menu ── */
#menu{position:fixed;z-index:30;min-width:180px;padding:4px;border:1px solid var(--border-2);border-radius:12px;background:var(--layer);box-shadow:var(--shadow-lv3)}
#menu button{display:flex;width:100%;align-items:center;min-height:40px;border:none;border-radius:10px;background:transparent;color:var(--text);padding:0 10px;font-size:14px;text-align:left}
#menu button:hover{background:var(--hover)}
#menu button.danger{color:var(--danger)}
#menu button.danger:hover{background:var(--hover-danger)}
#menu hr{border:none;border-top:1px solid var(--border-1);margin:4px 2px}

/* ── Form (New tab) ── */
.form{width:100%;max-width:560px}
.form h1{font-size:22px;font-weight:700;line-height:1.2;color:var(--text);margin:0 0 4px}
.form .lead{font-size:13px;color:var(--text-2);margin:0 0 20px}
label{display:block;margin:14px 0 6px;font-size:13px;font-weight:600;color:var(--text)}
.input,select.input,textarea.input{width:100%;height:32px;padding:0 10px;border-radius:8px;color:var(--text);border:1px solid var(--border-2);background:var(--input-bg);font:inherit}
textarea.input{height:auto;min-height:120px;padding:8px 10px;resize:vertical}
.input::placeholder{color:var(--text-dim)}
.input:focus-visible{outline:none;border-color:var(--accent)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form .btn.primary{width:100%;margin-top:20px}
.err{margin-top:12px;font-size:13px;font-weight:500;color:var(--danger)}
.buildstamp{margin:16px 0 0;font-size:11px;color:var(--text-3);opacity:0.7}

/* ── Session sidebar ── */
#resizer{flex:none;width:5px;margin:0 -2px;cursor:col-resize;background:transparent;z-index:5;touch-action:none}
#resizer:hover,#resizer.dragging{background:color-mix(in srgb,var(--accent) 35%,transparent)}
#resizer[hidden]{display:none}
#side{width:380px;min-width:280px;max-width:70vw;flex:none;display:flex;flex-direction:column;border-left:1px solid var(--border-2);background:var(--sidebar)}
#side[hidden]{display:none}
.side-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border-2);flex:none}
.side-head .t{font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.side-head .s{font-size:11px;color:var(--text-3);flex:none}
.side-close{flex:none;border:none;background:transparent;color:var(--text-3);width:22px;height:22px;border-radius:6px;padding:0;line-height:1}
.side-close:hover{background:var(--hover);color:var(--text)}
#log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:100%;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;max-width:88%;background:color-mix(in srgb,var(--accent) 12%,transparent);border:1px solid color-mix(in srgb,var(--accent) 28%,transparent);border-radius:14px 14px 4px 14px;padding:8px 12px;color:var(--text)}
.msg.assistant{align-self:flex-start;max-width:95%;color:var(--text)}
.toolsline{display:flex;align-items:center;gap:6px;color:var(--text-3);font-size:11px;font-weight:500}
.toolsline::before{content:"\\2261";font-size:13px;opacity:0.7}
.toolrow{max-width:100%}
.toolrow summary{cursor:pointer;color:var(--text-3);font-size:11px;font-weight:500;user-select:none}
.toolrow summary:hover{color:var(--text)}
.toolrow pre{font:11px/1.5 var(--mono);color:var(--text);background:var(--surface);border:1px solid var(--border-2);border-radius:6px;padding:8px 10px;margin:6px 0 0;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.log-empty{margin:auto;text-align:center;color:var(--text-3);font-size:13px}
.composer{padding:10px 12px 12px;border-top:1px solid var(--border-2);flex:none}
.composer-box{display:flex;align-items:flex-end;gap:8px;border:1px solid var(--border-2);background:var(--input-bg);border-radius:22px;padding:7px 7px 7px 14px;box-shadow:var(--shadow-lv2);transition:border-color .1s var(--ease)}
.composer-box:focus-within{border-color:var(--accent)}
/* max-height = 6 rows: 6 × (13px × 1.45) + 4px padding */
.composer-box textarea{flex:1;min-width:0;max-height:122px;resize:none;border:none;background:transparent;color:var(--text);font:inherit;font-size:13px;line-height:1.45;padding:4px 0;outline:none}
.composer-box textarea::placeholder{color:var(--text-dim)}
.send{flex:none;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9999px;border:none;background:var(--primary);color:var(--primary-fg);padding:0;transition:background .1s var(--ease)}
.send:hover:not(:disabled){background:var(--primary-hover)}
.send:disabled{cursor:default;background:var(--hover);color:var(--text-3)}
.send svg{display:block}
.spinner{width:22px;height:22px;border:2px solid var(--border-3);border-top-color:var(--accent);border-radius:9999px;animation:spin 0.8s linear infinite;margin:0 auto 14px}
@keyframes spin{to{transform:rotate(360deg)}}
/* ── New tab: build · marketplace · import ── */
.center.top{align-items:flex-start}
.newpane{width:100%;max-width:560px}
.newpane.wide{max-width:980px}
.modes{display:inline-flex;gap:2px;padding:3px;margin:0 0 18px;border:1px solid var(--border-2);border-radius:10px;background:var(--sidebar)}
.modes button{border:none;background:transparent;color:var(--text-3);padding:5px 12px;border-radius:8px;font-size:13px;font-weight:500}
.modes button:hover{color:var(--text)}
.modes button.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow-lv2)}
.pane h1{font-size:22px;font-weight:700;line-height:1.2;color:var(--text);margin:0 0 4px}
.pane .lead{font-size:13px;color:var(--text-2);margin:0 0 18px}
.pane .sub{font-size:13px;color:var(--text-2);margin:0 0 4px;line-height:1.5}
.searchrow{display:flex;gap:10px;margin:0 0 10px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.chip{border:1px solid var(--border-2);background:transparent;color:var(--text-2);border-radius:9999px;padding:2px 10px;font-size:12px}
.chip:hover{background:var(--hover)}
.chip.on{border-color:var(--accent);color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.app{display:flex;flex-direction:column;border:1px solid var(--border-2);background:var(--surface);border-radius:12px;overflow:hidden;box-shadow:var(--shadow-lv2)}
.app .thumb{aspect-ratio:16/9;background:var(--layer);display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:28px;font-weight:700}
.app .thumb img{width:100%;height:100%;object-fit:cover;display:block}
.app .body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:6px;flex:1}
.app h3{margin:0;font-size:14px;font-weight:600;color:var(--text);display:flex;align-items:baseline;gap:8px}
.app .ver{font:11px var(--mono);color:var(--text-3);font-weight:400}
.app .desc{margin:0;font-size:13px;color:var(--text-2);line-height:1.5}
.app .actions{margin-top:auto;padding-top:8px;display:flex;gap:8px;flex-wrap:wrap}
.tags{display:flex;flex-wrap:wrap;gap:4px}
.tag{font-size:11px;color:var(--text-2);background:var(--layer);border-radius:6px;padding:1px 6px}
.compat{font-size:12px;color:var(--text-3)}
.compat.yes{color:var(--success)}
.compat.no{color:var(--warn)}
.fields{border-top:1px solid var(--border-1);margin-top:4px}
.fields label{margin:8px 0 4px;font-size:12px}
.btn.small{height:30px;padding:0 12px;font-size:13px;border-radius:15px}
.note{font-size:12px;color:var(--text-3);margin:8px 0 0;line-height:1.5}
.empty{color:var(--text-3);font-size:13px;padding:24px 0;text-align:center}
.errbox{display:flex;flex-direction:column;align-items:flex-start;gap:10px;margin:12px 0}
.code{font:12px/1.6 var(--mono);background:var(--sidebar);border:1px solid var(--border-2);border-radius:8px;padding:8px 10px;margin:0;white-space:pre-wrap;word-break:break-word;width:100%;max-height:260px;overflow:auto;color:var(--text)}
.errbox .code{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 35%,transparent)}
.report{margin-top:18px;border:1px solid var(--border-2);background:var(--surface);border-radius:12px;padding:18px;box-shadow:var(--shadow-lv2)}
.report h2{margin:10px 0 4px;font-size:16px;font-weight:600;color:var(--text)}
.report .sub{font-size:13px;color:var(--text-2);margin:0}
.badges{display:flex;gap:6px;flex-wrap:wrap}
.badge{font-size:12px;font-weight:500;border-radius:9999px;padding:2px 9px;border:1px solid var(--border-2);color:var(--text-2)}
.badge.ok{color:var(--success);border-color:color-mix(in srgb,var(--success) 40%,transparent)}
.badge.no{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,transparent)}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;font-size:13px;margin:14px 0 0}
.kv dt{color:var(--text-3)}
.kv dd{margin:0;word-break:break-word}
.section{margin:16px 0 0}
.section h3{margin:0 0 6px;font-size:13px;font-weight:600;color:var(--text)}
.section ul{margin:0;padding-left:18px;font-size:13px;line-height:1.6}
.section ul.warn li{color:var(--warn)}
.route{border:1px solid var(--border-2);border-radius:10px;padding:10px 12px;margin:8px 0 0;font-size:13px;line-height:1.5}
.steps{list-style:none;margin:16px 0;padding:0;display:flex;flex-direction:column;gap:5px}
.steps li{display:flex;gap:10px;align-items:baseline;font-size:13px}
.steps .ic{width:16px;flex:none;text-align:center}
.steps .nm{min-width:96px;font-weight:500;flex:none}
.steps .dt{color:var(--text-3);font-size:12px;word-break:break-word}
.steps li.pending,.steps li.skipped{color:var(--text-3)}
.steps li.start .ic{color:var(--warn);animation:pulse 1.4s ease-in-out infinite}
.steps li.done .ic{color:var(--success)}
.steps li.failed .ic,.steps li.failed .dt{color:var(--danger)}
</style></head><body>
<header class="tabbar" id="tabbar"></header>
<main>
  <section id="view"><div id="frames"></div><div id="panel" class="center" hidden></div></section>
  <div id="resizer" hidden></div>
  <aside id="side" hidden>
    <div class="side-head"><span class="t" id="side-title"></span><span class="s">session</span><button class="side-close" id="side-close" title="Close">&#10005;</button></div>
    <div id="log"></div>
    <div class="composer"><div class="composer-box">
      <textarea id="chat-in" rows="1" placeholder="Ask for a change, a task, a report&hellip;"></textarea>
      <button class="send" id="chat-send" title="Send" disabled><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg></button>
    </div></div>
  </aside>
</main>
<div id="menu" hidden></div>
<script type="application/json" id="cfg">${cfgJson}</script>
<script>
"use strict";
const CFG = JSON.parse(document.getElementById("cfg").textContent);
if (CFG.dark) document.documentElement.setAttribute("data-dark", "");
const S = {
  rows: [], active: null, side: false, log: [], sending: false, busy: new Set(), confirmDelete: null,
  // The New + tab: which panel, the marketplace, the import, and an install in progress.
  newMode: "build",
  market: { q: "", tag: null, tags: [], data: null, error: null, loading: false, seq: 0, open: null },
  imp: { kind: "zip", from: "", file: null, origin: null, label: "", uploaded: false, report: null, error: null, busy: false },
  job: null,
};

function api(path, body) {
  const opts = { method: body ? "POST" : "GET", headers: { "x-a2app-token": CFG.token } };
  if (body) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
  return fetch(CFG.apiBase + path, opts).then((r) => r.json());
}
/** Send a zip as it is (no JSON, no encoding); the server keeps it for --from. */
function upload(file) {
  const opts = { method: "POST", headers: { "x-a2app-token": CFG.token, "content-type": "application/zip" }, body: file };
  return fetch(CFG.apiBase + "/upload", opts).then((r) => r.json());
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

async function refresh() {
  const data = await api("/apps");
  S.rows = data.rows;
  if (S.active === null) S.active = S.rows.length ? S.rows[0].path : "new";
  if (S.active !== "new" && !S.rows.some((r) => r.path === S.active)) S.active = S.rows.length ? S.rows[0].path : "new";
  render();
}
function activeRow() { return S.rows.find((r) => r.path === S.active) ?? null; }

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

function openMenu(r, anchor) {
  const m = document.getElementById("menu");
  m.replaceChildren();
  const item = (label, cls, fn) => { const b = el("button", cls, label); b.onclick = fn; m.appendChild(b); };
  if (r.status === "running") item("Pause", "", () => { closeMenu(); act(r, "stop"); });
  else if (!r.building) item("Launch", "", () => { closeMenu(); act(r, "serve"); });
  item(S.side ? "Hide session" : "Show session", "", () => { closeMenu(); toggleSide(); });
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

async function act(r, verb) {
  S.busy.add(r.path); render();
  try { await api("/app/" + verb, { path: r.path }); } finally { S.busy.delete(r.path); }
  await refresh();
}
async function removeApp(r) {
  S.busy.add(r.path); render();
  try { await api("/app/remove", { path: r.path }); } finally { S.busy.delete(r.path); }
  S.active = null;
  await refresh();
}

const frames = new Map();
let viewKey = "";
function renderView() {
  const panel = document.getElementById("panel");
  const framesBox = document.getElementById("frames");
  const r = activeRow();
  const showFrame = r && r.status === "running";
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
  const isNew = S.active === "new" || !r;
  const key = showFrame
    ? "frame:" + r.path
    : isNew
      ? "new:" + S.newMode + (S.job ? ":job" : "")
      : ["app", r.path, r.status, r.building, r.buildEnded, S.busy.has(r.path), S.side].join("|");
  if (key === viewKey) return;
  viewKey = key;
  if (showFrame) return;
  panel.replaceChildren();
  panel.classList.toggle("top", isNew);
  if (isNew) { panel.appendChild(newPanel()); return; }
  panel.appendChild(appPanel(r));
}
function appPanel(r) {
  const c = el("div", "card");
  const busy = S.busy.has(r.path);
  if (r.building) {
    c.appendChild(el("div", "spinner"));
    c.appendChild(el("h2", null, "The agent is building \\u201C" + r.name + "\\u201D"));
    c.appendChild(el("p", "sub", "It scaffolds, builds feature by feature, validates, walk-verifies, and serves the app. Watch it work in the session panel \\u2014 the tab goes live the moment the app is up."));
    if (!S.side) {
      const b = el("button", "btn", "Show session");
      b.onclick = () => toggleSide(true);
      c.appendChild(b);
    }
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
  sess.onclick = () => toggleSide(true);
  row.appendChild(sess);
  c.appendChild(row);
  return c;
}

function buildForm() {
  const f = el("div", "form");
  f.appendChild(el("h1", null, "Build an app"));
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
  f.appendChild(el("p", "buildstamp", "plugin build " + CFG.build));
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
  toggleSide(true);
}

/* ── New tab: build · marketplace · import ── */
const MODES = [["build", "Build"], ["market", "Marketplace"], ["import", "Import"]];
const KINDS = { "agent-app": "Agent App package", "living-ui": "CraftBot Living UI app", foreign: "Not an Agent App" };
const ROUTES = {
  convert: "Convert: the agent rebuilds it as a new Agent App, with the original source kept read-only in reference/source/. Nothing of the original code runs afterward.",
  adopt: "Adopt: the app runs unchanged behind the framework\\u2019s sidecar adapter. Agents operate it through the operations the agent maps; its own UI stays at its own address.",
};
const STEP_ICONS = { pending: "\\u25CB", start: "\\u25CF", done: "\\u2713", skipped: "\\u2013", failed: "\\u2717" };

function newPanel() {
  const wide = S.job || S.newMode !== "build";
  const wrap = el("div", "newpane" + (wide ? " wide" : ""));
  if (S.job) { wrap.appendChild(jobView()); return wrap; }
  const modes = el("div", "modes");
  for (const [mode, label] of MODES) {
    const b = el("button", S.newMode === mode ? "on" : "", label);
    b.onclick = () => { S.newMode = mode; render(); };
    modes.appendChild(b);
  }
  wrap.appendChild(modes);
  wrap.appendChild(S.newMode === "market" ? marketView() : S.newMode === "import" ? importView() : buildForm());
  return wrap;
}
function errorBox(message, retry) {
  const box = el("div", "errbox");
  box.appendChild(el("pre", "code", message));
  if (retry) { const b = el("button", "btn small", "Retry"); b.onclick = retry; box.appendChild(b); }
  return box;
}
function section(parent, title, body) {
  const s = el("div", "section");
  s.appendChild(el("h3", null, title));
  s.appendChild(body);
  parent.appendChild(s);
}
function list(items, cls) {
  const ul = el("ul", cls);
  for (const item of items) ul.appendChild(el("li", null, item));
  return ul;
}

/* Marketplace: the catalogue (searched by the CLI), filtered by tag, one card per app. */
let marketEls = null;
const tagsOf = (apps) => [...new Set(apps.flatMap((a) => (Array.isArray(a.tags) ? a.tags : [])))].sort();
function marketView() {
  const v = el("div", "pane");
  v.appendChild(el("h1", null, "Marketplace"));
  v.appendChild(el("p", "lead", "Apps ready to install. A marketplace app is catalogued: once it runs there is nothing more to verify."));
  const row = el("div", "searchrow");
  const q = el("input", "input");
  q.type = "search"; q.placeholder = "Search apps"; q.value = S.market.q; q.autocomplete = "off";
  let timer = 0;
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(() => loadCatalogue(q.value.trim()), 300); };
  row.appendChild(q);
  v.appendChild(row);
  marketEls = { chips: el("div", "chips"), status: el("div"), grid: el("div", "grid") };
  v.append(marketEls.chips, marketEls.status, marketEls.grid);
  if (S.market.data === null && !S.market.loading && S.market.error === null) loadCatalogue(S.market.q);
  else renderMarket();
  return v;
}
function loadCatalogue(q) {
  const m = S.market;
  const seq = ++m.seq;
  m.q = q; m.loading = true; m.error = null;
  renderMarket();
  const done = (out) => {
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
  };
  return api("/catalogue?search=" + encodeURIComponent(q)).then(done, (e) => done({ ok: false, message: String((e && e.message) || e) }));
}
function renderMarket() {
  if (!marketEls) return;
  const m = S.market;
  const { chips, status, grid } = marketEls;
  chips.replaceChildren();
  for (const t of m.tags.length ? m.tags : m.data ? tagsOf(m.data.apps) : []) {
    const c = el("button", "chip" + (m.tag === t ? " on" : ""), t);
    c.onclick = () => { m.tag = m.tag === t ? null : t; renderMarket(); };
    chips.appendChild(c);
  }
  status.replaceChildren();
  grid.replaceChildren();
  if (m.error) { status.appendChild(errorBox(m.error, () => loadCatalogue(m.q))); return; }
  if (!m.data) { status.appendChild(el("div", "empty", "Reading the marketplace\\u2026")); return; }
  const src = m.data.source || {};
  const from = "From " + (src.repository || src.location || "the marketplace") + (src.fallbackFrom ? " (" + src.fallbackFrom.location + " is unavailable)" : "");
  status.appendChild(el("p", "note", m.loading ? "Searching\\u2026" : from));
  const apps = m.data.apps.filter((a) => !m.tag || (Array.isArray(a.tags) && a.tags.includes(m.tag)));
  if (!apps.length) { grid.appendChild(el("div", "empty", m.q || m.tag ? "No app matches." : "The marketplace lists no apps.")); return; }
  for (const a of apps) grid.appendChild(appCard(a, src.location));
}
function thumb(a) {
  const t = el("div", "thumb");
  const initial = () => t.replaceChildren(document.createTextNode((a.name || a.id || "?").slice(0, 1).toUpperCase()));
  // A local marketplace's preview is a file: URL, which a page cannot load.
  if (typeof a.preview === "string" && /^https?:/i.test(a.preview)) {
    const img = document.createElement("img");
    img.alt = ""; img.loading = "lazy"; img.onerror = initial; img.src = a.preview;
    t.appendChild(img);
  } else initial();
  return t;
}
function appCard(a, source) {
  const card = el("div", "app");
  card.appendChild(thumb(a));
  const body = el("div", "body");
  const h = el("h3", null, a.name || a.id);
  if (a.version) h.appendChild(el("span", "ver", "v" + a.version));
  body.appendChild(h);
  if (Array.isArray(a.tags) && a.tags.length) {
    const tags = el("div", "tags");
    for (const t of a.tags) tags.appendChild(el("span", "tag", t));
    body.appendChild(tags);
  }
  if (a.description) body.appendChild(el("p", "desc", a.description));
  body.appendChild(a.compatible === true ? el("div", "compat yes", "\\u2713 Runs here")
    : a.compatible === false ? el("div", "compat no", "Not installable here: " + (a.reason || "no reason given"))
      : el("div", "compat", "Its requirements are not listed"));
  const fields = Array.isArray(a.customizable) ? a.customizable : [];
  const label = a.name || a.id;
  const actions = el("div", "actions");
  if (a.compatible === false) {
    const b = el("button", "btn small", "What can be done?");
    b.onclick = () => inspectSource({ id: a.id, source }, label);
    actions.appendChild(b);
  } else if (S.market.open === a.id) {
    const form = el("div", "fields");
    const inputs = {};
    for (const f of fields) {
      form.appendChild(el("label", null, f.label || f.key));
      const i = el("input", "input");
      i.value = f.default || ""; i.placeholder = f.placeholder || ""; i.autocomplete = "off";
      inputs[f.key] = i;
      form.appendChild(i);
    }
    body.appendChild(form);
    const go = el("button", "btn primary small", "Install");
    go.onclick = () => {
      const set = {};
      for (const key in inputs) set[key] = inputs[key].value;
      startInstall({ id: a.id, source, set }, label);
    };
    const cancel = el("button", "btn small", "Cancel");
    cancel.onclick = () => { S.market.open = null; renderMarket(); };
    actions.append(go, cancel);
  } else {
    const b = el("button", "btn primary small", "Install");
    b.onclick = () => {
      if (fields.length) { S.market.open = a.id; renderMarket(); }
      else startInstall({ id: a.id, source }, label);
    };
    actions.appendChild(b);
  }
  body.appendChild(actions);
  card.appendChild(body);
  return card;
}

/* Import: a zip, a folder or a git URL; inspect first, then install or hand it to the agent. */
let importEls = null;
const SOURCES = [
  ["zip", "Zip file", ""],
  ["folder", "Folder", "A folder on the machine running dsh, e.g. /home/me/apps/board"],
  ["git", "Git or GitHub", "https://github.com/owner/repo, github:owner/repo@main/path, or git+https://host/repo.git#ref"],
];
function importView() {
  const v = el("div", "pane");
  v.appendChild(el("h1", null, "Import"));
  v.appendChild(el("p", "lead", "Bring in an app from a zip, a folder or a git repository. Inspect it first: nothing from it runs until you install it."));
  const kinds = el("div", "modes");
  const input = el("div");
  const go = el("button", "btn primary", "Inspect");
  const drawInput = () => {
    kinds.replaceChildren();
    for (const [kind, label] of SOURCES) {
      const b = el("button", S.imp.kind === kind ? "on" : "", label);
      b.onclick = () => { S.imp.kind = kind; drawInput(); };
      kinds.appendChild(b);
    }
    input.replaceChildren();
    if (S.imp.kind === "zip") {
      const f = el("input", "input");
      f.type = "file"; f.accept = ".zip,application/zip";
      f.onchange = () => { S.imp.file = f.files && f.files[0] ? f.files[0] : null; };
      input.appendChild(f);
      if (S.imp.file) input.appendChild(el("p", "note", "Chosen: " + S.imp.file.name));
    } else {
      const t = el("input", "input");
      const spec = SOURCES.find((s) => s[0] === S.imp.kind);
      t.placeholder = spec[2]; t.value = S.imp.from; t.autocomplete = "off";
      t.oninput = () => { S.imp.from = t.value; };
      t.onkeydown = (e) => { if (e.key === "Enter") go.click(); };
      input.appendChild(t);
    }
  };
  go.onclick = () => {
    S.imp.error = null;
    if (S.imp.kind === "zip") {
      if (!S.imp.file) { S.imp.error = "Choose a .zip file."; renderReport(); return; }
      inspectZip(S.imp.file);
    } else {
      const from = S.imp.from.trim();
      if (!from) { S.imp.error = S.imp.kind === "git" ? "Give a git or GitHub URL." : "Give a folder path."; renderReport(); return; }
      runInspect({ from }, from);
    }
  };
  drawInput();
  const row = el("div", "row");
  row.style.marginTop = "12px";
  row.appendChild(go);
  importEls = { go, report: el("div") };
  v.append(kinds, input, row, importEls.report);
  renderReport();
  return v;
}
function runInspect(origin, label, uploaded) {
  const m = S.imp;
  m.busy = true; m.error = null; m.report = null; m.origin = origin; m.label = label; m.uploaded = !!uploaded;
  renderReport();
  return api("/inspect", origin).then((out) => {
    if (m.origin !== origin) return;
    m.busy = false;
    if (out.ok) m.report = out.report;
    else m.error = out.message || "The source could not be inspected.";
    renderReport();
  }, (e) => { m.busy = false; m.error = String((e && e.message) || e); renderReport(); });
}
function inspectZip(file) {
  S.imp.busy = true; S.imp.report = null; S.imp.error = null;
  renderReport();
  return upload(file).then((out) => {
    if (!out.ok) throw new Error(out.message || "The upload was refused.");
    return runInspect({ from: out.file }, file.name, true);
  }).catch((e) => { S.imp.busy = false; S.imp.error = String((e && e.message) || e); renderReport(); });
}
/** From a marketplace card: show what an app is, and what can be done with it, in the Import panel. */
function inspectSource(origin, label) {
  S.newMode = "import";
  render();
  runInspect(origin, label);
}
function renderReport() {
  if (!importEls) return;
  const m = S.imp;
  const box = importEls.report;
  importEls.go.disabled = m.busy;
  box.replaceChildren();
  if (m.busy) { box.appendChild(el("div", "empty", "Inspecting\\u2026 it is staged and read; nothing from it runs.")); return; }
  if (m.error) { box.appendChild(errorBox(m.error)); return; }
  const r = m.report;
  if (!r) return;
  const card = el("div", "report");
  const badges = el("div", "badges");
  badges.appendChild(el("span", "badge", KINDS[r.kind] || r.kind));
  badges.appendChild(el("span", "badge " + (r.installable ? "ok" : "no"), r.installable ? "Installable" : "Not installable"));
  card.appendChild(badges);
  const name = (r.app && r.app.name) || (r.source && r.source.name) || "";
  card.appendChild(el("h2", null, name || m.label));
  if (!r.installable && r.reason) card.appendChild(el("p", "sub", r.reason));
  const kv = el("dl", "kv");
  const row = (k, v) => { if (v) { kv.appendChild(el("dt", null, k)); kv.appendChild(el("dd", null, v)); } };
  const src = r.source || {};
  // An upload's location is the manager's private copy: name the file that was chosen.
  row("Source", m.uploaded ? m.label + " (uploaded)"
    : (src.catalogueId ? "marketplace app " + src.catalogueId + " in " : "") + (src.location || m.label) + (src.ref ? " @ " + src.ref : ""));
  row("Commit", src.commit);
  row("SHA-256", src.sha256);
  if (r.app) { row("Sign-in", r.app.authMode); row("Modules", (r.app.modules || []).join(", ")); }
  if (r.toolkit) {
    const av = r.toolkit.adapterVersion || {};
    row("Toolkit", (r.toolkit.id || "none named") + (r.toolkit.installed ? " (installed here)" : " (not installed here)") +
      (av.package && av.current && av.package !== av.current ? "; adapter " + av.package + " \\u2192 " + av.current : ""));
  }
  if (r.integrity && r.kind === "agent-app") {
    row("System files", r.integrity.canon === "drifted" ? "changed: " + (r.integrity.changed || []).join(", ") + " (install replaces them)"
      : r.integrity.canon === "intact" ? "as its own record says" : "no record (install makes one)");
  }
  card.appendChild(kv);
  if (r.pipeline) {
    const lines = Object.keys(r.pipeline).map((k) => k + ": " + (typeof r.pipeline[k] === "string" ? r.pipeline[k] : JSON.stringify(r.pipeline[k])));
    section(card, "What it will run (from the toolkit installed here, not from the package)", el("pre", "code", lines.join("\\n")));
  }
  if (r.capabilities && Object.keys(r.capabilities).length) section(card, "What it declares", el("pre", "code", JSON.stringify(r.capabilities, null, 2)));
  if (r.strips && r.strips.length) section(card, "What install removes", list(r.strips));
  if (r.placeholders && r.placeholders.length) section(card, "Placeholders filled at install", list(r.placeholders));
  if (r.warnings && r.warnings.length) section(card, "Warnings", list(r.warnings, "warn"));
  if (r.installable) card.appendChild(installForm(m.origin, name || m.label));
  else if (r.routes && r.routes.length) card.appendChild(handoff(m.origin, r.routes, name));
  box.appendChild(card);
}
function installForm(origin, name) {
  const v = el("div", "section");
  v.appendChild(el("label", null, "Name"));
  const n = el("input", "input");
  n.value = name; n.autocomplete = "off";
  v.appendChild(n);
  const go = el("button", "btn primary", "Install");
  go.style.marginTop = "12px";
  go.onclick = () => startInstall(Object.assign({}, origin, n.value.trim() ? { name: n.value.trim() } : {}), n.value.trim() || name);
  v.appendChild(go);
  v.appendChild(el("p", "note", origin.id
    ? "A marketplace app: once it runs there is nothing more to verify."
    : "Not from the marketplace: once it runs, have a separate agent walk-verify it before it is used for real work."));
  return v;
}
/** A source that is not a package: say what can be done, and start the agent on it in a new app's session. */
function handoff(origin, routes, name) {
  const v = el("div", "section");
  v.appendChild(el("h3", null, "What can be done instead"));
  for (const route of routes) v.appendChild(el("div", "route", ROUTES[route] || route));
  v.appendChild(el("label", null, "Name for the new app"));
  const n = el("input", "input");
  n.value = name || ""; n.autocomplete = "off";
  v.appendChild(n);
  const row = el("div", "row");
  row.style.marginTop = "12px";
  const err = el("div", "err");
  routes.forEach((route, i) => {
    const b = el("button", "btn" + (i === 0 ? " primary" : ""), route === "adopt" ? "Adopt it with the agent" : "Convert it with the agent");
    b.onclick = () => {
      err.textContent = "";
      const appName = n.value.trim();
      if (!appName) { err.textContent = "Give the new app a name."; return; }
      b.disabled = true;
      api("/import/agent", Object.assign({ action: route === "adopt" ? "adopt" : "import", name: appName }, origin)).then(async (out) => {
        b.disabled = false;
        if (!out.ok) { err.textContent = out.message; return; }
        S.job = null;
        S.active = out.path;
        await refresh();
        toggleSide(true);
      }, (e) => { b.disabled = false; err.textContent = String((e && e.message) || e); });
    };
    row.appendChild(b);
  });
  v.append(row, err);
  v.appendChild(el("p", "note", "The agent works in the new app\\u2019s session, in the side panel, and settles the details with you there through the importer skill."));
  return v;
}

/* An install: a job on the server, polled until it ends, then the app opens in its tab. */
let jobEls = null;
let jobTimer = 0;
function startInstall(request, label) {
  S.market.open = null;
  S.job = { label, request, data: null, error: null };
  render();
  const job = S.job;
  return api("/install", request).then((out) => {
    if (S.job !== job) return;
    if (out.ok) job.data = out.job;
    else job.error = out.message || "The install did not start.";
    renderJob();
    pollJob();
  }, (e) => { if (S.job === job) { job.error = String((e && e.message) || e); renderJob(); } });
}
function pollJob() {
  clearTimeout(jobTimer);
  const job = S.job;
  if (!job || !job.data || job.data.done) return;
  jobTimer = setTimeout(() => {
    api("/install?job=" + encodeURIComponent(job.data.id)).then((out) => {
      if (S.job !== job) return;
      if (!out.ok) { job.error = out.message || "The install is no longer known here."; renderJob(); return; }
      job.data = out.job;
      renderJob();
      if (job.data.done) finished(job);
      else pollJob();
    }, () => { if (S.job === job) pollJob(); }); // a dropped poll is retried; the install goes on regardless
  }, 1000);
}
function finished(job) {
  const r = job.data.result;
  if (!job.data.ok || !r || S.active !== "new") return;
  // Installed and serving: show it in its own tab.
  refresh().then(() => {
    if (S.job !== job || S.active !== "new") return;
    S.job = null;
    S.active = r.dir;
    render();
  });
}
function jobView() {
  const v = el("div", "pane");
  jobEls = { box: v };
  renderJob();
  return v;
}
function renderJob() {
  if (!jobEls || !S.job) return;
  const job = S.job;
  const d = job.data;
  const r = d && d.result;
  const box = jobEls.box;
  box.replaceChildren();
  const ended = !!(d && d.done) || !!job.error;
  const installed = !!(r && r.dir);
  box.appendChild(el("h1", null, !ended ? "Installing \\u201C" + job.label + "\\u201D"
    : d && d.ok ? "Installed \\u201C" + job.label + "\\u201D"
      : installed ? "\\u201C" + job.label + "\\u201D needs fixing" : "The install of \\u201C" + job.label + "\\u201D stopped"));
  const steps = new Map(((d && d.steps) || []).map((s) => [s.step, s]));
  const ol = el("ol", "steps");
  for (const name of CFG.steps) {
    const s = steps.get(name);
    const state = s ? s.status : "pending";
    const li = el("li", state);
    li.appendChild(el("span", "ic", STEP_ICONS[state] || ""));
    li.appendChild(el("span", "nm", name));
    const detail = s ? s.error || s.reason || "" : "";
    if (detail) li.appendChild(el("span", "dt", detail));
    ol.appendChild(li);
  }
  box.appendChild(ol);
  if (!ended) {
    box.appendChild(el("p", "note", "A download and the app\\u2019s dependencies can take several minutes. This page follows the install until it ends; leaving it does not stop it."));
    return;
  }
  const row = el("div", "row");
  const back = el("button", "btn", "Back");
  back.onclick = () => { S.job = null; render(); };
  const open = el("button", "btn primary", "Open it");
  open.onclick = () => { S.job = null; S.active = r.dir; render(); };
  if (d && d.ok) {
    box.appendChild(el("p", "sub", r.url ? "It is serving at " + r.url + "." : "It is installed."));
    if (r.next && r.next.length) section(box, "Still to do", list(r.next));
    row.append(open, back);
  } else if (installed) {
    box.appendChild(el("p", "sub", "It is installed but does not pass its gate, so it stays registered to be fixed."));
    const failures = (r.gate && r.gate.failures) || [];
    if (failures.length) section(box, "What the gate found", list(failures.map((f) => (f.step ? f.step + ": " : "") + (f.message || ""))));
    row.append(open, back);
  } else {
    box.appendChild(errorBox(job.error || (d && d.error) || "The install failed."));
    if (r && r.routes && r.routes.length) {
      const origin = {};
      for (const k of ["id", "from", "source"]) if (job.request[k]) origin[k] = job.request[k];
      box.appendChild(handoff(origin, r.routes, job.request.name || ""));
    }
    const retry = el("button", "btn primary", "Retry");
    retry.onclick = () => startInstall(job.request, job.label);
    row.append(retry, back);
  }
  box.appendChild(row);
}

function toggleSide(force) {
  S.side = force === true ? true : !S.side;
  render();
}
document.getElementById("side-close").onclick = () => { S.side = false; render(); };
async function pollLog() {
  const row = S.side ? activeRow() : null;
  if (!row) return;
  const r = await fetch(CFG.homeBase + "/session?app=" + encodeURIComponent(row.path));
  const out = await r.json();
  if (out.ok && S.side && activeRow()?.path === row.path) { S.log = out.messages; renderLog(); }
}
function prettify(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
function nodesFor(m, i) {
  const tools = m.tools ?? [];
  const out = [];
  if (m.role === "user") {
    out.push(el("div", "msg user", m.text));
  } else if (m.role === "assistant") {
    if (tools.length) out.push(el("div", "toolsline", "Used " + tools.join(", ")));
    if (m.text) out.push(el("div", "msg assistant", m.text));
  } else {
    const d = document.createElement("details");
    d.className = "toolrow";
    d.dataset.i = String(i);
    d.appendChild(el("summary", null, tools[0] ?? (m.role === "system" ? "System" : "Tool result")));
    d.appendChild(el("pre", null, prettify(m.text)));
    out.push(d);
  }
  return out;
}
// The transcript is append-only: unchanged renders touch nothing, growth appends
// only (so expanded tool rows and text selection survive), and a rare rewrite
// rebuilds while restoring expanded rows by position.
let logKeys = [];
const itemKey = (m) => m.role + "\\u001f" + m.text + "\\u001f" + (m.tools ?? []).join(",");
function resetLogView() {
  logKeys = [];
  document.getElementById("log").replaceChildren();
}
function renderLog() {
  const log = document.getElementById("log");
  const items = S.log.slice(-200);
  if (!items.length) {
    if (logKeys.length || !log.childElementCount) { logKeys = []; log.replaceChildren(el("div", "log-empty", "No session activity yet.")); }
    return;
  }
  const keys = items.map(itemKey);
  const grown = keys.length >= logKeys.length && logKeys.every((k, i) => k === keys[i]);
  if (grown && keys.length === logKeys.length) return;
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
  if (grown) {
    if (!logKeys.length) log.replaceChildren();
    for (let i = logKeys.length; i < items.length; i++) for (const n of nodesFor(items[i], i)) log.appendChild(n);
  } else {
    const open = new Set([...log.querySelectorAll("details[open]")].map((d) => d.dataset.i));
    log.replaceChildren();
    items.forEach((m, i) => {
      for (const n of nodesFor(m, i)) { if (n.tagName === "DETAILS" && open.has(n.dataset.i)) n.open = true; log.appendChild(n); }
    });
  }
  logKeys = keys;
  if (stick) log.scrollTop = log.scrollHeight;
}
const chatIn = document.getElementById("chat-in");
const chatSend = document.getElementById("chat-send");
async function sendChat() {
  const text = chatIn.value.trim();
  const row = activeRow();
  if (!text || !row || S.sending) return;
  S.sending = true;
  chatIn.value = ""; chatIn.style.height = "auto"; chatSend.disabled = true;
  S.log.push({ role: "user", text, tools: [] }); renderLog();
  try { await api("/session/send", { path: row.path, name: row.name, text }); }
  finally { S.sending = false; }
}
chatSend.onclick = sendChat;
chatIn.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
chatIn.addEventListener("input", () => {
  chatSend.disabled = !chatIn.value.trim();
  chatIn.style.height = "auto";
  chatIn.style.height = Math.min(chatIn.scrollHeight, 122) + "px";
});

const resizer = document.getElementById("resizer");
const sideEl = document.getElementById("side");
resizer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add("dragging");
  const startX = e.clientX;
  const startW = sideEl.getBoundingClientRect().width;
  const move = (ev) => {
    const w = Math.min(innerWidth * 0.7, Math.max(280, startW + (startX - ev.clientX)));
    sideEl.style.width = w + "px";
  };
  const up = () => {
    resizer.classList.remove("dragging");
    resizer.removeEventListener("pointermove", move);
    resizer.removeEventListener("pointerup", up);
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("pointerup", up);
});

// The session panel is bound to the active tab, so switching tabs switches the
// session and the New + tab shows none.
let sidePath = null;
function render() {
  renderTabs();
  renderView();
  const row = activeRow();
  const showSide = S.side && row != null;
  document.getElementById("side").hidden = !showSide;
  document.getElementById("resizer").hidden = !showSide;
  if (showSide) {
    document.getElementById("side-title").textContent = row.name;
    if (sidePath !== row.path) {
      sidePath = row.path;
      S.log = [];
      resetLogView();
      pollLog().catch(() => {});
    }
  } else {
    sidePath = null;
  }
}

const quiet = (fn) => () => fn().catch(() => {});
quiet(refresh)();
setInterval(quiet(refresh), 4000);
setInterval(quiet(pollLog), 2500);
</script></body></html>`;
}
