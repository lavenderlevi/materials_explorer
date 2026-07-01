"""
Search engine and Strategy pattern for Materials Explorer.

Optimization notes
------------------
OPT[LRU]: ``_resolve_formula_cached(name, score_cutoff)`` is a module-level
          ``@lru_cache`` function. RapidFuzz ``WRatio`` fuzzy matching is
          O(n·k) over the name DB. After the first lookup, identical names
          resolve in O(1). The cache is process-scoped and persists across
          Streamlit reruns when ``SearchEngine`` is held by
          ``@st.cache_resource``.
"""

from __future__ import annotations

import logging
import time
from abc import ABC, abstractmethod
from functools import lru_cache
from typing import Protocol, runtime_checkable

from rapidfuzz import fuzz
from rapidfuzz import process as fuzz_process

from .models import (
    MaterialDocument, ParsedQuery, QueryIntent,
    RankedResult, SearchResponse, SUMMARY_FIELDS,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Dependency Protocols
# ---------------------------------------------------------------------------


@runtime_checkable
class MPClientProtocol(Protocol):
    last_cache_hit: bool

    def get_by_id(self, material_id: str, fields: list[str]) -> MaterialDocument | None: ...
    def search(self, fields: list[str], **filters: object) -> list[MaterialDocument]: ...


@runtime_checkable
class RankingEngineProtocol(Protocol):
    def rank(self, docs: list[MaterialDocument], query: ParsedQuery) -> list[RankedResult]: ...


@runtime_checkable
class FilterBuilderProtocol(Protocol):
    def build(self, query: ParsedQuery) -> dict[str, object]: ...


# ---------------------------------------------------------------------------
# Name database
# ---------------------------------------------------------------------------

_NAME_DB: dict[str, str] = {
    "silicon": "Si",          "iron": "Fe",            "copper": "Cu",
    "aluminum": "Al",         "aluminium": "Al",        "gold": "Au",
    "silver": "Ag",           "nickel": "Ni",           "cobalt": "Co",
    "titanium": "Ti",         "zinc": "Zn",             "tin": "Sn",
    "lead": "Pb",             "chromium": "Cr",         "manganese": "Mn",
    "magnesium": "Mg",        "calcium": "Ca",          "carbon": "C",
    "graphite": "C",          "diamond": "C",           "sulfur": "S",
    "germanium": "Ge",        "gallium arsenide": "GaAs","indium phosphide": "InP",
    "gallium nitride": "GaN", "indium arsenide": "InAs","water": "H2O",
    "iron oxide": "Fe2O3",    "hematite": "Fe2O3",      "magnetite": "Fe3O4",
    "alumina": "Al2O3",       "silica": "SiO2",         "quartz": "SiO2",
    "zinc oxide": "ZnO",      "titania": "TiO2",        "titanium dioxide": "TiO2",
    "rutile": "TiO2",         "copper oxide": "CuO",    "cuprite": "Cu2O",
    "nickel oxide": "NiO",    "manganese dioxide": "MnO2","salt": "NaCl",
    "sodium chloride": "NaCl","calcite": "CaCO3",       "pyrite": "FeS2",
    "galena": "PbS",          "fluorite": "CaF2",
    "lithium iron phosphate": "LiFePO4", "lfp": "LiFePO4",
    "lithium cobalt oxide": "LiCoO2",    "lco": "LiCoO2",
    "lithium manganese oxide": "LiMn2O4","lithium oxide": "Li2O",
    "silicon carbide": "SiC", "boron nitride": "BN",
    "magnesium diboride": "MgB2",        "tungsten carbide": "WC",
}

# Freeze the keys view for fast O(1) membership in the LRU function below.
_NAME_DB_KEYS: tuple[str, ...] = tuple(_NAME_DB.keys())


# OPT[LRU]: Module-level cached name resolver. Key: (name, score_cutoff).
# All instances of MaterialNameStrategy with the same cutoff share one cache.
@lru_cache(maxsize=256)
def _resolve_formula_cached(name: str, score_cutoff: float) -> str | None:
    """Return resolved formula for *name*, or ``None`` on no match."""
    name_lower = name.lower().strip()
    if name_lower in _NAME_DB:
        logger.debug("Exact name hit: %r -> %r", name_lower, _NAME_DB[name_lower])
        return _NAME_DB[name_lower]
    hits = fuzz_process.extract(
        name_lower, _NAME_DB_KEYS, scorer=fuzz.WRatio,
        limit=3, score_cutoff=score_cutoff,
    )
    if not hits:
        logger.info("No name match for %r (cutoff=%.0f)", name, score_cutoff)
        return None
    best_name, best_score, _ = hits[0]
    logger.debug("Fuzzy name hit: %r -> %r (score=%.1f)", name_lower, best_name, best_score)
    return _NAME_DB[best_name]


# ---------------------------------------------------------------------------
# Abstract Strategy Base
# ---------------------------------------------------------------------------


class SearchStrategy(ABC):
    """Abstract base for all search strategies (Strategy pattern)."""

    @abstractmethod
    def execute(self, query: ParsedQuery, client: MPClientProtocol) -> list[MaterialDocument]:
        """Run the strategy and return unranked ``MaterialDocument`` objects."""


# ---------------------------------------------------------------------------
# Concrete Strategies
# ---------------------------------------------------------------------------


class MaterialIDStrategy(SearchStrategy):
    """Direct lookup by Materials Project ID (e.g. ``'mp-149'``)."""

    def execute(self, query: ParsedQuery, client: MPClientProtocol) -> list[MaterialDocument]:
        if not query.material_id:
            logger.warning("MaterialIDStrategy invoked without material_id. Query: %r",
                           query.raw_query)
            return []
        doc = client.get_by_id(query.material_id, fields=SUMMARY_FIELDS)
        return [doc] if doc is not None else []


class MaterialNameStrategy(SearchStrategy):
    """Resolves a common material name via ``_resolve_formula_cached`` + FormulaStrategy."""

    _DEFAULT_SCORE_CUTOFF: float = 72.0

    def __init__(
        self,
        name_db: dict[str, str] | None = None,
        score_cutoff: float = _DEFAULT_SCORE_CUTOFF,
    ) -> None:
        # OPT[LRU]: custom name_db not cacheable via module-level function;
        # if provided, falls back to per-call resolution. Default db uses cache.
        self._custom_db = name_db
        self._score_cutoff = score_cutoff
        self._formula_strategy = FormulaStrategy()

    def _resolve_formula(self, name: str) -> str | None:
        if self._custom_db is not None:
            # Test-injected DB — bypass module-level cache (different data).
            name_lower = name.lower().strip()
            if name_lower in self._custom_db:
                return self._custom_db[name_lower]
            hits = fuzz_process.extract(
                name_lower, self._custom_db.keys(), scorer=fuzz.WRatio,
                limit=1, score_cutoff=self._score_cutoff,
            )
            return self._custom_db[hits[0][0]] if hits else None
        # OPT[LRU]: cached resolution for the default name DB.
        return _resolve_formula_cached(name, self._score_cutoff)

    def execute(self, query: ParsedQuery, client: MPClientProtocol) -> list[MaterialDocument]:
        if not query.material_name:
            return []
        resolved_formula = self._resolve_formula(query.material_name)
        if resolved_formula is None:
            return []
        formula_query = query.model_copy(update={"formula": resolved_formula})
        docs = self._formula_strategy.execute(formula_query, client)
        return [
            doc.model_copy(update={"common_name": query.material_name})
            if doc.common_name is None else doc
            for doc in docs
        ]


class FormulaStrategy(SearchStrategy):
    """Search by exact or reduced chemical formula."""

    def execute(self, query: ParsedQuery, client: MPClientProtocol) -> list[MaterialDocument]:
        if not query.formula:
            return []
        filters: dict[str, object] = {"formula": query.formula}
        if query.stability_required:
            filters["energy_above_hull"] = (None, 0.0)
        return client.search(fields=SUMMARY_FIELDS, **filters)


class CategoryPropertyStrategy(SearchStrategy):
    """Search by material category and/or numeric property constraints."""

    def __init__(self, filter_builder: FilterBuilderProtocol) -> None:
        self._filter_builder = filter_builder

    def execute(self, query: ParsedQuery, client: MPClientProtocol) -> list[MaterialDocument]:
        mp_filters = self._filter_builder.build(query)
        if not mp_filters:
            logger.warning("FilterBuilder returned empty dict for %r — skipping scan.",
                           query.raw_query)
            return []
        return client.search(fields=SUMMARY_FIELDS, **mp_filters)


class MixedStrategy(SearchStrategy):
    """Handles queries combining multiple intents (formula + properties).

    De-duplication uses a ``dict`` keyed by ``material_id`` (insertion-order
    guaranteed in Python 3.7+) — eliminates the parallel ``set`` + ``list``
    from Step 1, reducing memory allocations by half.
    """

    def __init__(self, filter_builder: FilterBuilderProtocol) -> None:
        self._category_strategy = CategoryPropertyStrategy(filter_builder)
        self._formula_strategy = FormulaStrategy()

    def execute(self, query: ParsedQuery, client: MPClientProtocol) -> list[MaterialDocument]:
        # OPT[CPU]: single dict preserves insertion order AND provides O(1) dedup.
        seen: dict[str, MaterialDocument] = {}
        for doc in self._category_strategy.execute(query, client):
            seen.setdefault(doc.material_id, doc)
        if query.formula:
            for doc in self._formula_strategy.execute(query, client):
                seen.setdefault(doc.material_id, doc)
        return list(seen.values())


# ---------------------------------------------------------------------------
# Search Engine (Strategy Context / Router)
# ---------------------------------------------------------------------------


class SearchEngine:
    """Orchestrates the full search pipeline for Materials Explorer."""

    def __init__(
        self,
        client: MPClientProtocol,
        ranking_engine: RankingEngineProtocol,
        filter_builder: FilterBuilderProtocol,
        name_db: dict[str, str] | None = None,
    ) -> None:
        self._client = client
        self._ranking = ranking_engine
        self._filter_builder = filter_builder
        self._strategies: dict[QueryIntent, SearchStrategy] = (
            self._build_strategy_map(name_db)
        )

    def _build_strategy_map(
        self, name_db: dict[str, str] | None
    ) -> dict[QueryIntent, SearchStrategy]:
        """Wire ``QueryIntent → SearchStrategy`` in O(1) dict dispatch."""
        category_property = CategoryPropertyStrategy(self._filter_builder)
        name_strategy = MaterialNameStrategy(name_db=name_db)
        return {
            QueryIntent.MATERIAL_ID:    MaterialIDStrategy(),
            QueryIntent.MATERIAL_NAME:  name_strategy,
            QueryIntent.FORMULA:        FormulaStrategy(),
            QueryIntent.CATEGORY:       category_property,
            QueryIntent.PROPERTY_QUERY: category_property,   # shared instance — stateless
            QueryIntent.MIXED:          MixedStrategy(self._filter_builder),
        }

    def search(self, query: ParsedQuery) -> SearchResponse:
        """Execute the full pipeline and return a ranked ``SearchResponse``."""
        t_start = time.perf_counter()
        strategy = self._strategies.get(query.intent)
        raw_docs: list[MaterialDocument] = []

        if strategy is None:
            logger.error("No strategy for intent '%s'.", query.intent)
        else:
            try:
                raw_docs = strategy.execute(query, self._client)
                logger.info("%s → %d doc(s) for %r.",
                            type(strategy).__name__, len(raw_docs), query.raw_query)
            except Exception:
                logger.exception("%s raised for %r.", type(strategy).__name__, query.raw_query)

        ranked = self._ranking.rank(raw_docs, query)
        elapsed_ms = round((time.perf_counter() - t_start) * 1_000, 2)

        return SearchResponse(
            query=query, results=ranked, total_found=len(ranked),
            cache_hit=getattr(self._client, "last_cache_hit", False),
            elapsed_ms=elapsed_ms,
        )

    @property
    def registered_intents(self) -> list[QueryIntent]:
        return list(self._strategies.keys())