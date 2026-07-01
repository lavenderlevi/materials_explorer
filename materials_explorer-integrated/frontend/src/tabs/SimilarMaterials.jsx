/**
 * SimilarMaterials.jsx  —  Tab 3
 * Given a seed material ID, find the most property-similar materials
 * in the same element system via feature-vector similarity.
 *
 * Data contract (mirrors Python search/similarity.py):
 *   SimilarityMetric: "cosine" | "euclidean" | "weighted_cosine"
 *   FeatureDiff { feature, seed_value, candidate_value,
 *                 normalized_diff [0,1], match_pct [0,1] }
 *   SimilarMaterial { material: MaterialDocument, similarity_score [0,1],
 *                      rank, feature_diffs: FeatureDiff[] }
 *
 *   Feature weights (weighted_cosine, fixed in backend):
 *     band_gap 25% · formation_energy_per_atom 20% · energy_above_hull 20%
 *     density 15%  · volume 10% · nsites 5% · nelements 5%
 *
 * Visual: native SVG radar chart (replaces Plotly) comparing seed vs top-3,
 * built with draw-stroke axis animation + fade-in fill polygons —
 * matches the design system's "draw-stroke effects for axes" guideline.
 *
 * Animations: GSAP mount stagger, Framer Motion NumberTicker, AnimateHeight
 * expandable cards, SVG path draw-in for radar axes/polygons.
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

// ─── Metric config (mirrors SimilarityMetric enum) ─────────────────────────────
const METRICS = [
  { value: "weighted_cosine", label: "Weighted Cosine", hint: "Domain-tuned weights (recommended)" },
  { value: "cosine",          label: "Cosine",           hint: "Angle-based, scale-invariant" },
  { value: "euclidean",       label: "Euclidean",        hint: "Distance-based similarity" },
];

const FEATURE_WEIGHTS = [
  { field: "band_gap",                  label: "Band Gap",         pct: 25 },
  { field: "formation_energy_per_atom", label: "Formation Energy", pct: 20 },
  { field: "energy_above_hull",         label: "E above Hull",     pct: 20 },
  { field: "density",                   label: "Density",          pct: 15 },
  { field: "volume",                    label: "Volume",           pct: 10 },
  { field: "nsites",                    label: "Sites",            pct: 5 },
  { field: "nelements",                 label: "Elements",         pct: 5 },
];

const FEATURE_LABELS = {
  band_gap: "Band Gap",
  density: "Density",
  formation_energy_per_atom: "Form. Energy",
  energy_above_hull: "E Hull",
  volume: "Volume",
  nsites: "Sites",
  nelements: "Elements",
};

const RADAR_FEATURES = ["band_gap", "density", "formation_energy_per_atom", "energy_above_hull", "volume"];
const RADAR_COLORS = ["#06B6D4", "#22C55E", "#6366F1", "#F59E0B"]; // seed, top1, top2, top3

function scoreColor(pct) {
  if (pct >= 70) return T.success;
  if (pct >= 50) return T.warning;
  return T.danger;
}
function scoreLabel(pct) {
  if (pct >= 70) return "High";
  if (pct >= 50) return "Moderate";
  return "Low";
}

// ─── Number ticker ──────────────────────────────────────────────────────────
function NumberTicker({ value, decimals = 1, suffix = "" }) {
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { stiffness: 80, damping: 18 });
  const [display, setDisplay] = useState((0).toFixed(decimals) + suffix);
  useEffect(() => { mv.set(value); }, [value, mv]);
  useEffect(() => spring.on("change", v => setDisplay(v.toFixed(decimals) + suffix)), [spring, decimals, suffix]);
  return <span>{display}</span>;
}

function MiniBar({ value, color }) {
  return (
    <div style={{ height: "3px", background: "rgba(148,163,184,0.12)", borderRadius: "2px", overflow: "hidden" }}>
      <motion.div
        initial={{ width: 0 }} animate={{ width: `${Math.min(value, 100)}%` }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        style={{ height: "100%", background: color, borderRadius: "2px" }}
      />
    </div>
  );
}

// ─── Radar chart (native SVG, replaces Plotly) ─────────────────────────────────
function RadarChart({ seed, top3 }) {
  const SIZE = 360;
  const CX = SIZE / 2;
  const CY = SIZE / 2;
  const R = 130;
  const N = RADAR_FEATURES.length;
  const angleStep = (Math.PI * 2) / N;

  const allMats = [seed, ...top3.map(r => r.material)];
  const names = [`Seed · ${seed.formula_pretty}`, ...top3.map(r => r.material.formula_pretty)];

  // MinMax-normalize each feature across [seed, ...top3] — mirrors Python _minmax()
  const normed = useMemo(() => {
    const raw = {};
    RADAR_FEATURES.forEach(f => {
      raw[f] = allMats.map(m => m[f] ?? 0.0);
    });
    const out = {};
    RADAR_FEATURES.forEach(f => {
      const vals = raw[f];
      const lo = Math.min(...vals), hi = Math.max(...vals);
      out[f] = vals.map(v => (hi > lo ? (v - lo) / (hi - lo) : 0.5));
    });
    return out;
  }, [seed, top3]);

  const pointFor = (value01, index) => {
    const angle = -Math.PI / 2 + index * angleStep;
    const r = value01 * R;
    return [CX + r * Math.cos(angle), CY + r * Math.sin(angle)];
  };

  const polygonPoints = (seriesIndex) => {
    return RADAR_FEATURES.map((f, i) => pointFor(normed[f][seriesIndex], i));
  };

  const axisEndpoints = RADAR_FEATURES.map((_, i) => pointFor(1, i));
  const gridRings = [0.25, 0.5, 0.75, 1.0];

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        {/* Grid rings */}
        {gridRings.map((ring, ri) => {
          const pts = RADAR_FEATURES.map((_, i) => pointFor(ring, i));
          const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ") + " Z";
          return (
            <motion.path
              key={ring}
              d={d}
              fill="none"
              stroke="rgba(148,163,184,0.14)"
              strokeWidth="1"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3, delay: ri * 0.05 }}
            />
          );
        })}

        {/* Axes — draw-stroke effect */}
        {axisEndpoints.map((p, i) => (
          <motion.line
            key={i}
            x1={CX} y1={CY} x2={p[0]} y2={p[1]}
            stroke="rgba(148,163,184,0.20)"
            strokeWidth="1"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.1 + i * 0.04, ease: "easeOut" }}
          />
        ))}

        {/* Axis labels */}
        {RADAR_FEATURES.map((f, i) => {
          const [lx, ly] = pointFor(1.22, i);
          return (
            <text
              key={f}
              x={lx} y={ly}
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ fontFamily: T.sans, fontSize: "10px", fill: T.textMuted, fontWeight: 500 }}
            >
              {FEATURE_LABELS[f]}
            </text>
          );
        })}

        {/* Data polygons — fade + scale in, staggered per series */}
        {names.map((_, seriesIndex) => {
          const pts = polygonPoints(seriesIndex);
          const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ") + " Z";
          const color = RADAR_COLORS[seriesIndex];
          return (
            <motion.g key={seriesIndex}>
              <motion.path
                d={d}
                fill={color}
                fillOpacity={seriesIndex === 0 ? 0.12 : 0.08}
                stroke={color}
                strokeWidth={seriesIndex === 0 ? 2 : 1.4}
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, delay: 0.4 + seriesIndex * 0.1, ease: [0.22, 1, 0.36, 1] }}
                style={{ transformOrigin: `${CX}px ${CY}px` }}
              />
              {pts.map((p, i) => (
                <motion.circle
                  key={i}
                  cx={p[0]} cy={p[1]} r={seriesIndex === 0 ? 3 : 2.2}
                  fill={color}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3, delay: 0.6 + seriesIndex * 0.1 + i * 0.02 }}
                />
              ))}
            </motion.g>
          );
        })}
      </svg>

      {/* Legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", justifyContent: "center" }}>
        {names.map((name, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: RADAR_COLORS[i], flexShrink: 0 }} />
            <span style={{ fontFamily: T.mono, fontSize: "10.5px", color: T.textLabel }}>{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Seed summary banner ───────────────────────────────────────────────────────
function SeedBanner({ seed }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      style={{
        background: T.bgCard, border: "1px solid rgba(6,182,212,0.20)", borderRadius: "10px",
        padding: "16px", display: "flex", flexDirection: "column", gap: "12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <span style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.accent, letterSpacing: "0.08em", textTransform: "uppercase", background: T.accentDim, padding: "2px 8px", borderRadius: "4px", border: "1px solid rgba(6,182,212,0.20)" }}>
          Seed
        </span>
        <span style={{ fontFamily: T.mono, fontSize: "16px", fontWeight: 600, color: T.textPrimary }}>
          {seed.formula_pretty}
        </span>
        <span style={{ fontFamily: T.mono, fontSize: "12px", color: T.textMuted }}>
          {seed.material_id}
        </span>
        <span style={{
          fontFamily: T.sans, fontSize: "11px", fontWeight: 500, padding: "2px 8px", borderRadius: "5px",
          color: seed.is_stable ? "#86efac" : "#fcd34d",
          background: seed.is_stable ? "rgba(34,197,94,0.10)" : "rgba(245,158,11,0.10)",
          border: `1px solid ${seed.is_stable ? "rgba(34,197,94,0.22)" : "rgba(245,158,11,0.22)"}`,
        }}>
          {seed.is_stable ? "Stable" : "Metastable"}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px" }}>
        {[
          { label: "Band Gap", value: seed.band_gap, unit: "eV", dp: 3 },
          { label: "Density", value: seed.density, unit: "g/cm³", dp: 3 },
          { label: "E above hull", value: seed.energy_above_hull, unit: "eV/at", dp: 4 },
          { label: "Formation E", value: seed.formation_energy_per_atom, unit: "eV/at", dp: 4 },
        ].map(({ label, value, unit, dp }) => (
          <div key={label} style={{ background: "rgba(148,163,184,0.05)", border: `1px solid ${T.border}`, borderRadius: "7px", padding: "8px 10px" }}>
            <div style={{ fontFamily: T.sans, fontSize: "10px", color: T.textMuted }}>{label}</div>
            <div style={{ fontFamily: T.mono, fontSize: "13px", fontWeight: 600, color: T.textPrimary, marginTop: "2px" }}>
              {value != null ? value.toFixed(dp) : "N/A"}
              {value != null && <span style={{ fontSize: "10px", color: T.textMuted, marginLeft: "3px" }}>{unit}</span>}
            </div>
          </div>
        ))}
      </div>

      <div style={{ fontFamily: T.sans, fontSize: "11.5px", color: T.textLabel, lineHeight: 1.7 }}>
        <span style={{ color: T.textMuted }}>Crystal system:</span> {seed.crystal_system || "N/A"}
        <span style={{ color: T.textMuted, marginLeft: "14px" }}>Spacegroup:</span> {seed.spacegroup_symbol || "N/A"}
        <span style={{ color: T.textMuted, marginLeft: "14px" }}>Elements:</span>{" "}
        <span style={{ fontFamily: T.mono }}>{seed.elements?.join(", ")}</span>
        <span style={{ color: T.textMuted, marginLeft: "14px" }}>Sites:</span> {seed.nsites ?? "N/A"}
      </div>
    </motion.div>
  );
}

// ─── Quick-glance ranked list (top 8) ──────────────────────────────────────────
function QuickList({ results }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      {results.slice(0, 8).map((res, i) => {
        const pct = res.similarity_score * 100;
        const color = scoreColor(pct);
        const url = `https://materialsproject.org/materials/${res.material.material_id}`;
        return (
          <motion.a
            key={res.material.material_id}
            href={url} target="_blank" rel="noopener noreferrer"
            initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.25, delay: i * 0.04 }}
            style={{
              display: "flex", alignItems: "center", gap: "8px", padding: "7px 10px",
              borderRadius: "6px", textDecoration: "none", border: `1px solid ${T.border}`,
              background: "rgba(148,163,184,0.03)",
            }}
            className="quick-list-item"
          >
            <span style={{ fontFamily: T.mono, fontSize: "10px", color: T.textMuted, width: "16px", flexShrink: 0 }}>
              #{res.rank}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: "12px", fontWeight: 600, color: T.textPrimary, flexShrink: 0 }}>
              {res.material.formula_pretty}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: "10.5px", color: T.textMuted, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {res.material.material_id}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: "11.5px", fontWeight: 600, color, flexShrink: 0 }}>
              {pct.toFixed(1)}%
            </span>
          </motion.a>
        );
      })}
    </div>
  );
}

// ─── Feature diff row ───────────────────────────────────────────────────────
function FeatureDiffRow({ diff }) {
  const pct = diff.match_pct * 100;
  const color = scoreColor(pct);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.textSecondary }}>
          {FEATURE_LABELS[diff.feature] ?? diff.feature}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontFamily: T.mono, fontSize: "10px", color: T.textMuted }}>
            {diff.seed_value != null ? diff.seed_value.toFixed(3) : "N/A"}
            <span style={{ opacity: 0.5 }}> → </span>
            {diff.candidate_value != null ? diff.candidate_value.toFixed(3) : "N/A"}
          </span>
          <span style={{ fontFamily: T.mono, fontSize: "10.5px", fontWeight: 600, color, minWidth: "32px", textAlign: "right" }}>
            {pct.toFixed(0)}%
          </span>
        </div>
      </div>
      <MiniBar value={pct} color={color} />
    </div>
  );
}

// ─── Detailed result card ──────────────────────────────────────────────────────
function ResultCard({ result, index, isExpanded, onToggle }) {
  const { material: mat, similarity_score, rank, feature_diffs } = result;
  const pct = similarity_score * 100;
  const color = scoreColor(pct);
  const mpUrl = `https://materialsproject.org/materials/${mat.material_id}`;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
      transition={{
        layout: { type: "spring", stiffness: 300, damping: 30 },
        opacity: { duration: 0.3, delay: index * 0.03 },
        y: { duration: 0.35, delay: index * 0.03, ease: [0.22, 1, 0.36, 1] },
      }}
      style={{
        background: T.bgCard, border: `1px solid ${isExpanded ? "rgba(6,182,212,0.18)" : T.border}`,
        borderRadius: "10px", overflow: "hidden",
      }}
    >
      <button
        onClick={onToggle}
        style={{ width: "100%", background: "none", border: "none", cursor: "pointer", padding: "14px 16px", display: "flex", alignItems: "center", gap: "12px", textAlign: "left" }}
        className="result-card-header"
      >
        <div style={{ fontFamily: T.mono, fontSize: "11px", fontWeight: 500, color: T.textMuted, flexShrink: 0, width: "22px", textAlign: "right" }}>
          #{rank}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" }}>
            <span style={{ fontFamily: T.mono, fontSize: "14px", fontWeight: 600, color: T.textPrimary, letterSpacing: "-0.01em" }}>
              {mat.formula}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.accent, background: T.accentDim, padding: "1px 6px", borderRadius: "4px", border: "1px solid rgba(6,182,212,0.18)" }}>
              {mat.material_id}
            </span>
            {mat.crystal_system && (
              <span style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted }}>{mat.crystal_system}</span>
            )}
          </div>
        </div>
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{ textAlign: "right", minWidth: "52px" }}>
            <div style={{ fontFamily: T.mono, fontSize: "15px", fontWeight: 600, color, lineHeight: 1 }}>
              <NumberTicker value={pct} decimals={1} suffix="%" />
            </div>
            <div style={{ fontFamily: T.sans, fontSize: "9px", color, opacity: 0.7, marginTop: "2px", letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {scoreLabel(pct)}
            </div>
          </div>
          <motion.svg
            animate={{ rotate: isExpanded ? 180 : 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, color: T.textMuted }}
          >
            <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </motion.svg>
        </div>
      </button>

      <div style={{ padding: "0 16px 10px", marginTop: "-4px" }}>
        <MiniBar value={pct} color={color} />
      </div>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ height: { type: "spring", stiffness: 280, damping: 30 }, opacity: { duration: 0.2 } }}
            style={{ overflow: "hidden" }}
          >
            <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${T.border}`, paddingTop: "14px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>

                {/* LEFT: properties */}
                <div>
                  <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "8px" }}>
                    Properties
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontFamily: T.sans, fontSize: "11.5px", color: T.textLabel }}>
                    <div>Stability: <span style={{ fontFamily: T.mono, color: mat.is_stable ? "#86efac" : "#fcd34d" }}>{mat.is_stable ? "Stable" : "Metastable"}</span></div>
                    {mat.band_gap != null && <div>Band gap: <span style={{ fontFamily: T.mono, color: T.textPrimary }}>{mat.band_gap.toFixed(3)} eV</span></div>}
                    {mat.density != null && <div>Density: <span style={{ fontFamily: T.mono, color: T.textPrimary }}>{mat.density.toFixed(3)} g/cm³</span></div>}
                    {mat.energy_above_hull != null && <div>E above hull: <span style={{ fontFamily: T.mono, color: T.textPrimary }}>{mat.energy_above_hull.toFixed(4)} eV/atom</span></div>}
                    {mat.formation_energy_per_atom != null && <div>Formation energy: <span style={{ fontFamily: T.mono, color: T.textPrimary }}>{mat.formation_energy_per_atom.toFixed(4)} eV/atom</span></div>}
                  </div>
                  <a href={mpUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: "5px", marginTop: "12px", fontFamily: T.sans, fontSize: "11px", color: T.accent, textDecoration: "none", padding: "4px 8px", borderRadius: "5px", border: "1px solid rgba(6,182,212,0.20)", background: T.accentDim }} className="mp-link">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 8L8 2M8 2H4M8 2v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    View on Materials Project
                  </a>
                </div>

                {/* RIGHT: feature match */}
                <div>
                  <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "8px" }}>
                    Feature match (normalized)
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    {feature_diffs.map(d => <FeatureDiffRow key={d.feature} diff={d} />)}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
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
          <circle cx="8" cy="13" r="3.5" stroke={T.accent} strokeWidth="1.5"/>
          <circle cx="15" cy="9" r="3.5" stroke={T.accent} strokeWidth="1.5"/>
          <path d="M11 11l1-1" stroke={T.accent} strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </div>
      <div style={{ fontFamily: T.sans, fontSize: "14px", fontWeight: 500, color: T.textSecondary }}>
        Enter a seed material ID
      </div>
      <div style={{ fontFamily: T.sans, fontSize: "12px", color: T.textMuted, maxWidth: "320px", lineHeight: 1.6 }}>
        e.g. <span style={{ fontFamily: T.mono, color: T.textLabel }}>mp-149</span> (Silicon). Materials in the same
        element system are ranked by feature-vector similarity.
      </div>
    </motion.div>
  );
}

