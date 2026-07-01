"""
Page 6 — Property Correlation Explorer

Compute and visualize Pearson and Spearman correlations between material
properties over a user-defined corpus.

Workflow:
  1. Configure corpus (elements, stability, size) in the sidebar.
  2. Select properties and correlation method.
  3. Fetch corpus via CachedMPClient.
  4. Compute correlations with p-values via CorrelationAnalyzer.
  5. Tabs: Heatmap · Scatter Matrix · Strongest Correlations table.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

from resources import get_api_key, get_mp_client, render_api_key_sidebar
from search.correlation import (
    CORRELATABLE_PROPERTIES,
    CorrelationAnalyzer,
    corpus_to_dataframe,
)
from search.models import SUMMARY_FIELDS

st.set_page_config(
    page_title="Property Correlation · Materials Explorer",
    page_icon="📊",
    layout="wide",
)
st.title("📊 Property Correlation Explorer")
st.markdown(
    "Explore **pairwise correlations** between material properties. "
    "**Pearson r** measures linear correlation; "
    "**Spearman ρ** measures monotonic correlation (robust to outliers)."
)

render_api_key_sidebar()
api_key = get_api_key()
if not api_key:
    st.warning("⚠️ Configure your Materials Project API key in the sidebar.")
    st.stop()

# ---------------------------------------------------------------------------
# Sidebar
# ---------------------------------------------------------------------------
with st.sidebar:
    st.divider()
    st.header("⚙️ Corpus Configuration")
    elements_input = st.text_input(
        "Required elements (comma-separated)",
        placeholder="e.g.  O, Fe",
        help="Only materials containing ALL of these elements.",
    )
    stability_filter = st.checkbox("Stable materials only (eah ≤ 0)", value=False)
    corpus_size = st.slider("Max corpus size", 50, 500, 200, step=50)

    st.divider()
    st.header("🔬 Analysis Settings")
    selected_props = st.multiselect(
        "Properties to correlate",
        options=list(CORRELATABLE_PROPERTIES.keys()),
        default=["band_gap", "formation_energy_per_atom", "density", "energy_above_hull"],
        format_func=lambda k: CORRELATABLE_PROPERTIES[k],
    )
    method = st.radio(
        "Correlation method",
        options=["pearson", "spearman", "both"],
        format_func=lambda m: {
            "pearson": "Pearson r (linear)",
            "spearman": "Spearman ρ (monotonic)",
            "both": "Both",
        }[m],
    )
    min_valid = st.number_input(
        "Min valid pairs per property pair",
        min_value=3, max_value=200, value=10,
        help="Pairs with fewer valid samples are excluded from the table.",
    )

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
run = st.button("📊 Compute Correlations", type="primary")

if not run:
    st.info(
        "Configure the corpus and properties in the sidebar, "
        "then press **Compute Correlations**."
    )
    st.stop()

if len(selected_props) < 2:
    st.error("Select at least 2 properties to compute correlations.")
    st.stop()
if not elements_input.strip():
    st.error("Specify at least one element to bound the corpus size.")
    st.stop()

# ---------------------------------------------------------------------------
# Fetch corpus
# ---------------------------------------------------------------------------
client = get_mp_client(api_key)
fetch_filters: dict = {
    "elements": [e.strip() for e in elements_input.split(",") if e.strip()],
}
if stability_filter:
    fetch_filters["energy_above_hull"] = (None, 0.0)

with st.spinner("Fetching corpus from Materials Project…"):
    try:
        corpus = client.search(fields=SUMMARY_FIELDS, **fetch_filters)
        corpus = corpus[:corpus_size]
    except Exception as exc:
        st.error(f"MP API error: {exc}")
        st.stop()

if not corpus:
    st.warning("No materials returned. Broaden element selection or disable stability filter.")
    st.stop()

df = corpus_to_dataframe(corpus)
st.caption(
    f"Corpus: **{len(df)}** materials. "
    f"Properties: **{len(selected_props)}**. "
    f"Method: **{'Pearson + Spearman' if method == 'both' else method.capitalize()}**."
)

# ---------------------------------------------------------------------------
# Compute correlations
# ---------------------------------------------------------------------------
analyzer = CorrelationAnalyzer()
with st.spinner("Computing correlations…"):
    result = analyzer.compute(df, selected_props)

valid_counts = list(result.n_pair_valid.values())
st.success(
    f"✅ Done. Valid pair counts: "
    f"{min(valid_counts, default=0)}–{max(valid_counts, default=0)} materials per pair."
)
st.divider()

methods_to_show = ["pearson", "spearman"] if method == "both" else [method]

# ---------------------------------------------------------------------------
# Tabs
# ---------------------------------------------------------------------------
tab_heat, tab_scatter, tab_pairs = st.tabs(
    ["🟦 Correlation Heatmap", "⚫ Scatter Matrix", "🏆 Strongest Correlations"]
)

# ---- Heatmap ----
with tab_heat:
    for m in methods_to_show:
        mat = result.pearson if m == "pearson" else result.spearman
        title = f"{'Pearson r' if m == 'pearson' else 'Spearman ρ'} — Correlation Matrix"
        display = np.where(np.isnan(mat), 0.0, mat)
        text = [
            [f"{display[i,j]:.2f}" if not np.isnan(mat[i,j]) else "N/A"
             for j in range(len(selected_props))]
            for i in range(len(selected_props))
        ]
        fig_h = go.Figure(go.Heatmap(
            z=display, x=result.property_labels, y=result.property_labels,
            colorscale="RdBu", zmid=0, zmin=-1, zmax=1,
            text=text, texttemplate="%{text}",
            colorbar=dict(title="r", thickness=14),
        ))
        fig_h.update_layout(
            title=dict(text=title, x=0.5),
            height=380 + 25 * len(selected_props),
            margin=dict(l=10, r=10, t=50, b=10),
            paper_bgcolor="rgba(0,0,0,0)",
            xaxis=dict(tickangle=-35),
        )
        st.plotly_chart(fig_h, use_container_width=True,
                        config={"displayModeBar": False}, key=f"heatmap_{m}")
    st.caption(
        "🔴 Red = positive correlation  ·  🔵 Blue = negative correlation  ·  "
        "White = no linear relationship  ·  N/A = fewer than 3 valid pairs."
    )

# ---- Scatter Matrix ----
with tab_scatter:
    st.markdown("**Pairwise Scatter Matrix**")
    st.caption(
        "Each point = one material. Colour: 🟢 stable / 🔴 metastable. "
        "Only lower triangle shown. Hover for material details."
    )
    plot_df = df[selected_props + ["is_stable", "formula"]].copy()
    plot_df["Stability"] = plot_df["is_stable"].map({1: "Stable", 0: "Metastable"})

    fig_splom = px.scatter_matrix(
        plot_df,
        dimensions=selected_props,
        color="Stability",
        color_discrete_map={"Stable": "#2ECC71", "Metastable": "#E74C3C"},
        labels={p: CORRELATABLE_PROPERTIES.get(p, p) for p in selected_props},
        hover_data=["formula"],
        opacity=0.55,
    )
    fig_splom.update_traces(
        diagonal_visible=True,
        showupperhalf=False,
        marker=dict(size=4),
    )
    fig_splom.update_layout(
        height=max(420, 140 * len(selected_props)),
        margin=dict(l=10, r=10, t=30, b=10),
        paper_bgcolor="rgba(0,0,0,0)",
        legend=dict(orientation="h", yanchor="bottom", y=1.01, xanchor="right", x=1),
    )
    st.plotly_chart(fig_splom, use_container_width=True,
                    config={"displayModeBar": False}, key="splom")

# ---- Strongest Correlations ----
with tab_pairs:
    for m in methods_to_show:
        label = "Pearson r" if m == "pearson" else "Spearman ρ"
        pairs = result.strongest_pairs(method=m, n=15, min_valid=int(min_valid))
        st.subheader(f"Strongest Correlations — {label}")

        if not pairs:
            st.info(f"No pairs with ≥ {min_valid} valid samples. Reduce **Min valid pairs**.")
            continue

        rows = []
        for p in pairs:
            rows.append({
                "Property A": p["label_a"],
                "Property B": p["label_b"],
                "r": p["r"],
                "|r|": round(p["abs_r"], 4),
                "p-value": p["p_value"],
                "p < 0.05": "✅" if p["significant"] else "—",
                "N valid": p["n_valid"],
            })
        pairs_df = pd.DataFrame(rows).sort_values("|r|", ascending=False)
        st.dataframe(pairs_df, use_container_width=True, hide_index=True)
        st.caption(
            f"**r** = {label} coefficient · "
            f"**p-value** = two-tailed significance test · "
            f"**N valid** = materials with data for both properties."
        )