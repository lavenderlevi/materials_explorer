"""
Page 3 — Similar Materials Engine
Given a seed material ID, find the most property-similar materials
in the same element system.

Workflow:
  1. User inputs a seed material ID.
  2. Seed is fetched from MP API.
  3. Corpus of same-element-system materials is fetched.
  4. SimilarMaterialsEngine ranks corpus by feature-vector similarity.
  5. Results shown with: similarity score, feature diffs (progress bars),
     and a Plotly radar chart comparing seed vs top-3.
"""

from __future__ import annotations

import plotly.graph_objects as go
import streamlit as st

from resources import get_api_key, get_mp_client, get_similarity_engine
from search.models import SUMMARY_FIELDS
from search.similarity import SimilarityMetric

st.set_page_config(
    page_title="Similar Materials · Materials Explorer",
    page_icon="🔬",
    layout="wide",
)
st.title("🔬 Similar Materials Engine")
st.markdown(
    "Find materials with the most similar **numeric property profile** to a seed."
)

# ---------------------------------------------------------------------------
# API key guard
# ---------------------------------------------------------------------------
api_key = get_api_key()
if not api_key:
    st.warning("⚠️ Configure your Materials Project API key on the main page.")
    st.stop()

# ---------------------------------------------------------------------------
# Sidebar
# ---------------------------------------------------------------------------
with st.sidebar:
    st.header("⚙️ Configuration")

    metric_val = st.selectbox(
        "Similarity Metric",
        options=[m.value for m in SimilarityMetric],
        index=2,
        help="weighted_cosine applies domain-tuned weights (recommended).",
    )
    top_k = st.slider("Top results", 5, 20, 10)
    corpus_size = st.slider("Corpus size", 50, 300, 100, step=50)
    stability_filter = st.checkbox("Stable materials only (eah ≤ 0)", False)

    st.divider()
    st.subheader("Feature Weights (weighted_cosine)")
    weights_info = {
        "band_gap": "25%", "formation_energy": "20%",
        "energy_above_hull": "20%", "density": "15%",
        "volume": "10%", "nsites": "5%", "nelements": "5%",
    }
    for feat, w in weights_info.items():
        st.caption(f"`{feat}` → **{w}**")

# ---------------------------------------------------------------------------
# Seed input
# ---------------------------------------------------------------------------
col_id, col_btn = st.columns([5, 1])
seed_id_raw = col_id.text_input(
    "Seed Material ID",
    placeholder="e.g.  mp-149  (Silicon)",
    label_visibility="collapsed",
)
run = col_btn.button("🔍 Find", type="primary")

if not run or not seed_id_raw.strip():
    st.info("Enter a Materials Project ID above and press **Find**.")
    st.stop()

# ---------------------------------------------------------------------------
# Fetch seed
# ---------------------------------------------------------------------------
client = get_mp_client(api_key)
seed_id = seed_id_raw.strip().lower()

with st.spinner(f"Fetching seed material `{seed_id}`…"):
    seed = client.get_by_id(seed_id, fields=SUMMARY_FIELDS)

if seed is None:
    st.error(f"Material `{seed_id}` not found. Verify the ID format (e.g. `mp-149`).")
    st.stop()

# Seed summary banner
with st.expander(
    f"**Seed: {seed.material_id}** — `{seed.formula_pretty}` — "
    f"{'✅ Stable' if seed.is_stable else '⚠️ Metastable'}",
    expanded=True,
):
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Band Gap", f"{seed.band_gap:.3f} eV" if seed.band_gap is not None else "N/A")
    c2.metric("Density", f"{seed.density:.3f} g/cm³" if seed.density is not None else "N/A")
    c3.metric("E above hull",
              f"{seed.energy_above_hull:.4f} eV/at" if seed.energy_above_hull is not None else "N/A")
    c4.metric("Formation E",
              f"{seed.formation_energy_per_atom:.4f} eV/at"
              if seed.formation_energy_per_atom is not None else "N/A")
    st.markdown(
        f"**Crystal System:** {seed.crystal_system or 'N/A'}  |  "
        f"**Spacegroup:** {seed.spacegroup_symbol or 'N/A'}  |  "
        f"**Elements:** {', '.join(seed.elements)}  |  "
        f"**Sites:** {seed.nsites}"
    )

# ---------------------------------------------------------------------------
# Fetch corpus (same element system)
# ---------------------------------------------------------------------------
corpus_filters: dict = {"elements": list(seed.elements)}
if stability_filter:
    corpus_filters["energy_above_hull"] = (None, 0.0)

with st.spinner(f"Fetching corpus (elements: {list(seed.elements)})…"):
    try:
        corpus = client.search(fields=SUMMARY_FIELDS, **corpus_filters)
        corpus = corpus[:corpus_size]
    except Exception as exc:
        st.error(f"API error: {exc}")
        st.stop()

if len(corpus) < 2:
    st.warning("Corpus too small. Disable the stability filter or increase corpus size.")
    st.stop()

st.caption(
    f"Corpus: **{len(corpus)}** materials in the `{'-'.join(sorted(seed.elements))}` element space. "
    f"Metric: `{metric_val}`."
)

# ---------------------------------------------------------------------------
# Similarity search
# ---------------------------------------------------------------------------
with st.spinner("Computing feature vectors and similarity scores…"):
    engine = get_similarity_engine(metric=SimilarityMetric(metric_val))
    results = engine.find_similar(seed=seed, corpus=corpus, top_k=top_k)

