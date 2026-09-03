/**
 * lifecycle.promote — apply a code change to the live database.
 *
 * For a schema-in-code JSON store there is no destructive migration chain:
 * changes are additive (a new field simply defaults to absent, an existing
 * record stays valid). By the time this runs, the framework has ALREADY taken
 * the mandatory pre-promote backup. This step therefore:
 *   1. confirms the app still builds,
 *   2. confirms the current LIVE database is still readable under the new schema,
 *   3. REFUSES the one destructive case — an entity that still holds live data
 *      being removed from the schema — so promote can never silently orphan data.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { schema } from "../a2app.schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const LIVE = join(ROOT, "data", "db.json");

// 1. The app must build.
execFileSync(process.execPath, ["--check", join(ROOT, "server.mjs")], { stdio: "ignore" });

if (!existsSync(LIVE)) {
  process.stdout.write("first install — no live database to migrate\n");
  process.exit(0);
}

// 2. Live must still parse.
let db;
try {
  db = JSON.parse(readFileSync(LIVE, "utf8"));
} catch (err) {
  process.stderr.write(`live database is unreadable (${err.message}) — refusing to promote\n`);
  process.exit(1);
}

// 3. Refuse to orphan data: an entity that holds live records must still exist
//    in the new schema (removing it is a destructive migration).
const entities = new Set(Object.keys(schema.entities));
const orphaned = Object.keys(db).filter((e) => Object.keys(db[e] ?? {}).length > 0 && !entities.has(e));
if (orphaned.length > 0) {
  process.stderr.write(
    `refusing to promote: live data exists for entit${orphaned.length === 1 ? "y" : "ies"} removed ` +
      `from the schema (${orphaned.join(", ")}). Removing an entity that holds data is destructive — ` +
      "migrate or export that data first.\n",
  );
  process.exit(1);
}

const liveEntities = Object.keys(db).filter((e) => Object.keys(db[e] ?? {}).length > 0);
process.stdout.write(
  `live database compatible with the new schema (${entities.size} declared; ` +
    `live data in: ${liveEntities.join(", ") || "none"})\n`,
);
