"""
Crystal Similarity Search for Materials Explorer.

Two search modes
----------------
Fingerprint (fast):
    19-dim structural feature vector (lattice geometry + composition stats).
    MinMax + L2 corpus-normalized. Cosine similarity. Scales to hundreds of
    structures; cross-composition comparisons are valid and meaningful.

StructureMatcher (exact):
    pymatgen StructureMatcher RMS distance. Handles symmetry and site mapping.
    Only meaningful for same/similar compositions. Recommended corpus ≤ 30.

Caching strategy
----------------
StructureStore persists raw Structure JSON and raw (pre-normalization)
fingerprint vectors in SQLite using thread-local WAL connections.
Corpus-level normalization is recomputed fresh per search — only
the expensive raw feature extraction is cached.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import numpy as np

logger = logging.getLogger(__name__)

_MAX_ELEMENTS: Final[int] = 9
_FP_DIM: Final[int] = 19  # 1 + 3 + 3 + 3 + 9


# ---------------------------------------------------------------------------
# StructureStore
# ---------------------------------------------------------------------------


class StructureStore:
    """SQLite persistence for Structure JSON and raw fingerprint vectors.

    Two tables:
        structures           — Structure.as_dict() JSON, per material_id.
        crystal_fingerprints — raw 19-dim float32 vectors, per material_id.

    Thread-local WAL connections (same pattern as CacheStore). Writes
    serialized under _write_lock; reads need no Python lock under WAL.
    """

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
            self._local.conn = conn
        return conn

    def _init_schema(self) -> None:
        conn = self._connect()
        with self._write_lock:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS structures (
                    material_id    TEXT PRIMARY KEY,
                    structure_json TEXT NOT NULL,
                    created_at     REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS crystal_fingerprints (
                    material_id  TEXT PRIMARY KEY,
                    vector_json  TEXT NOT NULL,
                    created_at   REAL NOT NULL
                );
            """)
            conn.commit()

    def get_structure_json(self, material_id: str) -> dict | None:
        row = self._connect().execute(
            "SELECT structure_json FROM structures WHERE material_id = ?",
            (material_id,),
        ).fetchone()
        return json.loads(row["structure_json"]) if row else None

    def set_structure(self, material_id: str, structure_dict: dict) -> None:
        conn = self._connect()
        with self._write_lock:
            conn.execute(
                "INSERT OR REPLACE INTO structures (material_id, structure_json, created_at)"
                " VALUES (?, ?, ?)",
                (material_id, json.dumps(structure_dict), time.time()),
            )
            conn.commit()

    def get_fingerprints_batch(self, ids: list[str]) -> dict[str, np.ndarray]:
        """Batch-fetch raw fingerprints for *ids* in one SQL query."""
        if not ids:
            return {}
        ph = ",".join("?" * len(ids))
        rows = self._connect().execute(
            f"SELECT material_id, vector_json FROM crystal_fingerprints"
            f" WHERE material_id IN ({ph})",
            ids,
        ).fetchall()
        return {
            r["material_id"]: np.array(json.loads(r["vector_json"]), dtype=np.float32)
            for r in rows
        }

    def set_fingerprint(self, material_id: str, vector: np.ndarray) -> None:
        """Persist a raw (un-normalized) fingerprint vector."""
        conn = self._connect()
        with self._write_lock:
            conn.execute(
                "INSERT OR REPLACE INTO crystal_fingerprints"
                " (material_id, vector_json, created_at) VALUES (?, ?, ?)",
                (material_id, json.dumps(vector.tolist()), time.time()),
            )
            conn.commit()


# ---------------------------------------------------------------------------
# StructureClient
# ---------------------------------------------------------------------------


