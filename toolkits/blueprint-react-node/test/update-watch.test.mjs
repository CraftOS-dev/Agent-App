/**
 * The update watcher's contract, against a fake DOM and a stub identity server.
 *
 * The load-bearing assertion is still about not destroying work, but it has
 * moved: the watcher used to promise it would NEVER reload, and now promises it
 * will never reload a page that holds unsaved input. That is a stronger claim to
 * test, not a weaker one — "never" needed no evidence, whereas "only when it is
 * safe" is only true if `hasUnsavedInput` is right. So the reload branch and the
 * banner branch are both exercised here, and `hasUnsavedInput` is tested
 * directly on top of that.
 *
 * The other half is the data path: a record write moves `dataVersion` and must
 * be announced WITHOUT a reload, because the code the page is running is still
 * current and reloading would cost the person their half-typed form to fix a
 * change that was never about their page.
 *
 * Run: node test/update-watch.test.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WATCHER = join(HERE, "..", "template", "a2app-update.js");

/* An identity endpoint whose versions we move by hand. */
let appVersion = "av_first";
let schemaVersion = "sv_stable";
let dataVersion = "dv_first";
let failNext = 0;
const server = createServer((req, res) => {
  if (failNext > 0) {
    failNext -= 1;
    res.writeHead(503).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ a2app: true, app: { id: "x" }, schemaVersion, appVersion, dataVersion }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------------------------------------- fake DOM */

let reloads = 0;
function makeEl(tag) {
  const el = {
    tagName: tag,
    id: "",
    type: "",
    title: "",
    textContent: "",
    children: [],
    attrs: {},
    style: { cssText: "" },
    listeners: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    addEventListener(k, fn) {
      (this.listeners[k] ??= []).push(fn);
    },
    append(...kids) {
      this.children.push(...kids);
    },
    appendChild(kid) {
      this.children.push(kid);
      return kid;
    },
    remove() {
      document.body.children = document.body.children.filter((c) => c !== el);
    },
    click() {
      for (const fn of this.listeners.click ?? []) fn();
    },
  };
  return el;
}

/**
 * What `hasUnsavedInput` sees. Empty by default, so the page reads as clean and
 * the auto-reload branch is the one under test; a check that wants the banner
 * sets `page.inputs` and gets the other branch through the real code path
 * rather than by stubbing the decision.
 *
 * The selector strings are matched literally, so this stub is coupled to the
 * ones in the watcher — a deliberate trade: the alternative is a full DOM, and
 * the coupling fails loudly (every reload check flips) rather than silently.
 */
const page = { dialogOpen: false, inputs: [], selects: [], editables: [] };
const resetPage = () => {
  page.dialogOpen = false;
  page.inputs = [];
  page.selects = [];
  page.editables = [];
};

const document = {
  visibilityState: "visible",
  body: makeEl("body"),
  createElement: makeEl,
  addEventListener() {},
  removeEventListener() {},
  getElementById(id) {
    return document.body.children.find((c) => c.id === id) ?? null;
  },
  querySelector(sel) {
    if (sel === "dialog[open]") return page.dialogOpen ? makeEl("dialog") : null;
    return null;
  },
  querySelectorAll(sel) {
    if (sel === "input, textarea") return page.inputs;
    if (sel === "select") return page.selects;
    if (sel.startsWith("[contenteditable")) return page.editables;
    return [];
  },
};
globalThis.document = document;
globalThis.location = {
  reload() {
    reloads += 1;
  },
};

// `window` is where the watcher publishes a data change and hooks its goodbye.
const windowListeners = {};
const events = [];
globalThis.window = {
  addEventListener(k, fn) {
    (windowListeners[k] ??= []).push(fn);
  },
  removeEventListener(k, fn) {
    windowListeners[k] = (windowListeners[k] ?? []).filter((f) => f !== fn);
  },
  dispatchEvent(ev) {
    events.push(ev);
    for (const fn of windowListeners[ev.type] ?? []) fn(ev);
    return true;
  },
};

// The goodbye is best-effort inside a try/catch, so without a `navigator` the
// beacon would "pass" by being swallowed. Record it instead.
//
// `defineProperty`, not assignment: Node 20 has no `navigator` at all while
// Node 22 has a getter-only one, and plain assignment throws on the latter.
const beacons = [];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  writable: true,
  value: {
    sendBeacon(url) {
      beacons.push(url);
      return true;
    },
  },
});

