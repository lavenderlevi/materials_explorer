"""
Experiment Workspace for Materials Explorer.

WorkspaceStore   — Thread-safe SQLite CRUD for saved searches, comparison
                   sets, comparison items, and export history. Shares the
                   project DB file; uses separate tables from all other stores.
                   Thread-local WAL connections + write lock (same pattern as
                   CacheStore). FOREIGN_KEYS=ON + ON DELETE CASCADE keeps
                   comparison_items in sync with their parent sets.

DatasetExporter  — Converts list[MaterialDocument] to CSV / JSON / Excel bytes.
                   to_dataframe() flattens nested CompletenessFlags into
                   top-level boolean columns for clean tabular output.

WorkspaceManager — Lightweight facade: exposes wm.store and wm.exporter
                   publicly, plus a convenience export() that records history.
"""

from __future__ import annotations

import io
import json
import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Final

import pandas as pd
from pydantic import BaseModel, ConfigDict, Field

from .models import MaterialDocument, ParsedQuery

logger = logging.getLogger(__name__)

_EXPORT_COLS: Final[tuple[str, ...]] = (
    "material_id", "formula_pretty", "band_gap", "density",
    "formation_energy_per_atom", "energy_above_hull", "volume",
    "nsites", "nelements", "crystal_system", "spacegroup_symbol",
    "chemsys", "elements", "is_stable", "is_magnetic",
    "has_dos", "has_band_structure", "has_elastic", "theoretical", "mp_url",
)

# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


class SavedSearch(BaseModel):
    """A persisted search query with result metadata."""

    model_config = ConfigDict(frozen=True)

    id: int
    name: str
    raw_query: str
    parsed_query: ParsedQuery
    result_ids: tuple[str, ...]
    result_count: int
    created_at: float
    last_run_at: float | None = None


class ComparisonItem(BaseModel):
    """A single material entry within a ComparisonSet."""

    model_config = ConfigDict(frozen=True)

    material_id: str
    formula: str
    document: MaterialDocument
    added_at: float


class ComparisonSet(BaseModel):
    """Named collection of materials for side-by-side property comparison."""

    model_config = ConfigDict(frozen=True)

    id: int
    name: str
    notes: str = ""
    items: tuple[ComparisonItem, ...] = Field(default_factory=tuple)
    created_at: float
    updated_at: float


# ---------------------------------------------------------------------------
# WorkspaceStore
# ---------------------------------------------------------------------------