if not results:
    st.warning("No similar materials found. Try a larger corpus or different metric.")
    st.stop()

st.success(f"✅ Found **{len(results)}** similar materials.")
st.divider()

# ---------------------------------------------------------------------------
# Radar chart — seed vs top-3
# ---------------------------------------------------------------------------
_RADAR_FEATURES = [
    ("band_gap", "Band Gap"),
    ("density", "Density"),
    ("formation_energy_per_atom", "Form. Energy"),
    ("energy_above_hull", "E hull"),
    ("volume", "Volume"),
]


def _radar_chart(seed, top3: list) -> go.Figure:
    all_mats = [seed] + [r.material for r in top3]

    raw: dict[str, list[float]] = {f: [] for f, _ in _RADAR_FEATURES}
    for mat in all_mats:
        raw["band_gap"].append(mat.band_gap or 0.0)
        raw["density"].append(mat.density or 0.0)
        raw["formation_energy_per_atom"].append(mat.formation_energy_per_atom or 0.0)
        raw["energy_above_hull"].append(mat.energy_above_hull or 0.0)
        raw["volume"].append(mat.volume or 0.0)

    def _minmax(vals: list[float]) -> list[float]:
        lo, hi = min(vals), max(vals)
        return [(v - lo) / (hi - lo) if hi > lo else 0.5 for v in vals]

    normed = {f: _minmax(v) for f, v in raw.items()}
    labels = [lbl for _, lbl in _RADAR_FEATURES]
    colors = ["#2ECC71", "#3498DB", "#E74C3C", "#F39C12"]
    names = [f"Seed ({seed.formula_pretty})"] + [r.material.formula_pretty for r in top3]

    fig = go.Figure()
    for idx, (name, color) in enumerate(zip(names, colors)):
        vals = [normed[f][idx] for f, _ in _RADAR_FEATURES]
        vals += vals[:1]
        fig.add_trace(go.Scatterpolar(
            r=vals, theta=labels + [labels[0]],
            fill="toself", name=name,
            line=dict(color=color), opacity=0.75,
        ))

    fig.update_layout(
        polar=dict(radialaxis=dict(visible=True, range=[0, 1])),
        showlegend=True, height=420,
        title=dict(text="Property Radar: Seed vs Top-3 Similar", x=0.5),
        paper_bgcolor="rgba(0,0,0,0)",
        margin=dict(l=40, r=40, t=60, b=20),
    )
    return fig


col_radar, col_summary = st.columns([1, 1])

with col_radar:
    st.plotly_chart(
        _radar_chart(seed, results[:3]),
        use_container_width=True,
        config={"displayModeBar": False},
        key="radar_chart",
    )

with col_summary:
    st.markdown("### Top Results")
    for res in results[:8]:
        mat = res.material
        pct = res.similarity_score * 100
        icon = "🟢" if pct >= 70 else ("🟡" if pct >= 50 else "🔴")
        url = f"https://materialsproject.org/materials/{mat.material_id}"
        st.markdown(
            f"{icon} **#{res.rank}** [{mat.material_id}]({url}) — "
            f"`{mat.formula_pretty}` — **{pct:.1f}%**"
        )

st.divider()

# ---------------------------------------------------------------------------
# Full result cards with feature diffs
# ---------------------------------------------------------------------------
st.markdown("### Detailed Results")

for res in results:
    mat = res.material
    pct = res.similarity_score * 100
    icon = "🟢" if pct >= 70 else ("🟡" if pct >= 50 else "🔴")
    url = f"https://materialsproject.org/materials/{mat.material_id}"

    with st.expander(
        f"#{res.rank}  **{mat.material_id}**  |  `{mat.formula_pretty}`  "
        f"—  {icon} **{pct:.1f}% similar**",
        expanded=False,
    ):
        col_props, col_diffs = st.columns([1, 1])

        with col_props:
            st.markdown(f"**ID:** [{mat.material_id}]({url})")
            st.markdown(f"**Stability:** {'✅ Stable' if mat.is_stable else '⚠️ Metastable'}")
            if mat.band_gap is not None:
                st.markdown(f"**Band Gap:** {mat.band_gap:.3f} eV")
            if mat.density is not None:
                st.markdown(f"**Density:** {mat.density:.3f} g/cm³")
            if mat.energy_above_hull is not None:
                st.markdown(f"**E above hull:** {mat.energy_above_hull:.4f} eV/atom")
            if mat.formation_energy_per_atom is not None:
                st.markdown(f"**Formation Energy:** {mat.formation_energy_per_atom:.4f} eV/atom")
            if mat.crystal_system:
                st.markdown(f"**Crystal System:** {mat.crystal_system}")

        with col_diffs:
            st.markdown("**Feature Match (normalized)**")
            for diff in res.feature_diffs:
                sv = f"{diff.seed_value:.3f}" if diff.seed_value is not None else "N/A"
                cv = f"{diff.candidate_value:.3f}" if diff.candidate_value is not None else "N/A"
                st.markdown(f"`{diff.feature}` — seed: **{sv}** → candidate: **{cv}**")
                st.progress(
                    value=diff.match_pct,
                    text=f"{diff.match_pct * 100:.0f}% match",
                )