import { recommend } from "../api";
/**
 * Recommendations.jsx  —  Tab 2
 * Content-based recommendation engine: user defines PropertyRequirements
 * (target / acceptable range / importance) + hard categorical constraints,
 * engine scores and ranks the corpus.
 *
 * Data contract (mirrors Python search/recommender.py):
 *   PROPERTY_META: { field: { label, unit, min, max, step,
 *                              default_target, default_lo, default_hi } }
 *   PropertyRequirement { field, target, lo, hi, importance [1,10] }
 *   CategoryRequirements { stability_required, require_dos,
 *                           require_band_structure, require_elastic, require_phonon }
 *   PropertyScore { field, label, material_value, target,
 *                   raw_score [0,1], weighted_score, in_range }
 *   RecommendationResult { material: MaterialDocument, total_score [0,100],
 *                           property_scores[], hard_constraints_met, rank }
 *
 * Scoring semantics surfaced in UI:
 *   - in_range  → 1.0 raw_score (perfect match)
 *   - outside   → exponential decay from nearest bound
 *   - hard constraint violation → total_score = 0, sorted to bottom,
 *     shown with a visible warning (NOT hidden — transparency requirement)
 *
 * Animations: GSAP mount stagger, Framer Motion spring sliders + NumberTicker,
 * AnimatePresence for requirement cards (add/remove), expandable result cards.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence, useMotionValue, useSpring } from "framer-motion";
import { gsap } from "gsap";

// ─── Design tokens (shared source of truth) ────────────────────────────────────
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

// ─── PROPERTY_META mirror (search/recommender.py) ──────────────────────────────
const PROPERTY_META = {
  band_gap: {
    label: "Band Gap", unit: "eV",
    min: 0.0, max: 10.0, step: 0.1,
    default_target: 1.5, default_lo: 0.5, default_hi: 3.0,
  },
  density: {
    label: "Density", unit: "g/cm³",
    min: 0.5, max: 25.0, step: 0.5,
    default_target: 5.0, default_lo: 2.0, default_hi: 10.0,
  },
  formation_energy_per_atom: {
    label: "Formation Energy", unit: "eV/atom",
    min: -5.0, max: 2.0, step: 0.1,
    default_target: -1.0, default_lo: -3.0, default_hi: 0.0,
  },
  energy_above_hull: {
    label: "E above Hull", unit: "eV/atom",
    min: 0.0, max: 1.0, step: 0.01,
    default_target: 0.0, default_lo: 0.0, default_hi: 0.1,
  },
  volume: {
    label: "Volume", unit: "Å³",
    min: 5.0, max: 500.0, step: 5.0,
    default_target: 50.0, default_lo: 20.0, default_hi: 150.0,
  },
};
const PROPERTY_KEYS = Object.keys(PROPERTY_META);

function scoreColor(score100) {
  if (score100 >= 70) return T.success;
  if (score100 >= 40) return T.warning;
  return T.danger;
}
function scoreBg(score100) {
  if (score100 >= 70) return "rgba(34,197,94,0.10)";
  if (score100 >= 40) return "rgba(245,158,11,0.10)";
  return "rgba(239,68,68,0.10)";
}
function scoreLabel(score100) {
  if (score100 >= 70) return "Strong match";
  if (score100 >= 40) return "Partial match";
  return "Weak match";
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

// ─── Mini progress bar ──────────────────────────────────────────────────────
function MiniBar({ value, color }) {
  return (
    <div style={{ height: "3px", background: "rgba(148,163,184,0.12)", borderRadius: "2px", overflow: "hidden" }}>
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(value, 100)}%` }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        style={{ height: "100%", background: color, borderRadius: "2px" }}
      />
    </div>
  );
}

// ─── Spring-physics range slider (custom thumb, used everywhere) ──────────────
function SpringSlider({ min, max, step, value, onChange, disabled, accentColor = T.accent }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={{ position: "relative" }}>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        disabled={disabled}
        onChange={e => onChange(Number(e.target.value))}
        className="spring-range"
        style={{
          "--pct": `${pct}%`,
          "--thumb-color": accentColor,
        }}
      />
    </div>
  );
}

// ─── Requirement card (one PropertyRequirement) ────────────────────────────────
function RequirementCard({ field, requirement, onChange, onRemove }) {
  const meta = PROPERTY_META[field];
  const { target, lo, hi, importance } = requirement;
  const [expanded, setExpanded] = useState(true);

  const invalidRange = lo > hi;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.96, y: -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, height: 0, marginBottom: 0 }}
      transition={{ type: "spring", stiffness: 350, damping: 30 }}
      style={{
        background: "rgba(148,163,184,0.04)",
        border: `1px solid ${T.border}`,
        borderRadius: "9px",
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: "100%", background: "none", border: "none", cursor: "pointer",
          padding: "10px 12px", display: "flex", alignItems: "center",
          justifyContent: "space-between", textAlign: "left",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <motion.svg
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 26 }}
            width="11" height="11" viewBox="0 0 14 14" fill="none" style={{ color: T.textMuted, flexShrink: 0 }}
          >
            <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
          </motion.svg>
          <span style={{ fontFamily: T.sans, fontSize: "12.5px", fontWeight: 500, color: T.textPrimary }}>
            {meta.label}
          </span>
          <span style={{ fontFamily: T.mono, fontSize: "10px", color: T.accent, background: T.accentDim, padding: "1px 6px", borderRadius: "4px" }}>
            target {target.toFixed(2)} {meta.unit}
          </span>
        </div>
        <span
          role="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: "20px", height: "20px", borderRadius: "5px", color: T.textMuted, cursor: "pointer",
          }}
          className="remove-req-btn"
        >
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ height: { type: "spring", stiffness: 300, damping: 32 }, opacity: { duration: 0.15 } }}
            style={{ overflow: "hidden" }}
          >
            <div style={{ padding: "2px 12px 14px", display: "flex", flexDirection: "column", gap: "12px" }}>

              {/* Target */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                  <label style={{ fontFamily: T.sans, fontSize: "10.5px", color: T.textLabel }}>Target</label>
                  <span style={{ fontFamily: T.mono, fontSize: "10.5px", color: T.textPrimary }}>{target.toFixed(2)} {meta.unit}</span>
                </div>
                <SpringSlider
                  min={meta.min} max={meta.max} step={meta.step}
                  value={target} accentColor={T.accent}
                  onChange={v => onChange({ ...requirement, target: v })}
                />
              </div>

              {/* Range (lo/hi) — dual display */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                    <label style={{ fontFamily: T.sans, fontSize: "10.5px", color: T.textLabel }}>Min</label>
                    <span style={{ fontFamily: T.mono, fontSize: "10.5px", color: invalidRange ? T.danger : T.textPrimary }}>{lo.toFixed(2)}</span>
                  </div>
                  <SpringSlider
                    min={meta.min} max={meta.max} step={meta.step}
                    value={lo} accentColor={T.teal}
                    onChange={v => onChange({ ...requirement, lo: v })}
                  />
                </div>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                    <label style={{ fontFamily: T.sans, fontSize: "10.5px", color: T.textLabel }}>Max</label>
                    <span style={{ fontFamily: T.mono, fontSize: "10.5px", color: invalidRange ? T.danger : T.textPrimary }}>{hi.toFixed(2)}</span>
                  </div>
                  <SpringSlider
                    min={meta.min} max={meta.max} step={meta.step}
                    value={hi} accentColor={T.teal}
                    onChange={v => onChange({ ...requirement, hi: v })}
                  />
                </div>
              </div>
              {invalidRange && (
                <div style={{ fontFamily: T.sans, fontSize: "10.5px", color: T.warning }}>
                  Min exceeds max — will be swapped automatically on search.
                </div>
              )}

              {/* Importance */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                  <label style={{ fontFamily: T.sans, fontSize: "10.5px", color: T.textLabel }}>Importance</label>
                  <span style={{ fontFamily: T.mono, fontSize: "10.5px", color: T.indigo }}>
                    <NumberTicker value={importance} decimals={1} /> / 10
                  </span>
                </div>
                <SpringSlider
                  min={1} max={10} step={0.5}
                  value={importance} accentColor={T.indigo}
                  onChange={v => onChange({ ...requirement, importance: v })}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Property picker dropdown (add new requirement) ────────────────────────────
function PropertyPicker({ selectedFields, onAdd }) {
  const [open, setOpen] = useState(false);
  const available = PROPERTY_KEYS.filter(k => !selectedFields.includes(k));

  if (available.length === 0) return null;

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: "flex", alignItems: "center", gap: "6px",
          fontFamily: T.sans, fontSize: "12px", fontWeight: 500,
          color: T.accent, background: T.accentDim,
          border: `1px dashed rgba(6,182,212,0.35)`,
          borderRadius: "7px", padding: "7px 12px", cursor: "pointer", width: "100%",
          justifyContent: "center",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
        Add property requirement
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            style={{
              position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0,
              background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "8px",
              padding: "5px", zIndex: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            }}
          >
            {available.map(field => (
              <button
                key={field}
                onClick={() => { onAdd(field); setOpen(false); }}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  background: "none", border: "none", cursor: "pointer",
                  padding: "8px 10px", borderRadius: "5px",
                  fontFamily: T.sans, fontSize: "12px", color: T.textSecondary,
                }}
                className="property-option"
              >
                {PROPERTY_META[field].label}
                <span style={{ color: T.textMuted, marginLeft: "6px", fontFamily: T.mono, fontSize: "10px" }}>
                  {PROPERTY_META[field].unit}
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Hard constraint toggle row ────────────────────────────────────────────────
function ConstraintToggle({ label, checked, onChange }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" }}>
      <div
        onClick={onChange}
        style={{
          width: "30px", height: "17px", borderRadius: "9px",
          background: checked ? T.accent : "rgba(148,163,184,0.15)",
          border: `1px solid ${checked ? T.accent : T.border}`,
          position: "relative", cursor: "pointer", flexShrink: 0,
          transition: "background 200ms ease, border-color 200ms ease",
        }}
      >
        <motion.div
          animate={{ x: checked ? 13 : 2 }}
          transition={{ type: "spring", stiffness: 500, damping: 35 }}
          style={{ position: "absolute", top: "2px", width: "11px", height: "11px", borderRadius: "50%", background: "#fff" }}
        />
      </div>
      <span style={{ fontFamily: T.sans, fontSize: "11.5px", color: T.textLabel }}>{label}</span>
    </label>
  );
}

// ─── Single property-score row in a result card ────────────────────────────────
function PropertyScoreRow({ ps }) {
  const pct = ps.raw_score * 100;
  const color = ps.in_range ? T.success : (pct >= 40 ? T.warning : T.danger);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "5px", minWidth: 0 }}>
          <span style={{ flexShrink: 0 }}>
            {ps.in_range ? (
              <svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M3 7.5l3 3 5-6" stroke={T.success} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke={T.warning} strokeWidth="1.4"/><path d="M7 4.5v3" stroke={T.warning} strokeWidth="1.4" strokeLinecap="round"/><circle cx="7" cy="9.5" r="0.6" fill={T.warning}/></svg>
            )}
          </span>
          <span style={{ fontFamily: T.sans, fontSize: "11.5px", color: T.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {ps.label}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
          <span style={{ fontFamily: T.mono, fontSize: "10.5px", color: T.textMuted }}>
            {ps.material_value != null ? ps.material_value.toFixed(3) : "N/A"}
            <span style={{ opacity: 0.5 }}> / {ps.target.toFixed(2)}</span>
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

// ─── Result card ────────────────────────────────────────────────────────────
function ResultCard({ result, index, isExpanded, onToggle }) {
  const { material: mat, total_score, property_scores, hard_constraints_met, rank } = result;
  const color = hard_constraints_met ? scoreColor(total_score) : T.danger;
  const mpUrl = `https://materialsproject.org/materials/${mat.material_id}`;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        layout: { type: "spring", stiffness: 300, damping: 30 },
        opacity: { duration: 0.3, delay: index * 0.04 },
        y: { duration: 0.35, delay: index * 0.04, ease: [0.22, 1, 0.36, 1] },
      }}
      style={{
        background: T.bgCard,
        border: `1px solid ${isExpanded ? "rgba(6,182,212,0.18)" : (hard_constraints_met ? T.border : "rgba(239,68,68,0.18)")}`,
        borderRadius: "10px", overflow: "hidden",
        opacity: hard_constraints_met ? 1 : 0.75,
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
            {!hard_constraints_met && (
              <span style={{ fontFamily: T.sans, fontSize: "10.5px", color: "#fca5a5", background: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.25)", padding: "1px 7px", borderRadius: "4px", fontWeight: 500 }}>
                constraint violated
              </span>
            )}
          </div>
        </div>

        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{ textAlign: "right", minWidth: "58px" }}>
            <div style={{ fontFamily: T.mono, fontSize: "15px", fontWeight: 600, color, lineHeight: 1 }}>
              <NumberTicker value={total_score} decimals={1} /> <span style={{ fontSize: "10px", opacity: 0.6 }}>/100</span>
            </div>
            <div style={{ fontFamily: T.sans, fontSize: "9px", color, opacity: 0.7, marginTop: "2px", letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {hard_constraints_met ? scoreLabel(total_score) : "Disqualified"}
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
        <MiniBar value={total_score} color={color} />
      </div>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ height: { type: "spring", stiffness: 280, damping: 30 }, opacity: { duration: 0.2 } }}
            style={{ overflow: "hidden" }}
          >
            <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${T.border}`, paddingTop: "14px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>

                {/* LEFT: material properties */}
                <div>
                  <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "8px" }}>
                    Material
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontFamily: T.sans, fontSize: "11.5px", color: T.textLabel }}>
                    <div>Stability: <span style={{ fontFamily: T.mono, color: mat.is_stable ? "#86efac" : "#fcd34d" }}>{mat.is_stable ? "Stable" : "Metastable"}</span></div>
                    {mat.energy_above_hull != null && <div>E above hull: <span style={{ fontFamily: T.mono, color: T.textPrimary }}>{mat.energy_above_hull.toFixed(4)} eV/atom</span></div>}
                    {mat.band_gap != null && <div>Band gap: <span style={{ fontFamily: T.mono, color: T.textPrimary }}>{mat.band_gap.toFixed(3)} eV</span></div>}
                    {mat.density != null && <div>Density: <span style={{ fontFamily: T.mono, color: T.textPrimary }}>{mat.density.toFixed(3)} g/cm³</span></div>}
                    {mat.formation_energy_per_atom != null && <div>Formation energy: <span style={{ fontFamily: T.mono, color: T.textPrimary }}>{mat.formation_energy_per_atom.toFixed(4)} eV/atom</span></div>}
                    {mat.crystal_system && <div>Crystal system: <span style={{ fontFamily: T.mono, color: T.textPrimary }}>{mat.crystal_system}</span></div>}
                  </div>
                  {!hard_constraints_met && (
                    <div style={{ marginTop: "10px", padding: "8px 10px", borderRadius: "6px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.22)", fontFamily: T.sans, fontSize: "11px", color: "#fca5a5" }}>
                      One or more hard constraints were not met.
                    </div>
                  )}
                  <a href={mpUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: "5px", marginTop: "12px", fontFamily: T.sans, fontSize: "11px", color: T.accent, textDecoration: "none", padding: "4px 8px", borderRadius: "5px", border: "1px solid rgba(6,182,212,0.20)", background: T.accentDim }} className="mp-link">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 8L8 2M8 2H4M8 2v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    View on Materials Project
                  </a>
                </div>

                {/* RIGHT: requirement match breakdown */}
                <div>
                  <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "8px" }}>
                    Requirement match
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    {property_scores.map(ps => <PropertyScoreRow key={ps.field} ps={ps} />)}
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

const secondaryBtnStyle = {
  fontFamily: T.sans, fontSize: "11px", color: T.textLabel,
  background: "rgba(148,163,184,0.06)", border: `1px solid ${T.border}`,
  borderRadius: "5px", padding: "4px 10px", cursor: "pointer",
};

// ─── Results summary ────────────────────────────────────────────────────────
function ResultsSummary({ results, corpusSize, onExpandAll, onCollapseAll }) {
  const validCount = results.filter(r => r.hard_constraints_met).length;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "8px", flexWrap: "wrap", gap: "10px" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
        <div>
          <span style={{ fontFamily: T.mono, fontSize: "13px", fontWeight: 600, color: T.success }}>{validCount}</span>
          <span style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted, marginLeft: "4px" }}>
            meet constraints · {corpusSize} corpus
          </span>
        </div>
        <div style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted }}>
          showing top {results.length}
        </div>
      </div>
      <div style={{ display: "flex", gap: "6px" }}>
        <button onClick={onExpandAll} style={secondaryBtnStyle}>Expand all</button>
        <button onClick={onCollapseAll} style={secondaryBtnStyle}>Collapse</button>
      </div>
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
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none"><path d="M11 2l2.5 5 5.5.8-4 3.9.9 5.5L11 14.4l-4.9 2.6.9-5.5-4-3.9 5.5-.8L11 2z" stroke={T.accent} strokeWidth="1.5" strokeLinejoin="round"/></svg>
      </div>
      <div style={{ fontFamily: T.sans, fontSize: "14px", fontWeight: 500, color: T.textSecondary }}>
        Define requirements to get recommendations
      </div>
      <div style={{ fontFamily: T.sans, fontSize: "12px", color: T.textMuted, maxWidth: "340px", lineHeight: 1.6 }}>
        Add at least one property requirement and specify required elements.
        The engine scores by weighted match against your target ranges.
      </div>
    </motion.div>
  );
}

// ─── Main Recommendations component ────────────────────────────────────────────
export default function Recommendations() {
  // Corpus config
  const [elements, setElements]         = useState("");
  const [stabilityCorpus, setStabilityCorpus] = useState(true);
  const [corpusSize, setCorpusSize]     = useState(150);
  const [topK, setTopK]                 = useState(10);

  // Property requirements: { [field]: { target, lo, hi, importance } }
  const [requirements, setRequirements] = useState({
    band_gap: {
      target: PROPERTY_META.band_gap.default_target,
      lo: PROPERTY_META.band_gap.default_lo,
      hi: PROPERTY_META.band_gap.default_hi,
      importance: 5.0,
    },
    formation_energy_per_atom: {
      target: PROPERTY_META.formation_energy_per_atom.default_target,
      lo: PROPERTY_META.formation_energy_per_atom.default_lo,
      hi: PROPERTY_META.formation_energy_per_atom.default_hi,
      importance: 5.0,
    },
  });

  // Hard constraints
  const [constraints, setConstraints] = useState({
    stability_required: false,
    require_dos: false,
    require_band_structure: false,
    require_elastic: false,
    require_phonon: false,
  });

  const [results, setResults]         = useState([]);
  const [corpusCount, setCorpusCount] = useState(0);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [expandedCards, setExpandedCards] = useState(new Set());

  const headerRef = useRef(null);

  useEffect(() => {
    if (!headerRef.current) return;
    const els = headerRef.current.querySelectorAll(".gsap-item");
    gsap.fromTo(els, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out", stagger: 0.06, delay: 0.05 });
  }, []);

  const addRequirement = useCallback((field) => {
    const meta = PROPERTY_META[field];
    setRequirements(prev => ({
      ...prev,
      [field]: { target: meta.default_target, lo: meta.default_lo, hi: meta.default_hi, importance: 5.0 },
    }));
  }, []);

  const removeRequirement = useCallback((field) => {
    setRequirements(prev => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const updateRequirement = useCallback((field, value) => {
    setRequirements(prev => ({ ...prev, [field]: value }));
  }, []);

  const handleSearch = useCallback(async () => {
    const reqFields = Object.keys(requirements);
    if (reqFields.length === 0) {
      setError("Select at least one property requirement.");
      return;
    }
    if (!elements.trim()) {
      setError("Specify at least one element to bound the corpus.");
      return;
    }
    setError(null);
    setLoading(true);
    setHasSearched(true);

    try {
      const payload = {
        elements: elements.split(",").map(s => s.trim()).filter(Boolean),
        stability_corpus: stabilityCorpus,
        corpus_size: corpusSize,
        top_k: topK,
        requirements: reqFields.map(field => ({
          field,
          target: requirements[field].target,
          lo: Math.min(requirements[field].lo, requirements[field].hi),
          hi: Math.max(requirements[field].lo, requirements[field].hi),
          importance: requirements[field].importance,
        })),
        categorical: constraints,
      };

      const data = await recommend({
        elements: payload.elements,
        requirements: payload.requirements,
        categorical: payload.categorical,
        corpus_size: payload.corpus_size,
        top_k: payload.top_k,
      });
      // recommend() returns list[RecommendResultResponse] directly
      setResults(Array.isArray(data) ? data : (data.results ?? []));
      setCorpusCount(Array.isArray(data) ? data.length : (data.corpus_count ?? corpusSize));
      if (data.results?.length) setExpandedCards(new Set([0]));
    } catch (err) {
      setError(err.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [requirements, elements, stabilityCorpus, corpusSize, topK, constraints]);

  const toggleCard = useCallback((index) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      next.has(index) ? next.delete(index) : next.add(index);
      return next;
    });
  }, []);
  const expandAll   = () => setExpandedCards(new Set(results.map((_, i) => i)));
  const collapseAll = () => setExpandedCards(new Set());

  const reqFields = Object.keys(requirements);

  return (
    <>
      <style>{`
        .corpus-input:focus { border-color: ${T.borderFocus} !important; box-shadow: 0 0 0 3px ${T.accentGlow}; outline: none; }
        .mp-link:hover { background: rgba(6,182,212,0.16) !important; }
        .result-card-header:hover { background: rgba(148,163,184,0.04); }
        .property-option:hover { background: rgba(148,163,184,0.06); }
        .remove-req-btn:hover { background: rgba(239,68,68,0.12); color: ${T.danger}; }
        .search-btn:hover:not(:disabled) { transform: translateY(-1px); background: rgba(6,182,212,0.90) !important; }
        .search-btn:active:not(:disabled) { transform: translateY(0); }
        .search-btn:disabled { opacity: 0.55; cursor: not-allowed; }

        .spring-range {
          -webkit-appearance: none;
          width: 100%;
          height: 3px;
          border-radius: 2px;
          background: linear-gradient(to right, var(--thumb-color) var(--pct), rgba(148,163,184,0.15) var(--pct));
          cursor: pointer;
        }
        .spring-range::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 13px; height: 13px; border-radius: 50%;
          background: var(--thumb-color);
          border: 2px solid ${T.bgCard};
          box-shadow: 0 0 0 1px var(--thumb-color);
          cursor: pointer;
          transition: transform 150ms;
        }
        .spring-range::-webkit-slider-thumb:hover { transform: scale(1.2); }
        .spring-range:disabled { opacity: 0.5; cursor: not-allowed; }

        @keyframes shimmer { 0% { background-position: -200% center; } 100% { background-position: 200% center; } }
        .btn-shimmer {
          background: linear-gradient(90deg, rgba(6,182,212,0.85) 25%, rgba(20,184,166,0.95) 50%, rgba(6,182,212,0.85) 75%);
          background-size: 200% auto;
          animation: shimmer 1.4s linear infinite;
        }
      `}</style>

      <div style={{ padding: "28px 32px", maxWidth: "1100px", margin: "0 auto" }}>

        {/* ── Header ── */}
        <div ref={headerRef} style={{ marginBottom: "24px" }}>
          <div className="gsap-item" style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: T.accentDim, border: "1px solid rgba(6,182,212,0.20)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M10 2l2.09 4.26L17 7.27l-3.5 3.41.83 4.82L10 13.25l-4.33 2.25.83-4.82L3 7.27l4.91-.71L10 2z" stroke={T.accent} strokeWidth="1.5" strokeLinejoin="round"/></svg>
            </div>
            <h1 style={{ fontFamily: T.sans, fontSize: "17px", fontWeight: 600, color: T.textPrimary, margin: 0, letterSpacing: "-0.015em" }}>
              Recommendation Engine
            </h1>
          </div>
          <p className="gsap-item" style={{ fontFamily: T.sans, fontSize: "13px", color: T.textMuted, margin: 0, lineHeight: 1.6, maxWidth: "580px" }}>
            Define technical requirements — target values, acceptable ranges, and relative importance —
            and rank the corpus by weighted match.
          </p>
        </div>

        {/* ── Bento: requirements + corpus/constraints ── */}
        <div className="gsap-item" style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: "14px", marginBottom: "20px", alignItems: "start" }}>

          {/* LEFT: property requirements builder */}
          <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Property requirements
            </div>

            <AnimatePresence>
              {reqFields.map(field => (
                <RequirementCard
                  key={field}
                  field={field}
                  requirement={requirements[field]}
                  onChange={(val) => updateRequirement(field, val)}
                  onRemove={() => removeRequirement(field)}
                />
              ))}
            </AnimatePresence>

            <PropertyPicker selectedFields={reqFields} onAdd={addRequirement} />

            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                style={{ overflow: "hidden", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.22)", borderRadius: "7px", padding: "8px 12px", fontFamily: T.sans, fontSize: "12px", color: "#fca5a5" }}
              >
                {error}
              </motion.div>
            )}

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
                letterSpacing: "0.01em", marginTop: "4px",
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
                  Scoring corpus…
                </>
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 1l1.6 3.3 3.6.5-2.6 2.5.6 3.6L7 9.2l-3.2 1.7.6-3.6L1.8 4.8l3.6-.5L7 1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
                  Get recommendations
                </>
              )}
            </button>
          </div>

          {/* RIGHT: corpus + hard constraints */}
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>

            {/* Corpus config */}
            <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                Corpus
              </div>
              <div>
                <label style={{ display: "block", fontFamily: T.sans, fontSize: "11px", color: T.textLabel, marginBottom: "5px" }}>
                  Required elements
                </label>
                <input
                  type="text" value={elements} onChange={e => setElements(e.target.value)}
                  placeholder="Li, Fe, O" disabled={loading}
                  style={{ width: "100%", background: "rgba(148,163,184,0.05)", border: `1px solid ${T.border}`, borderRadius: "6px", padding: "7px 10px", fontFamily: T.mono, fontSize: "12px", color: T.textPrimary, outline: "none", boxSizing: "border-box", transition: "border-color 200ms ease, box-shadow 200ms ease" }}
                  className="corpus-input"
                />
              </div>
              <ConstraintToggle label="Near-stable corpus (eah ≤ 0.1 eV)" checked={stabilityCorpus} onChange={() => setStabilityCorpus(v => !v)} />
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <label style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>Max corpus size</label>
                  <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.accent }}>{corpusSize}</span>
                </div>
                <SpringSlider min={50} max={500} step={50} value={corpusSize} onChange={setCorpusSize} disabled={loading} />
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <label style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>Results to show</label>
                  <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.accent }}>{topK}</span>
                </div>
                <SpringSlider min={5} max={30} step={1} value={topK} onChange={setTopK} disabled={loading} />
              </div>
            </div>

            {/* Hard constraints */}
            <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div>
                <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                  Hard constraints
                </div>
                <div style={{ fontFamily: T.sans, fontSize: "10.5px", color: T.textMuted, marginTop: "3px", lineHeight: 1.5 }}>
                  Violators score 0 and sort to the bottom.
                </div>
              </div>
              <ConstraintToggle label="Must be stable (eah ≤ 0)" checked={constraints.stability_required} onChange={() => setConstraints(c => ({ ...c, stability_required: !c.stability_required }))} />
              <ConstraintToggle label="Must have DOS data" checked={constraints.require_dos} onChange={() => setConstraints(c => ({ ...c, require_dos: !c.require_dos }))} />
              <ConstraintToggle label="Must have Band Structure" checked={constraints.require_band_structure} onChange={() => setConstraints(c => ({ ...c, require_band_structure: !c.require_band_structure }))} />
              <ConstraintToggle label="Must have Elasticity data" checked={constraints.require_elastic} onChange={() => setConstraints(c => ({ ...c, require_elastic: !c.require_elastic }))} />
              <ConstraintToggle label="Must have Phonon data" checked={constraints.require_phonon} onChange={() => setConstraints(c => ({ ...c, require_phonon: !c.require_phonon }))} />
            </div>
          </div>
        </div>

        {/* ── Results ── */}
        <div className="gsap-item">
          {!hasSearched && !loading && <EmptyState />}

          {hasSearched && results.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <ResultsSummary results={results} corpusSize={corpusCount} onExpandAll={expandAll} onCollapseAll={collapseAll} />
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
          )}

          {hasSearched && !loading && results.length === 0 && !error && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ padding: "40px", textAlign: "center", fontFamily: T.sans, fontSize: "13px", color: T.textMuted }}>
              No results. Try removing hard constraints or broadening the corpus.
            </motion.div>
          )}
        </div>
      </div>
    </>
  );
}
