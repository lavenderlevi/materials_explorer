/**
 * PropertyCorrelation.jsx  —  Tab 6
 * Pairwise Pearson/Spearman correlation analysis over a user-defined corpus.
 *
 * Data contract (mirrors Python search/correlation.py):
 *   CORRELATABLE_PROPERTIES: 7 numeric fields → display labels
 *   CorrelationResult {
 *     properties[], property_labels[],
 *     pearson: number[][], spearman: number[][],          // NxN, NaN-able
 *     p_values_pearson: number[][], p_values_spearman: number[][],
 *     n_pair_valid: { "propA|propB": int },
 *     n_corpus: int,
 *   }
 *   strongest_pairs(method, n, min_valid) → [{ prop_a, label_a, prop_b,
 *     label_b, r, p_value, n_valid, abs_r, significant }]
 *
 * Visuals: native SVG heatmap (RdBu diverging, replaces Plotly Heatmap) with
 * cell fade-in stagger, native SVG scatter matrix (lower-triangle only,
 * stable/metastable color split, replaces Plotly splom) with point draw-in,
 * sortable strongest-pairs table with animated |r| bars.
 *
 * Animations: GSAP mount stagger, Framer Motion tab switcher with sliding
 * indicator, heatmap cell fade-stagger, scatter point fade-in, table row
 * stagger with bar fill.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
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

// ─── Mirrors CORRELATABLE_PROPERTIES ────────────────────────────────────────
const CORRELATABLE_PROPERTIES = {
  band_gap:                  "Band Gap (eV)",
  density:                   "Density (g/cm³)",
  formation_energy_per_atom: "Formation Energy (eV/atom)",
  energy_above_hull:         "E above Hull (eV/atom)",
  volume:                    "Volume (Å³)",
  nsites:                    "N Sites",
  nelements:                 "N Elements",
};
const PROP_KEYS = Object.keys(CORRELATABLE_PROPERTIES);

const SHORT_LABELS = {
  band_gap: "Band Gap",
  density: "Density",
  formation_energy_per_atom: "Form. E",
  energy_above_hull: "E Hull",
  volume: "Volume",
  nsites: "Sites",
  nelements: "Elements",
};

const DEFAULT_SELECTED = ["band_gap", "formation_energy_per_atom", "density", "energy_above_hull"];

// ─── RdBu diverging colorscale (r in [-1,1]) ───────────────────────────────────
function rdbuColor(r) {
  if (Number.isNaN(r)) return "rgba(148,163,184,0.08)";
  const t = (r + 1) / 2; // [0,1]
  // Blue (-1) → White (0) → Red (1), tuned for dark background
  const blue = [59, 130, 246];   // #3B82F6
  const white = [30, 41, 59];    // slate-800-ish neutral midpoint (dark theme, not literal white)
  const red = [239, 68, 68];     // #EF4444
  let c1, c2, localT;
  if (t < 0.5) { c1 = blue; c2 = white; localT = t / 0.5; }
  else { c1 = white; c2 = red; localT = (t - 0.5) / 0.5; }
  const mix = c1.map((v, i) => Math.round(v + (c2[i] - v) * localT));
  return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
}
function rdbuOpacity(r) {
  if (Number.isNaN(r)) return 0.3;
  return 0.35 + Math.abs(r) * 0.55;
}

// ─── Number ticker (generic) ───────────────────────────────────────────────────
function NumberTicker({ value, decimals = 2, suffix = "" }) {
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { stiffness: 80, damping: 18 });
  const [display, setDisplay] = useState((0).toFixed(decimals) + suffix);
  useEffect(() => { mv.set(value); }, [value, mv]);
  useEffect(() => spring.on("change", v => setDisplay(v.toFixed(decimals) + suffix)), [spring, decimals, suffix]);
  return <span>{display}</span>;
}

// ─── Segmented toggle (reused pattern) ─────────────────────────────────────────
function SegmentedToggle({ options, value, onChange, groupId, disabled }) {
  return (
    <div style={{ position: "relative", display: "flex", background: "rgba(148,163,184,0.05)", border: `1px solid ${T.border}`, borderRadius: "9px", padding: "3px" }}>
      {options.map(opt => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => !disabled && onChange(opt.value)}
            disabled={disabled}
            style={{
              position: "relative", flex: 1, padding: "8px 10px", border: "none", background: "none",
              cursor: disabled ? "not-allowed" : "pointer", zIndex: 1, opacity: disabled ? 0.5 : 1,
            }}
          >
            {isActive && (
              <motion.div
                layoutId={groupId}
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
                style={{ position: "absolute", inset: 0, borderRadius: "7px", background: T.accentDim, border: "1px solid rgba(6,182,212,0.28)", zIndex: -1 }}
              />
            )}
            <span style={{ fontFamily: T.sans, fontSize: "12px", fontWeight: isActive ? 600 : 500, color: isActive ? T.textPrimary : T.textLabel }}>
              {opt.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Property multi-select chips ───────────────────────────────────────────────
function PropertyChips({ selected, onToggle, disabled }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
      {PROP_KEYS.map(key => {
        const isSelected = selected.includes(key);
        return (
          <button
            key={key}
            onClick={() => !disabled && onToggle(key)}
            disabled={disabled}
            style={{
              display: "flex", alignItems: "center", gap: "5px",
              fontFamily: T.sans, fontSize: "11.5px", fontWeight: 500,
              padding: "6px 10px", borderRadius: "6px", cursor: disabled ? "not-allowed" : "pointer",
              color: isSelected ? T.accent : T.textLabel,
              background: isSelected ? T.accentDim : "rgba(148,163,184,0.05)",
              border: `1px solid ${isSelected ? "rgba(6,182,212,0.30)" : T.border}`,
              transition: "all 150ms ease", opacity: disabled ? 0.5 : 1,
            }}
          >
            {isSelected && (
              <svg width="10" height="10" viewBox="0 0 14 14" fill="none"><path d="M3 7.5l3 3 5-6" stroke={T.accent} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
            )}
            {SHORT_LABELS[key]}
          </button>
        );
      })}
    </div>
  );
}

// ─── Heatmap (native SVG, replaces Plotly Heatmap) ─────────────────────────────
function Heatmap({ matrix, labels, title }) {
  const N = labels.length;
  const CELL = Math.min(64, Math.max(40, 420 / N));
  const labelGutter = 110;
  const W = labelGutter + N * CELL + 20;
  const H = labelGutter + N * CELL + 20;

  return (
    <div>
      <div style={{ fontFamily: T.sans, fontSize: "12px", fontWeight: 600, color: T.textPrimary, marginBottom: "10px", textAlign: "center" }}>
        {title}
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block", margin: "0 auto", maxWidth: "100%" }}>
        {/* Column labels (rotated) */}
        {labels.map((label, j) => (
          <text
            key={`col-${j}`}
            x={labelGutter + j * CELL + CELL / 2}
            y={labelGutter - 10}
            textAnchor="start"
            transform={`rotate(-35, ${labelGutter + j * CELL + CELL / 2}, ${labelGutter - 10})`}
            style={{ fontFamily: T.sans, fontSize: "10px", fill: T.textMuted }}
          >
            {label}
          </text>
        ))}
        {/* Row labels */}
        {labels.map((label, i) => (
          <text
            key={`row-${i}`}
            x={labelGutter - 8}
            y={labelGutter + i * CELL + CELL / 2 + 4}
            textAnchor="end"
            style={{ fontFamily: T.sans, fontSize: "10px", fill: T.textMuted }}
          >
            {label}
          </text>
        ))}
        {/* Cells */}
        {matrix.map((row, i) =>
          row.map((val, j) => {
            const r = val;
            const isNaN_ = Number.isNaN(r);
            return (
              <motion.g key={`${i}-${j}`}>
                <motion.rect
                  x={labelGutter + j * CELL}
                  y={labelGutter + i * CELL}
                  width={CELL - 2} height={CELL - 2}
                  rx={4}
                  fill={rdbuColor(r)}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: rdbuOpacity(r) }}
                  transition={{ duration: 0.4, delay: (i * N + j) * 0.015, ease: "easeOut" }}
                />
                <motion.text
                  x={labelGutter + j * CELL + CELL / 2}
                  y={labelGutter + i * CELL + CELL / 2 + 4}
                  textAnchor="middle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3, delay: (i * N + j) * 0.015 + 0.15 }}
                  style={{ fontFamily: T.mono, fontSize: "10.5px", fontWeight: 600, fill: isNaN_ ? T.textMuted : "#fff", pointerEvents: "none" }}
                >
                  {isNaN_ ? "N/A" : r.toFixed(2)}
                </motion.text>
              </motion.g>
            );
          })
        )}
      </svg>
    </div>
  );
}

