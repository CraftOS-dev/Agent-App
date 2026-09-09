/**
 * The update watcher (SYSTEM-OWNED — hash-locked in the ownership canon).
 *
 * Served by `server.mjs` at `/_a2app/update.js`. A View loads it with one line
 * and an already-open tab stops being a lie:
 *
 *     <script type="module" src="/_a2app/update.js"></script>
 *
 * The problem it closes: the server serves `public/` from disk, so a promote is
 * live server-side at once — but a tab opened beforehand keeps running the
 * JavaScript it already has. Nothing tells the person in front of it, and
 * `schemaVersion` cannot: it fingerprints the model, so a View-only change leaves
 * it identical. This polls identity's `appVersion` (the fingerprint of the bytes
 * actually served) and, when it moves, offers a reload.
 *
 * IT NEVER RELOADS THE PAGE ITSELF, and there is no option that makes it. These
 * are data-entry apps: reloading someone who is halfway through typing an invoice
 * destroys work that cannot be recovered, which is strictly worse than the stale
 * tab it would be fixing. The only code path to `location.reload()` in this file
 * sits inside a click handler on a button the person pressed. A caller who wants
 * different UI passes `onUpdate` and gets the same guarantee — being told is the
 * capability on offer; acting on it stays the person's.
 *
 * Loading the module starts the watch. `watchForUpdates` is exported for a View
 * that wants its own affordance instead.
 */

/** Poll interval while the tab is visible. Long enough to be invisible in a
 *  server log, short enough that someone who tabs back after a promote is told
 *  before they type into a form the new version has changed. */
const POLL_MS = 20_000;
/** After a failed probe — a restart is exactly when probes fail, and a tight
 *  retry loop against a booting server helps nobody. */
const RETRY_MS = 5_000;
const BANNER_ID = "a2app-update-banner";

/** The identity fields that together mean "this app is not the one you loaded".
 *  `appVersion` is the marker that moves for a View change; `schemaVersion` is
 *  included because a model change also invalidates what a loaded page believes,
 *  and an adapter that publishes no `appVersion` still gets that much. */
function versionOf(identity) {
  if (identity === null || typeof identity !== "object") return null;
  const app = identity.appVersion ?? "";
  const schema = identity.schemaVersion ?? "";
  const both = `${app}|${schema}`;
  return both === "|" ? null : both;
}

async function probe(base) {
  const res = await fetch(`${base}/api/_a2app`, { cache: "no-store", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`identity responded ${res.status}`);
  return versionOf(await res.json());
}

/**
 * The default affordance: one dismissible bar, bottom-left, out of the way of
 * the primary action most Views put bottom-right.
 *
 * Styles are inline and namespaced rather than injected as a stylesheet, so this
 * cannot collide with — or be restyled out of existence by — the app's own CSS.
 * `role="status"` with `aria-live="polite"` announces it to a screen reader
 * without interrupting whatever the person is doing, which is the same rule the
 * no-auto-reload constraint states visually.
 */
function showBanner(onReload) {
  if (document.getElementById(BANNER_ID) !== null) return;

  const bar = document.createElement("div");
  bar.id = BANNER_ID;
  bar.setAttribute("role", "status");
  bar.setAttribute("aria-live", "polite");
  bar.style.cssText = [
    "position:fixed",
    "left:1rem",
    "bottom:1rem",
    "z-index:2147483000",
    "display:flex",
    "gap:.75rem",
    "align-items:center",
    "max-width:min(30rem,calc(100vw - 2rem))",
    "padding:.6rem .75rem",
    "border-radius:10px",
    "border:1px solid rgba(128,128,128,.4)",
    "background:Canvas",
    "color:CanvasText",
    "color-scheme:light dark",
    "box-shadow:0 6px 24px rgba(0,0,0,.18)",
    "font:14px/1.4 system-ui,sans-serif",
  ].join(";");

  const text = document.createElement("span");
  text.style.cssText = "flex:1";
  text.textContent = "A new version of this app is available.";

  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.style.cssText =
    "font:inherit;cursor:pointer;padding:.3rem .7rem;border-radius:8px;border:1px solid currentColor;background:transparent;color:inherit";
  // The ONLY reload in this file, and it is a click handler. Whatever is typed
  // into the page is lost by reloading, so the person holding that context is
  // the one who decides — never a timer.
  reload.addEventListener("click", onReload);

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "×";
  dismiss.title = "Dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.style.cssText =
    "font:inherit;cursor:pointer;padding:.1rem .4rem;border:none;background:none;color:inherit;opacity:.7";
  // Dismiss silences THIS version only: the watcher reports each version once,
  // so a later promote raises a fresh notice. Someone who said "not now" has not
  // said "never tell me".
  dismiss.addEventListener("click", () => bar.remove());

  bar.append(text, reload, dismiss);
  document.body.appendChild(bar);
}

/**
 * Watch for a newer version of the app and surface it. Returns a `stop()`.
 *
 * `onUpdate(version)` replaces the default banner. It is told; it is never
 * reloaded for — a custom handler that chooses to call `location.reload()` is
 * writing that line itself, in app-owned code, with the consequence in view.
 */
export function watchForUpdates(options = {}) {
  const base = options.base ?? "";
  const pollMs = options.pollMs ?? POLL_MS;
  const onUpdate = options.onUpdate ?? (() => showBanner(() => location.reload()));

  let loaded = null; // the version this page is running
  let notified = null; // the newest version already reported
  let timer = null;
  let stopped = false;

  const schedule = (ms) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
  };

  async function tick() {
    if (stopped) return;
    // A hidden tab is nobody's open tab: skip the request and re-check when it
    // comes back, so a browser full of parked apps is not a poll storm.
    if (document.visibilityState === "hidden") {
      schedule(pollMs);
      return;
    }
    let version;
    try {
      version = await probe(base);
    } catch {
      // A restart — which is exactly when the version is about to change — looks
      // like this. Keep the baseline and try again; never report an unreachable
      // app as an update.
      schedule(RETRY_MS);
      return;
    }
    // A probe issued before stop() resolves after it. Without this, stopping the
    // watch would still let one last banner appear over a page that asked to be
    // left alone.
    if (stopped) return;
    if (version !== null) {
      if (loaded === null) loaded = version;
      // Each version is reported ONCE. Polling is how we find out; it must not
      // be how often the app nags. Without this a handler that draws its own UI
      // (or logs, or posts) would fire on every tick for as long as the tab
      // stayed open on a superseded build.
      if (version !== loaded && version !== notified) {
        notified = version;
        try {
          onUpdate(version);
        } catch (err) {
          // A broken handler must not kill the watch, and must not be silent.
          console.error("[a2app] update handler failed", err);
        }
      }
    }
    schedule(pollMs);
  }

  // Re-check the moment the tab is looked at again, rather than up to a poll
  // interval later — returning to a tab is when staleness is noticed.
  const onVisible = () => {
    if (document.visibilityState === "visible") schedule(0);
  };
  document.addEventListener("visibilitychange", onVisible);

  void tick();

  return function stop() {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/* Loading the module starts the watch — `<script type="module"
   src="/_a2app/update.js">` is the whole integration. Guarded so that a View
   which also calls `watchForUpdates()` explicitly ends up with one watcher, not
   two racing to draw the same banner. */
if (!globalThis.__a2appUpdateWatch) {
  globalThis.__a2appUpdateWatch = watchForUpdates();
}
