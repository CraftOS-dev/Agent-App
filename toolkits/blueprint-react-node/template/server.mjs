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
import { createA2App, createA2AppServer } from "@a2app/adapter-core";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize } from "node:path";
import { schema } from "./a2app.schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(HERE, "a2app.data.json");
const TOKEN_FILE = join(HERE, ".agent-token");
const PUBLIC_DIR = join(HERE, "public");

const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
const PORT = Number(process.env.PORT ?? 8091);

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

/** The back face: maps the JSON store onto protocol types. The served surface
 *  and the pure rules are shared verbatim from `@a2app/adapter-core`. */
const binding = {
  appId: manifest.id,
  appName: manifest.name ?? null,
  adapterVersion: manifest.adapterVersion ?? "0.1.0",
  authMode: manifest.authMode === "multi-user" ? "multi-user" : "none",

  entities() {
    const out = {};
    for (const [name, def] of Object.entries(schema.entities)) out[name] = { fields: def.fields };
    return out;
  },

  listRecords(entity, query) {
    let items = Object.values(db[entity] ?? {});
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

const app = createA2App(binding, {
  credentials: [{ token, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"] }],
  operations: schema.operations ?? [],
  allowedOrigins: [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`],
  credentialHint: "Read the app's .agent-token file (mode 0600) in the project directory.",
});

/* ------------------------------------------------------------ static View */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

/** Fallthrough for any path the adapter does not own: serve `public/`. */
function serveStatic(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ a2app: true, ok: false, code: "not_found", message: "No such route." }));
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
  res.end(readFileSync(filePath));
}

const server = createA2AppServer(app, serveStatic);
server.listen(PORT, () => {
  process.stdout.write(`Agent App "${manifest.name ?? manifest.id}" on http://localhost:${PORT}  (A2App id ${manifest.id})\n`);
});