// ─── Scatter matrix (native SVG, lower-triangle, replaces Plotly splom) ────────
function ScatterMatrix({ rows, properties, labels }) {
  const N = properties.length;
  const CELL = Math.min(150, Math.max(90, 600 / N));
  const labelGutter = 80;
  const PAD = 8;
  const W = labelGutter + N * CELL + 20;
  const H = labelGutter + N * CELL + 20;

  // Compute domain per property (ignoring NaN)
  const domains = useMemo(() => {
    const d = {};
    properties.forEach(p => {
      const vals = rows.map(r => r[p]).filter(v => v != null && !Number.isNaN(v));
      const lo = vals.length ? Math.min(...vals) : 0;
      const hi = vals.length ? Math.max(...vals) : 1;
      d[p] = [lo, hi === lo ? lo + 1 : hi];
    });
    return d;
  }, [rows, properties]);

  const scaleX = (p, v, cellX) => {
    const [lo, hi] = domains[p];
    return cellX + PAD + ((v - lo) / (hi - lo)) * (CELL - 2 * PAD);
  };
  const scaleY = (p, v, cellY) => {
    const [lo, hi] = domains[p];
    // inverted: higher value = higher on screen
    return cellY + (CELL - PAD) - ((v - lo) / (hi - lo)) * (CELL - 2 * PAD);
  };

  return (
    <div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block", margin: "0 auto", maxWidth: "100%" }}>
        {/* Row/col labels along the diagonal edges */}
        {properties.map((p, i) => (
          <text key={`rl-${i}`} x={labelGutter - 8} y={labelGutter + i * CELL + CELL / 2 + 4} textAnchor="end" style={{ fontFamily: T.sans, fontSize: "10px", fill: T.textMuted }}>
            {SHORT_LABELS[p]}
          </text>
        ))}
        {properties.map((p, j) => (
          <text key={`cl-${j}`} x={labelGutter + j * CELL + CELL / 2} y={labelGutter - 10} textAnchor="middle" style={{ fontFamily: T.sans, fontSize: "10px", fill: T.textMuted }}>
            {SHORT_LABELS[p]}
          </text>
        ))}

        {/* Lower triangle cells (i > j), diagonal shows label, upper hidden */}
        {properties.map((pi, i) =>
          properties.map((pj, j) => {
            const cellX = labelGutter + j * CELL;
            const cellY = labelGutter + i * CELL;

            if (j > i) return null; // upper triangle hidden (matches showupperhalf=False)

            return (
              <g key={`${i}-${j}`}>
                <rect x={cellX} y={cellY} width={CELL - 1} height={CELL - 1} fill="rgba(148,163,184,0.02)" stroke={T.border} strokeWidth="1" />
                {i === j ? (
                  <text x={cellX + CELL / 2} y={cellY + CELL / 2 + 4} textAnchor="middle" style={{ fontFamily: T.sans, fontSize: "10.5px", fontWeight: 600, fill: T.textLabel }}>
                    {SHORT_LABELS[pi]}
                  </text>
                ) : (
                  rows.map((row, k) => {
                    const x = row[pj], y = row[pi];
                    if (x == null || y == null || Number.isNaN(x) || Number.isNaN(y)) return null;
                    return (
                      <motion.circle
                        key={k}
                        cx={scaleX(pj, x, cellX)} cy={scaleY(pi, y, cellY)}
                        r={2.2}
                        fill={row.is_stable ? "#22C55E" : "#EF4444"}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 0.55 }}
                        transition={{ duration: 0.3, delay: Math.min(k * 0.002, 0.8) }}
                      >
                        <title>{`${row.formula} — ${SHORT_LABELS[pj]}: ${x.toFixed(3)}, ${SHORT_LABELS[pi]}: ${y.toFixed(3)}`}</title>
                      </motion.circle>
                    );
                  })
                )}
              </g>
            );
          })
        )}
      </svg>

      {/* Legend */}
      <div style={{ display: "flex", justifyContent: "center", gap: "16px", marginTop: "10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#22C55E" }} />
          <span style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>Stable</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#EF4444" }} />
          <span style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>Metastable</span>
        </div>
      </div>
    </div>
  );
}