// Claim the auto-start slot before importing: loading the module in a browser
// starts a watch against a relative URL, which is right there and meaningless
// here. That the guard honours a slot already taken is part of the contract —
// a View that also calls watchForUpdates() gets one watcher, not two.
globalThis.__a2appUpdateWatch = "test-harness";
const { watchForUpdates, hasUnsavedInput } = await import(pathToFileURL(WATCHER).href);
assert.equal(globalThis.__a2appUpdateWatch, "test-harness", "auto-start must not clobber an existing watcher");

const banner = () => document.getElementById("a2app-update-banner");
const settle = () => new Promise((r) => setTimeout(r, 250));

/** A text input the person has typed into, as `hasUnsavedInput` reads one. */
const typedInto = (value) => ({ type: "text", disabled: false, readOnly: false, value, defaultValue: "" });

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  } finally {
    resetPage();
    document.body.children = [];
  }
}

/* --------------------------------------------------------- code changes */

await check("an unchanged app raises nothing", async () => {
  const seen = [];
  const stop = watchForUpdates({ base, pollMs: 30, onUpdate: (v) => seen.push(v) });
  await settle();
  assert.equal(seen.length, 0);
  assert.equal(banner(), null);
  stop();
});

await check("a moved appVersion is reported exactly once, however long the tab stays open", async () => {
  const seen = [];
  appVersion = "av_first";
  const stop = watchForUpdates({ base, pollMs: 30, onUpdate: (v) => seen.push(v) });
  await settle();
  appVersion = "av_second";
  await settle();
  await settle();
  assert.equal(seen.length, 1, `polling is how we find out, not how often we nag (got ${seen.length})`);
  stop();
});

await check("a moved schemaVersion is reported too", async () => {
  const seen = [];
  const stop = watchForUpdates({ base, pollMs: 30, onUpdate: (v) => seen.push(v) });
  await settle();
  schemaVersion = "sv_changed";
  await settle();
  assert.equal(seen.length, 1);
  schemaVersion = "sv_stable";
  stop();
});

await check("an unreachable app is never mistaken for an update", async () => {
  const seen = [];
  const stop = watchForUpdates({ base, pollMs: 30, onUpdate: (v) => seen.push(v) });
  await settle();
  failNext = 3; // a restart looks exactly like this
  await settle();
  assert.equal(seen.length, 0, "a failed probe must not fire the handler");
  stop();
  // A failed probe backs off for seconds, so an unconsumed failure would still
  // be waiting for the next check's first probe and starve its baseline.
  failNext = 0;
});

/* ------------------------------------------------- the reload decision */

await check("a page with nothing to lose reloads itself", async () => {
  reloads = 0;
  appVersion = "av_third";
  const stop = watchForUpdates({ base, pollMs: 30 });
  await settle();
  appVersion = "av_fourth";
  await settle();
  await settle();
  assert.equal(reloads, 1, "a clean page takes the new code without asking");
  assert.equal(banner(), null, "and is not also nagged about it");
  stop();
});

await check("a page holding unsaved input is NEVER reloaded — it is asked", async () => {
  reloads = 0;
  page.inputs = [typedInto("half-typed invoice")];
  appVersion = "av_fifth";
  const stop = watchForUpdates({ base, pollMs: 30 });
  await settle();
  appVersion = "av_sixth";
  await settle();
  await settle();
  await settle();
  assert.equal(reloads, 0, "the watcher reloaded over unsaved input — this destroys work no backup covers");
  assert.ok(banner(), "the person is offered the reload instead");
  stop();
});

await check("the offer is one dismissible banner with a Reload the user presses", async () => {
  reloads = 0;
  page.inputs = [typedInto("in progress")];
  appVersion = "av_seventh";
  const stop = watchForUpdates({ base, pollMs: 30 });
  await settle();
  appVersion = "av_eighth";
  await settle();
  await settle();

  const bar = banner();
  assert.ok(bar);
  assert.equal(bar.attrs.role, "status");
  assert.equal(bar.attrs["aria-live"], "polite", "announced politely — it must not interrupt");
  assert.equal(document.body.children.filter((c) => c.id === "a2app-update-banner").length, 1, "exactly one banner");

  const reload = bar.children.find((c) => c.textContent === "Reload");
  const dismiss = bar.children.find((c) => c.attrs["aria-label"] === "Dismiss");
  assert.ok(reload && dismiss, "a Reload and a Dismiss are both offered");

  dismiss.click();
  assert.equal(banner(), null, "dismiss removes the banner");
  await settle();
  assert.equal(banner(), null, "and the same version does not raise it again");
  assert.equal(reloads, 0);

  reload.click();
  assert.equal(reloads, 1, "the button — and only the button — reloads");
  stop();
});

