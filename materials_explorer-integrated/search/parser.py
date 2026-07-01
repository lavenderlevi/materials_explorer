"""
Intent detection and query parsing for Materials Explorer.

Optimization notes
------------------
OPT[RE]:  ``_CATEGORY_RE`` and ``_STABILITY_RE`` are compiled once at module
          load time as single alternation patterns. Each ``parse()`` call
          makes one ``re.search()`` pass instead of iterating all keywords.
          For k keywords each of length m, this is O(n) vs O(n·k·m).

OPT[LRU]: ``_cached_parse(raw_query, cutoff)`` is decorated with
          ``@lru_cache(maxsize=512)``. Repeated identical queries (e.g. a
          user re-submitting the same search) return a cached ``ParsedQuery``
          in O(1) dict lookup time. The cache is process-scoped; when
          ``IntentParser`` is managed via ``@st.cache_resource``, this cache
          persists across Streamlit reruns.
"""

from __future__ import annotations

import logging
import re
from functools import lru_cache
from typing import Final, NamedTuple

from rapidfuzz import fuzz
from rapidfuzz import process as fuzz_process

from .models import ParsedQuery, PropertyFilter, QueryIntent

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Domain constants
# ---------------------------------------------------------------------------

_ELEMENTS: Final[frozenset[str]] = frozenset({
    "H",  "He", "Li", "Be", "B",  "C",  "N",  "O",  "F",  "Ne", "Na", "Mg",
    "Al", "Si", "P",  "S",  "Cl", "Ar", "K",  "Ca", "Sc", "Ti", "V",  "Cr",
    "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr",
    "Rb", "Sr", "Y",  "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd",
    "In", "Sn", "Sb", "Te", "I",  "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd",
    "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu", "Hf",
    "Ta", "W",  "Re", "Os", "Ir", "Pt", "Au", "Hg", "Tl", "Pb", "Bi", "Po",
    "At", "Rn", "Fr", "Ra", "Ac", "Th", "Pa", "U",  "Np", "Pu", "Am", "Cm",
    "Bk", "Cf", "Es", "Fm", "Md", "No", "Lr", "Rf", "Db", "Sg", "Bh", "Hs",
    "Mt", "Ds", "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
})

_KNOWN_NAMES: Final[frozenset[str]] = frozenset({
    "silicon", "iron", "copper", "aluminum", "aluminium", "gold", "silver",
    "nickel", "cobalt", "titanium", "zinc", "tin", "lead", "chromium",
    "manganese", "magnesium", "calcium", "carbon", "graphite", "diamond",
    "sulfur", "germanium", "gallium arsenide", "indium phosphide",
    "gallium nitride", "indium arsenide", "water", "iron oxide", "hematite",
    "magnetite", "alumina", "silica", "quartz", "zinc oxide", "titania",
    "titanium dioxide", "rutile", "copper oxide", "cuprite", "nickel oxide",
    "manganese dioxide", "salt", "sodium chloride", "calcite", "pyrite",
    "galena", "fluorite", "lithium iron phosphate", "lfp",
    "lithium cobalt oxide", "lco", "lithium manganese oxide", "lithium oxide",
    "silicon carbide", "boron nitride", "magnesium diboride", "tungsten carbide",
})

_CATEGORY_KEYWORDS: Final[dict[str, str]] = {
    "semiconducting": "semiconductor",   "semiconductor": "semiconductor",
    "superconducting": "superconductor", "superconductor": "superconductor",
    "two-dimensional": "2d_material",    "2d": "2d_material",
    "energy storage": "battery",         "battery": "battery",
    "solar cell": "photovoltaic",        "photovoltaic": "photovoltaic",
    "ferromagnetic": "magnetic",         "antiferromagnetic": "magnetic",
    "ferrimagnetic": "magnetic",         "magnetic": "magnetic",
    "thermoelectric": "thermoelectric",  "piezoelectric": "piezoelectric",
    "topological": "topological",        "perovskite": "perovskite",
    "metallic": "metal",   "conductor": "metal",   "conductive": "metal",
    "metal": "metal",      "insulating": "insulator",
    "dielectric": "insulator",           "insulator": "insulator",
    "nitride": "nitride",  "carbide": "carbide",
    "oxide": "oxide",      "spinel": "spinel",
}

_STABILITY_TERMS: Final[frozenset[str]] = frozenset({
    "stable", "stability", "thermodynamically stable", "ground state",
})

_PROPERTY_ALIASES: Final[dict[str, str]] = {
    "band_gap": "band_gap",      "band gap": "band_gap",
    "bandgap": "band_gap",       "bg": "band_gap",
    "density": "density",
    "energy_above_hull": "energy_above_hull",
    "energy above hull": "energy_above_hull",
    "eah": "energy_above_hull",  "hull energy": "energy_above_hull",
    "formation_energy": "formation_energy_per_atom",
    "formation energy": "formation_energy_per_atom",
    "formation_energy_per_atom": "formation_energy_per_atom",
    "volume": "volume", "nsites": "nsites", "sites": "nsites", "atoms": "nsites",
}