// ─── Strongest pairs table ──────────────────────────────────────────────────
function PairsTable({ pairs, methodLabel }) {
  if (pairs.length === 0) {
    return (
      <div style={{ padding: "24px", textAlign: "center", fontFamily: T.sans, fontSize: "12.5px", color: T.textMuted, background: "rgba(148,163,184,0.03)", borderRadius: "8px", border: `1px solid ${T.border}` }}>
        No pairs meet the minimum valid-sample threshold. Reduce "Min valid pairs".
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontFamily: T.sans, fontSize: "12.5px", fontWeight: 600, color: T.textPrimary, marginBottom: "10px" }}>
        Strongest correlations — {methodLabel}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "1px", borderRadius: "8px", overflow: "hidden", border: `1px solid ${T.border}` }}>
        {/* Header */}
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1.4fr 70px 90px 60px 60px", gap: "8px", padding: "8px 12px", background: "rgba(148,163,184,0.05)" }}>
          {["Property A", "Property B", "r", "p-value", "Sig.", "N"].map(h => (
            <span key={h} style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 600, color: T.textMuted, letterSpacing: "0.05em", textTransform: "uppercase" }}>{h}</span>
          ))}
        </div>
        {/* Rows */}
        {pairs.map((p, i) => {
          const color = p.r > 0 ? T.danger : T.accent; // red-positive / blue-negative, matching RdBu
          return (
            <motion.div
              key={`${p.prop_a}-${p.prop_b}`}
              initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.25, delay: i * 0.03 }}
              style={{ display: "grid", gridTemplateColumns: "1.4fr 1.4fr 70px 90px 60px 60px", gap: "8px", padding: "9px 12px", background: T.bgCard, alignItems: "center" }}
            >
              <span style={{ fontFamily: T.sans, fontSize: "11.5px", color: T.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.label_a}</span>
              <span style={{ fontFamily: T.sans, fontSize: "11.5px", color: T.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.label_b}</span>
              <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                <span style={{ fontFamily: T.mono, fontSize: "12px", fontWeight: 600, color }}>{p.r > 0 ? "+" : ""}{p.r.toFixed(3)}</span>
                <div style={{ height: "2.5px", background: "rgba(148,163,184,0.12)", borderRadius: "2px", overflow: "hidden" }}>
                  <motion.div initial={{ width: 0 }} animate={{ width: `${p.abs_r * 100}%` }} transition={{ duration: 0.5, delay: i * 0.03 + 0.1 }} style={{ height: "100%", background: color, borderRadius: "2px" }} />
                </div>
              </div>
              <span style={{ fontFamily: T.mono, fontSize: "10.5px", color: T.textMuted }}>{p.p_value < 0.0001 ? "<0.0001" : p.p_value.toFixed(4)}</span>
              <span style={{ fontFamily: T.sans, fontSize: "11px" }}>
                {p.significant ? (
                  <span style={{ color: T.success }}>✓ p&lt;.05</span>
                ) : (
                  <span style={{ color: T.textMuted }}>—</span>
                )}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: "10.5px", color: T.textLabel }}>{p.n_valid}</span>
            </motion.div>
          );
        })}
      </div>
      <div style={{ fontFamily: T.sans, fontSize: "10.5px", color: T.textMuted, marginTop: "8px", lineHeight: 1.6 }}>
        <span style={{ fontFamily: T.mono, color: T.textLabel }}>r</span> = {methodLabel} coefficient ·{" "}
        <span style={{ fontFamily: T.mono, color: T.textLabel }}>p-value</span> = two-tailed significance test ·{" "}
        <span style={{ fontFamily: T.mono, color: T.textLabel }}>N</span> = materials with data for both properties.
      </div>
    </div>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────
