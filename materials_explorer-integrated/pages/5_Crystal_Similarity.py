"""
Page 5 — Crystal Similarity Search

Given a seed material ID, find the most structurally similar materials.

Workflow:
  1. Enter seed material ID → fetch MaterialDocument + pymatgen Structure.
  2. Build corpus: by element system (auto-fetch) or manual ID list.
  3. Fetch crystal structures for corpus via StructureClient (SQLite-cached).
  4. Select mode: Fingerprint (fast) or StructureMatcher (exact).
  5. Display ranked results with crystal system, spacegroup, and properties.
"""

from __future__ import annotations

import streamlit as st

from resources import (
    get_api_key,
    get_crystal_engine,
    get_mp_client,
    get_structure_client,
    render_api_key_sidebar,
)
from search.models import SUMMARY_FIELDS

st.set_page_config(
    page_title="Crystal Similarity · Materials Explorer",
    page_icon="💎",
    layout="wide",
)
st.title("💎 Crystal Similarity Search")
st.markdown(
    "Find materials with the most **structurally similar** crystal geometry to a seed.\n\n"
    "- **Fingerprint** mode: fast, 19-dim geometric vector, valid across any composition.\n"
    "- **StructureMatcher** mode: rigorous RMS distance, same/similar composition only."
)

render_api_key_sidebar()
api_key = get_api_key()
if not api_key:
    st.warning("⚠️ Configure your Materials Project API key in the sidebar.")
    st.stop()

# ---------------------------------------------------------------------------
# Sidebar — search configuration
# ---------------------------------------------------------------------------
with st.sidebar:
    st.divider()
    st.header("⚙️ Search Configuration")

    mode = st.radio(
        "Search Mode",
        options=["fingerprint", "structure_matcher"],
        format_func=lambda m: (
            "🚀 Fingerprint (fast, any composition)"
            if m == "fingerprint"
            else "🔬 StructureMatcher (exact, same composition)"
        ),
    )
    top_k = st.slider("Top results", 3, 20, 8)

    corpus_mode = st.radio(
        "Corpus Source",
        options=["element_system", "manual_ids"],
        format_func=lambda m: (
            "🧪 Element System (auto-fetch)" if m == "element_system"
            else "📋 Manual Material IDs"
        ),
    )

    if mode == "structure_matcher":
        st.divider()
        st.subheader("StructureMatcher Tolerances")
        max_corpus = st.slider("Max corpus size", 5, 30, 15,
                               help="Keep ≤ 30 — StructureMatcher is O(n) per candidate.")
        ltol = st.slider("Lattice tolerance", 0.05, 0.50, 0.20, step=0.05)
        stol = st.slider("Site tolerance", 0.10, 0.80, 0.30, step=0.05)
        angle_tol = st.slider("Angle tolerance (°)", 2.0, 15.0, 5.0, step=1.0)
    else:
        max_corpus = st.slider("Max corpus size", 10, 80, 30, step=10)
        ltol, stol, angle_tol = 0.2, 0.3, 5.0

# ---------------------------------------------------------------------------
# Main — seed + corpus inputs
# ---------------------------------------------------------------------------
seed_id_raw = st.text_input(
    "Seed Material ID",
    placeholder="e.g.  mp-149  (Silicon)  ·  mp-19017  (GaAs)",
)

if corpus_mode == "manual_ids":
    corpus_ids_raw = st.text_area(
        "Corpus Material IDs (comma or newline separated)",
        placeholder="mp-2534\nmp-1265\nmp-19017\nmp-20305\n...",
        height=110,
    )
    corpus_ids_input = [
        mid.strip()
        for mid in corpus_ids_raw.replace(",", "\n").splitlines()
        if mid.strip()
    ]
    elements_input = ""
else:
    elements_input = st.text_input(
        "Element system for corpus (comma-separated)",
        placeholder="e.g.  Si, O   — leave blank to use the seed's elements",
    )
    corpus_ids_input = []

run = st.button("🔍 Find Similar Structures", type="primary")

if not run or not seed_id_raw.strip():
    st.info("Enter a seed material ID and press **Find Similar Structures**.")
    st.stop()

# ---------------------------------------------------------------------------
# Fetch seed
# ---------------------------------------------------------------------------
seed_id = seed_id_raw.strip().lower()
client = get_mp_client(api_key)
struct_client = get_structure_client(api_key)

with st.spinner(f"Fetching seed material `{seed_id}`…"):
    seed_doc = client.get_by_id(seed_id, fields=SUMMARY_FIELDS)
    seed_structure = struct_client.get_structure(seed_id)

if seed_doc is None:
    st.error(f"`{seed_id}` not found. Check the ID format (e.g. `mp-149`).")
    st.stop()
if seed_structure is None:
    st.error(f"Could not fetch crystal structure for `{seed_id}` from MP API.")
    st.stop()

# Seed banner
with st.expander(
    f"**Seed: {seed_doc.material_id}** — `{seed_doc.formula_pretty}` — "
    f"{'✅ Stable' if seed_doc.is_stable else '⚠️ Metastable'}",
    expanded=True,
):
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Crystal System", seed_doc.crystal_system or "N/A")
    c2.metric("Spacegroup", seed_doc.spacegroup_symbol or "N/A")
    c3.metric("Band Gap",
              f"{seed_doc.band_gap:.3f} eV" if seed_doc.band_gap is not None else "N/A")
    c4.metric("Density",
              f"{seed_doc.density:.3f} g/cm³" if seed_doc.density is not None else "N/A")
    st.markdown(
        f"**Formula:** `{seed_doc.formula_pretty}`  |  "
        f"**Elements:** {', '.join(seed_doc.elements)}  |  "
        f"**Sites:** {seed_doc.nsites or 'N/A'}"
    )