_MP_ID_RE: Final[re.Pattern[str]] = re.compile(
    r'\b(mp-\d+|mvc-\d+)\b', re.IGNORECASE
)
_PROPERTY_RE: Final[re.Pattern[str]] = re.compile(
    r"""(?P<field>
        band[\s_]gap | bandgap | bg(?=\s*[><=]) |
        energy[\s_]above[\s_]hull | eah | hull[\s_]energy |
        formation[\s_]energy(?:[\s_]per[\s_]atom)? |
        density | volume | nsites | sites | atoms
    )\s*(?P<op>>=|<=|==|>|<|=)\s*(?P<value>-?\d+(?:\.\d+)?)""",
    re.VERBOSE | re.IGNORECASE,
)
_FORMULA_CANDIDATE_RE: Final[re.Pattern[str]] = re.compile(
    r'\b([A-Z][A-Za-z0-9]{1,})\b'
)
_SINGLE_ELEMENT_RE: Final[re.Pattern[str]] = re.compile(r'^([A-Z][a-z]?)$')
_ELEMENT_TOKEN_RE: Final[re.Pattern[str]] = re.compile(r'([A-Z][a-z]?)(\d*)')

# OPT[RE]: Single compiled alternation for all category keywords.
# Sorted longest-first so multi-word phrases ("energy storage") match
# before their sub-words ("energy"). re alternation is tried in listed order.
_SORTED_CATEGORY_KWS: Final[list[str]] = sorted(
    _CATEGORY_KEYWORDS.keys(), key=len, reverse=True
)
_CATEGORY_RE: Final[re.Pattern[str]] = re.compile(
    "|".join(re.escape(k) for k in _SORTED_CATEGORY_KWS),
    re.IGNORECASE,
)

# OPT[RE]: Single compiled alternation for all stability terms.
_STABILITY_RE: Final[re.Pattern[str]] = re.compile(
    "|".join(re.escape(t) for t in sorted(_STABILITY_TERMS, key=len, reverse=True)),
    re.IGNORECASE,
)

_NAME_DETECT_CUTOFF: Final[float] = 68.0


class _Extraction(NamedTuple):
    """Ephemeral intermediate result from the extraction pipeline."""
    material_id: str | None
    formula: str | None
    material_name: str | None
    name_match_score: float
    category: str | None
    property_filters: list[PropertyFilter]
    stability_required: bool


