"""
Recommendation Engine for Materials Explorer.

Content-based filtering: the user specifies PropertyRequirement objects
(target value + acceptable range + importance weight) and optional
categorical hard constraints. RecommendationEngine scores a corpus of
MaterialDocuments and returns ranked RecommendationResults.

Scoring model
-------------
For each numeric requirement:
    - score = 1.0                              if material value in [lo, hi]
    - score = exp(−5 · normalized_distance)   if outside range

Hard constraints (stability, completeness flags) zero out the total score
for violating materials — they are still returned for transparency but
sorted to the bottom.

Final score = weighted_avg(requirement_scores) × 100, in [0.0, 100.0].
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Final

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from .models import MaterialDocument

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Domain constants — used by UI pages for slider bounds
# ---------------------------------------------------------------------------

PROPERTY_META: Final[dict[str, dict]] = {
    "band_gap": {
        "label": "Band Gap (eV)", "unit": "eV",
        "min": 0.0, "max": 10.0, "step": 0.1,
        "default_target": 1.5, "default_lo": 0.5, "default_hi": 3.0,
    },
    "density": {
        "label": "Density (g/cm³)", "unit": "g/cm³",
        "min": 0.5, "max": 25.0, "step": 0.5,
        "default_target": 5.0, "default_lo": 2.0, "default_hi": 10.0,
    },
    "formation_energy_per_atom": {
        "label": "Formation Energy (eV/atom)", "unit": "eV/atom",
        "min": -5.0, "max": 2.0, "step": 0.1,
        "default_target": -1.0, "default_lo": -3.0, "default_hi": 0.0,
    },
    "energy_above_hull": {
        "label": "E above Hull (eV/atom)", "unit": "eV/atom",
        "min": 0.0, "max": 1.0, "step": 0.01,
        "default_target": 0.0, "default_lo": 0.0, "default_hi": 0.1,
    },
    "volume": {
        "label": "Volume (Å³)", "unit": "Å³",
        "min": 5.0, "max": 500.0, "step": 5.0,
        "default_target": 50.0, "default_lo": 20.0, "default_hi": 150.0,
    },
}

_DECAY_K: Final[float] = 5.0


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


class PropertyRequirement(BaseModel):
    """Target specification for one numeric material property.

    All fields are frozen — requirements are constructed once per search
    and must not be mutated during scoring.
    """

    model_config = ConfigDict(frozen=True)

    field: str = Field(description="mp-api field name; must be a key of PROPERTY_META.")
    target: float = Field(description="Ideal value for this property.")
    lo: float | None = Field(default=None, description="Acceptable range lower bound.")
    hi: float | None = Field(default=None, description="Acceptable range upper bound.")
    importance: float = Field(default=5.0, ge=1.0, le=10.0,
                              description="Relative weight [1, 10].")


@dataclass
class CategoryRequirements:
    """Hard categorical constraints. Violations zero out the total score."""
    stability_required: bool = False
    require_dos: bool = False
    require_band_structure: bool = False
    require_elastic: bool = False
    require_phonon: bool = False


@dataclass
class PropertyScore:
    """Match score for one PropertyRequirement on one material."""
    field: str
    label: str
    material_value: float | None
    target: float
    raw_score: float        # [0.0, 1.0]
    weighted_score: float   # raw_score × normalized_importance
    in_range: bool


@dataclass
class RecommendationResult:
    """A single recommendation with full per-property score breakdown."""
    material: MaterialDocument
    total_score: float              # [0.0, 100.0]
    property_scores: list[PropertyScore]
    hard_constraints_met: bool
    rank: int = 0                   # assigned after sort


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


class _CorpusStats:
    """Per-corpus MinMax bounds for normalizing property values.

    Bounds are computed from the fetched corpus — not global MP statistics —
    so scores reflect relative quality within the search result set.
    """

    def __init__(self, corpus: list[MaterialDocument]) -> None:
        self._bounds: dict[str, tuple[float, float]] = {}
        for field in PROPERTY_META:
            vals = [v for d in corpus if (v := getattr(d, field, None)) is not None]
            if vals:
                lo, hi = min(vals), max(vals)
                self._bounds[field] = (lo, hi if hi > lo else lo + 1e-8)
            else:
                self._bounds[field] = (0.0, 1.0)

    def normalize(self, field: str, value: float) -> float:
        lo, hi = self._bounds.get(field, (0.0, 1.0))
        return float(np.clip((value - lo) / (hi - lo), 0.0, 1.0))


class RequirementScorer:
    """Scores one MaterialDocument against one PropertyRequirement.

    Scoring rules (applied in order):
    1. material_value is None → 0.0 (missing data penalized fully).
    2. value in [lo, hi]      → 1.0 (perfect match).
    3. value outside range    → exp(−5 · normalized_distance_from_nearest_bound).
    """

    def score(
        self,
        doc: MaterialDocument,
        req: PropertyRequirement,
        stats: _CorpusStats,
    ) -> PropertyScore:
        label = PROPERTY_META.get(req.field, {}).get("label", req.field)
        raw_val: float | None = getattr(doc, req.field, None)

        if raw_val is None:
            return PropertyScore(
                field=req.field, label=label, material_value=None,
                target=req.target, raw_score=0.0, weighted_score=0.0, in_range=False,
            )

        norm_val = stats.normalize(req.field, raw_val)
        norm_lo = stats.normalize(req.field, req.lo) if req.lo is not None else None
        norm_hi = stats.normalize(req.field, req.hi) if req.hi is not None else None

        in_range = (
            (norm_lo is None or norm_val >= norm_lo)
            and (norm_hi is None or norm_val <= norm_hi)
        )

        if in_range:
            raw_score = 1.0
        else:
            # Clamp to nearest bound, compute normalized distance from it.
            clamped = norm_val
            if norm_lo is not None:
                clamped = max(clamped, norm_lo)
            if norm_hi is not None:
                clamped = min(clamped, norm_hi)
            raw_score = math.exp(-_DECAY_K * abs(norm_val - clamped))

        return PropertyScore(
            field=req.field, label=label, material_value=raw_val,
            target=req.target,
            raw_score=round(raw_score, 4),
            weighted_score=round(raw_score * req.importance, 4),
            in_range=in_range,
        )


# ---------------------------------------------------------------------------
# Public engine
# ---------------------------------------------------------------------------


class RecommendationEngine:
    """Ranks a corpus of MaterialDocuments against user-defined requirements.

    Parameters
    ----------
    requirements:
        At least one PropertyRequirement. Importance weights are normalized
        internally to sum-to-1, so the 1–10 scale is relative.
    categorical:
        Hard categorical constraints. Violating materials receive
        ``total_score = 0.0`` regardless of numeric property scores.
    """

    def __init__(
        self,
        requirements: list[PropertyRequirement],
        categorical: CategoryRequirements | None = None,
    ) -> None:
        if not requirements:
            raise ValueError("At least one PropertyRequirement is required.")
        self._reqs = requirements
        self._cat = categorical or CategoryRequirements()
        total_imp = sum(r.importance for r in requirements)
        # Normalized weights: sum to 1.0 so final score is a true weighted average.
        self._norm_weights: dict[str, float] = {
            r.field: r.importance / total_imp for r in requirements
        }

    def recommend(
        self,
        corpus: list[MaterialDocument],
        top_k: int = 10,
    ) -> list[RecommendationResult]:
        """Score and rank *corpus* against requirements, returning top-*k*.

        Hard-constraint violators receive score 0.0 and sort to the bottom.
        They are included in results (up to top_k) for user transparency.

        Parameters
        ----------
        corpus:
            Pool of MaterialDocuments from the MP API search.
        top_k:
            Maximum results to return. Capped at ``len(corpus)``.
        """
        if not corpus:
            return []

        stats = _CorpusStats(corpus)
        scorer = RequirementScorer()
        unsorted: list[RecommendationResult] = []

        for doc in corpus:
            hard_ok = self._check_hard_constraints(doc)
            pscores = [scorer.score(doc, req, stats) for req in self._reqs]

            if hard_ok:
                weighted_sum = sum(
                    ps.raw_score * self._norm_weights[ps.field] for ps in pscores
                )
                total = round(weighted_sum * 100.0, 2)
            else:
                total = 0.0

            unsorted.append(RecommendationResult(
                material=doc, total_score=total,
                property_scores=pscores, hard_constraints_met=hard_ok,
            ))

        unsorted.sort(key=lambda r: r.total_score, reverse=True)
        top = unsorted[:top_k]
        for i, r in enumerate(top):
            r.rank = i + 1
        return top

    def _check_hard_constraints(self, doc: MaterialDocument) -> bool:
        """Return False if any hard constraint is violated."""
        c, cp = self._cat, doc.completeness
        checks: list[tuple[bool, bool]] = [
            (c.stability_required, doc.is_stable),
            (c.require_dos, cp.has_dos),
            (c.require_band_structure, cp.has_band_structure),
            (c.require_elastic, cp.has_elastic),
            (c.require_phonon, cp.has_phonon),
        ]
        return all(not required or available for required, available in checks)