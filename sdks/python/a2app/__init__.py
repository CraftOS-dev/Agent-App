"""a2app — the Python client SDK for the A2App protocol (v0.1).

The agent-facing surface any Python harness needs to operate an Agent App:
identity + describe (context by pull), guarded reads/writes, declared
operations, the app->agent task/event plane, and whoami/context — plus the
client-side coercion (relative dates) that keeps a correct write within the
protocol's round-trip budget.

Dependency-free: standard library only (urllib), so it drops into any Python
environment. Mirrors ``@a2app/sdk`` (TypeScript); the wire contract is the same.
"""

from .client import (
    A2AppClient,
    A2AppResponse,
    A2AppUnreachableError,
    ACCEPTED_PROTOCOLS,
    PROTOCOL_VERSION,
)
from .coerce import parse_date, entity_to_schema, fetch_entity_index, fetch_entity_schema, locate_entity

SDK_VERSION = "0.1.0"

__all__ = [
    "A2AppClient",
    "A2AppResponse",
    "A2AppUnreachableError",
    "ACCEPTED_PROTOCOLS",
    "PROTOCOL_VERSION",
    "parse_date",
    "entity_to_schema",
    "fetch_entity_schema",
    "fetch_entity_index",
    "locate_entity",
    "SDK_VERSION",
]
