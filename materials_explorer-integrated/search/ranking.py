"""
Ranking engine for the Materials Explorer search pipeline.

Optimization notes
------------------
OPT[SQL]: ``RankingEngine.rank`` calls ``get_search_counts_batch`` ONCE for
          the entire result set (one SQL ``WHERE material_id IN (…)`` query)
          instead of calling ``get_search_count`` N times individually.
          For 20 results this is 20 round-trips → 1 round-trip.

OPT[HASH]: ``_score_document`` now receives the pre-fetched ``count: int``
           directly — it is a pure CPU function with no I/O dependency,
           making it straightforward to unit-test with zero mocking.
"""

from __future__ import annotations

import logging
import math
from typing import Protocol, runtime_checkable

from .models import (
    MaterialDocument, ParsedQuery, QueryIntent,
    RankedResult, ScoreBreakdown,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Dependency Protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class PopularityFetcherProtocol(Protocol):
    """Read-only interface over the SQLite search-frequency store."""

    def get_search_count(self, material_id: str) -> int: ...
    def get_max_search_count(self) -> int: ...
    # OPT[SQL]: Batch method — single SQL query for N materials.
    def get_search_counts_batch(self, material_ids: list[str]) -> dict[str, int]: ...


# ---------------------------------------------------------------------------
# Null implementation
# ---------------------------------------------------------------------------


class NullPopularityFetcher:
    """No-op fetcher used when SQLite is unavailable (tests, first run)."""

    def get_search_count(self, material_id: str) -> int:  # noqa: ARG002
        return 0

    def get_max_search_count(self) -> int:
        return 1  # Prevents ZeroDivisionError in log-normalisation.

    # OPT[SQL]: No-op batch — consistent interface with SQLitePopularityFetcher.
    def get_search_counts_batch(self, material_ids: list[str]) -> dict[str, int]:  # noqa: ARG002
        return {}


# ---------------------------------------------------------------------------
# Component scorers (stateless; one reason to change each)
# ---------------------------------------------------------------------------


class StabilityScorer:
    """Exponential-decay stability score.

    ``eah ≤ 0``    → 1.0  (on the convex hull)
    ``eah is None``→ 0.30 (unknown; penalised below verified-unstable midpoint)
    ``eah > 0``    → ``exp(−5 · eah)``

    Calibration: eah=0.05 → 0.78 | eah=0.10 → 0.61 | eah=0.20 → 0.37
    """

    _K: float = 5.0
    _UNKNOWN: float = 0.30

    def score(self, material: MaterialDocument) -> float:
        eah = material.energy_above_hull
        if eah is None:
            return self._UNKNOWN
        if eah <= 0.0:
            return 1.0
        # OPT[CPU]: math.exp is a single C-level call; no branching overhead.
        return round(math.exp(-self._K * eah), 4)


class CompletenessScorer:
    """Returns ``CompletenessFlags.score`` — now a precomputed O(1) field."""

    def score(self, material: MaterialDocument) -> float:
        # OPT[HASH]: _precomputed_score set by model_validator at construction.
        return material.completeness.score


class ExactMatchScorer:
    """Measures how closely the result matches the user's identity query."""

    _NEUTRAL: float = 0.50

    def score(self, material: MaterialDocument, query: ParsedQuery) -> float:
        intent = query.intent

        if intent == QueryIntent.MATERIAL_ID:
            if query.material_id:
                return 1.0 if material.material_id.lower() == query.material_id.lower() else 0.0
            return 0.0

        if intent == QueryIntent.FORMULA:
            if not query.formula:
                return 0.0
            if material.formula_pretty.lower() == query.formula.lower():
                return 1.0
            if query.formula.lower() in material.formula_pretty.lower():
                return 0.55
            return 0.0

        if intent == QueryIntent.MATERIAL_NAME:
            if material.common_name and query.material_name:
                return (
                    1.0 if material.common_name.lower() == query.material_name.lower()
                    else 0.70
                )
            return 0.45

        return self._NEUTRAL  # CATEGORY, PROPERTY_QUERY, MIXED


class ApplicationRelevanceScorer:
    """Semantic alignment between material properties and query intent."""

    _SC_LOW: float = 0.1
    _SC_HIGH: float = 3.0
    _METAL_THRESHOLD: float = 0.1

    def score(self, material: MaterialDocument, query: ParsedQuery) -> float:
        cat = query.category
        bg = material.band_gap

        if cat == "semiconductor":
            if bg is None:
                return 0.40
            if self._SC_LOW <= bg <= self._SC_HIGH:
                return 1.0
            dist = min(abs(bg - self._SC_LOW), abs(bg - self._SC_HIGH))
            return max(0.0, round(1.0 - dist * 0.5, 4))

        if cat in ("metal", "conductor"):
            if bg is None:
                return 0.40
            return 1.0 if bg <= self._METAL_THRESHOLD else max(0.0, round(1.0 - bg * 0.30, 4))

        if cat == "insulator":
            if bg is None:
                return 0.40
            return 1.0 if bg >= self._SC_HIGH else max(0.0, round(bg / self._SC_HIGH, 4))

        if cat == "magnetic":
            return 1.0 if material.is_magnetic else 0.10

        if cat in ("battery", "photovoltaic", "thermoelectric", "piezoelectric"):
            return 0.80 if (material.completeness.has_dos or material.completeness.has_elastic) else 0.40

        if cat in ("oxide", "nitride", "carbide"):
            target = {"oxide": "O", "nitride": "N", "carbide": "C"}[cat]
            return 0.85 if target in material.elements else 0.50

        if cat in ("perovskite", "spinel"):
            return 0.85 if "O" in material.elements else 0.50

        if query.stability_required and material.is_stable:
            return 0.90

        return 0.50


# ---------------------------------------------------------------------------
# Popularity normaliser
# ---------------------------------------------------------------------------


class PopularityNormaliser:
    """Log-normalises raw SQLite search counts to [0.0, 1.0]."""

    def normalise(self, count: int, max_count: int) -> float:
        safe_max = max(max_count, 1)
        return round(math.log1p(count) / math.log1p(safe_max), 4)


# ---------------------------------------------------------------------------
# Ranking Engine
# ---------------------------------------------------------------------------


class RankingEngine:
    """Scores and sorts ``MaterialDocument`` objects for a given ``ParsedQuery``.

    Implements ``RankingEngineProtocol`` via structural subtyping.
    """

    def __init__(
        self, popularity_fetcher: PopularityFetcherProtocol | None = None
    ) -> None:
        self._popularity = popularity_fetcher or NullPopularityFetcher()
        self._normaliser = PopularityNormaliser()
        self._stability = StabilityScorer()
        self._completeness = CompletenessScorer()
        self._exact_match = ExactMatchScorer()
        self._relevance = ApplicationRelevanceScorer()

    def rank(
        self, docs: list[MaterialDocument], query: ParsedQuery
    ) -> list[RankedResult]:
        """Score all docs and return them sorted best-first.

        OPT[SQL]: Fetches ALL popularity counts in ONE batch SQL query.
        Previous implementation called ``get_search_count`` individually
        for each document — N round-trips to SQLite for N results.
        """
        if not docs:
            return []

        max_count = self._popularity.get_max_search_count()

        # OPT[SQL]: Single SQL WHERE IN query → dict[material_id, count].
        ids = [doc.material_id for doc in docs]
        counts: dict[str, int] = self._popularity.get_search_counts_batch(ids)

        scored: list[RankedResult] = [
            self._score_document(doc, query, counts.get(doc.material_id, 0), max_count)
            for doc in docs
        ]
        scored.sort(key=lambda r: r.total_score, reverse=True)

        # Timsort is stable; model_copy is a shallow Pydantic dict-update — O(n).
        return [
            result.model_copy(update={"rank": rank})
            for rank, result in enumerate(scored, start=1)
        ]

    def _score_document(
        self,
        doc: MaterialDocument,
        query: ParsedQuery,
        count: int,        # OPT[SQL]: pre-fetched; no per-doc I/O call.
        max_count: int,
    ) -> RankedResult:
        """Pure CPU function — compute ``ScoreBreakdown`` for one document."""
        breakdown = ScoreBreakdown(
            stability=self._stability.score(doc),
            completeness=self._completeness.score(doc),
            exact_match=self._exact_match.score(doc, query),
            popularity=self._normaliser.normalise(count, max_count),
            application_relevance=self._relevance.score(doc, query),
        )
        logger.debug(
            "%s S=%.2f C=%.2f EM=%.2f P=%.2f AR=%.2f → %.1f",
            doc.material_id, breakdown.stability, breakdown.completeness,
            breakdown.exact_match, breakdown.popularity,
            breakdown.application_relevance, breakdown.total,
        )
        return RankedResult(
            material=doc, score_breakdown=breakdown,
            total_score=breakdown.total, rank=1,  # overwritten post-sort
        )