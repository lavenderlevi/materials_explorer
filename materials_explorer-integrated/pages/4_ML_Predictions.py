"""
Page 4 — ML Predictions
Predict band gap, formation energy, and bulk modulus from chemical formula.

Workflow:
  1. Sidebar: view model status (R², training size) per target.
  2. Sidebar: train/retrain models (requires API key + scikit-learn).
  3. Main: input formula → predict → display results with CI bars +
     feature importance chart.
"""

from __future__ import annotations

import plotly.graph_objects as go
import streamlit as st

from resources import get_api_key, get_ml_predictor
from search.ml_predict import FEATURE_NAMES, TARGET_UNITS, ElementFeaturizer, PredictionResult

st.set_page_config(
    page_title="ML Predictions · Materials Explorer",
    page_icon="🤖",
    layout="wide",
)
st.title("🤖 ML Property Predictions")
st.markdown(
    "Predict **band gap**, **formation energy**, and **bulk modulus** from a "
    "chemical formula using Gradient Boosting models trained on Materials Project data."
)

api_key = get_api_key()

# ---------------------------------------------------------------------------
# Sidebar — model status and training controls
# ---------------------------------------------------------------------------
with st.sidebar:
    st.header("🧮 Model Status")

    predictor = get_ml_predictor(api_key)
    status = predictor.model_status()

    _TARGET_LABELS = {
        "band_gap": "Band Gap",
        "formation_energy_per_atom": "Formation Energy",
        "bulk_modulus": "Bulk Modulus",
    }

    for target, info in status.items():
        label = _TARGET_LABELS[target]
        if info["trained"]:
            st.success(
                f"✅ **{label}**  \n"
                f"n_train={info['n_train']} · R²={info['r2']:.3f}"
            )
        else:
            st.warning(f"❌ **{label}** — not trained")

    st.divider()
    st.subheader("⚙️ Training")

    if not api_key:
        st.info("Add your API key on the main page to enable training.")
    else:
        n_train = st.slider(
            "Training samples per model", 100, 1000, 500, step=100,
            help="Higher → better accuracy but slower API fetch + training.",
        )
        if st.button("🚀 Train All Models", type="primary"):
            predictor._api_key = api_key
            predictor._n_train = n_train
            with st.spinner("Training models… this may take 2-5 minutes."):
                try:
                    predictor.train_all()
                    st.success("✅ All models trained and saved.")
                    st.rerun()
                except Exception as exc:
                    st.error(f"Training failed: {exc}")

        st.caption(
            "Models are saved to `./models/` and loaded automatically on restart. "
            "Re-train only if you want a larger or refreshed dataset."
        )

# ---------------------------------------------------------------------------
# Main — formula input
# ---------------------------------------------------------------------------
col_input, col_btn = st.columns([5, 1])
formula_raw = col_input.text_input(
    "Chemical Formula",
    placeholder="e.g.  Fe2O3  ·  LiFePO4  ·  GaAs  ·  BaTiO3",
    label_visibility="collapsed",
)
predict_clicked = col_btn.button("🔮 Predict", type="primary")

st.caption(
    "Enter any valid chemical formula. Predictions use composition-statistics "
    "features — no crystal structure input required."
)

if not predict_clicked or not formula_raw.strip():
    st.info("Enter a formula above and press **Predict**.")
    if not any(info["trained"] for info in status.values()):
        st.warning(
            "⚠️ No models are trained yet. Add your API key and press "
            "**Train All Models** in the sidebar."
        )
    st.stop()

# Validate formula before predicting
formula = formula_raw.strip()
try:
    test_feat = ElementFeaturizer().featurize(formula)
except ValueError as exc:
    st.error(f"Invalid formula: {exc}")
    st.stop()

# ---------------------------------------------------------------------------
# Predict
# ---------------------------------------------------------------------------
with st.spinner(f"Predicting properties for `{formula}`…"):
    preds = predictor.predict(formula)

any_result = any(v is not None for v in preds.values())
if not any_result:
    st.error(
        "No predictions available. Train at least one model in the sidebar "
        "(requires API key)."
    )
    st.stop()

st.subheader(f"Predictions for `{formula}`")
st.divider()