class StructureClient:
    """Fetches pymatgen Structure objects from MP API with SQLite caching.

    Structures are stored as Structure.as_dict() JSON. The MP API is only
    called on a cache miss. Tries the summary endpoint (modern mp-api) first,
    then falls back to the legacy get_structure_by_material_id helper.
    """

    def __init__(self, api_key: str, store: StructureStore) -> None:
        self._api_key = api_key
        self._store = store

    def get_structure(self, material_id: str):
        """Return a pymatgen Structure for *material_id*, or None on failure."""
        from pymatgen.core import Structure  # noqa: PLC0415

        cached = self._store.get_structure_json(material_id)
        if cached is not None:
            logger.debug("Structure cache HIT: %s", material_id)
            return Structure.from_dict(cached)

        try:
            from mp_api.client import MPRester  # noqa: PLC0415

            with MPRester(self._api_key) as mpr:
                structure = None
                try:
                    docs = mpr.materials.summary.search(
                        material_ids=[material_id], fields=["structure"]
                    )
                    structure = getattr(docs[0], "structure", None) if docs else None
                except Exception:
                    pass
                if structure is None:
                    helper = getattr(mpr, "get_structure_by_material_id", None)
                    if helper:
                        structure = helper(material_id)

            if structure is None:
                return None
            self._store.set_structure(material_id, structure.as_dict())
            logger.debug("Structure fetched + cached: %s", material_id)
            return structure
        except Exception:
            logger.exception("Structure fetch failed for '%s'.", material_id)
            return None

    def get_structures_batch(self, material_ids: list[str]) -> dict:
        """Fetch structures for all *material_ids*; uses SQLite cache first."""
        results: dict = {}
        missing: list[str] = []

        for mid in material_ids:
            cached = self._store.get_structure_json(mid)
            if cached is not None:
                from pymatgen.core import Structure  # noqa: PLC0415
                results[mid] = Structure.from_dict(cached)
            else:
                missing.append(mid)

        for mid in missing:
            s = self.get_structure(mid)
            if s is not None:
                results[mid] = s

        logger.info("Structures: %d/%d fetched.", len(results), len(material_ids))
        return results


# ---------------------------------------------------------------------------
# Crystal Fingerprinter
# ---------------------------------------------------------------------------


class CrystalFingerprinter:
    """Computes a 19-dim structural feature vector from a pymatgen Structure.

    Feature layout:
        [0]    vol_per_atom
        [1:4]  lattice ratios  (a/b, b/c, a/c)
        [4:7]  angles normalised (alpha/180, beta/180, gamma/180)
        [7:10] composition-weighted (X_mean, Z_mean, radius_mean)
        [10:]  element fractions sorted by X, padded to _MAX_ELEMENTS
    """

    def compute(self, structure) -> np.ndarray:
        """Return a raw (corpus-independent) float32 feature vector."""
        comp = structure.composition
        els = sorted(comp.elements, key=lambda e: float(e.X or 0.0))
        fracs = np.array([comp.get_atomic_fraction(e) for e in els], dtype=np.float64)
        w = fracs / (fracs.sum() + 1e-12)

        def _r(el) -> float:
            return float(el.atomic_radius or getattr(el, "atomic_radius_calculated", None) or 1.5)

        X_v = np.array([float(e.X or 0.0) for e in els])
        Z_v = np.array([float(e.Z) for e in els])
        r_v = np.array([_r(e) for e in els])
        n = min(len(els), len(w))

        a, b, c = structure.lattice.abc
        alpha, beta, gamma = structure.lattice.angles
        fracs_pad = np.zeros(_MAX_ELEMENTS, dtype=np.float64)
        fracs_pad[: min(len(fracs), _MAX_ELEMENTS)] = fracs[: _MAX_ELEMENTS]

        return np.array([
            structure.volume / max(len(structure), 1),
            a / (b + 1e-12), b / (c + 1e-12), a / (c + 1e-12),
            alpha / 180.0, beta / 180.0, gamma / 180.0,
            float(np.dot(w[:n], X_v[:n])),
            float(np.dot(w[:n], Z_v[:n])),
            float(np.dot(w[:n], r_v[:n])),
            *fracs_pad,
        ], dtype=np.float32)


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CrystalSimilarityResult:
    """One result from CrystalSimilarityEngine."""
    material_id: str
    formula: str
    similarity_score: float       # [0.0, 1.0]
    rank: int
    crystal_system: str
    search_mode: str              # "fingerprint" | "structure_matcher"
    spacegroup: str = "unknown"


# ---------------------------------------------------------------------------
# Crystal Similarity Engine
# ---------------------------------------------------------------------------


