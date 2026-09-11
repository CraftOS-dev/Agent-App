/**
 * @a2app/adapter-starter — a copy-to-create worked example of building an A2App
 * adapter for a NEW backend.
 *
 * Writing an adapter means writing ONE thing: a {@link Binding} (the back face)
 * that maps your stack's schema and record store onto the protocol type
 * vocabulary. The served surface (identity, describe, guard, read-back, IAM,
 * tasks, events) and the validation rules are shared verbatim from
 * `@a2app/adapter-core` and `@a2app/rules` — you never re-implement them.
 *
 * This example backs a tiny "notes" app with an in-object store. To port to a
 * real stack, replace the four record methods and `entities()` with calls into
 * your database; keep everything else.
 */
import { createA2App, createA2AppServer, type Binding, type EntityDef, type Grant, type StoredRecord } from "@a2app/adapter-core";
import type { NormalizedField } from "@a2app/rules";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

export const ADAPTER_VERSION = "0.1.0";

// 1) Describe your model in PROTOCOL types (not your backend's native types).
const NOTE_FIELDS: NormalizedField[] = [
  { name: "title", type: "string", required: true, max: 200 },
  { name: "body", type: "string", max: 10000 },
  { name: "pinned", type: "boolean" },
  { name: "created", type: "datetime", readOnly: true },
];

/** 2) Implement the Binding. Everything here is the ONLY stack-specific code. */
export class NotesBinding implements Binding {
  readonly appId = "notes_starter";
  readonly appName = "Notes (adapter starter)";
  readonly adapterVersion = ADAPTER_VERSION;
  readonly authMode = "none" as const;
  private notes = new Map<string, StoredRecord>();

  entities(): Record<string, EntityDef> {
    // Every entity names the module it lives in: describe groups by module,
    // and an entity outside every module has no screen to appear on.
    return { notes: { fields: NOTE_FIELDS, module: "notes", summary: "what you wrote down" } };
  }
  listRecords(): { items: StoredRecord[] } {
    return { items: [...this.notes.values()] };
  }
  getRecord(_entity: string, id: string): StoredRecord | null {
    return this.notes.get(id) ?? null;
  }
  createRecord(_entity: string, body: Record<string, unknown>): StoredRecord {
    const id = "note_" + randomBytes(6).toString("hex");
    const rec: StoredRecord = { id, created: new Date().toISOString() };
    for (const f of NOTE_FIELDS) if (!f.readOnly && f.name in body) rec[f.name] = body[f.name];
    this.notes.set(id, rec);
    return rec;
  }
  updateRecord(_entity: string, id: string, body: Record<string, unknown>): StoredRecord | null {
    const rec = this.notes.get(id);
    if (!rec) return null;
    for (const f of NOTE_FIELDS) {
      if (f.readOnly || !(f.name in body)) continue;
      const v = body[f.name];
      if (v === null || v === "") delete rec[f.name];
      else rec[f.name] = v;
    }
    return rec;
  }
  deleteRecord(_entity: string, id: string): boolean {
    return this.notes.delete(id);
  }
}

/** 3) Mount and run. In production the credential comes from your launch flow. */
export function startNotesApp(port = 8091, token = "a2app_starter_token"): ReturnType<typeof createA2AppServer> {
  const grant: Grant = { token, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"] };
  const app = createA2App(new NotesBinding(), {
    credentials: [grant],
    modules: [{ name: "notes", summary: "what you wrote down" }],
    allowedOrigins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
  });
  const server = createA2AppServer(app);
  // Loopback explicitly: `listen(port)` alone binds every interface, which this
  // line already claimed it did not.
  server.listen(port, "127.0.0.1", () => process.stdout.write(`notes adapter on http://127.0.0.1:${port}\n`));
  return server;
}

// Run directly: `node dist/index.js`
//
// pathToFileURL, not "file://" + argv[1]: on Windows the latter never matches
// (argv[1] is a backslash path, import.meta.url is `file:///C:/...`), so the
// starter would exit 0 without starting anything.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) startNotesApp();
