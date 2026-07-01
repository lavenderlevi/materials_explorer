"""
SQLite-backed caching and popularity tracking for Materials Explorer.

Optimization notes
------------------
OPT[TL]:  ``CacheStore._connect()`` uses ``threading.local()`` — one
          persistent connection per OS thread. Eliminates the ~5ms
          ``sqlite3.connect()`` overhead that the original per-call approach
          incurred on EVERY cache read. Streamlit's thread pool is small and
          stable, so connections are created once and reused indefinitely.

OPT[L1]:  ``_L1Cache`` is an in-process LRU-eviction dict with per-entry TTL.
          Warm queries (cache hit rate > 0) serve from RAM in <1 μs instead
          of ~1 ms for SQLite. Size-capped at 256 entries (≈ few MB at most).

OPT[SQL]: ``get_search_counts_batch`` executes a single
          ``WHERE material_id IN (…)`` query for an entire result set,
          replacing N individual ``get_search_count`` calls from Step 2.

Write serialization: a single ``threading.Lock`` (``_write_lock``) guards
all INSERT/UPDATE/DELETE statements. Reads under WAL mode need no Python-level
lock — SQLite WAL allows concurrent readers.
"""

from __future__ import annotations
from collections import OrderedDict
import hashlib
import json
import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Final

from .models import MaterialDocument

logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS: Final[int] = 7 * 24 * 3600
_L1_MAX_SIZE: Final[int] = 256  # entries — bounds memory to a few MB at most


# ---------------------------------------------------------------------------
# L1 in-memory cache
# ---------------------------------------------------------------------------


class _L1Cache:
    """Thread-safe in-process LRU cache with per-entry TTL.

    Uses Python's insertion-ordered ``dict`` (guaranteed 3.7+) for LRU
    eviction: on access, the entry is moved to the end; on overflow, the
    oldest (first) entry is evicted. TTL is checked on every read.

    OPT[L1]: Cache reads that hit L1 never touch SQLite or the file system.
    """

    def __init__(self, maxsize: int = _L1_MAX_SIZE) -> None:
        self._data: OrderedDict[str, tuple[list[Any], float]] = OrderedDict()
        self._maxsize = maxsize
        self._lock = threading.Lock()

    def get(self, key: str) -> list[Any] | None:
        """Return cached data for *key*, or ``None`` if absent or expired."""
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            data, expires_at = entry
            if expires_at < time.time():
                del self._data[key]
                return None
            # Move to end (most-recently-used) for LRU ordering.
            self._data.move_to_end(key)  # type: ignore[attr-defined]
            return data

    def set(self, key: str, data: list[Any], expires_at: float) -> None:
        """Store *data* under *key* with absolute expiry *expires_at*."""
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)  # type: ignore[attr-defined]
            elif len(self._data) >= self._maxsize:
                # Evict oldest entry (first key in insertion-ordered dict).
                self._data.pop(next(iter(self._data)))
            self._data[key] = (data, expires_at)

    def invalidate(self, key: str) -> None:
        """Remove a single entry, if present."""
        with self._lock:
            self._data.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


# ---------------------------------------------------------------------------
# CacheStore
# ---------------------------------------------------------------------------