class CrystalSimilarityEngine:
    """Ranks a corpus of pymatgen Structures by similarity to a seed.

    Parameters
    ----------
    store:
        StructureStore for raw fingerprint caching.
    """

    def __init__(self, store: StructureStore) -> None:
        self._store = store
        self._fingerprinter = CrystalFingerprinter()

    def fingerprint_search(
        self,
        seed_id: str,
        seed_structure,
        corpus: dict,           # {material_id: Structure} — may include seed
        top_k: int = 10,
    ) -> list[CrystalSimilarityResult]:
        """Fast cosine similarity over corpus-normalized 19-dim fingerprints.

        Raw fingerprints are loaded from cache or computed and stored.
        Corpus-level MinMax + row L2 normalization is always recomputed fresh
        so cached raw vectors remain valid across different corpus compositions.
        """
        corpus_ids = [mid for mid in corpus if mid != seed_id]
        all_ids = [seed_id] + corpus_ids
        all_structs = [seed_structure] + [corpus[mid] for mid in corpus_ids]

        cached = self._store.get_fingerprints_batch(all_ids)
        raw: dict[str, np.ndarray] = {}
        for i, mid in enumerate(all_ids):
            if mid in cached:
                raw[mid] = cached[mid]
            else:
                vec = self._fingerprinter.compute(all_structs[i])
                self._store.set_fingerprint(mid, vec)
                raw[mid] = vec

        raw_mat = np.stack([raw[mid] for mid in all_ids])           # (N, 19)
        lo, hi = raw_mat.min(axis=0), raw_mat.max(axis=0)
        denom = np.where((hi - lo) > 1e-8, hi - lo, 1.0)
        normed = (raw_mat - lo) / denom
        norms = np.linalg.norm(normed, axis=1, keepdims=True)
        norms = np.where(norms > 1e-8, norms, 1.0)
        fp_mat = (normed / norms).astype(np.float32)                # (N, 19) L2-normalized

        seed_vec = fp_mat[0]
        scored = [
            (float(np.clip(np.dot(seed_vec, fp_mat[i + 1]), 0.0, 1.0)), mid)
            for i, mid in enumerate(corpus_ids)
        ]
        scored.sort(reverse=True)

        return [
            CrystalSimilarityResult(
                material_id=mid, formula=corpus[mid].composition.reduced_formula,
                similarity_score=round(sc, 4), rank=rank + 1,
                crystal_system=self._crystal_system(corpus[mid]),
                search_mode="fingerprint",
                spacegroup=self._spacegroup(corpus[mid]),
            )
            for rank, (sc, mid) in enumerate(scored[:top_k])
        ]

    def matcher_search(
        self,
        seed_id: str,
        seed_structure,
        corpus: dict,
        ltol: float = 0.2,
        stol: float = 0.3,
        angle_tol: float = 5.0,
        top_k: int = 10,
    ) -> list[CrystalSimilarityResult]:
        """StructureMatcher RMS-distance similarity. Recommended corpus ≤ 30.

        Returns 1/(1+rms_dist) when structures can be mapped within tolerances;
        0.0 when mapping fails (incompatible compositions or geometries).
        """
        from pymatgen.analysis.structure_matcher import StructureMatcher  # noqa: PLC0415

        matcher = StructureMatcher(ltol=ltol, stol=stol, angle_tol=angle_tol)
        scored: list[tuple[float, str]] = []

        for mid, structure in corpus.items():
            if mid == seed_id:
                continue
            try:
                rms = matcher.get_rms_dist(seed_structure, structure)
                sc = round(1.0 / (1.0 + rms[0]), 4) if rms is not None else 0.0
            except Exception:
                sc = 0.0
            scored.append((sc, mid))

        scored.sort(reverse=True)
        return [
            CrystalSimilarityResult(
                material_id=mid, formula=corpus[mid].composition.reduced_formula,
                similarity_score=sc, rank=rank + 1,
                crystal_system=self._crystal_system(corpus[mid]),
                search_mode="structure_matcher",
                spacegroup=self._spacegroup(corpus[mid]),
            )
            for rank, (sc, mid) in enumerate(scored[:top_k])
        ]

    @staticmethod
    def _crystal_system(structure) -> str:
        try:
            from pymatgen.symmetry.analyzer import SpacegroupAnalyzer  # noqa: PLC0415
            return str(SpacegroupAnalyzer(structure, symprec=0.1).get_crystal_system())
        except Exception:
            return "unknown"

    @staticmethod
    def _spacegroup(structure) -> str:
        try:
            from pymatgen.symmetry.analyzer import SpacegroupAnalyzer  # noqa: PLC0415
            return str(SpacegroupAnalyzer(structure, symprec=0.1).get_space_group_symbol())
        except Exception:
            return "unknown"