"""
Grant stores for durable paid-key persistence (P0 #5).

Once a key is added to a grant store it is never re-scanned on-chain, making
paid access durable even after the vendor wallet accumulates 100+ newer
transactions that would push the original payment out of the scan window.

Usage — pass to any adapter as ``grant_store``:

    from agentpayments_python.grant_store import FileGrantStore

    # Django settings.py
    AGENTPAYMENTS_GRANT_STORE = FileGrantStore("/var/data/agp_grants.json")

    # FastAPI / Flask constructor arg
    register_agentpayments(app, ..., grant_store=FileGrantStore("/var/data/agp_grants.json"))

Grant store interface (implement your own for Redis, Postgres, etc.):

    class GrantStore(Protocol):
        def has(self, agent_key: str) -> bool: ...
        def add(self, agent_key: str, expires_at: float | None = None, tier: str | None = None) -> None: ...
        def revoke(self, agent_key: str) -> None: ...

``add``'s ``expires_at``/``tier`` arguments are optional — a custom store
whose ``add`` only accepts ``agent_key`` will break if a caller passes them
as keywords; this is the one Python-side interface change to be aware of
when upgrading a custom store (see CHANGELOG). ``revoke`` is called by the
vendor's own code (e.g. an admin route) to cut off a specific key early; the
adapters never call it — ``has()`` on the built-in stores already returns
False for a revoked or expired grant.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path


def _is_expired(grant: dict) -> bool:
    expires_at = grant.get("expires_at")
    return expires_at is not None and time.time() > expires_at


class MemoryGrantStore:
    """In-memory grant store. Does not survive restarts."""

    def __init__(self) -> None:
        self._grants: dict[str, dict] = {}
        self._lock = threading.Lock()

    def has(self, agent_key: str) -> bool:
        with self._lock:
            grant = self._grants.get(agent_key)
            if not grant or grant.get("revoked") or _is_expired(grant):
                return False
            return True

    def add(self, agent_key: str, expires_at: float | None = None, tier: str | None = None) -> None:
        with self._lock:
            self._grants[agent_key] = {"expires_at": expires_at, "tier": tier, "revoked": False}

    def revoke(self, agent_key: str) -> None:
        with self._lock:
            existing = self._grants.get(agent_key, {"expires_at": None, "tier": None})
            self._grants[agent_key] = {**existing, "revoked": True}


class FileGrantStore:
    """
    File-backed grant store. Persists grants to a JSON file so they survive
    process restarts. Writes are atomic (write to temp file, os.replace).

    Reads the legacy on-disk format (a plain JSON array of key strings) as
    pre-existing permanent grants, so upgrading does not invalidate a
    vendor's existing grants file. Writes the newer object-map format going
    forward.

    Not suitable for multi-process deployments — use a database or Redis there.
    """

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path).resolve()
        self._grants: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._load()

    def _load(self) -> None:
        try:
            parsed = json.loads(self._path.read_text())
            if isinstance(parsed, list):
                # Legacy format: array of key strings, each a permanent grant.
                for key in parsed:
                    self._grants[key] = {"expires_at": None, "tier": None, "revoked": False}
            elif isinstance(parsed, dict):
                for key, grant in parsed.items():
                    self._grants[key] = {
                        "expires_at": grant.get("expires_at"),
                        "tier": grant.get("tier"),
                        "revoked": bool(grant.get("revoked")),
                    }
        except FileNotFoundError:
            pass  # will be created on first write

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._grants, indent=2, sort_keys=True))
        os.replace(tmp, self._path)

    def has(self, agent_key: str) -> bool:
        with self._lock:
            grant = self._grants.get(agent_key)
            if not grant or grant.get("revoked") or _is_expired(grant):
                return False
            return True

    def add(self, agent_key: str, expires_at: float | None = None, tier: str | None = None) -> None:
        with self._lock:
            self._grants[agent_key] = {"expires_at": expires_at, "tier": tier, "revoked": False}
            self._save()

    def revoke(self, agent_key: str) -> None:
        with self._lock:
            existing = self._grants.get(agent_key, {"expires_at": None, "tier": None})
            self._grants[agent_key] = {**existing, "revoked": True}
            self._save()
