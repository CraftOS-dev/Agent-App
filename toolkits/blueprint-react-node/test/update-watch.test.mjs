/**
 * The update watcher's contract, against a fake DOM and a stub identity server.
 *
 * The load-bearing assertion is the boring one: NOTHING reloads without a click.
 * These are data-entry apps, and a page that reloads itself while someone is
 * halfway through an invoice destroys work that no backup covers — strictly
 * worse than the stale tab it would be curing. Everything else here is comfort;
 * that one is the reason the file exists.
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

/* An identity endpoint whose version we move by hand. */
let appVersion = "av_first";
let schemaVersion = "sv_stable";
let failNext = 0;
const server = createServer((req, res) => {
  if (failNext > 0) {
    failNext -= 1;
    res.writeHead(503).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ a2app: true, app: { id: "x" }, schemaVersion, appVersion }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

/* The smallest DOM the watcher actually uses. */
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
const document = {
  visibilityState: "visible",
  body: makeEl("body"),
  createElement: makeEl,
  addEventListener() {},
  removeEventListener() {},
  getElementById(id) {
    return document.body.children.find((c) => c.id === id) ?? null;
  },
};
globalThis.document = document;
globalThis.location = {
  reload() {
    reloads += 1;
  },
};

// Claim the auto-start slot before importing: loading the module in a browser
// starts a watch against a relative URL, which is right there and meaningless
// here. That the guard honours a slot already taken is part of the contract —
// a View that also calls watchForUpdates() gets one watcher, not two.
globalThis.__a2appUpdateWatch = "test-harness";
const { watchForUpdates } = await import(pathToFileURL(WATCHER).href);
assert.equal(globalThis.__a2appUpdateWatch, "test-harness", "auto-start must not clobber an existing watcher");

const banner = () => document.getElementById("a2app-update-banner");
const settle = () => new Promise((r) => setTimeout(r, 250));

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

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

await check("NOTHING reloads without a click", async () => {
  reloads = 0;
  appVersion = "av_third";
  const stop = watchForUpdates({ base, pollMs: 30 });
  await settle();
  appVersion = "av_fourth";
  await settle();
  await settle();
  await settle();
  assert.ok(banner(), "the default affordance is shown");
  assert.equal(reloads, 0, "the watcher reloaded the page on its own — this destroys unsaved input");
  stop();
  document.body.children = [];
});

await check("the default affordance is one dismissible banner with a Reload the user presses", async () => {
  reloads = 0;
  appVersion = "av_fifth";
  const stop = watchForUpdates({ base, pollMs: 30 });
  await settle();
  appVersion = "av_sixth";
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
  document.body.children = [];
});

await check("a later version raises a fresh notice — 'not now' is not 'never'", async () => {
  appVersion = "av_seventh";
  const stop = watchForUpdates({ base, pollMs: 30 });
  await settle();
  appVersion = "av_eighth";
  await settle();
  await settle();
  banner().children.find((c) => c.attrs["aria-label"] === "Dismiss").click();
  assert.equal(banner(), null);
  appVersion = "av_ninth";
  await settle();
  await settle();
  assert.ok(banner(), "a promote after a dismiss must be surfaced");
  stop();
  document.body.children = [];
});

await check("a hidden tab does not poll", async () => {
  let hits = 0;
  const counted = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ appVersion: "av_x" }));
  });
  await new Promise((r) => counted.listen(0, "127.0.0.1", r));
  const stop = watchForUpdates({ base: `http://127.0.0.1:${counted.address().port}`, pollMs: 30 });
  try {
    await settle();
    assert.ok(hits > 1, "a visible tab does poll");
    document.visibilityState = "hidden";
    await settle(); // drain a probe already in flight when the tab was hidden
    const parked = hits;
    await settle();
    assert.equal(hits, parked, "a parked tab must not keep polling");
  } finally {
    // Restore the shared fake DOM even when an assertion throws: leaving it
    // "hidden" would silently starve every later check of its baseline.
    document.visibilityState = "visible";
    stop();
    counted.close();
  }
});

await check("a throwing handler is reported and does not kill the watch", async () => {
  let calls = 0;
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args[0]);
  appVersion = "av_tenth";
  const stop = watchForUpdates({
    base,
    pollMs: 30,
    onUpdate: () => {
      calls += 1;
      throw new Error("handler is broken");
    },
  });
  await settle();
  appVersion = "av_eleventh";
  await settle();
  appVersion = "av_twelfth";
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
