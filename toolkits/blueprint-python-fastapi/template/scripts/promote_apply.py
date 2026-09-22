"""lifecycle.promote — apply a code change to the live database.

For a schema-in-code SQLite store there is no destructive migration chain:
changes are additive (a new field simply defaults to absent, an existing
record stays valid). By the time this runs, the framework has ALREADY taken
the mandatory pre-promote backup. This step therefore:
  1. confirms the app still compiles,
  2. confirms the current LIVE database is still readable under the new schema,
  3. REFUSES the one destructive case — an entity that still holds live data
     being removed from the schema — so promote can never silently orphan data.
"""
import py_compile
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import schema  # noqa: E402  (path set up above)

LIVE = ROOT / "data" / "db.sqlite"

# 1. The app must compile.
for source in ("main.py", "a2app_adapter.py", "schema.py"):
    py_compile.compile(str(ROOT / source), doraise=True)

if not LIVE.exists():
    print("first install — no live database to migrate")
    sys.exit(0)

# 2. Live must still open and read.
try:
    db = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True)
    held = db.execute("SELECT entity, COUNT(*) FROM records GROUP BY entity").fetchall()
    db.close()
except sqlite3.Error as err:
    print(f"live database is unreadable ({err}) — refusing to promote", file=sys.stderr)
    sys.exit(1)

# 3. Refuse to orphan data: an entity that holds live records must still exist
#    in the new schema (removing it is a destructive migration).
declared = set(schema.ENTITIES)
orphaned = [entity for entity, count in held if count > 0 and entity not in declared]
if orphaned:
    plural = "y" if len(orphaned) == 1 else "ies"
    print(
        f"refusing to promote: live data exists for entit{plural} removed "
        f"from the schema ({', '.join(orphaned)}). Removing an entity that holds data is destructive — "
        "migrate or export that data first.",
        file=sys.stderr,
    )
    sys.exit(1)

live_entities = [entity for entity, count in held if count > 0]
print(
    f"live database compatible with the new schema ({len(declared)} declared; "
    f"live data in: {', '.join(live_entities) or 'none'})"
)
