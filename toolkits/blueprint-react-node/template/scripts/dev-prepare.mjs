/**
 * lifecycle.dev — build a FRESH dev database by replaying the schema seed into an
 * isolated dev data directory (`.a2app/dev/data`), and prove the current
 * (possibly just-edited) `server.mjs` + `a2app.schema.mjs` load cleanly.
 *
 * This is the JSON-store analogue of "replay the full migration chain on a fresh
 * database": the schema IS the migration (schema-in-code), so a clean re-seed
 * from empty is exactly what proves an evolve is safe to promote. It NEVER reads
 * or writes the live `data/` directory — the framework `agent-app dev` command
 * fingerprints live before and after and aborts if this script touches it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { schema } from "../a2app.schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // scripts/
const ROOT = join(HERE, "..");
const DEV_DATA = join(ROOT, ".a2app", "dev", "data");

/** Mirror of server.mjs materialize(): assign id, fill server-managed `created`,
 *  drop blanks. Kept self-contained so this script has no runtime dependency. */
function materialize(fields, body) {
  const id = typeof body.id === "string" && body.id ? body.id : "rec_" + randomBytes(8).toString("hex");
  const rec = { id };
  for (const f of fields) {
    if (f.name in body && body[f.name] !== undefined && body[f.name] !== null && body[f.name] !== "") {
      rec[f.name] = body[f.name];
    } else if (f.readOnly && f.name === "created") {
      rec[f.name] = new Date().toISOString();
    }
  }
  return rec;
}

const db = {};
for (const [entity, def] of Object.entries(schema.entities)) {
  db[entity] = {};
  for (const seed of def.seed ?? []) {
    const rec = materialize(def.fields, seed);
    db[entity][rec.id] = rec;
  }
}

// Fresh, isolated dev DB — replaced every run.
rmSync(DEV_DATA, { recursive: true, force: true });
mkdirSync(DEV_DATA, { recursive: true });
writeFileSync(join(DEV_DATA, "db.json"), JSON.stringify(db, null, 2) + "\n");

// Prove the (possibly edited) server still parses.
execFileSync(process.execPath, ["--check", join(ROOT, "server.mjs")], { stdio: "ignore" });

process.stdout.write(
  `dev database prepared at .a2app/dev/data — ${Object.keys(schema.entities).length} entit${
    Object.keys(schema.entities).length === 1 ? "y" : "ies"
  } re-seeded from a fresh, empty store\n`,
);