await check("a later version raises a fresh notice — 'not now' is not 'never'", async () => {
  page.inputs = [typedInto("still typing")];
  appVersion = "av_ninth";
  const stop = watchForUpdates({ base, pollMs: 30 });
  await settle();
  appVersion = "av_tenth";
  await settle();
  await settle();
  banner().children.find((c) => c.attrs["aria-label"] === "Dismiss").click();
  assert.equal(banner(), null);
  appVersion = "av_eleventh";
  await settle();
  await settle();
  assert.ok(banner(), "a promote after a dismiss must be surfaced");
  stop();
});

await check("hasUnsavedInput is conservative in every direction", () => {
  const doc = (fixture) => ({
    querySelector: (sel) => (sel === "dialog[open]" && fixture.dialogOpen ? {} : null),
    querySelectorAll: (sel) => {
      if (sel === "input, textarea") return fixture.inputs ?? [];
      if (sel === "select") return fixture.selects ?? [];
      if (sel.startsWith("[contenteditable")) return fixture.editables ?? [];
      return [];
    },
  });

  assert.equal(hasUnsavedInput(doc({})), false, "an empty page is clean");
  assert.equal(
    hasUnsavedInput(doc({ inputs: [{ type: "text", value: "x", defaultValue: "x" }] })),
    false,
    "a field still showing what the markup shipped is not unsaved",
  );
  assert.equal(hasUnsavedInput(doc({ inputs: [typedInto("typed")] })), true);
  assert.equal(
    hasUnsavedInput(doc({ inputs: [{ type: "text", disabled: true, value: "x", defaultValue: "" }] })),
    false,
    "a disabled field holds nothing the person can lose",
  );
  assert.equal(
    hasUnsavedInput(doc({ inputs: [{ type: "checkbox", checked: true, defaultChecked: false }] })),
    true,
    "a toggled checkbox is unsaved state",
  );

  // The trap: a single <select> with no `selected` attribute still has an option
  // selected, because the browser picks the first. Comparing selected against
  // defaultSelected called every such dropdown dirty, which made every page
  // holding one permanently unreloadable.
  const untouched = {
    disabled: false,
    multiple: false,
    value: "a",
    options: [
      { value: "a", selected: true, defaultSelected: false },
      { value: "b", selected: false, defaultSelected: false },
    ],
  };
  assert.equal(hasUnsavedInput(doc({ selects: [untouched] })), false, "an untouched dropdown is not unsaved");
  assert.equal(
    hasUnsavedInput(doc({ selects: [{ ...untouched, value: "b" }] })),
    true,
    "a dropdown moved off its initial option is",
  );

  assert.equal(hasUnsavedInput(doc({ dialogOpen: true })), true, "an open dialog is state someone is looking at");
  assert.equal(hasUnsavedInput(doc({ editables: [{ textContent: "  " }] })), false);
  assert.equal(hasUnsavedInput(doc({ editables: [{ textContent: "written" }] })), true);

  // Anything it cannot classify counts as unsaved: the failure mode must be an
  // unnecessary banner, never a reload over someone's work.
  assert.equal(
    hasUnsavedInput({
      querySelector() {
        throw new Error("detached DOM");
      },
    }),
    true,
    "a DOM it cannot read is not a page it can prove is safe",
  );
});

/* --------------------------------------------------------- data changes */

await check("a moved dataVersion is announced, and never reloads", async () => {
  reloads = 0;
  const seen = [];
  events.length = 0;
  dataVersion = "dv_first";
  const stop = watchForUpdates({ base, pollMs: 30, onDataChange: (v) => seen.push(v) });
  await settle();
  assert.equal(seen.length, 0, "the first probe is the baseline, not a change");

  dataVersion = "dv_second"; // an agent wrote a record
  await settle();
  await settle();
  assert.deepEqual(seen, ["dv_second"], "reported once, on the version that moved");
  assert.equal(reloads, 0, "the code is current — a reload would cost typed work for someone else's write");
  assert.equal(banner(), null, "and there is nothing for the person to act on");

  const ev = events.filter((e) => e.type === "a2app:datachange");
  assert.equal(ev.length, 1, "a View that does not own the watcher can still subscribe");
  assert.equal(ev[0].detail.dataVersion, "dv_second");
  stop();
});