class IntentParser:
    """Converts a raw user query string into a structured ``ParsedQuery``.

    OPT[LRU]: ``parse()`` delegates to the module-level ``_cached_parse``
    function. The LRU cache is keyed on ``(raw_query, name_cutoff)`` so that
    identical queries are resolved in O(1) without re-running any extractor.
    """

    def __init__(self, name_score_cutoff: float = _NAME_DETECT_CUTOFF) -> None:
        self._name_cutoff = name_score_cutoff

    def parse(self, raw_query: str) -> ParsedQuery:
        """Parse *raw_query* into a ``ParsedQuery`` (LRU-cached per unique input)."""
        # OPT[LRU]: hot path — cache hit costs one dict lookup.
        return _cached_parse(raw_query.strip(), self._name_cutoff)

    def _parse_impl(self, raw_query: str) -> ParsedQuery:
        """Uncached implementation — called only on LRU cache miss."""
        text = raw_query.strip()
        if not text:
            return ParsedQuery(raw_query=raw_query, intent=QueryIntent.MIXED, confidence=0.0)
        ex = self._run_extractors(text)
        intent, confidence = self._classify_intent(ex)
        return ParsedQuery(
            raw_query=raw_query,
            intent=intent,
            material_id=ex.material_id,
            material_name=ex.material_name,
            formula=ex.formula,
            category=ex.category,
            property_filters=ex.property_filters,  # Pydantic coerces list→tuple
            stability_required=ex.stability_required,
            confidence=confidence,
        )

    def _run_extractors(self, text: str) -> _Extraction:
        material_id = self._extract_id(text)
        filters = self._extract_property_filters(text)
        stability = self._extract_stability(text)
        category = self._extract_category(text)
        formula: str | None = None
        name: str | None = None
        name_score: float = 0.0

        if not material_id:
            clean = _PROPERTY_RE.sub(" ", text).strip()
            formula = self._extract_formula(clean)
            if not formula:
                name, name_score = self._extract_name(clean)

        return _Extraction(
            material_id=material_id, formula=formula, material_name=name,
            name_match_score=name_score, category=category,
            property_filters=filters, stability_required=stability,
        )

    def _extract_id(self, text: str) -> str | None:
        m = _MP_ID_RE.search(text)
        return m.group(1).lower() if m else None

    def _extract_property_filters(self, text: str) -> list[PropertyFilter]:
        results: list[PropertyFilter] = []
        for m in _PROPERTY_RE.finditer(text):
            raw_field = " ".join(m.group("field").lower().split())
            canonical = _PROPERTY_ALIASES.get(
                raw_field, _PROPERTY_ALIASES.get(raw_field.replace(" ", "_"), raw_field)
            )
            op = m.group("op")
            operator = "==" if op == "=" else op
            try:
                results.append(PropertyFilter(field=canonical, operator=operator,
                                              value=float(m.group("value"))))
            except ValueError:
                logger.warning("Unparseable property value: %r", m.group("value"))
        return results

    def _extract_stability(self, text: str) -> bool:
        # OPT[RE]: single compiled regex search vs O(k) any() loop.
        return _STABILITY_RE.search(text) is not None

    def _extract_category(self, text: str) -> str | None:
        # OPT[RE]: one re.search() pass over text vs O(k) substring checks.
        m = _CATEGORY_RE.search(text)
        if m is None:
            return None
        return _CATEGORY_KEYWORDS.get(m.group(0).lower())

    def _extract_formula(self, text: str) -> str | None:
        for m in _FORMULA_CANDIDATE_RE.finditer(text):
            candidate = m.group(1)
            if self._is_valid_formula(candidate) and self._has_multi_elements(candidate):
                return candidate
        for candidate in ([text.strip()] + text.split()[:1]):
            sm = _SINGLE_ELEMENT_RE.match(candidate.strip())
            if sm and sm.group(1) in _ELEMENTS:
                return sm.group(1)
        return None

    def _extract_name(self, text: str) -> tuple[str | None, float]:
        tl = text.lower().strip()
        if tl in _KNOWN_NAMES:
            return tl, 100.0
        hits = fuzz_process.extract(
            tl, _KNOWN_NAMES, scorer=fuzz.WRatio, limit=1, score_cutoff=self._name_cutoff
        )
        if not hits:
            return None, 0.0
        best_name, best_score, _ = hits[0]
        return best_name, float(best_score)

    @staticmethod
    def _is_valid_formula(candidate: str) -> bool:
        pos, found = 0, False
        while pos < len(candidate):
            m = _ELEMENT_TOKEN_RE.match(candidate, pos)
            if not m or m.group(1) not in _ELEMENTS:
                return False
            pos, found = m.end(), True
        return found

    @staticmethod
    def _has_multi_elements(candidate: str) -> bool:
        symbols: set[str] = set()
        pos = 0
        while pos < len(candidate):
            m = _ELEMENT_TOKEN_RE.match(candidate, pos)
            if not m:
                break
            symbols.add(m.group(1))
            pos = m.end()
        return len(symbols) > 1

    def _classify_intent(self, ex: _Extraction) -> tuple[QueryIntent, float]:
        if ex.material_id:
            return QueryIntent.MATERIAL_ID, 1.0
        has_filters = bool(ex.property_filters)
        has_cat = ex.category is not None
        has_formula = ex.formula is not None
        has_name = ex.material_name is not None
        if sum([has_filters, has_cat, has_formula, has_name]) >= 2:
            return QueryIntent.MIXED, self._mixed_confidence(ex)
        if has_filters:
            return QueryIntent.PROPERTY_QUERY, 0.85
        if has_cat:
            return QueryIntent.CATEGORY, 0.80
        if has_formula:
            return QueryIntent.FORMULA, 0.90
        if has_name:
            c = 0.65 + (ex.name_match_score - 68.0) / 32.0 * 0.30
            return QueryIntent.MATERIAL_NAME, round(c, 3)
        logger.warning("No signals in %r — defaulting to MIXED/0.20", ex)
        return QueryIntent.MIXED, 0.20

    @staticmethod
    def _mixed_confidence(ex: _Extraction) -> float:
        scores: list[float] = []
        if ex.property_filters:
            scores.append(0.85)
        if ex.category:
            scores.append(0.80)
        if ex.formula:
            scores.append(0.90)
        if ex.material_name:
            scores.append(0.65 + (ex.name_match_score - 68.0) / 32.0 * 0.30)
        if not scores:
            return 0.20
        product = 1.0
        for s in scores:
            product *= s
        return round(product ** (1.0 / len(scores)), 3)


# OPT[LRU]: Module-level cache — defined AFTER IntentParser so the class is
# in scope. Key: (raw_query, name_cutoff). Process-scoped; survives reruns
# when IntentParser is held by @st.cache_resource in app.py.
@lru_cache(maxsize=512)
def _cached_parse(raw_query: str, name_cutoff: float) -> ParsedQuery:
    """LRU-cached parse dispatch. Only called on cache miss."""
    return IntentParser(name_cutoff)._parse_impl(raw_query)