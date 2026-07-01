"""
Page 2 — Recommendation Engine
Rank materials by how well they match user-defined technical requirements.

Workflow:
  1. Sidebar: select which properties to target, set target/range/importance.
  2. Sidebar: set hard categorical constraints (stability, dataset availability).
  3. Sidebar: configure corpus (element filter + size).
  4. Fetch corpus from MP API → RecommendationEngine.recommend() → render results.
"""

from __future__ import annotations

import streamlit as st

from resources import get_api_key, get_mp_client
from search.models import SUMMARY_FIELDS
from search.recommender import (
    CategoryRequirements,
    PropertyRequirement,
    RecommendationEngine,
    RecommendationResult,
    PROPERTY_META,
)

st.set_page_config(
    page_title="Recommendations · Materials Explorer",
    page_icon="🎯",
    layout="wide",
)
st.title("🎯 Recommendation Engine")
st.markdown(
    "Define your **technical requirements** — target values, acceptable ranges, "
    "and relative importance — and let the engine find the best-matching materials."
)

# ---------------------------------------------------------------------------
# API key guard
# ---------------------------------------------------------------------------
api_key = get_api_key()
if not api_key:
    st.warning("⚠️ Configure your Materials Project API key on the main page.")
    st.stop()

# ---------------------------------------------------------------------------
# Sidebar — full configuration
# ---------------------------------------------------------------------------
with st.sidebar:
    st.header("⚙️ Configuration")

    # --- Corpus settings ---
    st.subheader("📦 Corpus")
    elements_input = st.text_input(
        "Required elements (comma-separated)",
        placeholder="e.g.  Li, Fe, O",
        help="Only materials containing ALL of these elements are included.",
    )
    stability_corpus = st.checkbox("Near-stable corpus (eah ≤ 0.1 eV)", value=True)
    corpus_size = st.slider("Max corpus size", 50, 500, 150, step=50)
    top_k = st.slider("Results to show", 5, 30, 10)

    st.divider()

    # --- Property requirements ---
    st.subheader("📐 Property Requirements")
    selected_props: list[str] = st.multiselect(
        "Properties to target",
        options=list(PROPERTY_META.keys()),
        default=["band_gap", "formation_energy_per_atom"],
        format_func=lambda k: PROPERTY_META[k]["label"],
    )

    requirements: list[PropertyRequirement] = []
    for prop in selected_props:
        meta = PROPERTY_META[prop]
        with st.expander(f"🔧 {meta['label']}", expanded=True):
            target = st.slider(
                f"Target ({meta['unit']})",
                min_value=float(meta["min"]), max_value=float(meta["max"]),
                value=float(meta["default_target"]), step=float(meta["step"]),
                key=f"target_{prop}",
            )
            lo = st.slider(
                "Acceptable minimum",
                min_value=float(meta["min"]), max_value=float(meta["max"]),
                value=float(meta["default_lo"]), step=float(meta["step"]),
                key=f"lo_{prop}",
            )
            hi = st.slider(
                "Acceptable maximum",
                min_value=float(meta["min"]), max_value=float(meta["max"]),
                value=float(meta["default_hi"]), step=float(meta["step"]),
                key=f"hi_{prop}",
            )
            importance = st.slider(
                "Importance (1 = low, 10 = critical)",
                min_value=1.0, max_value=10.0, value=5.0, step=0.5,
                key=f"imp_{prop}",
            )
        if lo > hi:
            st.warning(f"{meta['label']}: min > max — swapping.")
            lo, hi = hi, lo

        requirements.append(PropertyRequirement(
            field=prop, target=target, lo=lo, hi=hi, importance=importance,
        ))

    st.divider()

    # --- Hard constraints ---
    st.subheader("🔒 Hard Constraints")
    st.caption("Materials violating these are scored 0 and shown at the bottom.")
    stability_required = st.checkbox("Must be thermodynamically stable (eah ≤ 0)", False)
    require_dos = st.checkbox("Must have DOS data", False)
    require_bs = st.checkbox("Must have Band Structure data", False)
    require_elastic = st.checkbox("Must have Elasticity data", False)
    require_phonon = st.checkbox("Must have Phonon data", False)

categorical = CategoryRequirements(
    stability_required=stability_required,
    require_dos=require_dos,
    require_band_structure=require_bs,
    require_elastic=require_elastic,
    require_phonon=require_phonon,
)

