/**
 * SemanticSearch.jsx — Tab 1
 * Uses centralized api.js client → POST /api/v1/semantic
 *
 * Response shape from FastAPI:
 *   list[SemanticResultResponse] where each item has:
 *     { material: MaterialResponse, similarity_score, rank, description }
 *   MaterialResponse: { material_id, formula, band_gap, density,
 *     formation_energy_per_atom, energy_above_hull, volume, nsites,
 *     crystal_system, spacegroup, is_stable, is_magnetic, elements,
 *     completeness: { has_dos, has_band_structure, has_elastic, has_phonon } }
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence, useMotionValue, useSpring } from "framer-motion";
import { gsap } from "gsap";
import { semanticSearch } from "../api";

const T = {
  bgPage: "#09090B", bgCard: "#0F172A", border: "rgba(148,163,184,0.12)",
  borderFocus: "rgba(6,182,212,0.45)", accent: "#06B6D4", accentDim: "rgba(6,182,212,0.10)",
  accentGlow: "rgba(6,182,212,0.20)", textPrimary: "#F1F5F9", textSecondary: "#CBD5E1",
  textMuted: "#64748B", textLabel: "#94A3B8", success: "#22C55E", warning: "#F59E0B",
  danger: "#EF4444", mono: "'JetBrains Mono', monospace", sans: "'Inter', system-ui, sans-serif",
};

const PLACEHOLDERS = [
  "stable wide-band-gap insulator for photovoltaics",
  "magnetic oxide with elastic and phonon data",
  "lightweight battery cathode with low formation energy",
  "semiconductor with band gap between 1.0 and 2.5 eV",
  "cubic perovskite with high density of states",
];

function scoreColor(pct) {
  return pct >= 60 ? T.success : pct >= 35 ? T.warning : T.danger;
}
function scoreLabel(pct) {
  return pct >= 60 ? "High" : pct >= 35 ? "Moderate" : "Low";
}

function NumberTicker({ value, decimals = 1, suffix = "" }) {
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { stiffness: 80, damping: 18 });
  const [display, setDisplay] = useState((0).toFixed(decimals) + suffix);
  useEffect(() => { mv.set(value); }, [value, mv]);
  useEffect(() => spring.on("change", v => setDisplay(v.toFixed(decimals) + suffix)), [spring, decimals, suffix]);
  return <span>{display}</span>;
}

function ScoreBar({ value, color }) {
  return (
    <div style={{ height: "3px", background: "rgba(148,163,184,0.12)", borderRadius: "2px", overflow: "hidden" }}>
      <motion.div initial={{ width: 0 }} animate={{ width: `${Math.min(value, 100)}%` }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        style={{ height: "100%", background: color, borderRadius: "2px" }} />
    </div>
  );
}

function DatasetBadge({ label, available }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "5px", padding: "3px 8px",
      borderRadius: "5px", background: available ? "rgba(34,197,94,0.08)" : "rgba(148,163,184,0.05)",
      border: `1px solid ${available ? "rgba(34,197,94,0.20)" : "rgba(148,163,184,0.10)"}`,
    }}>
      <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: available ? T.success : T.textMuted, flexShrink: 0 }} />
      <span style={{ fontFamily: T.mono, fontSize: "10px", fontWeight: 500, color: available ? "#86efac" : T.textMuted }}>
        {label}
      </span>
    </div>
  );
}

function PropPill({ label, value, unit }) {
  if (value == null) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px", padding: "8px 10px", borderRadius: "7px", background: "rgba(148,163,184,0.05)", border: `1px solid ${T.border}`, minWidth: "90px" }}>
      <span style={{ fontFamily: T.sans, fontSize: "10px", color: T.textMuted }}>{label}</span>
      <span style={{ fontFamily: T.mono, fontSize: "12px", color: T.textPrimary, fontWeight: 500 }}>
        {typeof value === "number" ? value.toFixed(3) : value}
        {unit && <span style={{ fontSize: "10px", color: T.textMuted, marginLeft: "3px" }}>{unit}</span>}
      </span>
    </div>
  );
}

function ResultCard({ result, index, isExpanded, onToggle }) {
  // API returns SemanticResultResponse — material.formula (not formula_pretty), material.spacegroup (not spacegroup_symbol)
  const { material: mat, similarity_score, rank, description } = result;
  const pct = similarity_score * 100;
  const color = scoreColor(pct);
  const mpUrl = `https://materialsproject.org/materials/${mat.material_id}`;
  const completeness = mat.completeness || {};
  const datasets = [
    { label: "DOS", available: completeness.has_dos },
    { label: "BS",  available: completeness.has_band_structure },
    { label: "ELC", available: completeness.has_elastic },
    { label: "PHN", available: completeness.has_phonon },
  ];

  return (
    <motion.div layout initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
      transition={{ layout: { type: "spring", stiffness: 300, damping: 30 }, opacity: { duration: 0.3, delay: index * 0.05 }, y: { duration: 0.35, delay: index * 0.05 } }}
      style={{ background: T.bgCard, border: `1px solid ${isExpanded ? "rgba(6,182,212,0.18)" : T.border}`, borderRadius: "10px", overflow: "hidden" }}
    >
      <button onClick={onToggle} style={{ width: "100%", background: "none", border: "none", cursor: "pointer", padding: "14px 16px", display: "flex", alignItems: "center", gap: "12px", textAlign: "left" }} className="result-card-header">
        <div style={{ fontFamily: T.mono, fontSize: "11px", color: T.textMuted, flexShrink: 0, width: "22px", textAlign: "right" }}>#{rank}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" }}>
            <span style={{ fontFamily: T.mono, fontSize: "14px", fontWeight: 600, color: T.textPrimary }}>{mat.formula}</span>
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.accent, background: T.accentDim, padding: "1px 6px", borderRadius: "4px", border: "1px solid rgba(6,182,212,0.18)" }}>{mat.material_id}</span>
            {mat.crystal_system && <span style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted }}>{mat.crystal_system}</span>}
          </div>
        </div>
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{ textAlign: "right", minWidth: "52px" }}>
            <div style={{ fontFamily: T.mono, fontSize: "15px", fontWeight: 600, color, lineHeight: 1 }}><NumberTicker value={pct} decimals={1} suffix="%" /></div>
            <div style={{ fontFamily: T.sans, fontSize: "9px", color, opacity: 0.7, marginTop: "2px", letterSpacing: "0.06em", textTransform: "uppercase" }}>{scoreLabel(pct)}</div>
          </div>
          <motion.svg animate={{ rotate: isExpanded ? 180 : 0 }} transition={{ type: "spring", stiffness: 300, damping: 28 }}
            width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ color: T.textMuted }}>
            <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </motion.svg>
        </div>
      </button>

      <div style={{ padding: "0 16px 10px", marginTop: "-4px" }}>
        <ScoreBar value={pct} color={color} />
      </div>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div key="body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ height: { type: "spring", stiffness: 280, damping: 30 }, opacity: { duration: 0.2 } }} style={{ overflow: "hidden" }}>
            <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${T.border}`, paddingTop: "14px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                <div>
                  <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "8px" }}>Properties</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    <PropPill label="Band Gap"     value={mat.band_gap}                   unit="eV" />
                    <PropPill label="E above hull" value={mat.energy_above_hull}           unit="eV/atom" />
                    <PropPill label="Form. Energy" value={mat.formation_energy_per_atom}   unit="eV/atom" />
                    <PropPill label="Density"      value={mat.density}                    unit="g/cm³" />
                    <PropPill label="Volume"       value={mat.volume}                     unit="Å³" />
                    <PropPill label="Sites"        value={mat.nsites} />
                  </div>
                  <div style={{ display: "flex", gap: "6px", marginTop: "10px", flexWrap: "wrap" }}>
                    <span style={{ fontFamily: T.sans, fontSize: "11px", padding: "3px 8px", borderRadius: "5px", color: mat.is_stable ? "#86efac" : "#fcd34d", background: mat.is_stable ? "rgba(34,197,94,0.10)" : "rgba(245,158,11,0.10)", border: `1px solid ${mat.is_stable ? "rgba(34,197,94,0.22)" : "rgba(245,158,11,0.22)"}`, fontWeight: 500 }}>{mat.is_stable ? "Stable" : "Metastable"}</span>
                    {mat.is_magnetic && <span style={{ fontFamily: T.sans, fontSize: "11px", padding: "3px 8px", borderRadius: "5px", background: "rgba(99,102,241,0.10)", border: "1px solid rgba(99,102,241,0.22)", color: "#a5b4fc", fontWeight: 500 }}>Magnetic</span>}
                    {mat.spacegroup && <span style={{ fontFamily: T.mono, fontSize: "11px", padding: "3px 8px", borderRadius: "5px", background: "rgba(148,163,184,0.06)", border: `1px solid ${T.border}`, color: T.textLabel }}>{mat.spacegroup}</span>}
                  </div>
                  <a href={mpUrl} target="_blank" rel="noopener noreferrer"
                    style={{ display: "inline-flex", alignItems: "center", gap: "5px", marginTop: "12px", fontFamily: T.sans, fontSize: "11px", color: T.accent, textDecoration: "none", padding: "4px 8px", borderRadius: "5px", border: "1px solid rgba(6,182,212,0.20)", background: T.accentDim }} className="mp-link">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 8L8 2M8 2H4M8 2v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    View on Materials Project
                  </a>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  <div>
                    <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "8px" }}>Available datasets</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
                      {datasets.map(({ label, available }) => <DatasetBadge key={label} label={label} available={available} />)}
                    </div>
                  </div>
                  {description && (
                    <div style={{ padding: "10px 12px", borderRadius: "7px", background: "rgba(148,163,184,0.04)", border: `1px solid ${T.border}` }}>
                      <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "5px" }}>Embedded description</div>
                      <p style={{ fontFamily: T.sans, fontSize: "11.5px", color: T.textMuted, lineHeight: 1.6, margin: 0, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical" }}>
                        {description.slice(0, 300)}{description.length > 300 ? "…" : ""}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function SemanticSearch() {
  const [query, setQuery] = useState("");
  const [config, setConfig] = useState({ elements: "", stabilityOnly: false, corpusSize: 80, topK: 10 });
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [expandedCards, setExpandedCards] = useState(new Set());
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const [isFocused, setIsFocused] = useState(false);
  const [corpusCount, setCorpusCount] = useState(0);
  const [lastQuery, setLastQuery] = useState("");
  const headerRef = useRef(null);

  useEffect(() => {
    if (!headerRef.current) return;
    gsap.fromTo(headerRef.current.querySelectorAll(".gsap-item"),
      { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out", stagger: 0.06, delay: 0.05 });
  }, []);

  useEffect(() => {
    if (isFocused || query) return;
    const id = setInterval(() => setPlaceholderIdx(i => (i + 1) % PLACEHOLDERS.length), 3200);
    return () => clearInterval(id);
  }, [isFocused, query]);

  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) { setError("Enter a query."); return; }
    if (!config.elements.trim()) { setError("Specify at least one element to bound the corpus."); return; }
    setError(null); setLoading(true); setHasSearched(true); setLastQuery(q);
    try {
      // semanticSearch returns list[SemanticResultResponse] directly (no wrapper)
      const data = await semanticSearch({
        query: q,
        elements: config.elements.split(",").map(s => s.trim()).filter(Boolean),
        stability_only: config.stabilityOnly,
        corpus_size: config.corpusSize,
        top_k: config.topK,
      });
      setResults(Array.isArray(data) ? data : []);
      setCorpusCount(config.corpusSize);
      if (data?.length) setExpandedCards(new Set([0]));
    } catch (err) { setError(err.message); setResults([]); }
    finally { setLoading(false); }
  }, [query, config]);

  const toggleCard = (index) => {
    setExpandedCards(prev => { const n = new Set(prev); n.has(index) ? n.delete(index) : n.add(index); return n; });
  };

  return (
    <>
      <style>{`
        .result-card-header:hover { background: rgba(148,163,184,0.04); }
        .mp-link:hover { background: rgba(6,182,212,0.16) !important; }
        .search-btn:hover:not(:disabled) { transform: translateY(-1px); }
        .search-btn:disabled { opacity: 0.55; cursor: not-allowed; }
        @keyframes shimmer { 0% { background-position: -200% center; } 100% { background-position: 200% center; } }
        .btn-shimmer { background: linear-gradient(90deg, rgba(6,182,212,0.85) 25%, rgba(20,184,166,0.95) 50%, rgba(6,182,212,0.85) 75%); background-size: 200% auto; animation: shimmer 1.4s linear infinite; }
        .spring-range { -webkit-appearance: none; width: 100%; height: 3px; border-radius: 2px; background: linear-gradient(to right, #06B6D4 var(--pct), rgba(148,163,184,0.15) var(--pct)); cursor: pointer; }
        .spring-range::-webkit-slider-thumb { -webkit-appearance: none; width: 13px; height: 13px; border-radius: 50%; background: #06B6D4; border: 2px solid #0F172A; cursor: pointer; }
      `}</style>
      <div style={{ padding: "28px 32px", maxWidth: "1100px", margin: "0 auto" }}>
        <div ref={headerRef} style={{ marginBottom: "24px" }}>
          <div className="gsap-item" style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: T.accentDim, border: "1px solid rgba(6,182,212,0.20)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="5.5" stroke={T.accent} strokeWidth="1.5"/><path d="M14.5 14.5L18 18" stroke={T.accent} strokeWidth="1.5" strokeLinecap="round"/><path d="M6 8.5h5M8.5 6v5" stroke={T.accent} strokeWidth="1.3" strokeLinecap="round"/></svg>
            </div>
            <h1 style={{ fontFamily: T.sans, fontSize: "17px", fontWeight: 600, color: T.textPrimary, margin: 0 }}>Semantic Search</h1>
          </div>
          <p className="gsap-item" style={{ fontFamily: T.sans, fontSize: "13px", color: T.textMuted, margin: 0, lineHeight: 1.6, maxWidth: "560px" }}>
            Rank materials by cosine similarity to a natural-language query — not keyword matching.
          </p>
        </div>

        <div className="gsap-item" style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: "14px", marginBottom: "20px", alignItems: "start" }}>
          {/* Query input */}
          <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>Query</div>
            <div style={{ position: "relative" }}>
              <AnimatePresence>
                {isFocused && (
                  <motion.div key="glow" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    style={{ position: "absolute", inset: "-2px", borderRadius: "10px", background: `radial-gradient(ellipse at 50% 0%, ${T.accentGlow} 0%, transparent 70%)`, pointerEvents: "none", zIndex: 0 }} />
                )}
              </AnimatePresence>
              <textarea value={query} onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !e.shiftKey && !loading && handleSearch()}
                onFocus={() => setIsFocused(true)} onBlur={() => setIsFocused(false)}
                disabled={loading} placeholder={PLACEHOLDERS[placeholderIdx]} rows={3}
                style={{ position: "relative", zIndex: 1, width: "100%", background: "rgba(148,163,184,0.04)", border: `1px solid ${isFocused ? T.borderFocus : T.border}`, borderRadius: "8px", padding: "12px 14px", fontFamily: T.sans, fontSize: "13.5px", color: T.textPrimary, resize: "none", boxSizing: "border-box", lineHeight: 1.6, boxShadow: isFocused ? `0 0 0 3px ${T.accentGlow}` : "none", outline: "none", transition: "border-color 200ms ease, box-shadow 200ms ease" }}
              />
            </div>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {["wide-band-gap insulator","magnetic oxide","battery cathode","perovskite structure"].map(h => (
                <button key={h} onClick={() => setQuery(h)} disabled={loading}
                  style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted, background: "rgba(148,163,184,0.06)", border: `1px solid ${T.border}`, borderRadius: "5px", padding: "3px 8px", cursor: "pointer" }}>
                  {h}
                </button>
              ))}
            </div>
            <AnimatePresence>
              {error && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                  style={{ overflow: "hidden", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.22)", borderRadius: "7px", padding: "8px 12px", fontFamily: T.sans, fontSize: "12px", color: "#fca5a5" }}>
                  {error}
                </motion.div>
              )}
            </AnimatePresence>
            <button onClick={handleSearch} disabled={loading}
              className={`search-btn${loading ? " btn-shimmer" : ""}`}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "7px", padding: "10px 20px", borderRadius: "8px", border: "none", background: loading ? undefined : T.accent, color: "#fff", fontFamily: T.sans, fontSize: "13px", fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", alignSelf: "flex-start", boxShadow: loading ? "none" : "0 0 16px rgba(6,182,212,0.25)", transition: "transform 200ms ease" }}>
              {loading ? (
                <><motion.svg width="13" height="13" viewBox="0 0 14 14" fill="none" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}><circle cx="7" cy="7" r="5.5" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5"/><path d="M7 1.5a5.5 5.5 0 015.5 5.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/></motion.svg>Ranking corpus…</>
              ) : "Run semantic search"}
            </button>
          </div>

          {/* Corpus config */}
          <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>Corpus configuration</div>
            <div>
              <label style={{ display: "block", fontFamily: T.sans, fontSize: "11px", color: T.textLabel, marginBottom: "5px" }}>Required elements</label>
              <input type="text" value={config.elements} onChange={e => setConfig(c => ({ ...c, elements: e.target.value }))} placeholder="Li, Fe, O" disabled={loading}
                style={{ width: "100%", background: "rgba(148,163,184,0.05)", border: `1px solid ${T.border}`, borderRadius: "6px", padding: "7px 10px", fontFamily: T.mono, fontSize: "12px", color: T.textPrimary, outline: "none", boxSizing: "border-box" }} />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" }}>
              <div onClick={() => !loading && setConfig(c => ({ ...c, stabilityOnly: !c.stabilityOnly }))}
                style={{ width: "30px", height: "17px", borderRadius: "9px", background: config.stabilityOnly ? T.accent : "rgba(148,163,184,0.15)", border: `1px solid ${config.stabilityOnly ? T.accent : T.border}`, position: "relative", cursor: "pointer", flexShrink: 0, transition: "background 200ms ease" }}>
                <motion.div animate={{ x: config.stabilityOnly ? 13 : 2 }} transition={{ type: "spring", stiffness: 500, damping: 35 }}
                  style={{ position: "absolute", top: "2px", width: "11px", height: "11px", borderRadius: "50%", background: "#fff" }} />
              </div>
              <span style={{ fontFamily: T.sans, fontSize: "11.5px", color: T.textLabel }}>Stable only</span>
            </label>
            {[
              { label: "Max corpus size", key: "corpusSize", min: 20, max: 200, step: 20 },
              { label: "Results to show", key: "topK", min: 5, max: 30, step: 1 },
            ].map(({ label, key, min, max, step }) => (
              <div key={key}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <label style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>{label}</label>
                  <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.accent }}>{config[key]}</span>
                </div>
                <input type="range" min={min} max={max} step={step} value={config[key]} disabled={loading}
                  onChange={e => setConfig(c => ({ ...c, [key]: Number(e.target.value) }))}
                  className="spring-range" style={{ "--pct": `${((config[key] - min) / (max - min)) * 100}%` }} />
              </div>
            ))}
          </div>
        </div>

        {/* Results */}
        <div>
          {!hasSearched && !loading && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 24px", textAlign: "center", gap: "12px" }}>
              <div style={{ fontFamily: T.sans, fontSize: "14px", fontWeight: 500, color: T.textSecondary }}>Enter a query to begin</div>
              <div style={{ fontFamily: T.sans, fontSize: "12px", color: T.textMuted, maxWidth: "320px", lineHeight: 1.6 }}>
                Describe a material's functional role, crystal class, stability, or property range.
              </div>
            </motion.div>
          )}
          {hasSearched && results.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "8px" }}>
                <div style={{ display: "flex", gap: "14px", alignItems: "center" }}>
                  <span style={{ fontFamily: T.mono, fontSize: "13px", fontWeight: 600, color: T.textPrimary }}>{results.length}</span>
                  <span style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted }}>results · {corpusCount} corpus</span>
                  {lastQuery && <span style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted }}>"{lastQuery}"</span>}
                </div>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button onClick={() => setExpandedCards(new Set(results.map((_, i) => i)))} style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel, background: "rgba(148,163,184,0.06)", border: `1px solid ${T.border}`, borderRadius: "5px", padding: "4px 10px", cursor: "pointer" }}>Expand all</button>
                  <button onClick={() => setExpandedCards(new Set())} style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel, background: "rgba(148,163,184,0.06)", border: `1px solid ${T.border}`, borderRadius: "5px", padding: "4px 10px", cursor: "pointer" }}>Collapse</button>
                </div>
              </div>
              {results.map((result, index) => (
                <ResultCard key={result.material?.material_id ?? index} result={result} index={index} isExpanded={expandedCards.has(index)} onToggle={() => toggleCard(index)} />
              ))}
            </div>
          )}
          {hasSearched && !loading && results.length === 0 && !error && (
            <div style={{ padding: "40px", textAlign: "center", fontFamily: T.sans, fontSize: "13px", color: T.textMuted }}>
              No results returned. Try rephrasing the query or expanding the corpus.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