# ---------------------------------------------------------------------------
# Build corpus document list
# ---------------------------------------------------------------------------
with st.spinner("Fetching corpus…"):
    if corpus_mode == "manual_ids":
        if not corpus_ids_input:
            st.error("Enter at least one corpus material ID in the text area.")
            st.stop()
        corpus_docs_list = []
        for mid in corpus_ids_input[:max_corpus]:
            if mid == seed_id:
                continue
            doc = client.get_by_id(mid, fields=SUMMARY_FIELDS)
            if doc:
                corpus_docs_list.append(doc)
    else:
        elements = (
            [e.strip() for e in elements_input.split(",") if e.strip()]
            or list(seed_doc.elements)
        )
        all_docs = client.search(fields=SUMMARY_FIELDS, elements=elements)
        corpus_docs_list = [
            d for d in all_docs if d.material_id != seed_id
        ][:max_corpus]

if not corpus_docs_list:
    st.warning("No corpus materials found. Try different elements or IDs.")
    st.stop()

corpus_ids = [d.material_id for d in corpus_docs_list]

# ---------------------------------------------------------------------------
# Fetch corpus structures
# ---------------------------------------------------------------------------
with st.spinner(f"Fetching {len(corpus_ids)} crystal structures (SQLite-cached where available)…"):
    corpus_structures = struct_client.get_structures_batch(corpus_ids)

fetched = len(corpus_structures)
if fetched == 0:
    st.error("Could not fetch any corpus structures. Check your API key and network.")
    st.stop()
if fetched < len(corpus_ids):
    st.warning(f"Fetched {fetched}/{len(corpus_ids)} structures — some IDs may be unavailable.")

corpus_docs_map = {
    d.material_id: d for d in corpus_docs_list if d.material_id in corpus_structures
}
st.caption(
    f"Corpus: **{fetched}** structures available. "
    f"Mode: `{mode}`. Seed: `{seed_id}`."
)

# ---------------------------------------------------------------------------
# Run similarity search
# ---------------------------------------------------------------------------
full_corpus = {seed_id: seed_structure, **corpus_structures}
engine = get_crystal_engine()

with st.spinner("Computing structural similarity…"):
    if mode == "fingerprint":
        results = engine.fingerprint_search(
            seed_id=seed_id, seed_structure=seed_structure,
            corpus=full_corpus, top_k=top_k,
        )
    else:
        results = engine.matcher_search(
            seed_id=seed_id, seed_structure=seed_structure,
            corpus=full_corpus, ltol=ltol, stol=stol,
            angle_tol=angle_tol, top_k=top_k,
        )

if not results:
    st.warning("No similar structures found. Try a larger corpus or different mode.")
    st.stop()

st.success(f"✅ Top **{len(results)}** similar structures found.")
st.divider()

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------
for res in results:
    mat_doc = corpus_docs_map.get(res.material_id)
    url = f"https://materialsproject.org/materials/{res.material_id}"
    pct = res.similarity_score * 100
    icon = "🟢" if pct >= 70 else ("🟡" if pct >= 40 else "🔴")

    with st.expander(
        f"#{res.rank}  **{res.material_id}**  |  `{res.formula}`  "
        f"—  {icon} **{pct:.1f}% similar**",
        expanded=(res.rank <= 2),
    ):
        col_crys, col_props = st.columns([1, 1], gap="large")

        with col_crys:
            st.markdown("**Crystal Structure Info**")
            cs_match = "✅" if res.crystal_system == (seed_doc.crystal_system or "") else "🔄"
            sg_match = "✅" if res.spacegroup == (seed_doc.spacegroup_symbol or "") else "🔄"
            st.markdown(f"{cs_match} Crystal System: **{res.crystal_system}**"
                        f"  ← seed: {seed_doc.crystal_system or 'N/A'}")
            st.markdown(f"{sg_match} Spacegroup: **{res.spacegroup}**"
                        f"  ← seed: {seed_doc.spacegroup_symbol or 'N/A'}")
            st.markdown(f"**Search Mode:** `{res.search_mode}`")
            st.markdown("**Similarity Score:**")
            st.progress(min(res.similarity_score, 1.0), text=f"{pct:.2f}%")
            st.markdown(f"[Open in Materials Project ↗]({url})")

        with col_props:
            if mat_doc:
                st.markdown("**Material Properties**")
                st.markdown(f"Formula: `{mat_doc.formula_pretty}`")
                st.markdown(
                    f"Stability: {'✅ Stable' if mat_doc.is_stable else '⚠️ Metastable'}"
                )
                if mat_doc.band_gap is not None:
                    st.markdown(f"Band Gap: {mat_doc.band_gap:.3f} eV")
                if mat_doc.density is not None:
                    st.markdown(f"Density: {mat_doc.density:.3f} g/cm³")
                if mat_doc.formation_energy_per_atom is not None:
                    st.markdown(f"Formation Energy: {mat_doc.formation_energy_per_atom:.4f} eV/atom")
                if mat_doc.energy_above_hull is not None:
                    st.markdown(f"E above hull: {mat_doc.energy_above_hull:.4f} eV/atom")
                if mat_doc.nsites is not None:
                    st.markdown(f"Sites: {mat_doc.nsites}  |  Elements: {mat_doc.nelements}")
            else:
                st.caption("Summary data not available for this material.")