# ---------------------------------------------------------------------------
# Main — search trigger
# ---------------------------------------------------------------------------
run = st.button("🎯 Get Recommendations", type="primary")

if not run:
    st.info(
        "Configure your requirements in the sidebar and press **Get Recommendations**. "
        "At least one property requirement and one element are needed."
    )
    st.stop()

if not requirements:
    st.error("Select at least one property requirement in the sidebar.")
    st.stop()
if not elements_input.strip():
    st.error("Specify at least one element to bound the corpus.")
    st.stop()

# ---------------------------------------------------------------------------
# Corpus fetch
# ---------------------------------------------------------------------------
client = get_mp_client(api_key)
filters: dict = {
    "elements": [e.strip() for e in elements_input.split(",") if e.strip()],
}
if stability_corpus:
    filters["energy_above_hull"] = (None, 0.1)

with st.spinner("Fetching corpus from Materials Project…"):
    try:
        corpus = client.search(fields=SUMMARY_FIELDS, **filters)
        corpus = corpus[:corpus_size]
    except Exception as exc:
        st.error(f"MP API error: {exc}")
        st.stop()

if not corpus:
    st.warning("No materials returned. Broaden element selection or disable the near-stable filter.")
    st.stop()

# ---------------------------------------------------------------------------
# Recommendation
# ---------------------------------------------------------------------------
engine = RecommendationEngine(requirements=requirements, categorical=categorical)

with st.spinner(f"Scoring {len(corpus)} materials against {len(requirements)} requirements…"):
    results = engine.recommend(corpus=corpus, top_k=top_k)

if not results:
    st.warning("No results. Try removing hard constraints or broadening the corpus.")
    st.stop()

valid_count = sum(1 for r in results if r.hard_constraints_met)
st.success(
    f"✅ **{valid_count}** materials meet all constraints "
    f"(out of **{len(corpus)}** in corpus). Showing top {len(results)}."
)
st.divider()


# ---------------------------------------------------------------------------
# Result rendering
# ---------------------------------------------------------------------------

def _render_result(res: RecommendationResult) -> None:
    mat = res.material
    score = res.total_score
    constraint_label = "" if res.hard_constraints_met else " ⚠️ [constraint violated]"
    icon = "🟢" if score >= 70 else ("🟡" if score >= 40 else "🔴")
    url = f"https://materialsproject.org/materials/{mat.material_id}"

    header = (
        f"#{res.rank}  **{mat.material_id}**  |  `{mat.formula_pretty}`"
        f"  —  {icon} **{score:.1f} / 100**{constraint_label}"
    )

    with st.expander(header, expanded=(res.rank == 1)):
        col_props, col_req = st.columns([1, 1], gap="large")

        with col_props:
            st.markdown(f"**ID:** [{mat.material_id}]({url})  |  **Formula:** `{mat.formula_pretty}`")
            st.markdown(f"**Stability:** {'✅ Stable' if mat.is_stable else '⚠️ Metastable'}")
            if mat.energy_above_hull is not None:
                st.markdown(f"**E above hull:** {mat.energy_above_hull:.4f} eV/atom")
            if mat.band_gap is not None:
                st.markdown(f"**Band Gap:** {mat.band_gap:.3f} eV")
            if mat.density is not None:
                st.markdown(f"**Density:** {mat.density:.3f} g/cm³")
            if mat.formation_energy_per_atom is not None:
                st.markdown(f"**Formation Energy:** {mat.formation_energy_per_atom:.4f} eV/atom")
            if mat.crystal_system:
                st.markdown(f"**Crystal System:** {mat.crystal_system}")
            if not res.hard_constraints_met:
                st.warning("⚠️ One or more hard constraints were not met.")

        with col_req:
            st.markdown("**Requirement Match**")
            for ps in res.property_scores:
                icon_m = "✅" if ps.in_range else "⚠️"
                val_str = f"{ps.material_value:.3f}" if ps.material_value is not None else "N/A"
                target_str = f"{ps.target:.3f}"
                st.markdown(f"{icon_m} **{ps.label}**  —  value: `{val_str}` | target: `{target_str}`")
                st.progress(
                    value=ps.raw_score,
                    text=f"{ps.raw_score * 100:.0f}% match  (importance: {ps.weighted_score:.1f})",
                )


for result in results:
    _render_result(result)