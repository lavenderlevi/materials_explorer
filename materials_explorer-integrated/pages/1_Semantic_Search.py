"""
Page 1 — AI Semantic Search
Natural-language query over a user-defined material corpus.

Workflow:
  1. User enters a natural-language query.
  2. User constrains corpus: by elements and/or stability.
  3. MP API fetches a broad corpus (up to corpus_size materials).
  4. SemanticSearchEngine ranks corpus by cosine similarity to the query.
  5. Results rendered with similarity score, property card, and embedded
     description shown for transparency.
"""

from __future__ import annotations

import streamlit as st

from resources import get_api_key, get_mp_client, get_semantic_engine
from search.models import SUMMARY_FIELDS

st.set_page_config(
    page_title="Semantic Search · Materials Explorer",
    page_icon="🧠",
    layout="wide",
)
st.title("🧠 AI Semantic Search")
st.markdown(
    "Search using **natural language**. The engine embeds your query and ranks "
    "materials by meaning — not keyword matching."
)

# ---------------------------------------------------------------------------
# API key guard
# ---------------------------------------------------------------------------
api_key = get_api_key()
if not api_key:
    st.warning("⚠️ Configure your Materials Project API key on the main page.")
    st.stop()

# ---------------------------------------------------------------------------
# Sidebar — corpus configuration
# ---------------------------------------------------------------------------
with st.sidebar:
    st.header("⚙️ Corpus Configuration")
    st.caption("Define which materials to search over.")

    elements_input = st.text_input(
        "Required elements (comma-separated)",
        placeholder="e.g.  Li, Fe, O",
        help="Only materials containing ALL of these elements are included.",
    )
    stability_only = st.checkbox("Stable only (energy_above_hull ≤ 0)", value=False)
    corpus_size = st.slider("Max corpus size", 20, 200, 80, step=20,
                            help="Larger corpus → better recall, slower embedding.")
    top_k = st.slider("Results to show", 5, 30, 10)
    st.divider()
    backend_slot = st.empty()   # filled after engine is loaded

# ---------------------------------------------------------------------------
# Query input
# ---------------------------------------------------------------------------
query = st.text_input(
    "Natural Language Query",
    placeholder=(
        "e.g.  stable wide-band-gap insulator for photovoltaic applications"
        "  ·  magnetic oxide with elastic data"
        "  ·  lightweight battery cathode"
    ),
    label_visibility="visible",
)
col_btn, col_hint = st.columns([1, 5])
run = col_btn.button("🔍 Search", type="primary")
col_hint.caption(
    "Describe the functional role, crystal class, stability, property range, "
    "or available datasets. The engine understands context."
)

if not run or not query.strip():
    st.info("Enter a query, configure the corpus in the sidebar, then press **Search**.")
    st.stop()

if not elements_input.strip() and not stability_only:
    st.error("Specify at least one element to bound the corpus size.")
    st.stop()

# ---------------------------------------------------------------------------
# Corpus fetch
# ---------------------------------------------------------------------------
client = get_mp_client(api_key)
filters: dict = {}

if elements_input.strip():
    filters["elements"] = [e.strip() for e in elements_input.split(",") if e.strip()]
if stability_only:
    filters["energy_above_hull"] = (None, 0.0)

with st.spinner("Fetching corpus from Materials Project…"):
    try:
        corpus = client.search(fields=SUMMARY_FIELDS, **filters)
        corpus = corpus[:corpus_size]
    except Exception as exc:
        st.error(f"MP API error: {exc}")
        st.stop()

if not corpus:
    st.warning("No materials returned. Broaden your element selection or disable the stability filter.")
    st.stop()

st.caption(f"Corpus: **{len(corpus)}** materials fetched. Ranking by semantic similarity…")

# ---------------------------------------------------------------------------
# Semantic ranking
# ---------------------------------------------------------------------------
engine = get_semantic_engine()

with st.spinner(
    "Computing semantic embeddings… "
    "(first run downloads the model — ~30 s. Subsequent runs use the cache.)"
):
    results = engine.search(query=query.strip(), corpus=corpus, top_k=top_k)

backend_slot.caption(f"Embedder: `{type(engine._embedder).__name__}`")

if not results:
    st.warning("No results returned. Try rephrasing the query or expanding the corpus.")
    st.stop()

st.success(f"✅ Ranked **{len(results)}** materials by semantic similarity.")
st.divider()

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------
for res in results:
    mat = res.material
    pct = res.similarity_score * 100
    icon = "🟢" if pct >= 60 else ("🟡" if pct >= 35 else "🔴")
    mp_url = f"https://materialsproject.org/materials/{mat.material_id}"

    header = (
        f"#{res.rank}  **{mat.material_id}**  |  `{mat.formula_pretty}`"
        f"  —  {icon} **{pct:.1f}% similarity**"
    )

    with st.expander(header, expanded=(res.rank == 1)):
        col_info, col_score = st.columns([3, 2])

        with col_info:
            st.markdown(f"**ID:** [{mat.material_id}]({mp_url})  |  "
                        f"**Formula:** `{mat.formula_pretty}`")
            st.markdown(f"**Stability:** {'✅ Stable' if mat.is_stable else '⚠️ Metastable'}")
            if mat.energy_above_hull is not None:
                st.markdown(f"**E above hull:** {mat.energy_above_hull:.4f} eV/atom")
            if mat.band_gap is not None:
                st.markdown(f"**Band Gap:** {mat.band_gap:.3f} eV")
            if mat.density is not None:
                st.markdown(f"**Density:** {mat.density:.3f} g/cm³")
            if mat.crystal_system:
                st.markdown(f"**Crystal System:** {mat.crystal_system}")
            st.divider()
            st.caption("**Embedded description (for transparency):**")
            preview = res.description[:280] + ("…" if len(res.description) > 280 else "")
            st.caption(preview)

        with col_score:
            st.metric("Similarity", f"{pct:.1f}%")
            st.progress(min(res.similarity_score, 1.0))
            st.markdown("**Available Datasets:**")
            f = mat.completeness
            for name, flag in [
                ("DOS", f.has_dos), ("Band Structure", f.has_band_structure),
                ("Elastic", f.has_elastic), ("Phonon", f.has_phonon),
                ("Magnetism", f.has_magnetism), ("XAS", f.has_xas),
            ]:
                st.markdown(f"{'✅' if flag else '❌'} {name}")