await check("an adapter that publishes no dataVersion simply does not raise one", async () => {
  const seen = [];
  const older = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ appVersion: "av_x" }));
  });
  await new Promise((r) => older.listen(0, "127.0.0.1", r));
  const stop = watchForUpdates({
    base: `http://127.0.0.1:${older.address().port}`,
    pollMs: 30,
    onDataChange: (v) => seen.push(v),
  });
  try {
    await settle();
    assert.equal(seen.length, 0, "absent means data watching is off, not wrongly triggered");
  } finally {
    stop();
    older.close();
  }
});

/* ------------------------------------------------------------- viewers */

await check("every probe carries this tab's viewer id", async () => {
  const seenIds = new Set();
  const counted = createServer((req, res) => {
    seenIds.add(req.headers["x-a2app-viewer"]);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ appVersion: "av_x" }));
  });
  await new Promise((r) => counted.listen(0, "127.0.0.1", r));
  const stop = watchForUpdates({ base: `http://127.0.0.1:${counted.address().port}`, pollMs: 30 });
  try {
    await settle();
    assert.equal(seenIds.size, 1, "one tab is one viewer, however many times it polls");
    const [id] = [...seenIds];
    assert.ok(typeof id === "string" && id.length > 0 && id.length <= 64, `usable viewer id (got ${id})`);
  } finally {
    stop();
    counted.close();
  }
});

await check("a hidden tab heartbeats slowly, and reports nothing", async () => {
  let hits = 0;
  const counted = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ appVersion: "av_x" }));
  });
  await new Promise((r) => counted.listen(0, "127.0.0.1", r));

  // Start it already hidden, so the first tick is unambiguously the hidden path
  // and nothing from a visible poll is in flight to confuse the count.
  document.visibilityState = "hidden";
  const seen = [];
  const stop = watchForUpdates({
    base: `http://127.0.0.1:${counted.address().port}`,
    pollMs: 30,
    onUpdate: (v) => seen.push(v),
  });
  try {
    await settle();
    // Silence would be simpler, but a parked tab that says nothing ages out of
    // the viewer count, and then `open --if-needed` opens a duplicate over a tab
    // the person only switched away from.
    assert.equal(hits, 1, "a hidden tab still tells the app it exists");
    await settle();
    assert.equal(hits, 1, "but on the slow interval, not the visible one");
    assert.equal(seen.length, 0, "there is nobody to report to");
  } finally {
    document.visibilityState = "visible";
    stop();
    counted.close();
  }
});

await check("a closing tab says goodbye so the count drops at once", async () => {
  beacons.length = 0;
  const stop = watchForUpdates({ base, pollMs: 30 });
  await settle();
  for (const fn of windowListeners["pagehide"] ?? []) fn();
  assert.equal(beacons.length, 1, "pagehide — not unload — is what still fires with bfcache");
  const url = new URL(beacons[0]);
  assert.ok(url.searchParams.get("viewer"), "the goodbye names the tab it is for");
  assert.equal(url.searchParams.get("leaving"), "1");
  stop();
  assert.equal(windowListeners["pagehide"].length, 0, "stop() unhooks it");
});

/* ---------------------------------------------------------- robustness */

await check("a throwing handler is reported and does not kill the watch", async () => {
  let calls = 0;
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args[0]);
  appVersion = "av_twelfth";
  const stop = watchForUpdates({
    base,
    pollMs: 30,
    onUpdate: () => {
      calls += 1;
      throw new Error("handler is broken");
    },
  });
  await settle();
  appVersion = "av_thirteenth";
  await settle();
  appVersion = "av_fourteenth";
  await settle();
  await settle();
  stop();
  console.error = realError;
  assert.equal(calls, 2, "the watch survived a handler that threw");
  assert.ok(logged.length >= 1, "a broken handler is loud, not silent");
});

await check("stop() ends the watch", async () => {
  const seen = [];
  appVersion = "av_a";
  const stop = watchForUpdates({ base, pollMs: 30, onUpdate: (v) => seen.push(v) });
  await settle();
  stop();
  appVersion = "av_b";
  await settle();
  await settle();
  assert.equal(seen.length, 0);
});

server.close();

if (failures > 0) {
  console.error(`\nupdate watcher: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nupdate watcher: all checks passed");