# ---------------------------------------------------------------------------
# Result metrics — 3 columns
# ---------------------------------------------------------------------------
cols = st.columns(3)
_ICONS = {"band_gap": "⚡", "formation_energy_per_atom": "🔋", "bulk_modulus": "🏋️"}

for col, target in zip(cols, TARGET_UNITS.keys()):
    pred: PredictionResult | None = preds[target]
    label = _TARGET_LABELS[target]
    unit = TARGET_UNITS[target]

    with col:
        st.markdown(f"### {_ICONS[target]} {label}")
        if pred is None:
            st.warning("Model not trained")
        else:
            st.metric(
                label=f"Predicted ({unit})",
                value=f"{pred.value:.4f}",
                delta=f"±{(pred.ci_high - pred.ci_low) / 2:.4f} (90% CI)",
            )
            # CI bar visualization
            ci_range = pred.ci_high - pred.ci_low
            ci_fig = go.Figure()
            ci_fig.add_trace(go.Bar(
                x=[ci_range], y=[""],
                orientation="h",
                base=[pred.ci_low],
                marker_color="#3498DB",
                opacity=0.4,
                name="90% CI",
                text=f"[{pred.ci_low:.3f}, {pred.ci_high:.3f}] {unit}",
                textposition="inside",
            ))
            ci_fig.add_trace(go.Scatter(
                x=[pred.value], y=[""],
                mode="markers",
                marker=dict(color="#E74C3C", size=14, symbol="diamond"),
                name="Prediction",
            ))
            ci_fig.update_layout(
                height=90, margin=dict(l=0, r=0, t=0, b=0),
                showlegend=False,
                paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
                xaxis=dict(showgrid=False, zeroline=False),
                yaxis=dict(showticklabels=False),
            )
            st.plotly_chart(
                ci_fig, use_container_width=True,
                config={"displayModeBar": False},
                key=f"ci_{target}",
            )
            st.caption(
                f"Training set: **{pred.n_train}** materials  |  "
                f"R² (validation): **{pred.r2_score:.3f}**"
            )

st.divider()

# ---------------------------------------------------------------------------
# Feature importance (band_gap model — usually best R²)
# ---------------------------------------------------------------------------
best_target = max(
    (t for t in TARGET_UNITS if preds[t] is not None),
    key=lambda t: preds[t].r2_score if preds[t] else -1,
    default=None,
)

if best_target:
    importances = predictor.feature_importances(best_target)
    if importances:
        sorted_items = sorted(importances.items(), key=lambda x: x[1], reverse=True)
        feat_labels, feat_vals = zip(*sorted_items)

        imp_fig = go.Figure(go.Bar(
            x=feat_vals, y=feat_labels, orientation="h",
            marker_color="#2ECC71",
            text=[f"{v:.3f}" for v in feat_vals],
            textposition="outside",
        ))
        imp_fig.update_layout(
            title=dict(
                text=f"Feature Importances ({_TARGET_LABELS[best_target]} model)",
                x=0.5,
            ),
            height=360, margin=dict(l=10, r=60, t=40, b=10),
            xaxis=dict(showgrid=False, zeroline=False, showticklabels=False),
            yaxis=dict(autorange="reversed"),
            paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
            font=dict(size=12),
        )
        st.plotly_chart(imp_fig, use_container_width=True,
                        config={"displayModeBar": False}, key="feat_imp")

        st.caption(
            "**How to read this:** Features are composition-weighted statistics over "
            "element properties. `X_mean` = mean Pauling electronegativity; "
            "`Z_mean` = mean atomic number; `radius_mean` = mean atomic radius."
        )

# ---------------------------------------------------------------------------
# Feature vector (transparent display)
# ---------------------------------------------------------------------------
with st.expander("🔬 View raw feature vector", expanded=False):
    feat_vec = ElementFeaturizer().featurize(formula)
    rows = {name: round(float(val), 5) for name, val in zip(FEATURE_NAMES, feat_vec)}
    col_a, col_b = st.columns(2)
    items = list(rows.items())
    for i, (k, v) in enumerate(items):
        (col_a if i < len(items) // 2 else col_b).markdown(f"`{k}` = **{v}**")