// ─── Main SimilarMaterials component ───────────────────────────────────────────
export default function SimilarMaterials() {
  const [seedIdInput, setSeedIdInput] = useState("");
  const [metric, setMetric]           = useState("weighted_cosine");
  const [topK, setTopK]               = useState(10);
  const [corpusSize, setCorpusSize]   = useState(100);
  const [stabilityFilter, setStabilityFilter] = useState(false);

  const [seed, setSeed]               = useState(null);
  const [results, setResults]         = useState([]);
  const [corpusCount, setCorpusCount] = useState(0);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [expandedCards, setExpandedCards] = useState(new Set());
  const [isFocused, setIsFocused]     = useState(false);
  const [metricMenuOpen, setMetricMenuOpen] = useState(false);

  const headerRef = useRef(null);

  useEffect(() => {
    if (!headerRef.current) return;
    const els = headerRef.current.querySelectorAll(".gsap-item");
    gsap.fromTo(els, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out", stagger: 0.06, delay: 0.05 });
  }, []);

  const handleSearch = useCallback(async () => {
    const seedId = seedIdInput.trim().toLowerCase();
    if (!seedId) { setError("Enter a Materials Project ID."); return; }

    setError(null);
    setLoading(true);
    setHasSearched(true);

    try {
      const payload = {
        seed_id: seedId,
        metric,
        top_k: topK,
        corpus_size: corpusSize,
        stability_filter: stabilityFilter,
      };

      const res = await fetch("/api/v1/similar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || (res.status === 404
          ? `Material '${seedId}' not found. Verify the ID format (e.g. mp-149).`
          : `HTTP ${res.status}`));
      }

      const data = await res.json();
      // API returns list[SimilarResultResponse] directly
      const resultList = Array.isArray(data) ? data : (data.results ?? []);
      setResults(resultList);
      setCorpusCount(corpusSize);
      if (resultList.length) setExpandedCards(new Set());
      // Fetch seed separately
      const seedRes = await fetch(`/api/v1/materials/${seedId}`);
      if (seedRes.ok) { const seedData = await seedRes.json(); setSeed(seedData); }
    } catch (err) {
      setError(err.message);
      setSeed(null);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [seedIdInput, metric, topK, corpusSize, stabilityFilter]);

  const handleKeyDown = (e) => { if (e.key === "Enter" && !loading) handleSearch(); };

  const toggleCard = useCallback((index) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      next.has(index) ? next.delete(index) : next.add(index);
      return next;
    });
  }, []);

  const selectedMetric = METRICS.find(m => m.value === metric);
  const top3 = results.slice(0, 3);

  return (
    <>
      <style>{`
        .corpus-input:focus, .seed-input:focus { border-color: ${T.borderFocus} !important; box-shadow: 0 0 0 3px ${T.accentGlow}; outline: none; }
        .mp-link:hover { background: rgba(6,182,212,0.16) !important; }
        .result-card-header:hover { background: rgba(148,163,184,0.04); }
        .quick-list-item:hover { background: rgba(148,163,184,0.06) !important; border-color: rgba(148,163,184,0.2) !important; }
        .search-btn:hover:not(:disabled) { transform: translateY(-1px); background: rgba(6,182,212,0.90) !important; }
        .search-btn:active:not(:disabled) { transform: translateY(0); }
        .search-btn:disabled { opacity: 0.55; cursor: not-allowed; }
        .metric-option:hover { background: rgba(148,163,184,0.06); }

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
                <circle cx="6" cy="10" r="3.5" stroke={T.accent} strokeWidth="1.5"/>
                <circle cx="14" cy="10" r="3.5" stroke={T.accent} strokeWidth="1.5"/>
                <path d="M9.5 10h1" stroke={T.accent} strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <h1 style={{ fontFamily: T.sans, fontSize: "17px", fontWeight: 600, color: T.textPrimary, margin: 0, letterSpacing: "-0.015em" }}>
              Similar Materials
            </h1>
          </div>
          <p className="gsap-item" style={{ fontFamily: T.sans, fontSize: "13px", color: T.textMuted, margin: 0, lineHeight: 1.6, maxWidth: "580px" }}>
            Find materials with the most similar numeric property profile to a seed,
            within the same element system.
          </p>
        </div>

        {/* ── Bento: seed input + config ── */}
        <div className="gsap-item" style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: "14px", marginBottom: "20px", alignItems: "start" }}>

          {/* Seed input zone */}
          <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Seed material
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
                value={seedIdInput}
                onChange={e => setSeedIdInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                disabled={loading}
                placeholder="mp-149  (Silicon)"
                style={{
                  position: "relative", zIndex: 1, width: "100%",
                  background: "rgba(148,163,184,0.04)", border: `1px solid ${isFocused ? T.borderFocus : T.border}`,
                  borderRadius: "8px", padding: "12px 14px", fontFamily: T.mono, fontSize: "14px",
                  color: T.textPrimary, boxSizing: "border-box",
                  transition: "border-color 200ms ease, box-shadow 200ms ease",
                  boxShadow: isFocused ? `0 0 0 3px ${T.accentGlow}` : "none", outline: "none",
                }}
                className="seed-input"
                aria-label="Seed material ID"
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
              onClick={handleSearch}
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
                  Computing similarity…
                </>
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.4"/><path d="M10 10l2.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
                  Find similar
                </>
              )}
            </button>
          </div>

          {/* Configuration panel */}
          <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Configuration
            </div>

            {/* Metric picker */}
            <div style={{ position: "relative" }}>
              <label style={{ display: "block", fontFamily: T.sans, fontSize: "11px", color: T.textLabel, marginBottom: "5px" }}>
                Similarity metric
              </label>
              <button
                onClick={() => setMetricMenuOpen(o => !o)}
                disabled={loading}
                style={{
                  width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                  background: "rgba(148,163,184,0.05)", border: `1px solid ${T.border}`, borderRadius: "6px",
                  padding: "7px 10px", cursor: "pointer", textAlign: "left",
                }}
              >
                <span style={{ fontFamily: T.sans, fontSize: "12px", color: T.textPrimary }}>{selectedMetric.label}</span>
                <motion.svg animate={{ rotate: metricMenuOpen ? 180 : 0 }} width="10" height="10" viewBox="0 0 14 14" fill="none" style={{ color: T.textMuted }}>
                  <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </motion.svg>
              </button>
              <AnimatePresence>
                {metricMenuOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.97 }}
                    transition={{ duration: 0.15 }}
                    style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: T.bgPage, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "4px", zIndex: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}
                  >
                    {METRICS.map(m => (
                      <button
                        key={m.value}
                        onClick={() => { setMetric(m.value); setMetricMenuOpen(false); }}
                        style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: "8px 10px", borderRadius: "5px" }}
                        className="metric-option"
                      >
                        <div style={{ fontFamily: T.sans, fontSize: "12px", color: T.textPrimary, fontWeight: m.value === metric ? 600 : 400 }}>{m.label}</div>
                        <div style={{ fontFamily: T.sans, fontSize: "10px", color: T.textMuted, marginTop: "1px" }}>{m.hint}</div>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Feature weights — only shown for weighted_cosine */}
            <AnimatePresence>
              {metric === "weighted_cosine" && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                  style={{ overflow: "hidden" }}
                >
                  <div style={{ fontFamily: T.sans, fontSize: "10px", color: T.textMuted, marginBottom: "6px" }}>
                    Feature weights
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    {FEATURE_WEIGHTS.map(fw => (
                      <div key={fw.field} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ fontFamily: T.mono, fontSize: "10px", color: T.textLabel, width: "92px", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {fw.label}
                        </span>
                        <div style={{ flex: 1, height: "3px", background: "rgba(148,163,184,0.10)", borderRadius: "2px", overflow: "hidden" }}>
                          <div style={{ width: `${fw.pct}%`, height: "100%", background: T.accent, opacity: 0.6, borderRadius: "2px" }} />
                        </div>
                        <span style={{ fontFamily: T.mono, fontSize: "9.5px", color: T.textMuted, width: "26px", textAlign: "right" }}>{fw.pct}%</span>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* top_k */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                <label style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>Top results</label>
                <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.accent }}>{topK}</span>
              </div>
              <input type="range" min={5} max={20} step={1} value={topK} disabled={loading}
                onChange={e => setTopK(Number(e.target.value))}
                className="spring-range"
                style={{ "--pct": `${((topK - 5) / 15) * 100}%` }}
              />
            </div>

            {/* corpus_size */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                <label style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>Corpus size</label>
                <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.accent }}>{corpusSize}</span>
              </div>
              <input type="range" min={50} max={300} step={50} value={corpusSize} disabled={loading}
                onChange={e => setCorpusSize(Number(e.target.value))}
                className="spring-range"
                style={{ "--pct": `${((corpusSize - 50) / 250) * 100}%` }}
              />
            </div>

            {/* stability filter */}
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
                <motion.div
                  animate={{ x: stabilityFilter ? 13 : 2 }}
                  transition={{ type: "spring", stiffness: 500, damping: 35 }}
                  style={{ position: "absolute", top: "2px", width: "11px", height: "11px", borderRadius: "50%", background: "#fff" }}
                />
              </div>
              <span style={{ fontFamily: T.sans, fontSize: "11.5px", color: T.textLabel }}>Stable only (eah ≤ 0)</span>
            </label>
          </div>
        </div>

        {/* ── Results ── */}
        <div className="gsap-item">
          {!hasSearched && !loading && <EmptyState />}

          {hasSearched && seed && results.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <SeedBanner seed={seed} />

              <div style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted }}>
                Corpus: <span style={{ fontFamily: T.mono, color: T.textLabel }}>{corpusCount}</span> materials in the{" "}
                <span style={{ fontFamily: T.mono, color: T.textLabel }}>{seed.elements?.slice().sort().join("-")}</span> element space ·
                metric: <span style={{ fontFamily: T.mono, color: T.accent }}>{selectedMetric.label}</span>
              </div>

              {/* Bento: radar + quick list */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "10px", alignSelf: "flex-start" }}>
                    Property radar · seed vs top-3
                  </div>
                  <RadarChart seed={seed} top3={top3} />
                </div>
                <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px" }}>
                  <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "10px" }}>
                    Top results
                  </div>
                  <QuickList results={results} />
                </div>
              </div>

              {/* Detailed result cards */}
              <div>
                <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "8px" }}>
                  Detailed results
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {results.map((result, index) => (
                    <ResultCard
                      key={result.material?.material_id ?? index}
                      result={result}
                      index={index}
                      isExpanded={expandedCards.has(index)}
                      onToggle={() => toggleCard(index)}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {hasSearched && !loading && results.length === 0 && !error && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ padding: "40px", textAlign: "center", fontFamily: T.sans, fontSize: "13px", color: T.textMuted }}>
              No similar materials found. Try a larger corpus or different metric.
            </motion.div>
          )}
        </div>
      </div>
    </>
  );
}
