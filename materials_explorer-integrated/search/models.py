"""
Data models for the Materials Explorer search pipeline.

All models are immutable Pydantic v2 BaseModels. Zero intra-package imports.

Optimization notes
------------------
- OPT[TUP]: `property_filters` and `elements` use `tuple` instead of `list`.
  Tuples are hashable, making `ParsedQuery` and `MaterialDocument` fully
  hashable when frozen. This is the prerequisite for `@lru_cache` on
  `FilterBuilder.build()` and `IntentParser._cached_parse()`.
- OPT[HASH]: All six models are frozen → auto-generated `__hash__` based on
  field values. Two structurally identical `ParsedQuery` objects share one
  cache entry in any `@lru_cache`.
"""

from __future__ import annotations

import logging
from enum import Enum
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

logger = logging.getLogger(__name__)

SUMMARY_FIELDS: list[str] = [
    "material_id", "formula_pretty", "energy_above_hull",
    "formation_energy_per_atom", "band_gap", "density", "volume",
    "nsites", "nelements", "elements", "chemsys", "symmetry",
    "theoretical", "has_props", "ordering",
]

_HAS_PROPS_FIELD_MAP: dict[str, str] = {
    "dos": "has_dos",
    "electronic_structure": "has_dos",
    "bandstructure": "has_band_structure",
    "band_structure": "has_band_structure",
    "elasticity": "has_elastic",
    "elastic": "has_elastic",
    "phonon": "has_phonon",
    "phonons": "has_phonon",
    "magnetism": "has_magnetism",
    "xas": "has_xas",
}


class QueryIntent(str, Enum):
    MATERIAL_ID = "material_id"
    MATERIAL_NAME = "material_name"
    FORMULA = "formula"
    CATEGORY = "category"
    PROPERTY_QUERY = "property_query"
    MIXED = "mixed"


class PropertyFilter(BaseModel):
    """A single numeric property constraint parsed from a user query.

    ``frozen=True`` + all-hashable fields → ``PropertyFilter`` is hashable,
    allowing it to be stored in a ``tuple`` that itself is hashable.
    """

    model_config = ConfigDict(frozen=True)

    field: str
    operator: str = Field(description="One of: '>', '<', '>=', '<=', '=='.")
    value: float

    def to_mp_range(self) -> tuple[float | None, float | None]:
        """Convert to the ``(min, max)`` tuple expected by mp-api."""
        if self.operator in (">", ">="):
            return (self.value, None)
        if self.operator in ("<", "<="):
            return (None, self.value)
        return (self.value, self.value)  # "==" tight range


class ParsedQuery(BaseModel):
    """Structured representation of a user query produced by ``IntentParser``.

    OPT[TUP]: ``property_filters`` is ``tuple[PropertyFilter, ...]`` — a
    hashable sequence. Combined with ``frozen=True`` this makes the entire
    ``ParsedQuery`` hashable, enabling ``@lru_cache`` on ``FilterBuilder.build``.
    Pydantic v2 auto-coerces a ``list`` input to ``tuple`` transparently.
    """

    model_config = ConfigDict(frozen=True)

    raw_query: str
    intent: QueryIntent
    material_id: str | None = None
    material_name: str | None = None
    formula: str | None = None
    category: str | None = None
    # OPT[TUP]: tuple, not list — makes ParsedQuery fully hashable.
    property_filters: tuple[PropertyFilter, ...] = Field(default_factory=tuple)
    stability_required: bool = False
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


class CompletenessFlags(BaseModel):
    """Tracks which computed property datasets exist for a material."""

    model_config = ConfigDict(frozen=True)

    has_dos: bool = False
    has_band_structure: bool = False
    has_elastic: bool = False
    has_phonon: bool = False
    has_magnetism: bool = False
    has_xas: bool = False
    # OPT[HASH]: Precomputed during model construction via model_validator.
    # Avoids iterating 6 booleans on every call to CompletenessScorer.score().
    _precomputed_score: float = 0.0

    @model_validator(mode="after")
    def _precompute_score(self) -> "CompletenessFlags":
        """Compute the fraction score once at construction time."""
        tracked = [
            self.has_dos, self.has_band_structure, self.has_elastic,
            self.has_phonon, self.has_magnetism, self.has_xas,
        ]
        # Use object.__setattr__ to bypass frozen restriction during construction.
        object.__setattr__(self, "_precomputed_score", sum(tracked) / len(tracked))
        return self

    @classmethod
    def from_has_props(cls, has_props: Any) -> Self:
        """Build ``CompletenessFlags`` from an mp-api ``has_props`` value."""
        field_values: dict[str, bool] = {k: False for k in cls.model_fields}
        if has_props is None:
            return cls(**field_values)

        if isinstance(has_props, (list, tuple, set)):
            props_set: set[str] = {str(p).lower().strip() for p in has_props}
        elif hasattr(has_props, "__dict__"):
            props_set = {k.lower() for k, v in vars(has_props).items() if v}
        else:
            props_set = {str(has_props).lower().strip()}

        for token, flag_name in _HAS_PROPS_FIELD_MAP.items():
            if token in props_set:
                field_values[flag_name] = True
        return cls(**field_values)

    @property
    def score(self) -> float:
        """Return precomputed fraction of available datasets [0.0, 1.0]."""
        return self._precomputed_score  # OPT[HASH]: O(1), precomputed.


