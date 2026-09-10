/**
 * The Agent App server (SYSTEM-OWNED — hash-locked in the ownership canon).
 *
 * A single Node process on the built-in `http` module. It mounts the A2App
 * adapter (`@a2app/adapter-core`) as embedded middleware and serves the static
 * View from `public/`; records live in a JSON file (`a2app.data.json`). The
 * agent evolves the app by editing `a2app.schema.mjs` (Model + operations) and
 * `public/` (View) — never this file. Because describe and `schemaVersion` are
 * derived from the live schema, an agent always sees the true model.
 */
import { createA2App, createA2AppServer, createStaticView, UnsupportedFilterError } from "@a2app/adapter-core";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { schema } from "./a2app.schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Records live inside the toolkit's declared `lifecycle.dataDir` ("data"), so
// `agent-app backup` / `restore` / `promote` capture the live database, and the
// template .gitignore keeps it out of the repo.
const DATA_DIR = join(HERE, "data");
const DATA_FILE = join(DATA_DIR, "db.json");
const TOKEN_FILE = join(HERE, ".agent-token");
const PUBLIC_DIR = join(HERE, "public");

const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
// The CLI reaches a running app at manifest.port; bind the same port so the two
// always agree. PORT env overrides (a host may assign one), then manifest.port.
const PORT = Number(process.env.PORT ?? manifest.port ?? 8091);

/* ----------------------------------------------------------- persistence */

/** Coerce a validated raw value into its stored form. The guard already
 *  accepted it; this only normalizes string→number/boolean. */
function coerce(field, value) {
  if (value === null || value === "") return value;
  if (field.type === "number" && typeof value === "string") return Number(value);
  if (field.type === "boolean" && typeof value === "string") return value === "true";
  return value;
}

/** Build a stored record from a raw body: assign an id, fill server-managed
 *  read-only `created`, drop blanks. */
function materialize(fields, body) {
  const id = typeof body.id === "string" && body.id ? body.id : "rec_" + randomBytes(8).toString("hex");
  const rec = { id };
  for (const f of fields) {
    if (f.name in body && body[f.name] !== undefined && body[f.name] !== null && body[f.name] !== "") {
      rec[f.name] = coerce(f, body[f.name]);
    } else if (f.readOnly && f.name === "created") {
      rec[f.name] = new Date().toISOString();
    }
  }
  return rec;
}

function seedDb() {
  const db = {};
  for (const [entity, def] of Object.entries(schema.entities)) {
    db[entity] = {};
    for (const seed of def.seed ?? []) {
      const rec = materialize(def.fields, seed);
      db[entity][rec.id] = rec;
    }
  }
  return db;
}

const db = existsSync(DATA_FILE) ? JSON.parse(readFileSync(DATA_FILE, "utf8")) : seedDb();

/** Persist the whole store atomically (temp file + rename). Operation runners
 *  call this synchronously, so it must complete before they return. */
function persist() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(db, null, 2) + "\n");
  renameSync(tmp, DATA_FILE);
}
if (!existsSync(DATA_FILE)) persist();

/* --------------------------------------------------------------- binding */

function cmp(a, b) {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return String(a) < String(b) ? -1 : 1;
}

/** The single-clause grammar this backend implements — `field = "value"`,
 *  `field != "value"`, or `field ~ "value"` (contains), optionally wrapped in one
 *  pair of parentheses. Enough for label→id resolution; a richer backend exposes
 *  its own query language.
 *
 *  Anything outside it is REFUSED, never ignored: an adapter that accepts
 *  `filter` and returns unfiltered rows answers 200 with the wrong records, which
 *  turns every label lookup into a false multi-match. */