function EmptyState() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 24px", textAlign: "center", gap: "12px" }}
    >
      <div style={{ width: "48px", height: "48px", borderRadius: "12px", background: T.accentDim, border: "1px solid rgba(6,182,212,0.18)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "4px" }}>
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <circle cx="5" cy="17" r="1.6" stroke={T.accent} strokeWidth="1.4"/>
          <circle cx="9" cy="12" r="1.6" stroke={T.accent} strokeWidth="1.4"/>
          <circle cx="13" cy="15" r="1.6" stroke={T.accent} strokeWidth="1.4"/>
          <circle cx="17" cy="6" r="1.6" stroke={T.accent} strokeWidth="1.4"/>
          <path d="M5 17l4-5 4 3 4-9" stroke={T.accent} strokeWidth="1.2" strokeDasharray="2 2" strokeLinecap="round"/>
        </svg>
      </div>
      <div style={{ fontFamily: T.sans, fontSize: "14px", fontWeight: 500, color: T.textSecondary }}>
        Configure the corpus to begin
      </div>
      <div style={{ fontFamily: T.sans, fontSize: "12px", color: T.textMuted, maxWidth: "360px", lineHeight: 1.6 }}>
        Select at least two properties and specify required elements,
        then run the analysis to see correlation heatmaps, scatter matrices,
        and ranked property pairs.
      </div>
    </motion.div>
  );
}

