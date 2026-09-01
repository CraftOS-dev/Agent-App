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


def describe_to_schema(describe: Dict[str, Any]) -> Dict[str, Dict[str, str]]:
    """Flatten a describe document into ``{entity: {field: type}}`` for quick
    lookups and 'did you mean' suggestions."""
    out: Dict[str, Dict[str, str]] = {}
    for entity, spec in (describe.get("entities") or {}).items():
        fields = {}
        for name, field in (spec.get("fields") or {}).items():
            fields[name] = field.get("type", "string")
        out[entity] = fields
    return out
