"""
MP API filter builder for Materials Explorer.

Optimization notes
------------------
OPT[LRU]: ``_build_filters_cached(query: ParsedQuery)`` is a module-level
          ``@lru_cache`` function. Because ``ParsedQuery`` is now fully
          hashable (frozen Pydantic + ``tuple`` fields), identical queries
          resolve in O(1) without re-running filter construction logic.

OPT[SAFE]: Returns a ``MappingProxyType`` from the cached function. Multiple
           callers share the same immutable object from the cache; accidental
           mutation raises ``TypeError`` rather than silently corrupting
           all future callers that share the cached dict reference.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from types import MappingProxyType
from typing import Any, Final

from .models import ParsedQuery, QueryIntent

logger = logging.getLogger(__name__)

_CATEGORY_FILTERS: Final[dict[str, dict[str, Any]]] = {
    "semiconductor":  {"band_gap":          (0.1, 3.0)},
    "metal":          {"band_gap":          (None, 0.1)},
    "conductor":      {"band_gap":          (None, 0.1)},
    "insulator":      {"band_gap":          (3.0, None)},
    "photovoltaic":   {"band_gap":          (0.9, 2.5)},
    "2d_material":    {"nsites":            (1, 10)},
    "oxide":          {"elements":          ["O"]},
    "nitride":        {"elements":          ["N"]},
    "carbide":        {"elements":          ["C"]},
    "spinel":         {"elements":          ["O"]},
    "perovskite":     {"elements":          ["O"]},
    "battery":        {"energy_above_hull": (None, 0.1)},
    # No reliable mp-api parameter — ApplicationRelevanceScorer handles these:
    "magnetic":       {},
    "superconductor": {},
    "thermoelectric": {},
    "piezoelectric":  {},
    "topological":    {},
}

_FIELD_TO_MPAPI: Final[dict[str, str]] = {
    "band_gap":                  "band_gap",
    "density":                   "density",
    "energy_above_hull":         "energy_above_hull",
    "formation_energy_per_atom": "formation_energy_per_atom",
    "volume":                    "volume",
    "nsites":                    "nsites",
}


# OPT[LRU]: Module-level cached filter builder. Key: ParsedQuery (fully hashable).
# Returns MappingProxyType so the cached object cannot be mutated by callers.
@lru_cache(maxsize=256)
def _build_filters_cached(query: ParsedQuery) -> MappingProxyType:
    """Build mp-api filter kwargs from *query* (cached, immutable result)."""
    filters: dict[str, Any] = {}

    # Step 1 — Category defaults
    if query.category:
        cat_kw = _CATEGORY_FILTERS.get(query.category, {})
        filters.update(cat_kw)
        if cat_kw:
            logger.debug("Category '%s' → %s", query.category, cat_kw)
        else:
            logger.debug("Category '%s' has no direct mp-api filter.", query.category)

    # Step 2 — User property filters (range intersection)
    for pf in query.property_filters:
        mp_field = _FIELD_TO_MPAPI.get(pf.field, pf.field)
        new_range = pf.to_mp_range()
        existing = filters.get(mp_field)
        if existing is not None and isinstance(existing, tuple) and len(existing) == 2:
            filters[mp_field] = _intersect_ranges(existing, new_range, mp_field)
        else:
            filters[mp_field] = new_range

    # Step 3 — Stability hard constraint (domain rule: eah ≤ 0)
    if query.stability_required:
        current = filters.get("energy_above_hull")
        if current is None:
            filters["energy_above_hull"] = (None, 0.0)
        else:
            lo, hi = current
            tighter_hi = min(hi, 0.0) if hi is not None else 0.0
            filters["energy_above_hull"] = (lo, tighter_hi)
        logger.debug("Stability applied: energy_above_hull → %s",
                     filters["energy_above_hull"])

    # Step 4 — Formula passthrough for MIXED queries
    if query.formula and query.intent == QueryIntent.MIXED:
        filters["formula"] = query.formula

    _validate_ranges(filters)
    # OPT[SAFE]: Wrap in MappingProxyType — shared cached object is read-only.
    return MappingProxyType(filters)


def _intersect_ranges(
    existing: tuple[float | None, float | None],
    incoming: tuple[float | None, float | None],
    field: str,
) -> tuple[float | None, float | None]:
    """Return the tighter (intersected) ``(lo, hi)`` range."""
    ex_lo, ex_hi = existing
    in_lo, in_hi = incoming
    lowers = [v for v in (ex_lo, in_lo) if v is not None]
    uppers = [v for v in (ex_hi, in_hi) if v is not None]
    result: tuple[float | None, float | None] = (
        max(lowers) if lowers else None,
        min(uppers) if uppers else None,
    )
    logger.debug("Range intersect %s: %s ∩ %s → %s", field, existing, incoming, result)
    return result


def _validate_ranges(filters: dict[str, Any]) -> None:
    """Log a warning for any inverted (lo > hi) range — indicates contradictory filters."""
    for field, value in filters.items():
        if isinstance(value, tuple) and len(value) == 2:
            lo, hi = value
            if lo is not None and hi is not None and lo > hi:
                logger.warning(
                    "Contradictory filter for '%s': lo=%.4f > hi=%.4f. "
                    "This will return zero results from mp-api.", field, lo, hi
                )


class FilterBuilder:
    """Translates a ``ParsedQuery`` into ``MPRester.materials.summary.search()`` kwargs.

    Implements ``FilterBuilderProtocol`` via structural subtyping. Stateless
    and safe to use as a singleton. ``build()`` delegates entirely to the
    module-level ``@lru_cache`` function — instance method retained for
    Protocol compatibility.
    """

    def build(self, query: ParsedQuery) -> dict[str, Any]:
        """Return mp-api filter kwargs for *query*.

        OPT[LRU]: Delegates to ``_build_filters_cached``. Cache hit returns
        the shared ``MappingProxyType`` in O(1). ``**unpacking`` of a
        ``MappingProxyType`` is supported natively by Python.
        """
        return _build_filters_cached(query)  # type: ignore[return-value]