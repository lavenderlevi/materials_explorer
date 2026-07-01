"""
Similar Materials Engine for Materials Explorer.

Approach: MinMax-normalized numeric feature vector over 7 physical properties.
None values are imputed with column means (not dropped) so every material
in the corpus has a valid vector for distance computation.

Three metrics:
    COSINE          — angle-based; scale-invariant.
    EUCLIDEAN       — Euclidean distance converted to similarity.
    WEIGHTED_COSINE — domain-tuned weights (default; recommended).

Feature weights for WEIGHTED_COSINE:
    band_gap (0.25) · formation_energy_per_atom (0.20) · energy_above_hull (0.20)
    density (0.15)  · volume (0.10) · nsites (0.05)   · nelements (0.05)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Final

import numpy as np

from .models import MaterialDocument

logger = logging.getLogger(__name__)

_FEATURES: Final[list[str]] = [
    "band_gap", "density", "formation_energy_per_atom",
    "energy_above_hull", "volume", "nsites", "nelements",
]

_WEIGHTS: Final[np.ndarray] = np.array(
    [0.25, 0.15, 0.20, 0.20, 0.10, 0.05, 0.05], dtype=np.float32
)
assert len(_WEIGHTS) == len(_FEATURES), "Weight/feature count mismatch."


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------


class SimilarityMetric(str, Enum):
    COSINE = "cosine"
    EUCLIDEAN = "euclidean"
    WEIGHTED_COSINE = "weighted_cosine"


@dataclass(frozen=True)
class FeatureDiff:
    """Normalized difference in one feature between seed and candidate."""
    feature: str
    seed_value: float | None
    candidate_value: float | None
    normalized_diff: float          # |seed_norm - candidate_norm| in [0.0, 1.0]
    match_pct: float                # 1.0 - normalized_diff, for display


@dataclass(frozen=True)
class SimilarMaterial:
    """One result from SimilarMaterialsEngine."""
    material: MaterialDocument
    similarity_score: float         # [0.0, 1.0] — higher is more similar
    rank: int
    feature_diffs: tuple[FeatureDiff, ...]   # per-feature explainability


# ---------------------------------------------------------------------------
# Feature Extractor
# ---------------------------------------------------------------------------


class FeatureExtractor:
    """MinMax-normalizes numeric features from MaterialDocuments.

    Fit-then-transform pattern matches sklearn convention.
    Column-mean imputation for None values is applied before scaling,
    so every document produces a valid, bounded [0, 1] feature vector.
    """

    def __init__(self) -> None:
        self._min: np.ndarray | None = None
        self._max: np.ndarray | None = None
        self._means: np.ndarray | None = None
        self._fitted = False

    def _extract_raw(self, doc: MaterialDocument) -> list[float | None]:
        return [
            doc.band_gap,
            doc.density,
            doc.formation_energy_per_atom,
            doc.energy_above_hull,
            doc.volume,
            float(doc.nsites) if doc.nsites is not None else None,
            float(doc.nelements) if doc.nelements is not None else None,
        ]

    def fit(self, corpus: list[MaterialDocument]) -> "FeatureExtractor":
        """Compute MinMax bounds and column means from *corpus*."""
        n, k = len(corpus), len(_FEATURES)
        mat = np.full((n, k), np.nan, dtype=np.float64)

        for i, doc in enumerate(corpus):
            for j, v in enumerate(self._extract_raw(doc)):
                if v is not None:
                    mat[i, j] = v

        col_means = np.nanmean(mat, axis=0)
        self._means = np.where(np.isnan(col_means), 0.0, col_means)

        for j in range(k):
            mat[np.isnan(mat[:, j]), j] = self._means[j]

        self._min = mat.min(axis=0)
        self._max = mat.max(axis=0)
        self._fitted = True
        return self

    def transform(self, doc: MaterialDocument) -> np.ndarray:
        """Return a [0, 1]-clipped normalized feature vector for *doc*. Shape: (k,)"""
        if not self._fitted:
            raise RuntimeError("Call fit() before transform().")
        raw = np.array(
            [v if v is not None else self._means[j]
             for j, v in enumerate(self._extract_raw(doc))],
            dtype=np.float64,
        )
        denom = self._max - self._min
        denom = np.where(denom < 1e-8, 1.0, denom)
        return np.clip((raw - self._min) / denom, 0.0, 1.0).astype(np.float32)

    def raw_values(self, doc: MaterialDocument) -> list[float | None]:
        return self._extract_raw(doc)


# ---------------------------------------------------------------------------
# Metric functions
# ---------------------------------------------------------------------------


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    return float(np.dot(a, b) / (na * nb)) if na > 1e-8 and nb > 1e-8 else 0.0


def _euclidean(a: np.ndarray, b: np.ndarray) -> float:
    return float(1.0 / (1.0 + np.linalg.norm(a - b)))


def _weighted_cosine(a: np.ndarray, b: np.ndarray) -> float:
    return _cosine(a * _WEIGHTS, b * _WEIGHTS)


_METRIC_FNS = {
    SimilarityMetric.COSINE: _cosine,
    SimilarityMetric.EUCLIDEAN: _euclidean,
    SimilarityMetric.WEIGHTED_COSINE: _weighted_cosine,
}


# ---------------------------------------------------------------------------
# Similar Materials Engine
# ---------------------------------------------------------------------------


class SimilarMaterialsEngine:
    """Finds materials numerically similar to a seed MaterialDocument.

    Parameters
    ----------
    metric:
        ``WEIGHTED_COSINE`` (default) applies domain-tuned feature weights.
    """

    def __init__(self, metric: SimilarityMetric = SimilarityMetric.WEIGHTED_COSINE) -> None:
        self._metric = metric
        self._fn = _METRIC_FNS[metric]

    def find_similar(
        self,
        seed: MaterialDocument,
        corpus: list[MaterialDocument],
        top_k: int = 10,
        exclude_seed: bool = True,
    ) -> list[SimilarMaterial]:
        """Return the top-*k* most similar materials to *seed* from *corpus*.

        Parameters
        ----------
        seed:
            Reference material. Its feature vector is the query.
        corpus:
            Candidate pool — typically a broad same-element-system MP fetch.
        top_k:
            Maximum results. Capped at ``len(corpus)``.
        exclude_seed:
            Exclude the seed from candidates to avoid trivial 100% self-match.
        """
        candidates = [
            d for d in corpus
            if not (exclude_seed and d.material_id == seed.material_id)
        ]
        if not candidates:
            return []

        ex = FeatureExtractor().fit([seed] + candidates)
        seed_vec = ex.transform(seed)
        seed_raw = ex.raw_values(seed)

        # Score all candidates — FeatureExtractor is already fitted.
        scored: list[tuple[float, MaterialDocument, np.ndarray]] = []
        for doc in candidates:
            vec = ex.transform(doc)
            scored.append((self._fn(seed_vec, vec), doc, vec))
        scored.sort(key=lambda x: x[0], reverse=True)

        results: list[SimilarMaterial] = []
        for rank, (score, doc, vec) in enumerate(scored[:top_k], start=1):
            cand_raw = ex.raw_values(doc)
            nd = [abs(float(seed_vec[j]) - float(vec[j])) for j in range(len(_FEATURES))]
            diffs = tuple(
                FeatureDiff(
                    feature=_FEATURES[j],
                    seed_value=seed_raw[j],
                    candidate_value=cand_raw[j],
                    normalized_diff=round(nd[j], 4),
                    match_pct=round(1.0 - nd[j], 4),
                )
                for j in range(len(_FEATURES))
            )
            results.append(SimilarMaterial(
                material=doc,
                similarity_score=round(score, 4),
                rank=rank,
                feature_diffs=diffs,
            ))
        return results