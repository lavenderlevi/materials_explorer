/**
 * MLPredictions.jsx  —  Tab 4
 * Predict band gap, formation energy, and bulk modulus from a chemical
 * formula using Quantile Gradient Boosting models (p10/p50/p90).
 *
 * Data contract (mirrors Python search/ml_predict.py):
 *   FEATURE_NAMES: 11-dim composition-stats vector
 *     [Z_mean, Z_std, X_mean, X_std, radius_mean, radius_std,
 *      row_mean, row_std, group_mean, group_std, n_elements]
 *   TARGET_UNITS: { band_gap: "eV", formation_energy_per_atom: "eV/atom",
 *                   bulk_modulus: "GPa" }
 *   PredictionResult { target, value (p50), ci_low (p10), ci_high (p90),
 *                       unit, n_train, r2_score }
 *   model_status(): { [target]: { trained, n_train?, r2?, file_exists? } }
 *   feature_importances(target): { [feature_name]: importance }
 *
 * Animations: GSAP mount stagger, Framer Motion NumberTicker for predicted
 * values, animated CI range bar with diamond marker, horizontal bar chart
 * draw-in for feature importances, AnimateHeight raw feature vector panel.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence, useMotionValue, useSpring } from "framer-motion";
import { gsap } from "gsap";

// ─── Design tokens ──────────────────────────────────────────────────────────
const T = {
  bgPage:        "#09090B",
  bgCard:        "#0F172A",
  border:        "rgba(148,163,184,0.12)",
  borderFocus:   "rgba(6,182,212,0.45)",
  accent:        "#06B6D4",
  accentDim:     "rgba(6,182,212,0.10)",
  accentGlow:    "rgba(6,182,212,0.20)",
  teal:          "#14B8A6",
  indigo:        "#6366F1",
  textPrimary:   "#F1F5F9",
  textSecondary: "#CBD5E1",
  textMuted:     "#64748B",
  textLabel:     "#94A3B8",
  success:       "#22C55E",
  warning:       "#F59E0B",
  danger:        "#EF4444",
  mono:          "'JetBrains Mono', 'Geist Mono', monospace",
  sans:          "'Inter', 'Geist', system-ui, sans-serif",
};

// ─── Constants mirrored from Python ────────────────────────────────────────────
const FEATURE_NAMES = [
  "Z_mean", "Z_std", "X_mean", "X_std", "radius_mean", "radius_std",
  "row_mean", "row_std", "group_mean", "group_std", "n_elements",
];

const TARGET_META = {
  band_gap: { label: "Band Gap", unit: "eV" },
  formation_energy_per_atom: { label: "Formation Energy", unit: "eV/atom" },
  bulk_modulus: { label: "Bulk Modulus", unit: "GPa" },
};
const TARGETS = Object.keys(TARGET_META);

const TARGET_ICONS = {
  band_gap: (color) => (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M11 2L4 12h5l-1 6 7-10h-5l1-6z" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/></svg>
  ),
  formation_energy_per_atom: (color) => (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none"><rect x="6" y="3" width="8" height="5" rx="1" stroke={color} strokeWidth="1.5"/><path d="M8 8v4a2 2 0 002 2 2 2 0 002-2V8" stroke={color} strokeWidth="1.5"/><rect x="5" y="14" width="10" height="4" rx="1" stroke={color} strokeWidth="1.5"/></svg>
  ),
  bulk_modulus: (color) => (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke={color} strokeWidth="1.5"/><path d="M7 10h6M10 7v6" stroke={color} strokeWidth="1.3" strokeLinecap="round"/></svg>
  ),
};

function r2Color(r2) {
  if (r2 >= 0.8) return T.success;
  if (r2 >= 0.5) return T.warning;
  return T.danger;
}

// ─── Number ticker ──────────────────────────────────────────────────────────
function NumberTicker({ value, decimals = 4, suffix = "", prefix = "" }) {
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { stiffness: 70, damping: 18 });
  const [display, setDisplay] = useState(prefix + (0).toFixed(decimals) + suffix);
  useEffect(() => { mv.set(value); }, [value, mv]);
  useEffect(() => spring.on("change", v => setDisplay(prefix + v.toFixed(decimals) + suffix)), [spring, decimals, suffix, prefix]);
  return <span>{display}</span>;
}

// ─── Model status pill (sidebar-equivalent, shown in config card) ──────────────
function ModelStatusPill({ target, info }) {
  const meta = TARGET_META[target];
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "8px 10px", borderRadius: "7px",
      background: info.trained ? "rgba(34,197,94,0.06)" : "rgba(148,163,184,0.04)",
      border: `1px solid ${info.trained ? "rgba(34,197,94,0.18)" : T.border}`,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
        <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: info.trained ? T.success : T.textMuted, flexShrink: 0 }} />
        <span style={{ fontFamily: T.sans, fontSize: "11.5px", color: T.textSecondary, fontWeight: 500 }}>{meta.label}</span>
      </div>
      {info.trained ? (
        <span style={{ fontFamily: T.mono, fontSize: "10px", color: r2Color(info.r2) }}>
          R² {info.r2.toFixed(3)} · n={info.n_train}
        </span>
      ) : (
        <span style={{ fontFamily: T.sans, fontSize: "10px", color: T.textMuted }}>not trained</span>
      )}
    </div>
  );
}

// ─── CI range bar with diamond marker ─────────────────────────────────────────
function CIRangeBar({ ciLow, value, ciHigh, color }) {
  // Normalize to a [0,1] track relative to [ciLow, ciHigh] padded by 15%
  const pad = (ciHigh - ciLow) * 0.2 || 0.5;
  const lo = ciLow - pad;
  const hi = ciHigh + pad;
  const span = hi - lo || 1;
  const toPct = (v) => ((v - lo) / span) * 100;

  return (
    <div style={{ position: "relative", height: "28px", marginTop: "6px" }}>
      {/* Track */}
      <div style={{ position: "absolute", top: "12px", left: 0, right: 0, height: "3px", background: "rgba(148,163,184,0.10)", borderRadius: "2px" }} />
      {/* CI range fill */}
      <motion.div
        initial={{ width: 0, left: `${toPct(ciLow)}%` }}
        animate={{ width: `${toPct(ciHigh) - toPct(ciLow)}%`, left: `${toPct(ciLow)}%` }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        style={{ position: "absolute", top: "12px", height: "3px", background: color, opacity: 0.4, borderRadius: "2px" }}
      />
      {/* Diamond marker at p50 */}
      <motion.div
        initial={{ left: "50%", opacity: 0 }}
        animate={{ left: `${toPct(value)}%`, opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
        style={{
          position: "absolute", top: "7px", width: "10px", height: "10px",
          background: color, transform: "translateX(-50%) rotate(45deg)",
          borderRadius: "2px", boxShadow: `0 0 8px ${color}88`,
        }}
      />
      {/* Bound labels */}
      <div style={{ position: "absolute", top: "20px", left: `${toPct(ciLow)}%`, transform: "translateX(-50%)", fontFamily: T.mono, fontSize: "9px", color: T.textMuted, whiteSpace: "nowrap" }}>
        {ciLow.toFixed(3)}
      </div>
      <div style={{ position: "absolute", top: "20px", left: `${toPct(ciHigh)}%`, transform: "translateX(-50%)", fontFamily: T.mono, fontSize: "9px", color: T.textMuted, whiteSpace: "nowrap" }}>
        {ciHigh.toFixed(3)}
      </div>
    </div>
  );
}

// ─── Prediction card (one of three targets) ────────────────────────────────────
function PredictionCard({ target, pred, index }) {
  const meta = TARGET_META[target];
  const color = [T.accent, T.teal, T.indigo][index % 3];

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.08, ease: [0.22, 1, 0.36, 1] }}
      style={{
        background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px",
        padding: "16px", display: "flex", flexDirection: "column", gap: "10px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <div style={{ width: "26px", height: "26px", borderRadius: "7px", background: `${color}1a`, border: `1px solid ${color}33`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          {TARGET_ICONS[target](color)}
        </div>
        <span style={{ fontFamily: T.sans, fontSize: "12.5px", fontWeight: 600, color: T.textPrimary }}>
          {meta.label}
        </span>
      </div>

      {pred === null || pred === undefined ? (
        <div style={{
          padding: "14px", textAlign: "center", borderRadius: "7px",
          background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.18)",
        }}>
          <span style={{ fontFamily: T.sans, fontSize: "11.5px", color: "#fcd34d" }}>
            Model not trained
          </span>
        </div>
      ) : (
        <>
          <div>
            <div style={{ fontFamily: T.mono, fontSize: "26px", fontWeight: 600, color: T.textPrimary, lineHeight: 1.1 }}>
              <NumberTicker value={pred.value} decimals={4} />
              <span style={{ fontSize: "13px", color: T.textMuted, marginLeft: "5px", fontWeight: 400 }}>{meta.unit}</span>
            </div>
            <div style={{ fontFamily: T.sans, fontSize: "10.5px", color: T.textMuted, marginTop: "3px" }}>
              ± {((pred.ci_high - pred.ci_low) / 2).toFixed(4)} (90% CI)
            </div>
          </div>

          <CIRangeBar ciLow={pred.ci_low} value={pred.value} ciHigh={pred.ci_high} color={color} />

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "4px", paddingTop: "10px", borderTop: `1px solid ${T.border}` }}>
            <span style={{ fontFamily: T.sans, fontSize: "10.5px", color: T.textMuted }}>
              Training set: <span style={{ fontFamily: T.mono, color: T.textLabel }}>{pred.n_train}</span>
            </span>
            <span style={{ fontFamily: T.sans, fontSize: "10.5px", color: T.textMuted }}>
              R²: <span style={{ fontFamily: T.mono, color: r2Color(pred.r2_score) }}>{pred.r2_score.toFixed(3)}</span>
            </span>
          </div>
        </>
      )}
    </motion.div>
  );
}