class MaterialDocument(BaseModel):
    """Canonical internal representation of a single material.

    OPT[TUP]: ``elements`` is ``tuple[str, ...]``. Pydantic coerces a ``list``
    input automatically. This makes ``MaterialDocument`` fully hashable when
    frozen — enabling future caching layers if needed.
    """

    model_config = ConfigDict(frozen=True)

    material_id: str
    formula_pretty: str
    energy_above_hull: float | None = None
    formation_energy_per_atom: float | None = None
    band_gap: float | None = None
    density: float | None = None
    volume: float | None = None
    nsites: int | None = None
    nelements: int | None = None
    # OPT[TUP]: tuple for hashability; Pydantic coerces list → tuple.
    elements: tuple[str, ...] = Field(default_factory=tuple)
    chemsys: str | None = None
    spacegroup_symbol: str | None = None
    crystal_system: str | None = None
    is_stable: bool = False
    is_magnetic: bool = False
    theoretical: bool = False
    completeness: CompletenessFlags = Field(default_factory=CompletenessFlags)
    common_name: str | None = None

    @classmethod
    def from_summary_doc(cls, doc: Any, common_name: str | None = None) -> Self:
        """Adapter: build a ``MaterialDocument`` from an mp-api ``SummaryDoc``.

        OPT[CPU]: Local alias ``g = getattr`` reduces attribute-lookup overhead
        in the hot path where many docs are converted in a single search call.
        """
        g = getattr  # OPT[CPU]: single local lookup vs repeated global resolution.
        eah: float | None = g(doc, "energy_above_hull", None)
        symmetry = g(doc, "symmetry", None)
        spacegroup = g(symmetry, "symbol", None) if symmetry else None
        crystal_sys_raw = g(symmetry, "crystal_system", None) if symmetry else None
        crystal_sys = str(crystal_sys_raw).capitalize() if crystal_sys_raw else None
        ordering = g(doc, "ordering", None)
        is_magnetic = bool(ordering and str(ordering).upper() not in ("NM", "NONE", ""))
        elements_raw = g(doc, "elements", []) or []

        return cls(
            material_id=str(doc.material_id),
            formula_pretty=str(doc.formula_pretty),
            energy_above_hull=eah,
            formation_energy_per_atom=g(doc, "formation_energy_per_atom", None),
            band_gap=g(doc, "band_gap", None),
            density=g(doc, "density", None),
            volume=g(doc, "volume", None),
            nsites=g(doc, "nsites", None),
            nelements=g(doc, "nelements", None) or len(elements_raw),
            elements=tuple(str(e) for e in elements_raw),  # OPT[TUP]
            chemsys=g(doc, "chemsys", None),
            spacegroup_symbol=spacegroup,
            crystal_system=crystal_sys,
            is_stable=bool(eah is not None and eah <= 0.0),
            is_magnetic=is_magnetic,
            theoretical=bool(g(doc, "theoretical", False)),
            completeness=CompletenessFlags.from_has_props(g(doc, "has_props", None)),
            common_name=common_name,
        )


class ScoreBreakdown(BaseModel):
    """Individual weighted score components, each in [0.0, 1.0].

    OPT[HASH]: ``total`` is precomputed via ``model_validator`` so it is
    calculated exactly once at construction — not re-evaluated on every
    access to ``RankedResult.total_score``.
    """

    model_config = ConfigDict(frozen=True)

    stability: float = Field(ge=0.0, le=1.0)
    completeness: float = Field(ge=0.0, le=1.0)
    exact_match: float = Field(ge=0.0, le=1.0)
    popularity: float = Field(ge=0.0, le=1.0)
    application_relevance: float = Field(ge=0.0, le=1.0)
    # OPT[HASH]: Precomputed field — never a re-evaluated property.
    total: float = Field(default=0.0, ge=0.0, le=100.0)

    @model_validator(mode="after")
    def _compute_total(self) -> "ScoreBreakdown":
        """Compute weighted total once during construction."""
        val = round(
            (
                0.35 * self.stability
                + 0.25 * self.completeness
                + 0.15 * self.exact_match
                + 0.15 * self.popularity
                + 0.10 * self.application_relevance
            )
            * 100,
            2,
        )
        object.__setattr__(self, "total", val)  # bypass frozen during init
        return self


class RankedResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    material: MaterialDocument
    score_breakdown: ScoreBreakdown
    total_score: float = Field(ge=0.0, le=100.0)
    rank: int = Field(ge=1)


class SearchResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    query: ParsedQuery
    results: list[RankedResult]
    total_found: int = Field(ge=0)
    cache_hit: bool
    elapsed_ms: float = Field(ge=0.0)