// ─── Main PropertyCorrelation component ────────────────────────────────────────
export default function PropertyCorrelation() {
  const [elements, setElements]       = useState("");
  const [stabilityFilter, setStabilityFilter] = useState(false);
  const [corpusSize, setCorpusSize]   = useState(200);
  const [selectedProps, setSelectedProps] = useState(DEFAULT_SELECTED);
  const [method, setMethod]           = useState("both");
  const [minValid, setMinValid]       = useState(10);

  const [resultData, setResultData]   = useState(null); // CorrelationResult-shaped
  const [rows, setRows]               = useState([]);   // raw corpus rows for scatter
  const [nCorpus, setNCorpus]         = useState(0);

  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [activeView, setActiveView]   = useState("heatmap"); // heatmap | scatter | pairs

  const headerRef = useRef(null);

  useEffect(() => {
    if (!headerRef.current) return;
    const els = headerRef.current.querySelectorAll(".gsap-item");
    gsap.fromTo(els, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out", stagger: 0.06, delay: 0.05 });
  }, []);

  const togglePropSelection = useCallback((key) => {
    setSelectedProps(prev => prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key]);
  }, []);

  const handleCompute = useCallback(async () => {
    if (selectedProps.length < 2) { setError("Select at least 2 properties to compute correlations."); return; }
    if (!elements.trim()) { setError("Specify at least one element to bound the corpus size."); return; }

    setError(null);
    setLoading(true);
    setHasSearched(true);

    try {
      const payload = {
        elements: elements.split(",").map(s => s.trim()).filter(Boolean),
        stability_filter: stabilityFilter,
        corpus_size: corpusSize,
        properties: selectedProps,
        method,
        min_valid: minValid,
      };

      const res = await fetch("/api/v1/correlation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }

      const data = await res.json();
      // data shape: { result: CorrelationResult, rows: [{material_id, formula,
      //   is_stable, ...properties}], n_corpus }
      setResultData(data.result ?? null);
      setRows(data.rows ?? []);
      setNCorpus(data.n_corpus ?? 0);
    } catch (err) {
      setError(err.message);
      setResultData(null);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [elements, stabilityFilter, corpusSize, selectedProps, method, minValid]);

  const methodsToShow = method === "both" ? ["pearson", "spearman"] : [method];
  const methodLabels = { pearson: "Pearson r", spearman: "Spearman ρ" };

  const pairsByMethod = useMemo(() => {
    if (!resultData) return {};
    const out = {};
    for (const m of methodsToShow) {
      const matrix = m === "pearson" ? resultData.pearson : resultData.spearman;
      const pMat = m === "pearson" ? resultData.p_values_pearson : resultData.p_values_spearman;
      const k = resultData.properties.length;
      const pairs = [];
      for (let i = 0; i < k; i++) {
        for (let j = i + 1; j < k; j++) {
          const pi = resultData.properties[i], pj = resultData.properties[j];
          const nv = resultData.n_pair_valid[`${pi}|${pj}`] ?? 0;
          if (nv < minValid) continue;
          const r = matrix[i][j];
          if (Number.isNaN(r)) continue;
          pairs.push({
            prop_a: pi, label_a: resultData.property_labels[i],
            prop_b: pj, label_b: resultData.property_labels[j],
            r, p_value: pMat[i][j], n_valid: nv,
            abs_r: Math.abs(r), significant: pMat[i][j] < 0.05,
          });
        }
      }
      pairs.sort((a, b) => b.abs_r - a.abs_r);
      out[m] = pairs.slice(0, 15);
    }
    return out;
  }, [resultData, methodsToShow, minValid]);

  const validCountsRange = useMemo(() => {
    if (!resultData) return [0, 0];
    const counts = Object.values(resultData.n_pair_valid);
    if (!counts.length) return [0, 0];
    return [Math.min(...counts), Math.max(...counts)];
  }, [resultData]);

  return (
    <>
      <style>{`
        .corpus-input:focus { border-color: ${T.borderFocus} !important; box-shadow: 0 0 0 3px ${T.accentGlow}; outline: none; }
        .search-btn:hover:not(:disabled) { transform: translateY(-1px); background: rgba(6,182,212,0.90) !important; }
        .search-btn:active:not(:disabled) { transform: translateY(0); }
        .search-btn:disabled { opacity: 0.55; cursor: not-allowed; }

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

      <div style={{ padding: "28px 32px", maxWidth: "1180px", margin: "0 auto" }}>

        {/* ── Header ── */}
        <div ref={headerRef} style={{ marginBottom: "24px" }}>
          <div className="gsap-item" style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: T.accentDim, border: "1px solid rgba(6,182,212,0.20)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <circle cx="5" cy="15" r="1.5" stroke={T.accent} strokeWidth="1.4"/>
                <circle cx="8" cy="11" r="1.5" stroke={T.accent} strokeWidth="1.4"/>
                <circle cx="11" cy="8" r="1.5" stroke={T.accent} strokeWidth="1.4"/>
                <circle cx="15" cy="5" r="1.5" stroke={T.accent} strokeWidth="1.4"/>
              </svg>
            </div>
            <h1 style={{ fontFamily: T.sans, fontSize: "17px", fontWeight: 600, color: T.textPrimary, margin: 0, letterSpacing: "-0.015em" }}>
              Property Correlation Explorer
            </h1>
          </div>
          <p className="gsap-item" style={{ fontFamily: T.sans, fontSize: "13px", color: T.textMuted, margin: 0, lineHeight: 1.6, maxWidth: "640px" }}>
            Explore pairwise correlations between material properties.{" "}
            <span style={{ color: T.textLabel }}>Pearson r</span> measures linear correlation;{" "}
            <span style={{ color: T.textLabel }}>Spearman ρ</span> measures monotonic correlation, robust to outliers.
          </p>
        </div>

        {/* ── Bento: corpus config + analysis settings ── */}
        <div className="gsap-item" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "20px", alignItems: "start" }}>

          {/* Corpus configuration */}
          <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Corpus configuration
            </div>
            <div>
              <label style={{ display: "block", fontFamily: T.sans, fontSize: "11px", color: T.textLabel, marginBottom: "5px" }}>
                Required elements
              </label>
              <input
                type="text" value={elements} onChange={e => setElements(e.target.value)}
                placeholder="O, Fe" disabled={loading}
                style={{ width: "100%", background: "rgba(148,163,184,0.05)", border: `1px solid ${T.border}`, borderRadius: "6px", padding: "7px 10px", fontFamily: T.mono, fontSize: "12px", color: T.textPrimary, outline: "none", boxSizing: "border-box", transition: "border-color 200ms ease, box-shadow 200ms ease" }}
                className="corpus-input"
              />
              <div style={{ fontFamily: T.sans, fontSize: "10px", color: T.textMuted, marginTop: "3px" }}>
                Only materials containing ALL of these elements.
              </div>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" }}>
              <div
                onClick={() => !loading && setStabilityFilter(v => !v)}
                style={{
                  width: "30px", height: "17px", borderRadius: "9px",
                  background: stabilityFilter ? T.accent : "rgba(148,163,184,0.15)",
                  border: `1px solid ${stabilityFilter ? T.accent : T.border}`,
                  position: "relative", cursor: "pointer", flexShrink: 0,
                  transition: "background 200ms ease, border-color 200ms ease",
                }}
              >
                <motion.div animate={{ x: stabilityFilter ? 13 : 2 }} transition={{ type: "spring", stiffness: 500, damping: 35 }} style={{ position: "absolute", top: "2px", width: "11px", height: "11px", borderRadius: "50%", background: "#fff" }} />
              </div>
              <span style={{ fontFamily: T.sans, fontSize: "11.5px", color: T.textLabel }}>Stable materials only (eah ≤ 0)</span>
            </label>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                <label style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>Max corpus size</label>
                <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.accent }}>{corpusSize}</span>
              </div>
              <input type="range" min={50} max={500} step={50} value={corpusSize} disabled={loading}
                onChange={e => setCorpusSize(Number(e.target.value))}
                className="spring-range" style={{ "--pct": `${((corpusSize - 50) / 450) * 100}%` }}
              />
            </div>
          </div>

          {/* Analysis settings */}
          <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Analysis settings
            </div>
            <div>
              <label style={{ display: "block", fontFamily: T.sans, fontSize: "11px", color: T.textLabel, marginBottom: "6px" }}>
                Properties to correlate ({selectedProps.length} selected)
              </label>
              <PropertyChips selected={selectedProps} onToggle={togglePropSelection} disabled={loading} />
            </div>

            <div>
              <label style={{ display: "block", fontFamily: T.sans, fontSize: "11px", color: T.textLabel, marginBottom: "6px" }}>
                Correlation method
              </label>
              <SegmentedToggle
                groupId="corr-method-pill"
                options={[
                  { value: "pearson", label: "Pearson r" },
                  { value: "spearman", label: "Spearman ρ" },
                  { value: "both", label: "Both" },
                ]}
                value={method} onChange={setMethod} disabled={loading}
              />
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                <label style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>Min valid pairs per property pair</label>
                <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.accent }}>{minValid}</span>
              </div>
              <input type="range" min={3} max={200} step={1} value={minValid} disabled={loading}
                onChange={e => setMinValid(Number(e.target.value))}
                className="spring-range" style={{ "--pct": `${((minValid - 3) / 197) * 100}%` }}
              />
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
              onClick={handleCompute}
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
                  Computing correlations…
                </>
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="5" cy="11" r="1.4" fill="currentColor"/><circle cx="9" cy="6" r="1.4" fill="currentColor"/><path d="M5 11l4-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                  Compute correlations
                </>
              )}
            </button>
          </div>
        </div>

        {/* ── Results ── */}
        <div className="gsap-item">
          {!hasSearched && !loading && <EmptyState />}

          {hasSearched && resultData && (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted }}>
                Corpus: <span style={{ fontFamily: T.mono, color: T.textLabel }}>{nCorpus}</span> materials ·
                Properties: <span style={{ fontFamily: T.mono, color: T.textLabel }}>{selectedProps.length}</span> ·
                Method: <span style={{ fontFamily: T.mono, color: T.accent }}>{method === "both" ? "Pearson + Spearman" : methodLabels[method]}</span> ·
                Valid pairs: <span style={{ fontFamily: T.mono, color: T.success }}>{validCountsRange[0]}–{validCountsRange[1]}</span> materials/pair
              </div>

              {/* View tabs */}
              <SegmentedToggle
                groupId="view-tab-pill"
                options={[
                  { value: "heatmap", label: "Correlation Heatmap" },
                  { value: "scatter", label: "Scatter Matrix" },
                  { value: "pairs", label: "Strongest Correlations" },
                ]}
                value={activeView} onChange={setActiveView}
              />

              <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "20px", minHeight: "300px" }}>
                <AnimatePresence mode="wait">
                  {activeView === "heatmap" && (
                    <motion.div key="heatmap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
                      {methodsToShow.map(m => (
                        <Heatmap
                          key={m}
                          matrix={m === "pearson" ? resultData.pearson : resultData.spearman}
                          labels={resultData.property_labels}
                          title={`${methodLabels[m]} — Correlation Matrix`}
                        />
                      ))}
                      <div style={{ fontFamily: T.sans, fontSize: "10.5px", color: T.textMuted, textAlign: "center" }}>
                        Red = positive correlation · Blue = negative correlation · N/A = fewer than 3 valid pairs.
                      </div>
                    </motion.div>
                  )}

                  {activeView === "scatter" && (
                    <motion.div key="scatter" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                      <div style={{ fontFamily: T.sans, fontSize: "12.5px", fontWeight: 600, color: T.textPrimary, marginBottom: "4px" }}>
                        Pairwise Scatter Matrix
                      </div>
                      <div style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted, marginBottom: "14px" }}>
                        Each point is one material. Lower triangle only. Hover for details.
                      </div>
                      <ScatterMatrix rows={rows} properties={selectedProps} labels={resultData.property_labels} />
                    </motion.div>
                  )}

                  {activeView === "pairs" && (
                    <motion.div key="pairs" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
                      {methodsToShow.map(m => (
                        <PairsTable key={m} pairs={pairsByMethod[m] ?? []} methodLabel={methodLabels[m]} />
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