// ─── Feature importance bar chart ──────────────────────────────────────────────
function FeatureImportanceChart({ importances, targetLabel }) {
  const sorted = Object.entries(importances).sort((a, b) => b[1] - a[1]);
  const maxVal = Math.max(...sorted.map(([, v]) => v), 0.001);

  return (
    <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px" }}>
      <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "2px" }}>
        Feature importances
      </div>
      <div style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel, marginBottom: "14px" }}>
        {targetLabel} model
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {sorted.map(([name, value], i) => (
          <div key={name} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontFamily: T.mono, fontSize: "10.5px", color: T.textSecondary, width: "84px", flexShrink: 0, textAlign: "right" }}>
              {name}
            </span>
            <div style={{ flex: 1, height: "14px", background: "rgba(148,163,184,0.06)", borderRadius: "3px", overflow: "hidden", position: "relative" }}>
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${(value / maxVal) * 100}%` }}
                transition={{ duration: 0.6, delay: 0.1 + i * 0.04, ease: [0.22, 1, 0.36, 1] }}
                style={{ height: "100%", background: "linear-gradient(90deg, rgba(34,197,94,0.7), rgba(34,197,94,0.9))", borderRadius: "3px" }}
              />
            </div>
            <span style={{ fontFamily: T.mono, fontSize: "10px", color: T.textMuted, width: "44px", flexShrink: 0 }}>
              {value.toFixed(3)}
            </span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: `1px solid ${T.border}`, fontFamily: T.sans, fontSize: "10.5px", color: T.textMuted, lineHeight: 1.6 }}>
        Features are composition-weighted statistics over element properties.{" "}
        <span style={{ fontFamily: T.mono, color: T.textLabel }}>X_mean</span> = mean Pauling electronegativity;{" "}
        <span style={{ fontFamily: T.mono, color: T.textLabel }}>Z_mean</span> = mean atomic number;{" "}
        <span style={{ fontFamily: T.mono, color: T.textLabel }}>radius_mean</span> = mean atomic radius.
      </div>
    </div>
  );
}

// ─── Raw feature vector panel (collapsible) ────────────────────────────────────
function FeatureVectorPanel({ featureVector }) {
  const [open, setOpen] = useState(false);
  if (!featureVector) return null;

  return (
    <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", overflow: "hidden" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: "100%", background: "none", border: "none", cursor: "pointer", padding: "13px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M3 8l4-5 4 5-4 5-4-5z" stroke={T.textMuted} strokeWidth="1.4" strokeLinejoin="round"/><path d="M11 12l4-5 4 5-4 5-4-5z" stroke={T.textMuted} strokeWidth="1.4" strokeLinejoin="round"/></svg>
          <span style={{ fontFamily: T.sans, fontSize: "12.5px", fontWeight: 500, color: T.textSecondary }}>
            View raw feature vector
          </span>
        </div>
        <motion.svg animate={{ rotate: open ? 180 : 0 }} transition={{ type: "spring", stiffness: 300, damping: 28 }} width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ color: T.textMuted }}>
          <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </motion.svg>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ height: { type: "spring", stiffness: 280, damping: 30 }, opacity: { duration: 0.2 } }}
            style={{ overflow: "hidden" }}
          >
            <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${T.border}`, paddingTop: "12px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 20px" }}>
                {FEATURE_NAMES.map(name => (
                  <div key={name} style={{ display: "flex", justifyContent: "space-between", fontFamily: T.mono, fontSize: "11px" }}>
                    <span style={{ color: T.textMuted }}>{name}</span>
                    <span style={{ color: T.textPrimary, fontWeight: 500 }}>{featureVector[name]?.toFixed(5) ?? "—"}</span>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────
function EmptyState({ anyTrained }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 24px", textAlign: "center", gap: "12px" }}
    >
      <div style={{ width: "48px", height: "48px", borderRadius: "12px", background: T.accentDim, border: "1px solid rgba(6,182,212,0.18)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "4px" }}>
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <rect x="3" y="9" width="3" height="9" rx="0.8" stroke={T.accent} strokeWidth="1.5"/>
          <rect x="9.5" y="5" width="3" height="13" rx="0.8" stroke={T.accent} strokeWidth="1.5"/>
          <rect x="16" y="2" width="3" height="16" rx="0.8" stroke={T.accent} strokeWidth="1.5"/>
        </svg>
      </div>
      <div style={{ fontFamily: T.sans, fontSize: "14px", fontWeight: 500, color: T.textSecondary }}>
        Enter a chemical formula
      </div>
      <div style={{ fontFamily: T.sans, fontSize: "12px", color: T.textMuted, maxWidth: "340px", lineHeight: 1.6 }}>
        e.g. <span style={{ fontFamily: T.mono, color: T.textLabel }}>Fe2O3</span>,{" "}
        <span style={{ fontFamily: T.mono, color: T.textLabel }}>LiFePO4</span>,{" "}
        <span style={{ fontFamily: T.mono, color: T.textLabel }}>GaAs</span>,{" "}
        <span style={{ fontFamily: T.mono, color: T.textLabel }}>BaTiO3</span>.
        Predictions use composition-statistics features — no crystal structure required.
      </div>
      {!anyTrained && (
        <div style={{ marginTop: "6px", padding: "8px 14px", borderRadius: "7px", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.20)", fontFamily: T.sans, fontSize: "11.5px", color: "#fcd34d" }}>
          No models are trained yet. Configure training in the panel above.
        </div>
      )}
    </motion.div>
  );
}

// ─── Main MLPredictions component ──────────────────────────────────────────────
export default function MLPredictions() {
  const [formula, setFormula]         = useState("");
  const [modelStatus, setModelStatus] = useState(
    Object.fromEntries(TARGETS.map(t => [t, { trained: false, file_exists: false }]))
  );
  const [nTrain, setNTrain]           = useState(500);
  const [training, setTraining]       = useState(false);
  const [trainError, setTrainError]   = useState(null);
  const [hasApiKey, setHasApiKey]     = useState(true); // assume configured upstream

  const [predictions, setPredictions] = useState(null);   // { [target]: PredictionResult|null }
  const [featureVector, setFeatureVector] = useState(null);
  const [importances, setImportances] = useState(null);
  const [bestTarget, setBestTarget]   = useState(null);

  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [isFocused, setIsFocused]     = useState(false);

  const headerRef = useRef(null);

  useEffect(() => {
    if (!headerRef.current) return;
    const els = headerRef.current.querySelectorAll(".gsap-item");
    gsap.fromTo(els, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out", stagger: 0.06, delay: 0.05 });
  }, []);

  // Fetch model status on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/v1/predict/status");
        if (res.ok) {
          const data = await res.json();
          // API returns { targets: {target: {...}}, feature_names, target_units }
          setModelStatus(data.targets ?? modelStatus);
          setHasApiKey(true); // key is server-side, not exposed
        }
      } catch {
        // status fetch is best-effort; keep defaults
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTrain = useCallback(async () => {
    setTraining(true);
    setTrainError(null);
    try {
      const res = await fetch("/api/v1/predict/train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n_train: nTrain }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Training failed: HTTP ${res.status}`);
      }
      const data = await res.json();
      setModelStatus(data.status ?? modelStatus);
    } catch (err) {
      setTrainError(err.message);
    } finally {
      setTraining(false);
    }
  }, [nTrain, modelStatus]);

  const handlePredict = useCallback(async () => {
    const f = formula.trim();
    if (!f) { setError("Enter a chemical formula."); return; }

    setError(null);
    setLoading(true);
    setHasSearched(true);

    try {
      const res = await fetch("/api/v1/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ formula: f }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Invalid formula: HTTP ${res.status}`);
      }

      const data = await res.json();
      // API returns PredictAPIResponse: { formula, band_gap, formation_energy_per_atom, bulk_modulus }
      // Transform to { predictions: {target: detail}, feature_vector: null, importances: null }
      const preds = {
        band_gap: data.band_gap ?? null,
        formation_energy_per_atom: data.formation_energy_per_atom ?? null,
        bulk_modulus: data.bulk_modulus ?? null,
      };
      setPredictions(preds);
      setFeatureVector(null);
      setImportances(null);
      // Pick best_target as the one with highest r2_score
      const trained = Object.entries(preds).filter(([, v]) => v !== null);
      if (trained.length) {
        const best = trained.reduce((a, b) => (a[1].r2_score > b[1].r2_score ? a : b));
        setBestTarget(best[0]);
        // Fetch importances for best model
        try {
          const impRes = await fetch(`/api/v1/predict/importance?target=${best[0]}`);
          if (impRes.ok) { const impData = await impRes.json(); setImportances(impData.importances ?? null); }
        } catch {}
      }
    } catch (err) {
      setError(err.message);
      setPredictions(null);
    } finally {
      setLoading(false);
    }
  }, [formula]);

  const handleKeyDown = (e) => { if (e.key === "Enter" && !loading) handlePredict(); };

  const anyTrained = Object.values(modelStatus).some(s => s.trained);
  const anyPrediction = predictions && Object.values(predictions).some(v => v !== null);

  return (
    <>
      <style>{`
        .formula-input:focus { border-color: ${T.borderFocus} !important; box-shadow: 0 0 0 4px ${T.accentGlow}; outline: none; }
        .search-btn:hover:not(:disabled) { transform: translateY(-1px); background: rgba(6,182,212,0.90) !important; }
        .search-btn:active:not(:disabled) { transform: translateY(0); }
        .search-btn:disabled { opacity: 0.55; cursor: not-allowed; }
        .train-btn:hover:not(:disabled) { transform: translateY(-1px); border-color: rgba(6,182,212,0.5) !important; }
        .train-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .spring-range {
          -webkit-appearance: none; width: 100%; height: 3px; border-radius: 2px;
          background: linear-gradient(to right, ${T.accent} var(--pct), rgba(148,163,184,0.15) var(--pct));
          cursor: pointer;
        }
        .spring-range::-webkit-slider-thumb {
          -webkit-appearance: none; width: 13px; height: 13px; border-radius: 50%;
          background: ${T.accent}; border: 2px solid ${T.bgCard};
          box-shadow: 0 0 0 1px ${T.accent}; cursor: pointer; transition: transform 150ms;
        }
        .spring-range::-webkit-slider-thumb:hover { transform: scale(1.2); }
        .spring-range:disabled { opacity: 0.5; cursor: not-allowed; }

        @keyframes shimmer { 0% { background-position: -200% center; } 100% { background-position: 200% center; } }
        .btn-shimmer {
          background: linear-gradient(90deg, rgba(6,182,212,0.85) 25%, rgba(20,184,166,0.95) 50%, rgba(6,182,212,0.85) 75%);
          background-size: 200% auto; animation: shimmer 1.4s linear infinite;
        }
      `}</style>

      <div style={{ padding: "28px 32px", maxWidth: "1100px", margin: "0 auto" }}>

        {/* ── Header ── */}
        <div ref={headerRef} style={{ marginBottom: "24px" }}>
          <div className="gsap-item" style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: T.accentDim, border: "1px solid rgba(6,182,212,0.20)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <rect x="2" y="14" width="3" height="4" rx="0.8" stroke={T.accent} strokeWidth="1.5"/>
                <rect x="8.5" y="9" width="3" height="9" rx="0.8" stroke={T.accent} strokeWidth="1.5"/>
                <rect x="15" y="4" width="3" height="14" rx="0.8" stroke={T.accent} strokeWidth="1.5"/>
              </svg>
            </div>
            <h1 style={{ fontFamily: T.sans, fontSize: "17px", fontWeight: 600, color: T.textPrimary, margin: 0, letterSpacing: "-0.015em" }}>
              ML Property Predictions
            </h1>
          </div>
          <p className="gsap-item" style={{ fontFamily: T.sans, fontSize: "13px", color: T.textMuted, margin: 0, lineHeight: 1.6, maxWidth: "600px" }}>
            Predict band gap, formation energy, and bulk modulus from a chemical formula
            using Gradient Boosting models trained on Materials Project data.
          </p>
        </div>

        {/* ── Bento: formula input + model status/training ── */}
        <div className="gsap-item" style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: "14px", marginBottom: "20px", alignItems: "start" }}>

          {/* Formula input zone */}
          <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Chemical formula
            </div>

            <div style={{ position: "relative" }}>
              <AnimatePresence>
                {isFocused && (
                  <motion.div
                    key="glow" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
                    style={{ position: "absolute", inset: "-2px", borderRadius: "10px", background: `radial-gradient(ellipse at 50% 0%, ${T.accentGlow} 0%, transparent 70%)`, pointerEvents: "none", zIndex: 0 }}
                  />
                )}
              </AnimatePresence>
              <input
                type="text"
                value={formula}
                onChange={e => setFormula(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                disabled={loading}
                placeholder="Fe2O3 · LiFePO4 · GaAs · BaTiO3"
                style={{
                  position: "relative", zIndex: 1, width: "100%",
                  background: "rgba(148,163,184,0.04)", border: `1px solid ${isFocused ? T.borderFocus : T.border}`,
                  borderRadius: "8px", padding: "12px 14px", fontFamily: T.mono, fontSize: "15px",
                  color: T.textPrimary, boxSizing: "border-box",
                  transition: "border-color 200ms ease, box-shadow 200ms ease",
                  boxShadow: isFocused ? `0 0 0 4px ${T.accentGlow}` : "none", outline: "none",
                }}
                className="formula-input"
                aria-label="Chemical formula"
              />
            </div>

            <div style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted, lineHeight: 1.6 }}>
              Enter any valid chemical formula. Predictions use composition-statistics features —
              no crystal structure input required.
            </div>

            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                  style={{ overflow: "hidden", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.22)", borderRadius: "7px", padding: "8px 12px", fontFamily: T.sans, fontSize: "12px", color: "#fca5a5" }}
                >
                  {error}
                </motion.div>
              )}
            </AnimatePresence>

            <button
              onClick={handlePredict}
              disabled={loading}
              className={`search-btn${loading ? " btn-shimmer" : ""}`}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: "7px",
                padding: "10px 20px", borderRadius: "8px", border: "none",
                background: loading ? undefined : T.accent, color: "#fff",
                fontFamily: T.sans, fontSize: "13px", fontWeight: 600,
                cursor: loading ? "not-allowed" : "pointer", alignSelf: "flex-start",
                letterSpacing: "0.01em",
                transition: "transform 200ms ease, background 200ms ease, box-shadow 200ms ease",
                boxShadow: loading ? "none" : "0 0 16px rgba(6,182,212,0.25)",
              }}
            >
              {loading ? (
                <>
                  <motion.svg width="13" height="13" viewBox="0 0 14 14" fill="none" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}>
                    <circle cx="7" cy="7" r="5.5" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5"/>
                    <path d="M7 1.5a5.5 5.5 0 015.5 5.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
                  </motion.svg>
                  Predicting…
                </>
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 1l1.6 3.3 3.6.5-2.6 2.5.6 3.6L7 9.2l-3.2 1.7.6-3.6L1.8 4.8l3.6-.5L7 1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
                  Predict
                </>
              )}
            </button>
          </div>

          {/* Model status + training panel */}
          <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Model status
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {TARGETS.map(target => (
                <ModelStatusPill key={target} target={target} info={modelStatus[target]} />
              ))}
            </div>

            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                Training
              </div>

              {!hasApiKey ? (
                <div style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted, lineHeight: 1.6 }}>
                  Add your API key on the main page to enable training.
                </div>
              ) : (
                <>
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                      <label style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>Training samples / model</label>
                      <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.accent }}>{nTrain}</span>
                    </div>
                    <input
                      type="range" min={100} max={1000} step={100} value={nTrain} disabled={training}
                      onChange={e => setNTrain(Number(e.target.value))}
                      className="spring-range"
                      style={{ "--pct": `${((nTrain - 100) / 900) * 100}%` }}
                    />
                  </div>

                  <AnimatePresence>
                    {trainError && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                        style={{ overflow: "hidden", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.22)", borderRadius: "6px", padding: "7px 10px", fontFamily: T.sans, fontSize: "11px", color: "#fca5a5" }}
                      >
                        {trainError}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <button
                    onClick={handleTrain}
                    disabled={training}
                    className="train-btn"
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
                      padding: "8px 14px", borderRadius: "7px",
                      border: `1px solid rgba(6,182,212,0.30)`, background: "transparent",
                      color: T.accent, fontFamily: T.sans, fontSize: "12px", fontWeight: 600,
                      cursor: training ? "not-allowed" : "pointer",
                      transition: "transform 200ms ease, border-color 200ms ease",
                    }}
                  >
                    {training ? (
                      <>
                        <motion.svg width="12" height="12" viewBox="0 0 14 14" fill="none" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}>
                          <circle cx="7" cy="7" r="5.5" stroke="rgba(6,182,212,0.3)" strokeWidth="1.5"/>
                          <path d="M7 1.5a5.5 5.5 0 015.5 5.5" stroke={T.accent} strokeWidth="1.5" strokeLinecap="round"/>
                        </motion.svg>
                        Training… (2-5 min)
                      </>
                    ) : (
                      "Train all models"
                    )}
                  </button>
                  <div style={{ fontFamily: T.sans, fontSize: "10px", color: T.textMuted, lineHeight: 1.5 }}>
                    Models persist and reload automatically. Re-train only for a larger or refreshed dataset.
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── Results ── */}
        <div className="gsap-item">
          {!hasSearched && !loading && <EmptyState anyTrained={anyTrained} />}

          {hasSearched && predictions && anyPrediction && (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div style={{ fontFamily: T.sans, fontSize: "13px", fontWeight: 600, color: T.textPrimary }}>
                Predictions for <span style={{ fontFamily: T.mono, color: T.accent }}>{formula.trim()}</span>
              </div>

              {/* 3-column prediction cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "14px" }}>
                {TARGETS.map((target, i) => (
                  <PredictionCard key={target} target={target} pred={predictions[target]} index={i} />
                ))}
              </div>

              {/* Feature importance + raw vector */}
              {importances && bestTarget && (
                <FeatureImportanceChart importances={importances} targetLabel={TARGET_META[bestTarget].label} />
              )}
              <FeatureVectorPanel featureVector={featureVector} />
            </div>
          )}

          {hasSearched && !loading && predictions && !anyPrediction && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              style={{ padding: "40px", textAlign: "center", borderRadius: "10px", background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.18)" }}
            >
              <div style={{ fontFamily: T.sans, fontSize: "13px", color: "#fca5a5" }}>
                No predictions available. Train at least one model in the panel above.
              </div>
            </motion.div>
          )}
        </div>
      </div>
    </>
  );
}
