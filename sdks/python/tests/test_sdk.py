"""Tests for the a2app Python SDK.

Standard library only, run directly (``python tests/test_sdk.py``) so CI needs
no test runner and no install step — the SDK itself is dependency-free and must
stay that way.

Everything here is offline: the coercion helpers are pure, and the describe
helpers take a client object, so a stub records the calls instead of reaching a
real app. What is asserted is the contract the helpers promise, not their
internals.
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import a2app
from a2app import (
    ACCEPTED_PROTOCOLS,
    PROTOCOL_VERSION,
    entity_to_schema,
    fetch_entity_index,
    fetch_entity_schema,
    locate_entity,
    parse_date,
)

FAILURES = []


def check(label, got, want):
    if got != want:
        FAILURES.append("%s\n    expected: %r\n    actual:   %r" % (label, want, got))


class StubClient:
    """Minimal stand-in for A2AppClient: serves canned describe levels and
    records every path asked for, so a helper that over-fetches is caught."""

    def __init__(self, matches=None, root=None, modules=None, entities=None):
        self.matches = matches or []
        self.root = root
        self.modules = modules or {}
        self.entities = entities or {}
        self.calls = []

    def find(self, term):
        self.calls.append("find:" + term)
        return {"matches": self.matches}

    def describe_root(self):
        self.calls.append("describe:")
        return self.root

    def describe(self, path="", all=False):
        self.calls.append("describe:" + path)
        return self.modules.get(path)

    def describe_entity(self, module, entity):
        self.calls.append("describe:%s/%s" % (module, entity))
        return self.entities.get("%s/%s" % (module, entity))


# --- the package surface ----------------------------------------------------

check("PROTOCOL_VERSION is an accepted protocol",
      PROTOCOL_VERSION in ACCEPTED_PROTOCOLS, True)
check("every __all__ name is importable",
      sorted(n for n in a2app.__all__ if not hasattr(a2app, n)), [])

# --- parse_date -------------------------------------------------------------

BASE = date(2026, 3, 10)

check("None passes through", parse_date(None), None)
check("empty string means clear-the-field", parse_date(""), "")
check("whitespace-only means clear-the-field", parse_date("   "), "")
check("absolute ISO date is unchanged", parse_date("2026-01-31"), "2026-01-31")
check("ISO datetime is unchanged", parse_date("2026-01-31T09:30"), "2026-01-31T09:30")
check("today resolves", parse_date("today", BASE), "2026-03-10")
check("tomorrow resolves", parse_date("tomorrow", BASE), "2026-03-11")
check("yesterday resolves", parse_date("yesterday", BASE), "2026-03-09")
check("case is ignored", parse_date("ToMoRrOw", BASE), "2026-03-11")
check("surrounding space is ignored", parse_date("  today  ", BASE), "2026-03-10")
check("in N days resolves", parse_date("in 3 days", BASE), "2026-03-13")
check("in 1 day resolves", parse_date("in 1 day", BASE), "2026-03-11")
check("in N weeks resolves", parse_date("in 2 weeks", BASE), "2026-03-24")
check("month rollover is real arithmetic", parse_date("in 30 days", BASE), "2026-04-09")
check("unrecognized wording returns None, never a guess",
      parse_date("next tuesday", BASE), None)
check("a bare word is not a date", parse_date("soon", BASE), None)

# --- entity_to_schema -------------------------------------------------------

check("fields flatten to {name: type}",
      entity_to_schema({"fields": {"title": {"type": "string"},
                                   "due": {"type": "date"}}}),
      {"title": "string", "due": "date"})
check("a field with no declared type defaults to string",
      entity_to_schema({"fields": {"note": {}}}), {"note": "string"})
check("no fields key yields an empty schema", entity_to_schema({}), {})
check("null fields yields an empty schema", entity_to_schema({"fields": None}), {})

# --- locate_entity ----------------------------------------------------------

exact_last = StubClient(matches=[
    {"level": "entity", "path": "board/cards-archive"},
    {"level": "entity", "path": "board/cards"},
])
check("an exact name beats a substring match, whatever the order",
      locate_entity(exact_last, "cards"), "board")

check("an operation match is not an entity",
      locate_entity(StubClient(matches=[
          {"level": "entity", "path": "board/cards", "operation": "archive-card"},
      ]), "cards"), None)

check("a non-entity level is ignored",
      locate_entity(StubClient(matches=[
          {"level": "module", "path": "cards"},
      ]), "cards"), None)

check("no matches at all returns None", locate_entity(StubClient(), "cards"), None)

# --- fetch_entity_schema ----------------------------------------------------

found = StubClient(
    matches=[{"level": "entity", "path": "board/cards"}],
    entities={"board/cards": {"level": "entity",
                              "fields": {"title": {"type": "string"},
                                         "done": {"type": "boolean"}}}},
)
check("a located entity yields its flattened schema",
      fetch_entity_schema(found, "cards"), {"title": "string", "done": "boolean"})
check("locating and describing costs exactly two requests",
      found.calls, ["find:cards", "describe:board/cards"])

check("an entity that cannot be located yields None",
      fetch_entity_schema(StubClient(), "ghosts"), None)

# --- fetch_entity_index -----------------------------------------------------

index_client = StubClient(
    root={"level": "root", "modules": [
        {"name": "board", "entities": 2},
        {"name": "secret", "entities": 5, "access": "none"},
        {"name": "empty", "entities": 0},
    ]},
    modules={"board": {"level": "module",
                       "entities": [{"name": "cards"}, {"name": "lists"}]}},
)
check("every readable entity maps to its module",
      fetch_entity_index(index_client), {"cards": "board", "lists": "board"})
check("modules the caller cannot access, and empty ones, are never described",
      index_client.calls, ["describe:", "describe:board"])

check("no root means an empty index", fetch_entity_index(StubClient()), {})

# --- report -----------------------------------------------------------------

if FAILURES:
    print("a2app SDK: %d check(s) FAILED\n" % len(FAILURES))
    for f in FAILURES:
        print("  [FAIL] %s\n" % f)
    sys.exit(1)
print("a2app SDK: all checks passed")