class WorkspaceStore:
    """Thread-safe SQLite store for all workspace entities."""

    def __init__(self, db_path: str | Path = "materials_explorer.db") -> None:
        self._db_path = str(db_path)
        self._local = threading.local()
        self._write_lock = threading.Lock()
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self._db_path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA synchronous=NORMAL;")
            conn.execute("PRAGMA foreign_keys=ON;")
            self._local.conn = conn
        return conn

    def _init_schema(self) -> None:
        conn = self._connect()
        with self._write_lock:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS saved_searches (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    name         TEXT    NOT NULL,
                    raw_query    TEXT    NOT NULL,
                    parsed_json  TEXT    NOT NULL,
                    result_ids   TEXT    NOT NULL DEFAULT '[]',
                    result_count INTEGER NOT NULL DEFAULT 0,
                    created_at   REAL    NOT NULL,
                    last_run_at  REAL
                );
                CREATE TABLE IF NOT EXISTS comparison_sets (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    name       TEXT    NOT NULL,
                    notes      TEXT    NOT NULL DEFAULT '',
                    created_at REAL    NOT NULL,
                    updated_at REAL    NOT NULL
                );
                CREATE TABLE IF NOT EXISTS comparison_items (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    set_id      INTEGER NOT NULL
                                REFERENCES comparison_sets(id) ON DELETE CASCADE,
                    material_id TEXT    NOT NULL,
                    formula     TEXT    NOT NULL,
                    doc_json    TEXT    NOT NULL,
                    added_at    REAL    NOT NULL,
                    UNIQUE(set_id, material_id)
                );
                CREATE TABLE IF NOT EXISTS export_history (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    fmt         TEXT    NOT NULL,
                    query_text  TEXT,
                    n_materials INTEGER NOT NULL,
                    exported_at REAL    NOT NULL
                );
            """)
            conn.commit()

    # --- Saved Searches ---

    def save_search(
        self,
        name: str,
        raw_query: str,
        parsed_query: ParsedQuery,
        result_ids: list[str],
    ) -> int:
        """Persist a search. Returns the new auto-incremented row ID."""
        now = time.time()
        conn = self._connect()
        with self._write_lock:
            cur = conn.execute(
                "INSERT INTO saved_searches"
                " (name, raw_query, parsed_json, result_ids, result_count, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (name, raw_query, parsed_query.model_dump_json(),
                 json.dumps(result_ids), len(result_ids), now),
            )
            conn.commit()
        return cur.lastrowid

    def get_saved_searches(self) -> list[SavedSearch]:
        rows = self._connect().execute(
            "SELECT * FROM saved_searches ORDER BY created_at DESC"
        ).fetchall()
        result: list[SavedSearch] = []
        for r in rows:
            try:
                result.append(SavedSearch(
                    id=r["id"], name=r["name"], raw_query=r["raw_query"],
                    parsed_query=ParsedQuery.model_validate_json(r["parsed_json"]),
                    result_ids=tuple(json.loads(r["result_ids"])),
                    result_count=r["result_count"],
                    created_at=r["created_at"], last_run_at=r["last_run_at"],
                ))
            except Exception:
                logger.warning("Corrupt saved_search id=%s — skipped.", r["id"])
        return result

    def update_last_run(self, search_id: int) -> None:
        conn = self._connect()
        with self._write_lock:
            conn.execute(
                "UPDATE saved_searches SET last_run_at = ? WHERE id = ?",
                (time.time(), search_id),
            )
            conn.commit()

    def delete_saved_search(self, search_id: int) -> None:
        conn = self._connect()
        with self._write_lock:
            conn.execute("DELETE FROM saved_searches WHERE id = ?", (search_id,))
            conn.commit()

    # --- Comparison Sets ---

    def create_comparison_set(self, name: str, notes: str = "") -> int:
        now = time.time()
        conn = self._connect()
        with self._write_lock:
            cur = conn.execute(
                "INSERT INTO comparison_sets (name, notes, created_at, updated_at)"
                " VALUES (?, ?, ?, ?)",
                (name, notes, now, now),
            )
            conn.commit()
        return cur.lastrowid

    def add_to_set(self, set_id: int, doc: MaterialDocument) -> bool:
        """Add material to set. Returns False if already present (UNIQUE constraint)."""
        conn = self._connect()
        with self._write_lock:
            try:
                conn.execute(
                    "INSERT INTO comparison_items"
                    " (set_id, material_id, formula, doc_json, added_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (set_id, doc.material_id, doc.formula_pretty,
                     doc.model_dump_json(), time.time()),
                )
                conn.execute(
                    "UPDATE comparison_sets SET updated_at = ? WHERE id = ?",
                    (time.time(), set_id),
                )
                conn.commit()
                return True
            except sqlite3.IntegrityError:
                return False

    def remove_from_set(self, set_id: int, material_id: str) -> None:
        conn = self._connect()
        with self._write_lock:
            conn.execute(
                "DELETE FROM comparison_items WHERE set_id = ? AND material_id = ?",
                (set_id, material_id),
            )
            conn.execute(
                "UPDATE comparison_sets SET updated_at = ? WHERE id = ?",
                (time.time(), set_id),
            )
            conn.commit()

    def get_comparison_sets(self) -> list[ComparisonSet]:
        conn = self._connect()
        sets = conn.execute(
            "SELECT * FROM comparison_sets ORDER BY updated_at DESC"
        ).fetchall()
        result: list[ComparisonSet] = []
        for s in sets:
            item_rows = conn.execute(
                "SELECT * FROM comparison_items WHERE set_id = ? ORDER BY added_at",
                (s["id"],),
            ).fetchall()
            items: list[ComparisonItem] = []
            for it in item_rows:
                try:
                    items.append(ComparisonItem(
                        material_id=it["material_id"], formula=it["formula"],
                        document=MaterialDocument.model_validate_json(it["doc_json"]),
                        added_at=it["added_at"],
                    ))
                except Exception:
                    logger.warning("Corrupt comparison_item set_id=%s — skipped.", s["id"])
            result.append(ComparisonSet(
                id=s["id"], name=s["name"], notes=s["notes"],
                items=tuple(items),
                created_at=s["created_at"], updated_at=s["updated_at"],
            ))
        return result

    def delete_comparison_set(self, set_id: int) -> None:
        """CASCADE deletes all comparison_items for this set."""
        conn = self._connect()
        with self._write_lock:
            conn.execute("DELETE FROM comparison_sets WHERE id = ?", (set_id,))
            conn.commit()

    # --- Export History & Stats ---

    def record_export(self, fmt: str, query_text: str | None, n: int) -> None:
        conn = self._connect()
        with self._write_lock:
            conn.execute(
                "INSERT INTO export_history (fmt, query_text, n_materials, exported_at)"
                " VALUES (?, ?, ?, ?)",
                (fmt, query_text, n, time.time()),
            )
            conn.commit()

    def workspace_stats(self) -> dict[str, int]:
        conn = self._connect()
        return {
            "saved_searches": conn.execute("SELECT COUNT(*) FROM saved_searches").fetchone()[0],
            "comparison_sets": conn.execute("SELECT COUNT(*) FROM comparison_sets").fetchone()[0],
            "comparison_items": conn.execute("SELECT COUNT(*) FROM comparison_items").fetchone()[0],
            "exports": conn.execute("SELECT COUNT(*) FROM export_history").fetchone()[0],
        }


# ---------------------------------------------------------------------------
# DatasetExporter
# ---------------------------------------------------------------------------


class DatasetExporter:
    """Converts list[MaterialDocument] to CSV / JSON / Excel bytes.

    to_dataframe() flattens nested CompletenessFlags into top-level boolean
    columns. All None numeric values become NaN for clean CSV/Excel output.
    Requires openpyxl for Excel export: pip install openpyxl.
    """

    def to_dataframe(
        self,
        docs: list[MaterialDocument],
        columns: list[str] | None = None,
    ) -> pd.DataFrame:
        rows: list[dict[str, Any]] = []
        for doc in docs:
            rows.append({
                "material_id": doc.material_id,
                "formula_pretty": doc.formula_pretty,
                "band_gap": doc.band_gap,
                "density": doc.density,
                "formation_energy_per_atom": doc.formation_energy_per_atom,
                "energy_above_hull": doc.energy_above_hull,
                "volume": doc.volume,
                "nsites": doc.nsites,
                "nelements": doc.nelements,
                "crystal_system": doc.crystal_system,
                "spacegroup_symbol": doc.spacegroup_symbol,
                "chemsys": doc.chemsys,
                "elements": " ".join(doc.elements),
                "is_stable": doc.is_stable,
                "is_magnetic": doc.is_magnetic,
                "has_dos": doc.completeness.has_dos,
                "has_band_structure": doc.completeness.has_band_structure,
                "has_elastic": doc.completeness.has_elastic,
                "theoretical": doc.theoretical,
                "mp_url": f"https://materialsproject.org/materials/{doc.material_id}",
            })
        df = pd.DataFrame(rows)
        if columns:
            df = df[[c for c in columns if c in df.columns]]
        return df

    def to_csv_bytes(
        self, docs: list[MaterialDocument], columns: list[str] | None = None
    ) -> bytes:
        return self.to_dataframe(docs, columns).to_csv(index=False).encode("utf-8")

    def to_json_bytes(
        self, docs: list[MaterialDocument], columns: list[str] | None = None
    ) -> bytes:
        return self.to_dataframe(docs, columns).to_json(
            orient="records", indent=2
        ).encode("utf-8")

    def to_excel_bytes(
        self, docs: list[MaterialDocument], columns: list[str] | None = None
    ) -> bytes:
        buf = io.BytesIO()
        with pd.ExcelWriter(buf, engine="openpyxl") as writer:
            self.to_dataframe(docs, columns).to_excel(
                writer, sheet_name="Materials", index=False
            )
        return buf.getvalue()


# ---------------------------------------------------------------------------
# WorkspaceManager — public facade
# ---------------------------------------------------------------------------


class WorkspaceManager:
    """Facade composing WorkspaceStore and DatasetExporter.

    Pages access ``wm.store`` and ``wm.exporter`` directly for full CRUD.
    ``export()`` is a convenience that selects the right serialiser and
    records the action to export_history in one call.
    """

    def __init__(self, db_path: str | Path = "materials_explorer.db") -> None:
        self.store = WorkspaceStore(db_path=db_path)
        self.exporter = DatasetExporter()

    @property
    def available_columns(self) -> tuple[str, ...]:
        """All column names available for export."""
        return _EXPORT_COLS

    def export(
        self,
        docs: list[MaterialDocument],
        fmt: str,
        columns: list[str] | None = None,
        query_text: str | None = None,
    ) -> bytes:
        """Export *docs* to *fmt* bytes and record to export_history.

        Parameters
        ----------
        fmt : "csv" | "json" | "excel" | "xlsx"
        """
        fmt = fmt.lower()
        dispatch: dict[str, Any] = {
            "csv": self.exporter.to_csv_bytes,
            "json": self.exporter.to_json_bytes,
            "excel": self.exporter.to_excel_bytes,
            "xlsx": self.exporter.to_excel_bytes,
        }
        fn = dispatch.get(fmt)
        if fn is None:
            raise ValueError(f"Unknown format {fmt!r}. Choose: csv / json / excel.")
        data: bytes = fn(docs, columns)
        self.store.record_export(fmt=fmt, query_text=query_text, n=len(docs))
        return data