"""A2AppClient — a dependency-free HTTP client for the A2App protocol.

Every method returns the app's response verbatim (status + parsed JSON) so the
caller branches on the machine ``code``, never on prose.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional

PROTOCOL_VERSION = "0.1"
# Some adapters still report "1.0"; it is an alias of "0.1" during the
# transition window.
ACCEPTED_PROTOCOLS = ("0.1", "1.0")


class A2AppUnreachableError(Exception):
    """The app is unreachable (spec: CLI exit 3). Network failure, not a
    protocol rejection."""


@dataclass
class A2AppResponse:
    status: int
    body: str
    json: Any
    ok: bool


class A2AppClient:
    def __init__(
        self,
        base_url: str,
        token: Optional[str] = None,
        agent_name: str = "a2app-python",
        auth_token: Optional[str] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._token = token
        self._agent_name = agent_name
        self._auth_token = auth_token

    # ----------------------------------------------------------- low level

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> A2AppResponse:
        headers: Dict[str, str] = {
            "Content-Type": "application/json",
            "X-A2App-Agent": self._agent_name,
        }
        if self._token is not None:
            headers["X-A2App-Token"] = self._token
        if self._auth_token is not None:
            headers["Authorization"] = self._auth_token
        if extra_headers:
            headers.update(extra_headers)

        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as resp:  # noqa: S310 (loopback by design)
                text = resp.read().decode("utf-8")
                status = resp.status
        except urllib.error.HTTPError as e:  # a rejection is a normal outcome
            text = e.read().decode("utf-8")
            status = e.code
        except urllib.error.URLError as e:
            raise A2AppUnreachableError(
                f"{e.reason}. The app may not be running (a refused connection is a dead "
                f"local server, not a network problem). Launch it, then retry."
            ) from e

        try:
            parsed = json.loads(text) if text else None
        except json.JSONDecodeError:
            parsed = None
        return A2AppResponse(status=status, body=text, json=parsed, ok=status < 300)

    # ----------------------------------------------------------- discovery

    def identity(self) -> Optional[Dict[str, Any]]:
        """Probe an app's identity, or None when no identity document was served.

        The success check is `res.ok` AND the marker, not the marker alone. Every
        adapter error envelope also carries `a2app: true` -- it is how a client
        knows a refusal came from the app rather than from something in front of
        it -- so a marker-only test accepts a 403 forbidden_host or a 401 as an
        identity document. What comes back then has no `protocol` and no
        `app.id`, and the caller reports whichever of those it touches first
        instead of the refusal that actually occurred.
        """
        for path in ("/.well-known/a2app.json", "/api/_a2app"):
            res = self.request("GET", path)
            if not res.ok:
                continue
            if isinstance(res.json, dict) and res.json.get("a2app") is True:
                return res.json
        return None

    @staticmethod
    def protocol_supported(protocol: str) -> bool:
        return protocol in ACCEPTED_PROTOCOLS

    def describe(self, path: str = "", all: bool = False) -> Optional[Dict[str, Any]]:
        """Fetch ONE level of describe (A2APP-SPEC 3).

        ``path`` is the location to describe — ``""`` for the root (the app's
        modules), ``"sales"`` for a module, ``"sales/invoices"`` for an entity,
        ``"sales/invoices/INV-1"`` for a record and the operations its current
        state allows, plus one more segment for a sub-resource. Segments are
        encoded here because entity names and record ids are the app's own.

        There is no call that returns the whole model: a task touching two
        entities pays for two, not for the app.
        """
        segments = [urllib.parse.quote(s, safe="") for s in path.split("/") if s]
        suffix = "/" + "/".join(segments) if segments else ""
        query = "?all=true" if all else ""
        res = self.request("GET", f"/api/_a2app/describe{suffix}{query}")
        return res.json if res.ok else None

    def describe_root(self) -> Optional[Dict[str, Any]]:
        """The app's root screen: its modules, their sizes, and this caller's access."""
        level = self.describe("")
        return level if level and level.get("level") == "root" else None

    def describe_entity(self, module: str, entity: str) -> Optional[Dict[str, Any]]:
        """One entity's fields and the operations that act on it."""
        level = self.describe(f"{module}/{entity}")
        return level if level and level.get("level") == "entity" else None

    def describe_record(self, module: str, entity: str, record_id: str) -> Optional[Dict[str, Any]]:
        """One record, and which operations its current state allows."""
        level = self.describe(f"{module}/{entity}/{record_id}")
        return level if level and level.get("level") == "record" else None

    def find(self, term: str) -> Optional[Dict[str, Any]]:
        """Search entity, operation and module names; returns locations.

        Without this the walk is a linked list: an agent that picks the wrong
        branch pays a full backtrack to correct itself.
        """
        res = self.request("GET", f"/api/_a2app/describe?find={urllib.parse.quote(term, safe='')}")
        level = res.json if res.ok else None
        return level if level and level.get("level") == "find" else None

    def whoami(self) -> Optional[Dict[str, Any]]:
        res = self.request("GET", "/api/_a2app/whoami")
        return res.json if res.ok else None

    def context(self) -> Optional[Dict[str, Any]]:
        res = self.request("GET", "/api/_a2app/context")
        return res.json if res.ok else None

    # ---------------------------------------------------------------- data

    def _records(self, entity: str) -> str:
        return f"/api/collections/{urllib.parse.quote(entity)}/records"

    def list_records(
        self, entity: str, filter: Optional[str] = None, sort: Optional[str] = None, per_page: Optional[int] = None
    ) -> A2AppResponse:
        qs: Dict[str, str] = {}
        if filter:
            qs["filter"] = filter
        if sort:
            qs["sort"] = sort
        if per_page:
            qs["perPage"] = str(per_page)
        suffix = f"?{urllib.parse.urlencode(qs)}" if qs else ""
        return self.request("GET", self._records(entity) + suffix)

    def get_record(self, entity: str, record_id: str) -> A2AppResponse:
        return self.request("GET", f"{self._records(entity)}/{record_id}")

    def create_record(self, entity: str, body: Dict[str, Any], idempotency_key: Optional[str] = None) -> A2AppResponse:
        return self.request("POST", self._records(entity), body, _idem(idempotency_key))

    def update_record(
        self, entity: str, record_id: str, body: Dict[str, Any], idempotency_key: Optional[str] = None
    ) -> A2AppResponse:
        return self.request("PATCH", f"{self._records(entity)}/{record_id}", body, _idem(idempotency_key))

    def delete_record(self, entity: str, record_id: str) -> A2AppResponse:
        return self.request("DELETE", f"{self._records(entity)}/{record_id}")

    # ---------------------------------------------------------- operations

    def call_operation(
        self, name: str, args: Optional[Dict[str, Any]] = None, approval_key: Optional[str] = None
    ) -> A2AppResponse:
        headers = {"X-A2App-Approval": approval_key} if approval_key else None
        return self.request("POST", f"/api/ops/{urllib.parse.quote(name)}", args or {}, headers)

    # ------------------------------------------------------------ app->agent

    def poll_events(self, since: Optional[str] = None) -> A2AppResponse:
        suffix = f"?since={urllib.parse.quote(since)}" if since else ""
        return self.request("GET", f"/api/_a2app/events{suffix}")

    def poll_tasks(self, status: str = "submitted") -> A2AppResponse:
        return self.request("GET", f"/api/_a2app/tasks?status={urllib.parse.quote(status)}")

    def get_task(self, task_id: str) -> A2AppResponse:
        return self.request("GET", f"/api/_a2app/tasks/{task_id}")

    def claim_task(self, task_id: str, credential_id: str) -> A2AppResponse:
        return self.request("POST", f"/api/_a2app/tasks/{task_id}/claim", {"agent": credential_id})

    def progress_task(self, task_id: str, step: Optional[str] = None, percent: Optional[int] = None) -> A2AppResponse:
        body: Dict[str, Any] = {}
        if step is not None:
            body["step"] = step
        if percent is not None:
            body["percent"] = percent
        return self.request("POST", f"/api/_a2app/tasks/{task_id}/progress", body)

    def complete_task(self, task_id: str, status: str = "completed", result: Any = None, reason: Optional[str] = None) -> A2AppResponse:
        body: Dict[str, Any] = {"status": status}
        if result is not None:
            body["result"] = result
        if reason is not None:
            body["reason"] = reason
        return self.request("POST", f"/api/_a2app/tasks/{task_id}/complete", body)

    def cancel_task(self, task_id: str) -> A2AppResponse:
        return self.request("POST", f"/api/_a2app/tasks/{task_id}/cancel", {})


def _idem(key: Optional[str]) -> Optional[Dict[str, str]]:
    return {"Idempotency-Key": key} if key else None
