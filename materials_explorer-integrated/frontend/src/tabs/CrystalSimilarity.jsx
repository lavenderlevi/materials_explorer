/**
 * CrystalSimilarity.jsx  —  Tab 5
 * Find materials with the most structurally similar crystal geometry
 * to a seed, via two interchangeable search modes.
 *
 * Data contract (mirrors Python search/crystal.py):
 *   mode: "fingerprint" | "structure_matcher"
 *     fingerprint        — 19-dim geometric vector, cosine similarity,
 *                           fast, valid across any composition
 *     structure_matcher   — pymatgen RMS distance, exact, same composition
 *                           only, tolerances: ltol / stol / angle_tol
 *   corpus_mode: "element_system" | "manual_ids"
 *   CrystalSimilarityResult { material_id, formula, similarity_score [0,1],
 *                              rank, crystal_system, search_mode, spacegroup }
 *
 * UI mirrors backend constraints directly:
 *   - StructureMatcher tolerance sliders only render in that mode
 *   - corpus size cap differs by mode (≤30 for matcher, performance warning)
 *   - manual ID corpus uses a multiline textarea (comma/newline separated)
 *   - crystal system / spacegroup match-vs-seed shown with a sync icon
 *
 * Animations: GSAP mount stagger, Framer Motion radio-style mode switcher
 * with sliding indicator, AnimatePresence for conditional tolerance panel,
 * NumberTicker for similarity scores, expandable result cards.
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

function scoreColor(pct) {
  if (pct >= 70) return T.success;
  if (pct >= 40) return T.warning;
  return T.danger;
}
function scoreLabel(pct) {
  if (pct >= 70) return "High";
  if (pct >= 40) return "Moderate";
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

// ─── Segmented toggle (Magic UI-style sliding pill) ────────────────────────────
function SegmentedToggle({ options, value, onChange, disabled }) {
  return (
    <div style={{
      position: "relative", display: "flex", background: "rgba(148,163,184,0.05)",
      border: `1px solid ${T.border}`, borderRadius: "9px", padding: "3px",
    }}>
      {options.map(opt => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => !disabled && onChange(opt.value)}
            disabled={disabled}
            style={{
              position: "relative", flex: 1, padding: "9px 12px", border: "none",
              background: "none", cursor: disabled ? "not-allowed" : "pointer",
              display: "flex", flexDirection: "column", alignItems: "center", gap: "2px",
              zIndex: 1, opacity: disabled ? 0.5 : 1,
            }}
          >
            {isActive && (
              <motion.div
                layoutId={opt.groupId}
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
                style={{
                  position: "absolute", inset: 0, borderRadius: "7px",
                  background: T.accentDim, border: `1px solid rgba(6,182,212,0.28)`, zIndex: -1,
                }}
              />
            )}
            <span style={{ fontFamily: T.sans, fontSize: "12px", fontWeight: isActive ? 600 : 500, color: isActive ? T.textPrimary : T.textLabel }}>
              {opt.label}
            </span>
            {opt.hint && (
              <span style={{ fontFamily: T.sans, fontSize: "9.5px", color: isActive ? T.accent : T.textMuted }}>
                {opt.hint}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Spring slider ──────────────────────────────────────────────────────────
function SpringSlider({ min, max, step, value, onChange, disabled }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range" min={min} max={max} step={step} value={value} disabled={disabled}
      onChange={e => onChange(Number(e.target.value))}
      className="spring-range"
      style={{ "--pct": `${pct}%` }}
    />
  );
}

// ─── Match indicator (crystal system / spacegroup vs seed) ─────────────────────
function MatchRow({ label, value, seedValue }) {
  const matches = value && seedValue && value === seedValue;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "7px", fontFamily: T.sans, fontSize: "11.5px" }}>
      {matches ? (
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}><path d="M3 7.5l3 3 5-6" stroke={T.success} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}><path d="M2 4.5a4.5 4.5 0 017.5-3M12 9.5a4.5 4.5 0 01-7.5 3M9.5 1v3h-3M4.5 13v-3h3" stroke={T.textMuted} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
      )}
      <span style={{ color: T.textLabel }}>{label}:</span>
      <span style={{ fontFamily: T.mono, color: matches ? "#86efac" : T.textPrimary, fontWeight: 500 }}>{value || "unknown"}</span>
      <span style={{ color: T.textMuted, fontSize: "10.5px" }}>← seed: {seedValue || "N/A"}</span>
    </div>
  );
}

// ─── Seed banner ────────────────────────────────────────────────────────────
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
        <span style={{ fontFamily: T.mono, fontSize: "16px", fontWeight: 600, color: T.textPrimary }}>{seed.formula_pretty}</span>
        <span style={{ fontFamily: T.mono, fontSize: "12px", color: T.textMuted }}>{seed.material_id}</span>
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
          { label: "Crystal System", value: seed.crystal_system || "N/A" },
          { label: "Spacegroup", value: seed.spacegroup_symbol || "N/A" },
          { label: "Band Gap", value: seed.band_gap != null ? `${seed.band_gap.toFixed(3)} eV` : "N/A" },
          { label: "Density", value: seed.density != null ? `${seed.density.toFixed(3)} g/cm³` : "N/A" },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: "rgba(148,163,184,0.05)", border: `1px solid ${T.border}`, borderRadius: "7px", padding: "8px 10px" }}>
            <div style={{ fontFamily: T.sans, fontSize: "10px", color: T.textMuted }}>{label}</div>
            <div style={{ fontFamily: T.mono, fontSize: "12.5px", fontWeight: 600, color: T.textPrimary, marginTop: "2px" }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ fontFamily: T.sans, fontSize: "11.5px", color: T.textLabel }}>
        <span style={{ color: T.textMuted }}>Elements:</span>{" "}
        <span style={{ fontFamily: T.mono }}>{seed.elements?.join(", ")}</span>
        <span style={{ color: T.textMuted, marginLeft: "14px" }}>Sites:</span> {seed.nsites ?? "N/A"}
      </div>
    </motion.div>
  );
}

// ─── Result card ────────────────────────────────────────────────────────────
function ResultCard({ result, seed, materialDoc, index, isExpanded, onToggle }) {
  const { material_id, formula, similarity_score, rank, crystal_system, spacegroup, search_mode } = result;
  const pct = similarity_score * 100;
  const color = scoreColor(pct);
  const mpUrl = `https://materialsproject.org/materials/${material_id}`;

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
              {formula}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.accent, background: T.accentDim, padding: "1px 6px", borderRadius: "4px", border: "1px solid rgba(6,182,212,0.18)" }}>
              {material_id}
            </span>
            <span style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted }}>{crystal_system}</span>
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

                {/* LEFT: crystal structure info */}
                <div>
                  <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "8px" }}>
                    Crystal structure
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
                    <MatchRow label="Crystal system" value={crystal_system} seedValue={seed.crystal_system} />
                    <MatchRow label="Spacegroup" value={spacegroup} seedValue={seed.spacegroup_symbol} />
                  </div>
                  <div style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted, marginTop: "10px" }}>
                    Search mode: <span style={{ fontFamily: T.mono, color: T.textLabel }}>{search_mode}</span>
                  </div>
                  <a href={mpUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: "5px", marginTop: "12px", fontFamily: T.sans, fontSize: "11px", color: T.accent, textDecoration: "none", padding: "4px 8px", borderRadius: "5px", border: "1px solid rgba(6,182,212,0.20)", background: T.accentDim }} className="mp-link">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 8L8 2M8 2H4M8 2v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    View on Materials Project
                  </a>
                </div>

                {/* RIGHT: material properties */}
                <div>
                  <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "8px" }}>
                    Material properties
                  </div>
                  {materialDoc ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontFamily: T.sans, fontSize: "11.5px", color: T.textLabel }}>
                      <div>Stability: <span style={{ fontFamily: T.mono, color: materialDoc.is_stable ? "#86efac" : "#fcd34d" }}>{materialDoc.is_stable ? "Stable" : "Metastable"}</span></div>
                      {materialDoc.band_gap != null && <div>Band gap: <span style={{ fontFamily: T.mono, color: T.textPrimary }}>{materialDoc.band_gap.toFixed(3)} eV</span></div>}
                      {materialDoc.density != null && <div>Density: <span style={{ fontFamily: T.mono, color: T.textPrimary }}>{materialDoc.density.toFixed(3)} g/cm³</span></div>}
                      {materialDoc.formation_energy_per_atom != null && <div>Formation energy: <span style={{ fontFamily: T.mono, color: T.textPrimary }}>{materialDoc.formation_energy_per_atom.toFixed(4)} eV/atom</span></div>}
                      {materialDoc.energy_above_hull != null && <div>E above hull: <span style={{ fontFamily: T.mono, color: T.textPrimary }}>{materialDoc.energy_above_hull.toFixed(4)} eV/atom</span></div>}
                      {materialDoc.nsites != null && <div>Sites: <span style={{ fontFamily: T.mono, color: T.textPrimary }}>{materialDoc.nsites}</span> · Elements: <span style={{ fontFamily: T.mono, color: T.textPrimary }}>{materialDoc.nelements}</span></div>}
                    </div>
                  ) : (
                    <div style={{ fontFamily: T.sans, fontSize: "11.5px", color: T.textMuted, fontStyle: "italic" }}>
                      Summary data not available for this material.
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

// ─── Empty state ────────────────────────────────────────────────────────────
function EmptyState() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 24px", textAlign: "center", gap: "12px" }}
    >
      <div style={{ width: "48px", height: "48px", borderRadius: "12px", background: T.accentDim, border: "1px solid rgba(6,182,212,0.18)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "4px" }}>
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <polygon points="11,2 19,7 19,15 11,20 3,15 3,7" stroke={T.accent} strokeWidth="1.5" strokeLinejoin="round"/>
          <polygon points="11,7 15,9.5 15,13.5 11,16 7,13.5 7,9.5" stroke={T.accent} strokeWidth="1.2" strokeLinejoin="round"/>
        </svg>
      </div>
      <div style={{ fontFamily: T.sans, fontSize: "14px", fontWeight: 500, color: T.textSecondary }}>
        Enter a seed material ID
      </div>
      <div style={{ fontFamily: T.sans, fontSize: "12px", color: T.textMuted, maxWidth: "360px", lineHeight: 1.6 }}>
        e.g. <span style={{ fontFamily: T.mono, color: T.textLabel }}>mp-149</span> (Silicon),{" "}
        <span style={{ fontFamily: T.mono, color: T.textLabel }}>mp-19017</span> (GaAs).
        Fingerprint mode is fast and composition-agnostic; StructureMatcher is exact but
        limited to similar compositions.
      </div>
    </motion.div>
  );
}

// ─── Main CrystalSimilarity component ──────────────────────────────────────────
export default function CrystalSimilarity() {
  const [seedIdInput, setSeedIdInput] = useState("");
  const [mode, setMode]               = useState("fingerprint");
  const [topK, setTopK]               = useState(8);
  const [corpusMode, setCorpusMode]   = useState("element_system");
  const [elementsInput, setElementsInput] = useState("");
  const [manualIdsInput, setManualIdsInput] = useState("");

  // structure_matcher-only params
  const [maxCorpus, setMaxCorpus]     = useState(15);
  const [ltol, setLtol]               = useState(0.20);
  const [stol, setStol]               = useState(0.30);
  const [angleTol, setAngleTol]       = useState(5.0);

  const [seed, setSeed]               = useState(null);
  const [results, setResults]         = useState([]);
  const [materialDocs, setMaterialDocs] = useState({});
  const [corpusFetched, setCorpusFetched] = useState(0);
  const [corpusTotal, setCorpusTotal] = useState(0);

  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [expandedCards, setExpandedCards] = useState(new Set());
  const [isFocused, setIsFocused]     = useState(false);

  const headerRef = useRef(null);

  useEffect(() => {
    if (!headerRef.current) return;
    const els = headerRef.current.querySelectorAll(".gsap-item");
    gsap.fromTo(els, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out", stagger: 0.06, delay: 0.05 });
  }, []);

  // Sync max corpus default by mode (mirrors Python: 5-30 default 15 for matcher, 10-80 default 30 for fingerprint)
  const handleModeChange = useCallback((newMode) => {
    setMode(newMode);
    setMaxCorpus(newMode === "structure_matcher" ? 15 : 30);
  }, []);

  const handleSearch = useCallback(async () => {
    const seedId = seedIdInput.trim().toLowerCase();
    if (!seedId) { setError("Enter a seed material ID."); return; }
    if (corpusMode === "manual_ids" && !manualIdsInput.trim()) {
      setError("Enter at least one corpus material ID in the text area.");
      return;
    }

    setError(null);
    setLoading(true);
    setHasSearched(true);

    try {
      const corpusIds = corpusMode === "manual_ids"
        ? manualIdsInput.replace(/,/g, "\n").split("\n").map(s => s.trim()).filter(Boolean)
        : [];

      const payload = {
        seed_id: seedId,
        mode,
        top_k: topK,
        corpus_mode: corpusMode,
        elements: corpusMode === "element_system"
          ? elementsInput.split(",").map(s => s.trim()).filter(Boolean)
          : [],
        corpus_ids: corpusIds,
        max_corpus: maxCorpus,
        ...(mode === "structure_matcher" ? { ltol, stol, angle_tol: angleTol } : {}),
      };

      const res = await fetch(mode === "structure_matcher" ? "/api/v1/crystal/matcher" : "/api/v1/crystal/fingerprint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || (res.status === 404
          ? `'${seedId}' not found. Check the ID format (e.g. mp-149).`
          : `HTTP ${res.status}`));
      }

      const data = await res.json();
      // data shape: { seed: MaterialDocument, results: CrystalSimilarityResult[],
      //               material_docs: {material_id: MaterialDocument},
      //               corpus_fetched: int, corpus_total: int }
      setSeed(data.seed ?? null);
      setResults(data.results ?? []);
      setMaterialDocs(data.material_docs ?? {});
      setCorpusFetched(data.corpus_fetched ?? 0);
      setCorpusTotal(data.corpus_total ?? 0);
      if (data.results?.length) setExpandedCards(new Set([0, 1])); // top-2 expanded, matches Python rank<=2
    } catch (err) {
      setError(err.message);
      setSeed(null);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [seedIdInput, mode, topK, corpusMode, elementsInput, manualIdsInput, maxCorpus, ltol, stol, angleTol]);

  const toggleCard = useCallback((index) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      next.has(index) ? next.delete(index) : next.add(index);
      return next;
    });
  }, []);

  return (
    <>
      <style>{`
        .seed-input:focus { border-color: ${T.borderFocus} !important; box-shadow: 0 0 0 4px ${T.accentGlow}; outline: none; }
        .corpus-input:focus, .corpus-textarea:focus { border-color: ${T.borderFocus} !important; box-shadow: 0 0 0 3px ${T.accentGlow}; outline: none; }
        .mp-link:hover { background: rgba(6,182,212,0.16) !important; }
        .result-card-header:hover { background: rgba(148,163,184,0.04); }
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

      <div style={{ padding: "28px 32px", maxWidth: "1100px", margin: "0 auto" }}>

        {/* ── Header ── */}
        <div ref={headerRef} style={{ marginBottom: "24px" }}>
          <div className="gsap-item" style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: T.accentDim, border: "1px solid rgba(6,182,212,0.20)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <polygon points="10,2 18,7 18,13 10,18 2,13 2,7" stroke={T.accent} strokeWidth="1.5" strokeLinejoin="round"/>
                <polygon points="10,6 14,8.5 14,11.5 10,14 6,11.5 6,8.5" stroke={T.accent} strokeWidth="1.2" strokeLinejoin="round"/>
              </svg>
            </div>
            <h1 style={{ fontFamily: T.sans, fontSize: "17px", fontWeight: 600, color: T.textPrimary, margin: 0, letterSpacing: "-0.015em" }}>
              Crystal Similarity Search
            </h1>
          </div>
          <p className="gsap-item" style={{ fontFamily: T.sans, fontSize: "13px", color: T.textMuted, margin: 0, lineHeight: 1.6, maxWidth: "620px" }}>
            Find materials with the most structurally similar crystal geometry to a seed.{" "}
            <span style={{ color: T.textLabel }}>Fingerprint</span> mode is fast and composition-agnostic;{" "}
            <span style={{ color: T.textLabel }}>StructureMatcher</span> is rigorous RMS distance, same composition only.
          </p>
        </div>

        {/* ── Bento: seed + corpus + mode config ── */}
        <div className="gsap-item" style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "14px", marginBottom: "20px", alignItems: "start" }}>

          {/* LEFT: seed + corpus source */}
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>

            {/* Seed input */}
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
                  type="text" value={seedIdInput} onChange={e => setSeedIdInput(e.target.value)}
                  onFocus={() => setIsFocused(true)} onBlur={() => setIsFocused(false)}
                  disabled={loading} placeholder="mp-149 (Silicon) · mp-19017 (GaAs)"
                  style={{
                    position: "relative", zIndex: 1, width: "100%",
                    background: "rgba(148,163,184,0.04)", border: `1px solid ${isFocused ? T.borderFocus : T.border}`,
                    borderRadius: "8px", padding: "12px 14px", fontFamily: T.mono, fontSize: "14px",
                    color: T.textPrimary, boxSizing: "border-box",
                    transition: "border-color 200ms ease, box-shadow 200ms ease",
                    boxShadow: isFocused ? `0 0 0 4px ${T.accentGlow}` : "none", outline: "none",
                  }}
                  className="seed-input"
                />
              </div>
            </div>

            {/* Corpus source */}
            <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                Corpus source
              </div>
              <SegmentedToggle
                options={[
                  { value: "element_system", label: "Element System", hint: "auto-fetch", groupId: "corpus-mode-pill" },
                  { value: "manual_ids", label: "Manual IDs", hint: "explicit list", groupId: "corpus-mode-pill" },
                ]}
                value={corpusMode} onChange={setCorpusMode} disabled={loading}
              />

              <AnimatePresence mode="wait">
                {corpusMode === "element_system" ? (
                  <motion.div key="el" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                    <label style={{ display: "block", fontFamily: T.sans, fontSize: "11px", color: T.textLabel, marginBottom: "5px" }}>
                      Element system (leave blank to use seed's elements)
                    </label>
                    <input
                      type="text" value={elementsInput} onChange={e => setElementsInput(e.target.value)}
                      placeholder="Si, O" disabled={loading}
                      style={{ width: "100%", background: "rgba(148,163,184,0.05)", border: `1px solid ${T.border}`, borderRadius: "6px", padding: "7px 10px", fontFamily: T.mono, fontSize: "12px", color: T.textPrimary, outline: "none", boxSizing: "border-box", transition: "border-color 200ms ease, box-shadow 200ms ease" }}
                      className="corpus-input"
                    />
                  </motion.div>
                ) : (
                  <motion.div key="manual" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                    <label style={{ display: "block", fontFamily: T.sans, fontSize: "11px", color: T.textLabel, marginBottom: "5px" }}>
                      Corpus material IDs (comma or newline separated)
                    </label>
                    <textarea
                      value={manualIdsInput} onChange={e => setManualIdsInput(e.target.value)}
                      placeholder={"mp-2534\nmp-1265\nmp-19017\nmp-20305"}
                      disabled={loading} rows={4}
                      style={{ width: "100%", background: "rgba(148,163,184,0.05)", border: `1px solid ${T.border}`, borderRadius: "6px", padding: "8px 10px", fontFamily: T.mono, fontSize: "12px", color: T.textPrimary, outline: "none", boxSizing: "border-box", resize: "none", lineHeight: 1.6, transition: "border-color 200ms ease, box-shadow 200ms ease" }}
                      className="corpus-textarea"
                    />
                  </motion.div>
                )}
              </AnimatePresence>

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
                    Computing structural similarity…
                  </>
                ) : (
                  <>
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.4"/><path d="M10 10l2.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
                    Find similar structures
                  </>
                )}
              </button>
            </div>
          </div>

          {/* RIGHT: search mode + tolerances */}
          <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Search configuration
            </div>

            <div>
              <label style={{ display: "block", fontFamily: T.sans, fontSize: "11px", color: T.textLabel, marginBottom: "6px" }}>Search mode</label>
              <SegmentedToggle
                options={[
                  { value: "fingerprint", label: "Fingerprint", hint: "fast", groupId: "search-mode-pill" },
                  { value: "structure_matcher", label: "StructureMatcher", hint: "exact", groupId: "search-mode-pill" },
                ]}
                value={mode} onChange={handleModeChange} disabled={loading}
              />
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                <label style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>Top results</label>
                <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.accent }}>{topK}</span>
              </div>
              <SpringSlider min={3} max={20} step={1} value={topK} onChange={setTopK} disabled={loading} />
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                <label style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>Max corpus size</label>
                <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.accent }}>{maxCorpus}</span>
              </div>
              <SpringSlider
                min={mode === "structure_matcher" ? 5 : 10}
                max={mode === "structure_matcher" ? 30 : 80}
                step={mode === "structure_matcher" ? 1 : 10}
                value={maxCorpus} onChange={setMaxCorpus} disabled={loading}
              />
              {mode === "structure_matcher" && (
                <div style={{ fontFamily: T.sans, fontSize: "10px", color: T.warning, marginTop: "4px" }}>
                  Keep ≤ 30 — StructureMatcher is O(n) per candidate.
                </div>
              )}
            </div>

            {/* StructureMatcher tolerance panel — conditional */}
            <AnimatePresence>
              {mode === "structure_matcher" && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                  transition={{ height: { type: "spring", stiffness: 280, damping: 30 }, opacity: { duration: 0.2 } }}
                  style={{ overflow: "hidden" }}
                >
                  <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: "14px", display: "flex", flexDirection: "column", gap: "12px" }}>
                    <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                      StructureMatcher tolerances
                    </div>
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                        <label style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>Lattice tolerance</label>
                        <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.indigo }}>{ltol.toFixed(2)}</span>
                      </div>
                      <SpringSlider min={0.05} max={0.50} step={0.05} value={ltol} onChange={setLtol} disabled={loading} />
                    </div>
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                        <label style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>Site tolerance</label>
                        <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.indigo }}>{stol.toFixed(2)}</span>
                      </div>
                      <SpringSlider min={0.10} max={0.80} step={0.05} value={stol} onChange={setStol} disabled={loading} />
                    </div>
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                        <label style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>Angle tolerance (°)</label>
                        <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.indigo }}>{angleTol.toFixed(1)}</span>
                      </div>
                      <SpringSlider min={2.0} max={15.0} step={1.0} value={angleTol} onChange={setAngleTol} disabled={loading} />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* ── Results ── */}
        <div className="gsap-item">
          {!hasSearched && !loading && <EmptyState />}

          {hasSearched && seed && results.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <SeedBanner seed={seed} />

              <div style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted }}>
                Corpus: <span style={{ fontFamily: T.mono, color: T.textLabel }}>{corpusFetched}</span> structures available
                {corpusFetched < corpusTotal && (
                  <span style={{ color: T.warning }}> (fetched {corpusFetched}/{corpusTotal} — some IDs unavailable)</span>
                )} · mode: <span style={{ fontFamily: T.mono, color: T.accent }}>{mode}</span> · seed: <span style={{ fontFamily: T.mono, color: T.textLabel }}>{seed.material_id}</span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {results.map((result, index) => (
                  <ResultCard
                    key={result.material_id ?? index}
                    result={result}
                    seed={seed}
                    materialDoc={materialDocs[result.material_id]}
                    index={index}
                    isExpanded={expandedCards.has(index)}
                    onToggle={() => toggleCard(index)}
                  />
                ))}
              </div>
            </div>
          )}

          {hasSearched && !loading && results.length === 0 && !error && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ padding: "40px", textAlign: "center", fontFamily: T.sans, fontSize: "13px", color: T.textMuted }}>
              No similar structures found. Try a larger corpus or different mode.
            </motion.div>
          )}
        </div>
      </div>
    </>
  );
}