class CacheStore:
    """Thread-safe SQLite store with L1 memory cache layer.

    Parameters
    ----------
    db_path:
        Path to the SQLite database file.
    l1_maxsize:
        Maximum number of entries in the in-memory L1 cache.
    """

    def __init__(
        self,
        db_path: str | Path = "materials_explorer.db",
        l1_maxsize: int = _L1_MAX_SIZE,
    ) -> None:
        self._db_path = str(db_path)
        # OPT[TL]: Per-instance thread-local storage → one connection per thread.
        self._local = threading.local()
        self._write_lock = threading.Lock()
        # OPT[L1]: In-process cache; checked before every SQLite read.
        self._l1 = _L1Cache(maxsize=l1_maxsize)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        """Return a thread-local connection, creating one on first access.

        OPT[TL]: Connections are created once per thread and reused across
        all subsequent calls in that thread. Eliminates per-call connect()
        overhead (~5 ms) at the cost of holding connections open permanently
        (acceptable for Streamlit's small, stable thread pool).
        """
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self._db_path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA synchronous=NORMAL;")
            # OPT[SQL]: 8 MB page cache reduces disk I/O for repeated reads.
            conn.execute("PRAGMA cache_size=-8192;")
            conn.execute("PRAGMA temp_store=MEMORY;")
            self._local.conn = conn
        return conn

    def _init_schema(self) -> None:
        """Create tables and indexes. Idempotent — safe to call on startup."""
        conn = self._connect()
        with self._write_lock:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS api_cache (
                    cache_key     TEXT PRIMARY KEY,
                    response_json TEXT NOT NULL,
                    created_at    REAL NOT NULL,
                    expires_at    REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_cache_expires ON api_cache(expires_at);

                CREATE TABLE IF NOT EXISTS search_popularity (
                    material_id      TEXT PRIMARY KEY,
                    search_count     INTEGER NOT NULL DEFAULT 1,
                    last_searched_at REAL    NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_popularity_count
                    ON search_popularity(search_count DESC);
            """)

    # ------------------------------------------------------------------
    # Cache CRUD
    # ------------------------------------------------------------------

    def get(self, key: str) -> list[Any] | None:
        """Return cached payload, checking L1 then SQLite.

        OPT[L1]: L1 hit → returns in <1 μs without touching SQLite.
        OPT[TL]: SQLite read uses thread-local connection; no lock needed
                 under WAL mode which allows concurrent readers.
        """
        # L1 check — fast path.
        l1 = self._l1.get(key)
        if l1 is not None:
            logger.debug("L1 HIT key=%s…", key[:12])
            return l1

        now = time.time()
        conn = self._connect()
        row = conn.execute(
            "SELECT response_json, expires_at FROM api_cache WHERE cache_key = ?",
            (key,),
        ).fetchone()

        if row is None:
            return None
        if row["expires_at"] < now:
            self._evict(key)
            logger.debug("SQLite EXPIRED key=%s…", key[:12])
            return None

        data: list[Any] = json.loads(row["response_json"])
        # OPT[L1]: Populate L1 on SQLite hit so next access is from RAM.
        self._l1.set(key, data, row["expires_at"])
        logger.debug("SQLite HIT key=%s…", key[:12])
        return data

    def set(self, key: str, data: list[Any], ttl: int = _CACHE_TTL_SECONDS) -> None:
        """Persist *data* under *key* and update L1."""
        now = time.time()
        expires_at = now + ttl
        payload = json.dumps(data, default=str)
        conn = self._connect()
        with self._write_lock:
            conn.execute(
                "INSERT OR REPLACE INTO api_cache (cache_key, response_json, created_at, expires_at)"
                " VALUES (?, ?, ?, ?)",
                (key, payload, now, expires_at),
            )
            conn.commit()
        # OPT[L1]: Write-through so L1 is warm immediately after set().
        self._l1.set(key, data, expires_at)
        logger.debug("Cache SET key=%s… (%d items)", key[:12], len(data))

    def _evict(self, key: str) -> None:
        """Remove a single expired entry from both tiers."""
        self._l1.invalidate(key)
        conn = self._connect()
        with self._write_lock:
            conn.execute("DELETE FROM api_cache WHERE cache_key = ?", (key,))
            conn.commit()

    def purge_expired(self) -> int:
        """Delete all expired entries from SQLite. Returns removed count."""
        conn = self._connect()
        with self._write_lock:
            cur = conn.execute("DELETE FROM api_cache WHERE expires_at < ?", (time.time(),))
            conn.commit()
        # L1 entries expire lazily on next access; full clear is safe here.
        self._l1.clear()
        logger.info("Purged %d expired cache entries.", cur.rowcount)
        return cur.rowcount

    def cache_stats(self) -> dict[str, int]:
        """Return ``{total, active, expired}`` entry counts from SQLite."""
        now = time.time()
        conn = self._connect()
        total: int = conn.execute("SELECT COUNT(*) FROM api_cache").fetchone()[0]
        expired: int = conn.execute(
            "SELECT COUNT(*) FROM api_cache WHERE expires_at < ?", (now,)
        ).fetchone()[0]
        return {"total": total, "expired": expired, "active": total - expired}

    # ------------------------------------------------------------------
    # Popularity tracking
    # ------------------------------------------------------------------

    def record_search(self, material_ids: list[str]) -> None:
        """Upsert search counts for *material_ids* in one batch statement."""
        if not material_ids:
            return
        now = time.time()
        conn = self._connect()
        with self._write_lock:
            conn.executemany(
                """INSERT INTO search_popularity (material_id, search_count, last_searched_at)
                   VALUES (?, 1, ?)
                   ON CONFLICT(material_id) DO UPDATE SET
                       search_count = search_count + 1,
                       last_searched_at = excluded.last_searched_at""",
                [(mid, now) for mid in material_ids],
            )
            conn.commit()

    def get_search_count(self, material_id: str) -> int:
        """Return cumulative search count for *material_id*, or 0."""
        conn = self._connect()
        row = conn.execute(
            "SELECT search_count FROM search_popularity WHERE material_id = ?",
            (material_id,),
        ).fetchone()
        return int(row["search_count"]) if row else 0

    def get_max_search_count(self) -> int:
        """Return the highest search count across all tracked materials (min 1)."""
        conn = self._connect()
        row = conn.execute(
            "SELECT COALESCE(MAX(search_count), 0) AS m FROM search_popularity"
        ).fetchone()
        return max(int(row["m"]), 1)

    def get_search_counts_batch(self, material_ids: list[str]) -> dict[str, int]:
        """Fetch counts for *material_ids* in ONE SQL query.

        OPT[SQL]: Replaces N individual ``get_search_count`` calls with a
        single ``WHERE material_id IN (…)`` statement.
        """
        if not material_ids:
            return {}
        placeholders = ",".join("?" * len(material_ids))
        conn = self._connect()
        rows = conn.execute(
            f"SELECT material_id, search_count FROM search_popularity"
            f" WHERE material_id IN ({placeholders})",
            material_ids,
        ).fetchall()
        return {row["material_id"]: int(row["search_count"]) for row in rows}

    def get_top_materials(self, n: int = 10) -> list[tuple[str, int]]:
        """Return the top-*n* most-searched materials as ``(material_id, count)``."""
        conn = self._connect()
        rows = conn.execute(
            "SELECT material_id, search_count FROM search_popularity"
            " ORDER BY search_count DESC LIMIT ?",
            (n,),
        ).fetchall()
        return [(row["material_id"], int(row["search_count"])) for row in rows]


# ---------------------------------------------------------------------------
# CachedMPClient — implements MPClientProtocol
# ---------------------------------------------------------------------------


class CachedMPClient:
    """``MPClientProtocol``-compatible client with transparent SQLite + L1 caching.

    ``mp_api`` is imported lazily so that this module is importable in
    environments where mp-api is not installed (CI, unit test pipelines).
    """

    def __init__(self, api_key: str, cache_store: CacheStore) -> None:
        self._api_key = api_key
        self._store = cache_store
        self.last_cache_hit: bool = False

    @staticmethod
    def _make_key(operation: str, **kwargs: Any) -> str:
        """SHA-256 of a deterministically sorted JSON payload.

        Sorting kwargs ensures argument-order independence:
        ``search(band_gap=…, density=…)`` == ``search(density=…, band_gap=…)``.
        """
        payload = {"op": operation, **{k: str(v) for k, v in sorted(kwargs.items())}}
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()

    def get_by_id(
        self, material_id: str, fields: list[str]
    ) -> MaterialDocument | None:
        """Return a single material by MP ID; uses L1 → SQLite → API."""
        key = self._make_key("get_by_id", material_id=material_id, fields=sorted(fields))
        cached = self._store.get(key)
        if cached:
            self.last_cache_hit = True
            return MaterialDocument.model_validate(cached[0]) if cached else None

        self.last_cache_hit = False
        try:
            from mp_api.client import MPRester  # noqa: PLC0415
            with MPRester(self._api_key) as mpr:
                docs = mpr.materials.summary.search(
                    material_ids=[material_id], fields=fields
                )
            if not docs:
                return None
            result = MaterialDocument.from_summary_doc(docs[0])
            self._store.set(key, [result.model_dump()])
            self._store.record_search([result.material_id])
            return result
        except Exception:
            logger.exception("MP API get_by_id failed for '%s'.", material_id)
            return None

    def search(self, fields: list[str], **filters: Any) -> list[MaterialDocument]:
        """Search MP summary endpoint; uses L1 → SQLite → API."""
        key = self._make_key("search", fields=sorted(fields), **filters)
        cached = self._store.get(key)
        if cached:
            self.last_cache_hit = True
            return [MaterialDocument.model_validate(d) for d in cached]

        self.last_cache_hit = False
        try:
            from mp_api.client import MPRester  # noqa: PLC0415
            with MPRester(self._api_key) as mpr:
                docs = mpr.materials.summary.search(fields=fields, **filters)
            results = [MaterialDocument.from_summary_doc(d) for d in (docs or [])]
            self._store.set(key, [r.model_dump() for r in results])
            if results:
                self._store.record_search([r.material_id for r in results])
            return results
        except Exception:
            logger.exception("MP API search failed. filters=%s", filters)
            return []


# ---------------------------------------------------------------------------
# SQLitePopularityFetcher — implements PopularityFetcherProtocol
# ---------------------------------------------------------------------------


class SQLitePopularityFetcher:
    """Narrow adapter: exposes only ``PopularityFetcherProtocol`` over ``CacheStore``."""

    def __init__(self, cache_store: CacheStore) -> None:
        self._store = cache_store

    def get_search_count(self, material_id: str) -> int:
        return self._store.get_search_count(material_id)

    def get_max_search_count(self) -> int:
        return self._store.get_max_search_count()

    # OPT[SQL]: Delegates batch query to CacheStore.get_search_counts_batch.
    def get_search_counts_batch(self, material_ids: list[str]) -> dict[str, int]:
        return self._store.get_search_counts_batch(material_ids)