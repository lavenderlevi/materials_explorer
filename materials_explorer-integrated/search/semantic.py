"""
AI Semantic Search engine for Materials Explorer.

Two embedding backends behind a Protocol interface:

    SentenceTransformerEmbedder  — preferred; all-MiniLM-L6-v2 (~80 MB,
                                   downloaded once and cached by HuggingFace).
    TFIDFEmbedder                — sklearn TF-IDF + TruncatedSVD fallback;
                                   no internet download; lower quality.

Caching strategy
----------------
SentenceTransformer embeddings are vocabulary-independent: a vector computed
for mp-149 on corpus A is identical on corpus B. They are persisted in SQLite
via EmbeddingStore and reused across sessions.

TF-IDF embeddings are corpus-specific (vocabulary built from the current
corpus + query). They are never persisted — always recomputed per search.

EmbeddingStore uses the same DB file as CacheStore but a separate table,
keeping concerns cleanly separated with no cross-module imports.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Protocol, runtime_checkable

import numpy as np

from .models import MaterialDocument

logger = logging.getLogger(__name__)

_ST_MODEL: Final[str] = "all-MiniLM-L6-v2"
_ST_DIM: Final[int] = 384
_TFIDF_DIM: Final[int] = 128
_ST_BACKEND: Final[str] = "sentence_transformer"
_TFIDF_BACKEND: Final[str] = "tfidf"


# ---------------------------------------------------------------------------
# Embedding Protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class EmbedderProtocol(Protocol):
    """Abstract interface over text embedding backends."""

    @property
    def backend_name(self) -> str: ...

    @property
    def is_cacheable(self) -> bool:
        """True when embeddings are corpus-independent and can be persisted."""
        ...

    def fit(self, texts: list[str]) -> None:
        """Fit on corpus; no-op for pre-trained models."""
        ...

    def embed_query(self, text: str) -> np.ndarray: ...
    def embed_batch(self, texts: list[str]) -> np.ndarray: ...


# ---------------------------------------------------------------------------
# Concrete Embedders
# ---------------------------------------------------------------------------


class SentenceTransformerEmbedder:
    """L2-normalized embeddings via all-MiniLM-L6-v2.

    Model is lazy-loaded on first use and singleton-held per instance.
    Thread-safe via double-checked locking pattern.
    """

    def __init__(self, model_name: str = _ST_MODEL) -> None:
        self._model_name = model_name
        self._model = None
        self._lock = threading.Lock()

    @property
    def backend_name(self) -> str:
        return _ST_BACKEND

    @property
    def is_cacheable(self) -> bool:
        return True

    def _load(self) -> None:
        if self._model is not None:
            return
        with self._lock:
            if self._model is not None:
                return
            try:
                from sentence_transformers import SentenceTransformer
                self._model = SentenceTransformer(self._model_name)
                logger.info("Loaded SentenceTransformer: %s", self._model_name)
            except ImportError as exc:
                raise ImportError(
                    "sentence-transformers not installed. "
                    "Run: pip install sentence-transformers"
                ) from exc

    def fit(self, texts: list[str]) -> None:  # noqa: ARG002
        self._load()

    def embed_query(self, text: str) -> np.ndarray:
        self._load()
        return np.array(
            self._model.encode(text, normalize_embeddings=True), dtype=np.float32
        )

    def embed_batch(self, texts: list[str]) -> np.ndarray:
        self._load()
        return np.array(
            self._model.encode(
                texts, normalize_embeddings=True,
                show_progress_bar=False, batch_size=32,
            ),
            dtype=np.float32,
        )


class TFIDFEmbedder:
    """TF-IDF + TruncatedSVD + L2-norm fallback. Zero internet dependency.

    IMPORTANT: must be fitted on ``corpus_descriptions + [query]`` BEFORE
    calling ``embed_query`` or ``embed_batch``, so the query terms are
    part of the TF-IDF vocabulary. Re-fitting per search is expected.

    Thread-safety note: this embedder is NOT thread-safe across concurrent
    searches because ``fit()`` mutates the sklearn pipeline. Use
    SentenceTransformerEmbedder in any multi-user production deployment.
    """

    def __init__(self, n_components: int = _TFIDF_DIM) -> None:
        from sklearn.decomposition import TruncatedSVD
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import Normalizer

        self._pipe = Pipeline([
            ("tfidf", TfidfVectorizer(
                ngram_range=(1, 2), max_features=8000, sublinear_tf=True
            )),
            ("svd", TruncatedSVD(n_components=n_components, random_state=42)),
            ("norm", Normalizer(copy=False)),
        ])
        self._fitted = False
        self._n = n_components

    @property
    def backend_name(self) -> str:
        return _TFIDF_BACKEND

    @property
    def is_cacheable(self) -> bool:
        return False  # Vocabulary-dependent; embeddings not transferable.

    def fit(self, texts: list[str]) -> None:
        self._pipe.fit(texts)
        self._fitted = True
        logger.info("TFIDFEmbedder fitted on %d texts.", len(texts))

    def embed_query(self, text: str) -> np.ndarray:
        if not self._fitted:
            raise RuntimeError("Call fit() before embed_query().")
        return self._pipe.transform([text])[0].astype(np.float32)

    def embed_batch(self, texts: list[str]) -> np.ndarray:
        if not self._fitted:
            raise RuntimeError("Call fit() before embed_batch().")
        return self._pipe.transform(texts).astype(np.float32)


# ---------------------------------------------------------------------------
# Embedding Store
# ---------------------------------------------------------------------------


class EmbeddingStore:
    """SQLite persistence for precomputed SentenceTransformer embeddings.

    Uses the same DB file as CacheStore but a dedicated ``embeddings`` table.
    Thread-safe: per-thread connections (WAL mode allows concurrent readers).
    Writes serialized under ``_write_lock``.
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
                CREATE TABLE IF NOT EXISTS embeddings (
                    material_id TEXT    NOT NULL,
                    backend     TEXT    NOT NULL,
                    vector_json TEXT    NOT NULL,
                    created_at  REAL    NOT NULL,
                    PRIMARY KEY (material_id, backend)
                );
            """)
            conn.commit()

    def get_batch(self, ids: list[str], backend: str) -> dict[str, np.ndarray]:
        """Fetch all cached vectors for *ids* in a single SQL query."""
        if not ids:
            return {}
        ph = ",".join("?" * len(ids))
        rows = self._connect().execute(
            f"SELECT material_id, vector_json FROM embeddings"
            f" WHERE backend = ? AND material_id IN ({ph})",
            [backend, *ids],
        ).fetchall()
        return {
            r["material_id"]: np.array(json.loads(r["vector_json"]), dtype=np.float32)
            for r in rows
        }

    def set_batch(self, ids: list[str], vecs: np.ndarray, backend: str) -> None:
        """Persist *vecs* for *ids* with INSERT OR REPLACE."""
        now = time.time()
        rows = [
            (mid, backend, json.dumps(vecs[i].tolist()), now)
            for i, mid in enumerate(ids)
        ]
        conn = self._connect()
        with self._write_lock:
            conn.executemany(
                "INSERT OR REPLACE INTO embeddings"
                " (material_id, backend, vector_json, created_at) VALUES (?, ?, ?, ?)",
                rows,
            )
            conn.commit()
        logger.debug("Stored %d embeddings (backend=%s).", len(ids), backend)


# ---------------------------------------------------------------------------
# Description Builder
# ---------------------------------------------------------------------------


def build_material_description(doc: MaterialDocument) -> str:
    """Construct a rich, embeddable natural-language description for *doc*.

    The description deliberately includes functional vocabulary so that
    queries like "stable battery cathode" or "wide-gap insulator for
    photovoltaics" can semantically match relevant materials even without
    exact formula or ID matching.
    """
    parts: list[str] = [doc.formula_pretty]

    if doc.elements:
        parts.append(f"contains {' '.join(doc.elements)}")
    if doc.crystal_system:
        parts.append(f"{doc.crystal_system} crystal system")
    if doc.spacegroup_symbol:
        parts.append(f"spacegroup {doc.spacegroup_symbol}")

    if doc.band_gap is not None:
        if doc.band_gap < 0.1:
            parts.append("metallic conductor near-zero band gap")
        elif doc.band_gap < 3.0:
            parts.append(f"semiconductor band gap {doc.band_gap:.2f} eV")
        else:
            parts.append(f"insulator wide band gap {doc.band_gap:.2f} eV")

    if doc.density is not None:
        parts.append(f"density {doc.density:.2f} g per cm3")
    if doc.formation_energy_per_atom is not None:
        parts.append(f"formation energy {doc.formation_energy_per_atom:.3f} eV per atom")

    parts.append("thermodynamically stable" if doc.is_stable else "metastable unstable")
    if doc.is_magnetic:
        parts.append("magnetic ferromagnetic")

    avail: list[str] = []
    if doc.completeness.has_dos:
        avail.append("density of states electronic structure")
    if doc.completeness.has_band_structure:
        avail.append("band structure")
    if doc.completeness.has_elastic:
        avail.append("elastic constants bulk modulus")
    if doc.completeness.has_phonon:
        avail.append("phonon spectrum lattice dynamics")
    if avail:
        parts.append(f"computed data available {' '.join(avail)}")

    return ". ".join(parts)


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SemanticResult:
    """A single semantic search result."""
    material: MaterialDocument
    similarity_score: float     # cosine similarity in [0.0, 1.0]
    rank: int
    description: str            # embedded text (shown in UI for transparency)


# ---------------------------------------------------------------------------
# Semantic Search Engine
# ---------------------------------------------------------------------------


class SemanticSearchEngine:
    """Ranks a MaterialDocument corpus by semantic similarity to a text query.

    Parameters
    ----------
    embedder:
        Backend to use. If ``None``, tries SentenceTransformer then TFIDF.
    store:
        SQLite embedding cache. If ``None``, opens default DB path.
    db_path:
        Used only when *store* is ``None``.
    """

    def __init__(
        self,
        embedder: EmbedderProtocol | None = None,
        store: EmbeddingStore | None = None,
        db_path: str | Path = "materials_explorer.db",
    ) -> None:
        self._store = store or EmbeddingStore(db_path)
        self._embedder: EmbedderProtocol = embedder or self._auto_select()

    @staticmethod
    def _auto_select() -> EmbedderProtocol:
        try:
            import sentence_transformers  # noqa: F401
            logger.info("Using SentenceTransformerEmbedder.")
            return SentenceTransformerEmbedder()
        except ImportError:
            logger.warning(
                "sentence-transformers not found — using TFIDFEmbedder fallback. "
                "Install with: pip install sentence-transformers"
            )
            return TFIDFEmbedder()

    def search(
        self,
        query: str,
        corpus: list[MaterialDocument],
        top_k: int = 10,
    ) -> list[SemanticResult]:
        """Rank *corpus* by cosine similarity to *query*.

        Parameters
        ----------
        query:
            Natural-language query (e.g. "stable oxide for battery cathode").
        corpus:
            Pool of MaterialDocument objects fetched from MP API.
        top_k:
            Maximum number of results to return.
        """
        if not corpus:
            return []

        descs = [build_material_description(doc) for doc in corpus]

        # TFIDF must see query + corpus together for a consistent vocabulary.
        if isinstance(self._embedder, TFIDFEmbedder):
            self._embedder.fit(descs + [query])

        corpus_matrix = self._embed_corpus(corpus, descs)   # (N, D) normalized
        query_vec = self._embedder.embed_query(query)        # (D,) normalized

        # Dot product of L2-normalized vectors = cosine similarity
        similarities: np.ndarray = corpus_matrix @ query_vec  # (N,)

        k = min(top_k, len(corpus))
        top_idx = np.argpartition(similarities, -k)[-k:]
        top_idx = top_idx[np.argsort(similarities[top_idx])[::-1]]

        return [
            SemanticResult(
                material=corpus[i],
                similarity_score=float(np.clip(similarities[i], 0.0, 1.0)),
                rank=rank + 1,
                description=descs[i],
            )
            for rank, i in enumerate(top_idx)
        ]

    def _embed_corpus(
        self, corpus: list[MaterialDocument], descs: list[str]
    ) -> np.ndarray:
        """Return embedding matrix (N, D), using SQLite cache when possible."""
        ids = [doc.material_id for doc in corpus]

        if self._embedder.is_cacheable:
            cached = self._store.get_batch(ids, self._embedder.backend_name)
            missing = [i for i, mid in enumerate(ids) if mid not in cached]

            if missing:
                new_vecs = self._embedder.embed_batch([descs[i] for i in missing])
                self._store.set_batch([ids[i] for i in missing], new_vecs,
                                      self._embedder.backend_name)
                for k, i in enumerate(missing):
                    cached[ids[i]] = new_vecs[k]
                logger.info("Computed %d new embeddings.", len(missing))

            return np.stack([cached[mid] for mid in ids])

        # TFIDF: always recompute — vocabulary is corpus-specific.
        return self._embedder.embed_batch(descs)