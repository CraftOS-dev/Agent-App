"""Client-side coercion: resolve relative dates to ISO 8601 with the local clock
before sending, so the app's guard — which rejects relative words — receives a
real date. Kept deliberately small and pure.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any, Dict, Optional

_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?")
_IN_N = re.compile(r"^in\s+(\d+)\s+(day|days|week|weeks)$", re.IGNORECASE)


def parse_date(value: Optional[str], today: Optional[date] = None) -> Optional[str] | str:
    """Resolve a date expression to ``YYYY-MM-DD``.

    - absolute ISO passes through unchanged;
    - today / tomorrow / yesterday and "in N days/weeks" resolve against the
      local clock;
    - empty string stays "" (means "clear this field", spec 5.2);
    - anything unrecognized returns None (the caller should ask, not guess).
    """
    if value is None:
        return None
    text = value.strip()
    if text == "":
        return ""
    if _ISO.match(text):
        return text
    base = today or date.today()
    low = text.lower()
    if low == "today":
        return base.isoformat()
    if low == "tomorrow":
        return (base + timedelta(days=1)).isoformat()
    if low == "yesterday":
        return (base - timedelta(days=1)).isoformat()
    m = _IN_N.match(text)
    if m:
        n = int(m.group(1))
        days = n * (7 if m.group(2).lower().startswith("week") else 1)
        return (base + timedelta(days=days)).isoformat()
    return None


def entity_to_schema(level: Dict[str, Any]) -> Dict[str, str]:
    """Flatten ONE entity level into ``{field: type}`` for quick lookups.

    Takes the entity level of describe (A2APP-SPEC 3.3), not a whole-app
    document — there is no such document. Mirrors ``entityToSchema`` in
    ``@a2app/sdk``.
    """
    return {name: field.get("type", "string") for name, field in (level.get("fields") or {}).items()}


def locate_entity(client: Any, entity: str) -> Optional[str]:
    """Which module an entity lives in, so a caller holding only its name can
    address it. One request, by name search rather than by walking every module.

    An exact name match wins over a substring one: ``find`` matches loosely by
    design, and "cards" must not resolve to "cards-archive" merely because that
    entity sorted first.
    """
    found = client.find(entity)
    if not found:
        return None
    for match in found.get("matches") or []:
        path = match.get("path", "")
        if match.get("level") == "entity" and "operation" not in match and path.split("/", 1)[-1] == entity:
            return path.split("/", 1)[0]
    return None


def fetch_entity_schema(client: Any, entity: str) -> Optional[Dict[str, str]]:
    """Read one entity's model by name: locate it, then describe it.

    Two requests, deliberately not a whole-app fetch — the point of the
    navigational surface is that a task touching two entities pays for two.
    Callers repeating this across a session should cache against the app's
    ``schemaVersion`` (A2APP-SPEC 2).
    """
    module = locate_entity(client, entity)
    if module is None:
        return None
    level = client.describe_entity(module, entity)
    return None if level is None else entity_to_schema(level)


def fetch_entity_index(client: Any) -> Dict[str, str]:
    """Every readable entity name, mapped to the module it lives in."""
    out: Dict[str, str] = {}
    root = client.describe_root()
    if not root:
        return out
    for module in root.get("modules") or []:
        if module.get("access") == "none" or not module.get("entities"):
            continue
        level = client.describe(module["name"], all=True)
        if not level or level.get("level") != "module":
            continue
        for entity in level.get("entities") or []:
            out[entity["name"]] = module["name"]
    return out