const FILTER_CLAUSE =
  /^\s*\(?\s*([A-Za-z_]\w*)\s*(=|!=|~)\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"'()]+))\s*\)?\s*$/;

function matchFilter(expr) {
  const m = FILTER_CLAUSE.exec(expr);
  if (!m) throw new UnsupportedFilterError(expr);
  const [, field, op, quoted, singleQuoted, bare] = m;
  // Only the double-quoted form carries escapes; unescape exactly what the
  // escaping side wrote (`\x` -> `x`).
  const val = quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : (singleQuoted ?? bare ?? "");
  return (r) => {
    const cur = r[field];
    const s = cur === undefined || cur === null ? "" : String(cur);
    if (op === "=") return s === val;
    if (op === "!=") return s !== val;
    return s.includes(val);
  };
}

/** The back face: maps the JSON store onto protocol types. The served surface
 *  and the pure rules are shared verbatim from `@a2app/adapter-core`. */
const binding = {
  appId: manifest.id,
  appName: manifest.name ?? null,
  adapterVersion: manifest.adapterVersion ?? "0.1.0",
  authMode: manifest.authMode === "multi-user" ? "multi-user" : "none",

  entities() {
    const out = {};
    for (const [name, def] of Object.entries(schema.entities)) {
      // module + summary travel with the entity: describe groups by module, so
      // an entity that dropped them here would have no screen to appear on.
      out[name] = { fields: def.fields, module: def.module, ...(def.summary ? { summary: def.summary } : {}) };
    }
    return out;
  },

  listRecords(entity, query) {
    let items = Object.values(db[entity] ?? {});
    if (query.filter) items = items.filter(matchFilter(query.filter));
    if (query.sort) {
      const desc = query.sort.startsWith("-");
      const key = desc ? query.sort.slice(1) : query.sort;
      items = [...items].sort((a, b) => cmp(a[key], b[key]) * (desc ? -1 : 1));
    }
    const totalItems = items.length;
    const perPage = query.perPage ?? totalItems;
    const page = query.page ?? 1;
    const start = (page - 1) * perPage;
    return { items: items.slice(start, start + perPage), page, perPage, totalItems };
  },

  getRecord(entity, id) {
    return db[entity]?.[id] ?? null;
  },

  createRecord(entity, body) {
    const def = schema.entities[entity];
    const rec = materialize(def.fields, body);
    (db[entity] ??= {})[rec.id] = rec;
    persist();
    return rec;
  },

  updateRecord(entity, id, body) {
    const rec = db[entity]?.[id];
    if (!rec) return null;
    for (const f of schema.entities[entity].fields) {
      if (f.readOnly || !(f.name in body)) continue;
      const v = body[f.name];
      if (v === null || v === "") delete rec[f.name];
      else rec[f.name] = coerce(f, v);
    }
    persist();
    return rec;
  },

  deleteRecord(entity, id) {
    if (!db[entity]?.[id]) return false;
    delete db[entity][id];
    persist();
    return true;
  },

  runOperation(name, args, ctx) {
    const runner = schema.operationRunners?.[name];
    if (!runner) throw new Error(`no runner for operation "${name}"`);
    return runner(args, ctx, { db, persist });
  },
};

/* ------------------------------------------------------------ credential */

let token;
if (existsSync(TOKEN_FILE)) {
  token = readFileSync(TOKEN_FILE, "utf8").trim();
} else {
  token = "a2app_" + randomBytes(24).toString("hex");
  writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
}

/* ------------------------------------------------------------ static View */

/**
 * The View, served from disk with real cache validators.
 *
 * `createStaticView` is the framework's static handler, not a per-app one: it
 * answers every asset with `ETag`, `Last-Modified` and `Cache-Control: no-cache`
 * and honours conditional requests, so a plain reload always re-checks and an
 * unchanged file costs a bodyless 304. This file is system-owned and hash-locked
 * precisely so an app author never has to fix cache correctness themselves.
 *
 * `view.version()` fingerprints the bytes it serves. That is published below as
 * identity's `appVersion`, and it is the ONLY signal that moves for a View-only
 * change — `schemaVersion` covers entities and operations, so a new control, a
 * CSS tweak or reworded copy leaves it byte-identical. `a2app.schema.mjs` is
 * folded in as well: an operation's description is not in `schemaVersion` either,
 * yet it changes what the app tells an agent.
 */
const view = createStaticView(PUBLIC_DIR, {
  // The update watcher lives at the project root, not inside `public/`: it is
  // system-owned, and `public/` is the agent's to rewrite entirely.
  aliases: { "/_a2app/update.js": join(HERE, "a2app-update.js") },
  fingerprintPaths: [join(HERE, "a2app.schema.mjs")],
  // An author who wants to move the marker by hand can bump manifest.appVersion.
  versionSalt: manifest.appVersion ?? "",
});

const app = createA2App(binding, {
  credentials: [{ token, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"] }],
  // Re-derived per request, so it stays true for a server whose files changed
  // under it — the same "derive, do not declare" rule schemaVersion follows.
  appVersion: () => view.version(),
  operations: schema.operations ?? [],
  // Modules are declared in the manifest and are what describe's root level
  // lists; every entity and operation names one.
  modules: manifest.modules,
  allowedOrigins: [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`],
  credentialHint: "Read the app's .agent-token file (mode 0600) in the project directory.",
  // Adapter-owned state (idempotency keys, tasks, events, grants, audit) lives
  // beside the records, inside the toolkit's declared lifecycle dataDir. The
  // idempotency table MUST survive a restart: a restart is exactly when a
  // retried write arrives, so an in-memory table would return a duplicate
  // record instead of the 409 the protocol promises.
  storePath: join(DATA_DIR, "a2app-state.json"),
});

/* ---------------------------------------------------------------- listen */

// Any path the adapter does not own falls through to the View.
const server = createA2AppServer(app, view.handler);
// Bind loopback explicitly. `listen(PORT)` alone binds every interface, so the
// app was reachable from the network while its own log line said localhost --
// and a same-origin request is trusted as the owner without a credential, which
// made a scaffolded Agent App remotely writable by anyone who could reach the
// port. Exposing it must be a deliberate act, hence the env var.
const HOST = process.env.A2APP_HOST ?? "127.0.0.1";
server.listen(PORT, HOST, () => {
  process.stdout.write(`Agent App "${manifest.name ?? manifest.id}" on http://${HOST}:${PORT}  (A2App id ${manifest.id})\n`);
});
