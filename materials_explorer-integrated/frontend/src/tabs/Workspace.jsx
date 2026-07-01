/**
 * Workspace.jsx  —  Tab 7
 * Experiment Workspace: persistent storage of searches, material sets,
 * and dataset export.
 *
 * Data contract (mirrors Python search/workspace.py):
 *
 *   WorkspaceStats  { saved_searches, comparison_sets, comparison_items, exports }
 *
 *   SavedSearch     { id, name, raw_query, parsed_query: { intent, confidence },
 *                     result_ids[], result_count, created_at, last_run_at }
 *
 *   ComparisonItem  { material_id, formula, document: MaterialDocument, added_at }
 *   ComparisonSet   { id, name, notes, items: ComparisonItem[], created_at, updated_at }
 *
 *   _EXPORT_COLS (20 cols): material_id, formula_pretty, band_gap, density,
 *     formation_energy_per_atom, energy_above_hull, volume, nsites, nelements,
 *     crystal_system, spacegroup_symbol, chemsys, elements, is_stable,
 *     is_magnetic, has_dos, has_band_structure, has_elastic, theoretical, mp_url
 *
 * Three sub-tabs matching the Python page:
 *   1. Saved Searches  — save/re-run/delete searches; mini result table on re-run
 *   2. Comparison Sets — create sets, add/remove materials, side-by-side property table
 *   3. Dataset Export  — source selector, column picker, format selector, download
 *
 * Animations: GSAP mount stagger, Framer Motion AnimatePresence for list
 * add/remove, tab sliding indicator, expandable panels, spring toggles.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { gsap } from "gsap";

// ─── Design tokens ──────────────────────────────────────────────────────────
const T = {
  bgPage:        "#09090B",
  bgCard:        "#0F172A",
  bgCardAlt:     "#111827",
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

// ─── Export column registry (mirrors _EXPORT_COLS + col_labels) ───────────────
const EXPORT_COLS = [
  { key: "material_id",               label: "Material ID" },
  { key: "formula_pretty",            label: "Formula" },
  { key: "band_gap",                  label: "Band Gap" },
  { key: "density",                   label: "Density" },
  { key: "formation_energy_per_atom", label: "Formation Energy" },
  { key: "energy_above_hull",         label: "E above Hull" },
  { key: "volume",                    label: "Volume" },
  { key: "nsites",                    label: "N Sites" },
  { key: "nelements",                 label: "N Elements" },
  { key: "crystal_system",            label: "Crystal System" },
  { key: "spacegroup_symbol",         label: "Spacegroup" },
  { key: "chemsys",                   label: "Chem System" },
  { key: "elements",                  label: "Elements" },
  { key: "is_stable",                 label: "Stable" },
  { key: "is_magnetic",               label: "Magnetic" },
  { key: "has_dos",                   label: "Has DOS" },
  { key: "has_band_structure",        label: "Has Band Structure" },
  { key: "has_elastic",               label: "Has Elastic" },
  { key: "theoretical",               label: "Theoretical" },
  { key: "mp_url",                    label: "MP URL" },
];
const DEFAULT_EXPORT_COLS = ["material_id","formula_pretty","band_gap","density","formation_energy_per_atom","energy_above_hull","is_stable","crystal_system"];

// Comparison table property rows (mirrors _comparison_df _PROPS dict)
const COMPARISON_PROPS = [
  { label: "Band Gap (eV)",       field: "band_gap",                   fmt: "float" },
  { label: "Density (g/cm³)",     field: "density",                    fmt: "float" },
  { label: "Formation E (eV/at)", field: "formation_energy_per_atom",  fmt: "float" },
  { label: "E Hull (eV/at)",      field: "energy_above_hull",          fmt: "float" },
  { label: "Crystal System",      field: "crystal_system",             fmt: "str" },
  { label: "Spacegroup",          field: "spacegroup_symbol",          fmt: "str" },
  { label: "N Sites",             field: "nsites",                     fmt: "int" },
  { label: "N Elements",          field: "nelements",                  fmt: "int" },
  { label: "Stable",              field: "is_stable",                  fmt: "bool" },
  { label: "Magnetic",            field: "is_magnetic",                fmt: "bool" },
];

// ─── Utils ──────────────────────────────────────────────────────────────────
function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtPropValue(val, fmt) {
  if (val === null || val === undefined) return "N/A";
  if (fmt === "bool") return val ? "✓ Yes" : "— No";
  if (fmt === "float" && typeof val === "number") return val.toFixed(4);
  return String(val);
}

// ─── Shared primitives ──────────────────────────────────────────────────────

function SegmentedToggle({ options, value, onChange, groupId }) {
  return (
    <div style={{ position: "relative", display: "flex", background: "rgba(148,163,184,0.05)", border: `1px solid ${T.border}`, borderRadius: "9px", padding: "3px" }}>
      {options.map(opt => {
        const isActive = opt.value === value;
        return (
          <button key={opt.value} onClick={() => onChange(opt.value)}
            style={{ position: "relative", flex: 1, padding: "9px 10px", border: "none", background: "none", cursor: "pointer", zIndex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
          >
            {isActive && (
              <motion.div layoutId={groupId} transition={{ type: "spring", stiffness: 380, damping: 32 }}
                style={{ position: "absolute", inset: 0, borderRadius: "7px", background: T.accentDim, border: "1px solid rgba(6,182,212,0.28)", zIndex: -1 }} />
            )}
            {opt.icon && <span style={{ color: isActive ? T.accent : T.textMuted, fontSize: "14px" }}>{opt.icon}</span>}
            <span style={{ fontFamily: T.sans, fontSize: "12px", fontWeight: isActive ? 600 : 500, color: isActive ? T.textPrimary : T.textLabel }}>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ToggleSwitch({ checked, onChange }) {
  return (
    <div onClick={onChange} style={{ width: "30px", height: "17px", borderRadius: "9px", background: checked ? T.accent : "rgba(148,163,184,0.15)", border: `1px solid ${checked ? T.accent : T.border}`, position: "relative", cursor: "pointer", flexShrink: 0, transition: "background 200ms ease" }}>
      <motion.div animate={{ x: checked ? 13 : 2 }} transition={{ type: "spring", stiffness: 500, damping: 35 }} style={{ position: "absolute", top: "2px", width: "11px", height: "11px", borderRadius: "50%", background: "#fff" }} />
    </div>
  );
}

function StyledInput({ value, onChange, placeholder, disabled, mono, style = {} }) {
  const [focused, setFocused] = useState(false);
  return (
    <input value={value} onChange={onChange} placeholder={placeholder} disabled={disabled}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={{
        width: "100%", background: "rgba(148,163,184,0.05)", border: `1px solid ${focused ? T.borderFocus : T.border}`,
        borderRadius: "6px", padding: "8px 10px", fontFamily: mono ? T.mono : T.sans,
        fontSize: "12.5px", color: T.textPrimary, outline: "none", boxSizing: "border-box",
        boxShadow: focused ? `0 0 0 3px ${T.accentGlow}` : "none", transition: "border-color 200ms ease, box-shadow 200ms ease",
        ...style,
      }}
      className="workspace-input"
    />
  );
}

function PrimaryBtn({ onClick, disabled, loading, children, style = {} }) {
  return (
    <button onClick={onClick} disabled={disabled || loading}
      className={`search-btn${loading ? " btn-shimmer" : ""}`}
      style={{
        display: "flex", alignItems: "center", gap: "6px", padding: "8px 16px",
        borderRadius: "7px", border: "none", background: loading ? undefined : T.accent,
        color: "#fff", fontFamily: T.sans, fontSize: "12.5px", fontWeight: 600,
        cursor: (disabled || loading) ? "not-allowed" : "pointer", flexShrink: 0,
        transition: "transform 200ms ease, background 200ms ease, box-shadow 200ms ease",
        boxShadow: loading ? "none" : "0 0 12px rgba(6,182,212,0.20)",
        ...style,
      }}
    >
      {loading ? (
        <motion.svg width="12" height="12" viewBox="0 0 14 14" fill="none" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}>
          <circle cx="7" cy="7" r="5.5" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5"/>
          <path d="M7 1.5a5.5 5.5 0 015.5 5.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
        </motion.svg>
      ) : null}
      {children}
    </button>
  );
}

function GhostBtn({ onClick, children, danger, style = {} }) {
  return (
    <button onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: "5px", padding: "6px 10px",
        borderRadius: "6px", border: `1px solid ${danger ? "rgba(239,68,68,0.25)" : T.border}`,
        background: "none", color: danger ? "#fca5a5" : T.textLabel,
        fontFamily: T.sans, fontSize: "11.5px", cursor: "pointer",
        transition: "background 150ms ease, border-color 150ms ease",
        ...style,
      }}
      className="ghost-btn"
    >
      {children}
    </button>
  );
}

function ErrorBanner({ msg }) {
  if (!msg) return null;
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
      style={{ overflow: "hidden", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.22)", borderRadius: "7px", padding: "8px 12px", fontFamily: T.sans, fontSize: "12px", color: "#fca5a5" }}
    >
      {msg}
    </motion.div>
  );
}

// ─── Stat card ──────────────────────────────────────────────────────────────
function StatCard({ label, value, icon }) {
  return (
    <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "9px", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
        <span style={{ fontSize: "14px" }}>{icon}</span>
        <span style={{ fontFamily: T.sans, fontSize: "10.5px", color: T.textMuted, letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 500 }}>{label}</span>
      </div>
      <span style={{ fontFamily: T.mono, fontSize: "22px", fontWeight: 600, color: T.textPrimary }}>{value}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SUB-TAB 1: Saved Searches
// ═══════════════════════════════════════════════════════════════════════════
function SavedSearchesTab({ stats, onStatsRefresh }) {
  const [searches, setSearches]     = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [expanded, setExpanded]     = useState(new Set());

  // New search form
  const [newQuery, setNewQuery]     = useState("");
  const [saveName, setSaveName]     = useState("");
  const [saving, setSaving]         = useState(false);
  const [saveError, setSaveError]   = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(null);

  // Re-run state per search id
  const [rerunning, setRerunning]   = useState(new Set());
  const [rerunResults, setRerunResults] = useState({});

  const fetchSearches = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch("/api/v1/workspace/searches");
      if (res.ok) { const d = await res.json(); setSearches(Array.isArray(d) ? d : (d.searches ?? [])); }
    } finally { setLoadingList(false); }
  }, []);

  useEffect(() => { fetchSearches(); }, [fetchSearches]);

  const handleSaveSearch = useCallback(async () => {
    if (!newQuery.trim()) { setSaveError("Enter a query."); return; }
    setSaveError(null); setSaveSuccess(null); setSaving(true);
    try {
      const res = await fetch("/api/v1/workspace/searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_query: newQuery.trim(), name: saveName.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      setSaveSuccess(`Saved "${data.name || req.raw_query}" — ${data.result_count ?? 0} results.`);
      setNewQuery(""); setSaveName("");
      await fetchSearches();
      onStatsRefresh();
    } catch (err) { setSaveError(err.message); }
    finally { setSaving(false); }
  }, [newQuery, saveName, fetchSearches, onStatsRefresh]);

  const handleRerun = useCallback(async (search) => {
    setRerunning(prev => new Set([...prev, search.id]));
    try {
      const res = await fetch(`/api/v1/workspace/searches/${search.id}/run`, { method: "POST" });
      const data = await res.json();
      // SearchAPIResponse.results are RankedResultResponse — extract material for table display
      const rawResults = data.results ?? [];
      const materialRows = rawResults.map(r => ({
        material_id: r.material?.material_id,
        formula_pretty: r.material?.formula,
        band_gap: r.material?.band_gap,
        density: r.material?.density,
        is_stable: r.material?.is_stable,
      }));
      setRerunResults(prev => ({ ...prev, [search.id]: materialRows }));
      await fetchSearches();
    } catch { /* silent */ }
    finally { setRerunning(prev => { const n = new Set(prev); n.delete(search.id); return n; }); }
  }, [fetchSearches]);

  const handleDelete = useCallback(async (id) => {
    await fetch(`/api/v1/workspace/searches/${id}`, { method: "DELETE" });
    setSearches(prev => prev.filter(s => s.id !== id));
    onStatsRefresh();
  }, [onStatsRefresh]);

  const toggleExpand = (id) => {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* New search panel */}
      <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Save a new search
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: "8px" }}>
          <StyledInput value={newQuery} onChange={e => setNewQuery(e.target.value)} placeholder="e.g. stable semiconductor band gap > 1" disabled={saving} />
          <StyledInput value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="Optional name" disabled={saving} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <PrimaryBtn onClick={handleSaveSearch} loading={saving}>
            Search &amp; Save
          </PrimaryBtn>
          {saveSuccess && <span style={{ fontFamily: T.sans, fontSize: "11.5px", color: T.success }}>{saveSuccess}</span>}
        </div>
        <AnimatePresence><ErrorBanner msg={saveError} /></AnimatePresence>
      </div>

      {/* Saved list */}
      {loadingList ? (
        <div style={{ fontFamily: T.sans, fontSize: "12px", color: T.textMuted, padding: "20px", textAlign: "center" }}>Loading saved searches…</div>
      ) : searches.length === 0 ? (
        <div style={{ fontFamily: T.sans, fontSize: "12.5px", color: T.textMuted, padding: "28px", textAlign: "center", background: T.bgCard, borderRadius: "10px", border: `1px solid ${T.border}` }}>
          No saved searches yet. Use the form above to save your first search.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <AnimatePresence>
            {searches.map(s => (
              <motion.div key={s.id} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0, marginBottom: 0 }} transition={{ type: "spring", stiffness: 300, damping: 30 }}
                style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "9px", overflow: "hidden" }}
              >
                <button onClick={() => toggleExpand(s.id)} style={{ width: "100%", background: "none", border: "none", cursor: "pointer", padding: "12px 14px", display: "flex", alignItems: "center", gap: "10px", textAlign: "left" }} className="result-card-header">
                  <motion.svg animate={{ rotate: expanded.has(s.id) ? 90 : 0 }} transition={{ type: "spring", stiffness: 300, damping: 26 }} width="11" height="11" viewBox="0 0 14 14" fill="none" style={{ color: T.textMuted, flexShrink: 0 }}>
                    <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                  </motion.svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <span style={{ fontFamily: T.sans, fontSize: "13px", fontWeight: 600, color: T.textPrimary }}>{s.name}</span>
                      <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "280px" }}>{s.raw_query}</span>
                    </div>
                    <div style={{ fontFamily: T.sans, fontSize: "10.5px", color: T.textMuted, marginTop: "2px" }}>
                      <span style={{ fontFamily: T.mono, color: T.accent }}>{s.result_count}</span> results · saved {fmtDate(s.created_at)}
                      {s.last_run_at && <span> · last run {fmtDate(s.last_run_at)}</span>}
                    </div>
                  </div>
                </button>
                <AnimatePresence initial={false}>
                  {expanded.has(s.id) && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ height: { type: "spring", stiffness: 280, damping: 30 }, opacity: { duration: 0.2 } }} style={{ overflow: "hidden" }}>
                      <div style={{ padding: "8px 14px 14px", borderTop: `1px solid ${T.border}` }}>
                        <div style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted, marginBottom: "10px" }}>
                          Intent: <span style={{ fontFamily: T.mono, color: T.textLabel }}>{s.parsed_query?.intent ?? "—"}</span> · Confidence: <span style={{ fontFamily: T.mono, color: T.accent }}>{s.parsed_query?.confidence != null ? (s.parsed_query.confidence * 100).toFixed(0) + "%" : "—"}</span>
                        </div>
                        <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
                          <PrimaryBtn onClick={() => handleRerun(s)} loading={rerunning.has(s.id)}>
                            Re-run
                          </PrimaryBtn>
                          <GhostBtn onClick={() => handleDelete(s.id)} danger>
                            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3L3 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                            Delete
                          </GhostBtn>
                        </div>
                        {/* Mini result table */}
                        {rerunResults[s.id]?.length > 0 && (
                          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ borderRadius: "7px", overflow: "hidden", border: `1px solid ${T.border}` }}>
                            <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 90px 90px 60px", background: "rgba(148,163,184,0.05)", padding: "7px 10px" }}>
                              {["ID", "Formula", "Band Gap", "Density", "Stable"].map(h => (
                                <span key={h} style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 600, color: T.textMuted, letterSpacing: "0.05em", textTransform: "uppercase" }}>{h}</span>
                              ))}
                            </div>
                            {rerunResults[s.id].slice(0, 10).map((r, i) => (
                              <div key={r.material_id} style={{ display: "grid", gridTemplateColumns: "130px 1fr 90px 90px 60px", padding: "7px 10px", background: i % 2 ? "rgba(148,163,184,0.02)" : T.bgCard }}>
                                <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.accent }}>{r.material_id}</span>
                                <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.textPrimary }}>{r.formula_pretty}</span>
                                <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.textLabel }}>{r.band_gap?.toFixed(3) ?? "N/A"}</span>
                                <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.textLabel }}>{r.density?.toFixed(3) ?? "N/A"}</span>
                                <span style={{ fontFamily: T.sans, fontSize: "11px", color: r.is_stable ? T.success : T.warning }}>{r.is_stable ? "✓" : "—"}</span>
                              </div>
                            ))}
                          </motion.div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SUB-TAB 2: Comparison Sets
// ═══════════════════════════════════════════════════════════════════════════
function ComparisonSetsTab({ onStatsRefresh }) {
  const [sets, setSets]             = useState([]);
  const [loading, setLoading]       = useState(true);
  const [expanded, setExpanded]     = useState(new Set());

  // Create form
  const [newName, setNewName]       = useState("");
  const [newNotes, setNewNotes]     = useState("");
  const [creating, setCreating]     = useState(false);
  const [createError, setCreateError] = useState(null);

  // Per-set add form
  const [addInputs, setAddInputs]   = useState({});
  const [adding, setAdding]         = useState(new Set());
  const [addError, setAddError]     = useState({});

  const fetchSets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/workspace/sets");
      if (res.ok) { const d = await res.json(); setSets(d.sets ?? []); }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchSets(); }, [fetchSets]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) { setCreateError("Enter a set name."); return; }
    setCreateError(null); setCreating(true);
    try {
      const res = await fetch("/api/v1/workspace/sets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), notes: newNotes.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      setNewName(""); setNewNotes("");
      await fetchSets(); onStatsRefresh();
    } catch (err) { setCreateError(err.message); }
    finally { setCreating(false); }
  }, [newName, newNotes, fetchSets, onStatsRefresh]);

  const handleAdd = useCallback(async (setId) => {
    const matId = (addInputs[setId] ?? "").trim().toLowerCase();
    if (!matId) { setAddError(p => ({ ...p, [setId]: "Enter a material ID." })); return; }
    setAddError(p => ({ ...p, [setId]: null }));
    setAdding(prev => new Set([...prev, setId]));
    try {
      const res = await fetch(`/api/v1/workspace/sets/${setId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ material_id: matId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      setAddInputs(p => ({ ...p, [setId]: "" }));
      await fetchSets(); onStatsRefresh();
    } catch (err) { setAddError(p => ({ ...p, [setId]: err.message })); }
    finally { setAdding(prev => { const n = new Set(prev); n.delete(setId); return n; }); }
  }, [addInputs, fetchSets, onStatsRefresh]);

  const handleRemove = useCallback(async (setId, materialId) => {
    await fetch(`/api/v1/workspace/sets/${setId}/items/${materialId}`, { method: "DELETE" });
    await fetchSets(); onStatsRefresh();
  }, [fetchSets, onStatsRefresh]);

  const handleDeleteSet = useCallback(async (setId) => {
    await fetch(`/api/v1/workspace/sets/${setId}`, { method: "DELETE" });
    setSets(prev => prev.filter(s => s.id !== setId));
    onStatsRefresh();
  }, [onStatsRefresh]);

  const toggleExpand = (id) => {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Create new set */}
      <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Create new comparison set
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
          <StyledInput value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Battery Cathodes" disabled={creating} />
          <StyledInput value={newNotes} onChange={e => setNewNotes(e.target.value)} placeholder="Optional notes" disabled={creating} />
        </div>
        <PrimaryBtn onClick={handleCreate} loading={creating} style={{ alignSelf: "flex-start" }}>Create Set</PrimaryBtn>
        <AnimatePresence><ErrorBanner msg={createError} /></AnimatePresence>
      </div>

      {loading ? (
        <div style={{ fontFamily: T.sans, fontSize: "12px", color: T.textMuted, padding: "20px", textAlign: "center" }}>Loading comparison sets…</div>
      ) : sets.length === 0 ? (
        <div style={{ fontFamily: T.sans, fontSize: "12.5px", color: T.textMuted, padding: "28px", textAlign: "center", background: T.bgCard, borderRadius: "10px", border: `1px solid ${T.border}` }}>
          No comparison sets yet. Create one above, then add materials to it.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <AnimatePresence>
            {sets.map(cset => (
              <motion.div key={cset.id} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ type: "spring", stiffness: 300, damping: 30 }}
                style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "9px", overflow: "hidden" }}
              >
                <button onClick={() => toggleExpand(cset.id)} style={{ width: "100%", background: "none", border: "none", cursor: "pointer", padding: "12px 14px", display: "flex", alignItems: "center", gap: "10px", textAlign: "left" }} className="result-card-header">
                  <motion.svg animate={{ rotate: expanded.has(cset.id) ? 90 : 0 }} transition={{ type: "spring", stiffness: 300, damping: 26 }} width="11" height="11" viewBox="0 0 14 14" fill="none" style={{ color: T.textMuted, flexShrink: 0 }}>
                    <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                  </motion.svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontFamily: T.sans, fontSize: "13px", fontWeight: 600, color: T.textPrimary }}>{cset.name}</span>
                      <span style={{ fontFamily: T.mono, fontSize: "11px", color: T.accent, background: T.accentDim, padding: "1px 6px", borderRadius: "4px", border: "1px solid rgba(6,182,212,0.18)" }}>
                        {cset.items.length} material{cset.items.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                    {cset.notes && <div style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted, marginTop: "2px" }}>{cset.notes}</div>}
                  </div>
                  <span style={{ fontFamily: T.sans, fontSize: "10px", color: T.textMuted, flexShrink: 0 }}>updated {fmtDate(cset.updated_at)}</span>
                </button>

                <AnimatePresence initial={false}>
                  {expanded.has(cset.id) && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ height: { type: "spring", stiffness: 280, damping: 30 }, opacity: { duration: 0.2 } }} style={{ overflow: "hidden" }}>
                      <div style={{ padding: "0 14px 16px", borderTop: `1px solid ${T.border}`, paddingTop: "14px", display: "flex", flexDirection: "column", gap: "14px" }}>

                        {/* Comparison table (property rows × material columns) */}
                        {cset.items.length > 0 ? (
                          <div style={{ overflowX: "auto", borderRadius: "8px", border: `1px solid ${T.border}` }}>
                            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: `${220 + cset.items.length * 140}px` }}>
                              <thead>
                                <tr style={{ background: "rgba(148,163,184,0.05)" }}>
                                  <th style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 600, color: T.textMuted, letterSpacing: "0.05em", textTransform: "uppercase", padding: "8px 12px", textAlign: "left", width: "160px", borderBottom: `1px solid ${T.border}` }}>
                                    Property
                                  </th>
                                  {cset.items.map(it => (
                                    <th key={it.material_id} style={{ fontFamily: T.mono, fontSize: "11px", fontWeight: 600, color: T.accent, padding: "8px 12px", textAlign: "center", minWidth: "130px", borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>
                                      {it.material_id}<br/>
                                      <span style={{ fontFamily: T.mono, fontSize: "10px", color: T.textMuted, fontWeight: 400 }}>{it.formula}</span>
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {COMPARISON_PROPS.map((prop, pi) => (
                                  <tr key={prop.field} style={{ background: pi % 2 ? "rgba(148,163,184,0.02)" : "transparent" }}>
                                    <td style={{ fontFamily: T.sans, fontSize: "11.5px", color: T.textLabel, padding: "7px 12px", borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>
                                      {prop.label}
                                    </td>
                                    {cset.items.map(it => {
                                      // ComparisonItemResponse doesn't include full document; show available data
                                      const val = it.document ? it.document[prop.field] : (prop.field === 'formula_pretty' ? it.formula : null);
                                      const display = fmtPropValue(val, prop.fmt);
                                      const isBool = prop.fmt === "bool";
                                      return (
                                        <td key={it.material_id} style={{ fontFamily: T.mono, fontSize: "11.5px", textAlign: "center", padding: "7px 12px", borderBottom: `1px solid ${T.border}`, color: isBool ? (val ? T.success : T.textMuted) : T.textPrimary }}>
                                          {display}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div style={{ fontFamily: T.sans, fontSize: "12px", color: T.textMuted, padding: "16px", textAlign: "center", background: "rgba(148,163,184,0.03)", borderRadius: "7px" }}>
                            No materials in this set yet.
                          </div>
                        )}

                        {/* Remove material chips */}
                        {cset.items.length > 0 && (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                            {cset.items.map(it => (
                              <button key={it.material_id} onClick={() => handleRemove(cset.id, it.material_id)}
                                style={{ display: "flex", alignItems: "center", gap: "5px", fontFamily: T.mono, fontSize: "11px", padding: "4px 8px", borderRadius: "5px", background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.18)", color: "#fca5a5", cursor: "pointer" }}
                                className="ghost-btn"
                              >
                                <svg width="10" height="10" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3L3 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                                {it.material_id}
                              </button>
                            ))}
                          </div>
                        )}

                        {/* Add material */}
                        <div style={{ display: "flex", gap: "8px", alignItems: "flex-start", flexDirection: "column" }}>
                          <div style={{ display: "flex", gap: "8px", width: "100%", maxWidth: "360px" }}>
                            <StyledInput
                              value={addInputs[cset.id] ?? ""}
                              onChange={e => setAddInputs(p => ({ ...p, [cset.id]: e.target.value }))}
                              placeholder="mp-149"
                              mono
                              disabled={adding.has(cset.id)}
                              style={{ flex: 1 }}
                            />
                            <PrimaryBtn onClick={() => handleAdd(cset.id)} loading={adding.has(cset.id)}>
                              Add
                            </PrimaryBtn>
                          </div>
                          <AnimatePresence><ErrorBanner msg={addError[cset.id]} /></AnimatePresence>
                        </div>

                        {/* Delete set */}
                        <div style={{ paddingTop: "8px", borderTop: `1px solid ${T.border}` }}>
                          <GhostBtn onClick={() => handleDeleteSet(cset.id)} danger>
                            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3L3 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                            Delete this set
                          </GhostBtn>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SUB-TAB 3: Dataset Export
// ═══════════════════════════════════════════════════════════════════════════
function DatasetExportTab() {
  const [source, setSource]           = useState("comparison_set");
  const [sets, setSets]               = useState([]);
  const [selectedSet, setSelectedSet] = useState(null);

  // Custom fetch
  const [elements, setElements]       = useState("");
  const [expSize, setExpSize]         = useState(100);
  const [expStable, setExpStable]     = useState(false);
  const [fetching, setFetching]       = useState(false);
  const [fetchError, setFetchError]   = useState(null);
  const [fetchedDocs, setFetchedDocs] = useState([]);

  // Export options
  const [selectedCols, setSelectedCols] = useState(DEFAULT_EXPORT_COLS);
  const [format, setFormat]           = useState("csv");
  const [exporting, setExporting]     = useState(false);
  const [exportError, setExportError] = useState(null);
  const [previewRows, setPreviewRows] = useState([]);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/v1/workspace/sets");
      if (res.ok) { const d = await res.json(); const arr = Array.isArray(d) ? d : (d.sets ?? []); setSets(arr); if (arr.length) setSelectedSet(arr[0].id); }
    })();
  }, []);

  const handleFetch = useCallback(async () => {
    if (!elements.trim()) { setFetchError("Enter at least one element."); return; }
    setFetchError(null); setFetching(true);
    try {
      const res = await fetch("/api/v1/workspace/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ elements: elements.split(",").map(s => s.trim()).filter(Boolean), max_materials: expSize, stable_only: expStable }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      setFetchedDocs(data.docs ?? []);
      setPreviewRows(data.preview ?? []);
    } catch (err) { setFetchError(err.message); }
    finally { setFetching(false); }
  }, [elements, expSize, expStable]);

  const handleExport = useCallback(async () => {
    setExportError(null); setExporting(true);
    try {
      // API only supports comparison set export (ExportRequest requires set_id)
      if (source !== "comparison_set" || !selectedSet) {
        throw new Error("Select a comparison set to export. Custom fetch export is not yet supported.");
      }
      const payload = {
        set_id: selectedSet,
        fmt: format,
        columns: selectedCols,
      };
      const res = await fetch("/api/v1/workspace/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const ext = format === "excel" ? "xlsx" : format;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `materials_export.${ext}`; a.click();
      URL.revokeObjectURL(url);
    } catch (err) { setExportError(err.message); }
    finally { setExporting(false); }
  }, [source, selectedSet, selectedCols, format]);

  const toggleCol = (key) => setSelectedCols(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);

  const activeSet = sets.find(s => s.id === selectedSet);
  const docCount = source === "comparison_set" ? (activeSet?.items.length ?? 0) : fetchedDocs.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>
        <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Export source
        </div>
        <SegmentedToggle groupId="export-source-pill"
          options={[
            { value: "comparison_set", label: "Comparison Set", icon: "🔬" },
            { value: "custom_fetch",   label: "Custom Fetch",   icon: "🌐" },
          ]}
          value={source} onChange={setSource}
        />

        <AnimatePresence mode="wait">
          {source === "comparison_set" ? (
            <motion.div key="cs" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {sets.length === 0 ? (
                <div style={{ fontFamily: T.sans, fontSize: "12px", color: T.textMuted }}>
                  No comparison sets. Create one in the Comparison Sets tab first.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <label style={{ fontFamily: T.sans, fontSize: "11px", color: T.textLabel }}>Select set</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {sets.map(s => (
                      <button key={s.id} onClick={() => setSelectedSet(s.id)}
                        style={{ fontFamily: T.sans, fontSize: "12px", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontWeight: s.id === selectedSet ? 600 : 400, color: s.id === selectedSet ? T.accent : T.textLabel, background: s.id === selectedSet ? T.accentDim : "rgba(148,163,184,0.05)", border: `1px solid ${s.id === selectedSet ? "rgba(6,182,212,0.30)" : T.border}`, transition: "all 150ms ease" }}
                      >
                        {s.name} <span style={{ fontFamily: T.mono, fontSize: "10px", opacity: 0.7 }}>({s.items.length})</span>
                      </button>
                    ))}
                  </div>
                  {activeSet && <div style={{ fontFamily: T.sans, fontSize: "11px", color: T.textMuted }}>{activeSet.items.length} materials in <span style={{ color: T.textLabel }}>{activeSet.name}</span></div>}
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div key="cf" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: "8px" }}>
                <StyledInput value={elements} onChange={e => setElements(e.target.value)} placeholder="Li, Fe, O" disabled={fetching} />
                <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontFamily: T.sans, fontSize: "10px", color: T.textMuted }}>Max</span>
                    <span style={{ fontFamily: T.mono, fontSize: "10px", color: T.accent }}>{expSize}</span>
                  </div>
                  <input type="range" min={20} max={500} step={20} value={expSize} onChange={e => setExpSize(Number(e.target.value))} className="spring-range" style={{ "--pct": `${((expSize - 20) / 480) * 100}%` }} />
                </div>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" }}>
                <ToggleSwitch checked={expStable} onChange={() => setExpStable(v => !v)} />
                <span style={{ fontFamily: T.sans, fontSize: "11.5px", color: T.textLabel }}>Stable only (eah ≤ 0)</span>
              </label>
              <PrimaryBtn onClick={handleFetch} loading={fetching} style={{ alignSelf: "flex-start" }}>
                Fetch corpus
              </PrimaryBtn>
              <AnimatePresence><ErrorBanner msg={fetchError} /></AnimatePresence>
              {fetchedDocs.length > 0 && <div style={{ fontFamily: T.sans, fontSize: "11px", color: T.success }}>{fetchedDocs.length} materials fetched and ready.</div>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Export options — only shown when there are docs to export */}
      {docCount > 0 && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
          style={{ display: "flex", flexDirection: "column", gap: "14px" }}
        >
          <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ fontFamily: T.sans, fontSize: "10px", fontWeight: 500, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Export options
            </div>

            {/* Column picker */}
            <div>
              <label style={{ display: "block", fontFamily: T.sans, fontSize: "11px", color: T.textLabel, marginBottom: "6px" }}>
                Columns to include ({selectedCols.length} of {EXPORT_COLS.length})
              </label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
                {EXPORT_COLS.map(({ key, label }) => {
                  const isSelected = selectedCols.includes(key);
                  return (
                    <button key={key} onClick={() => toggleCol(key)}
                      style={{ fontFamily: T.sans, fontSize: "11px", padding: "4px 8px", borderRadius: "5px", cursor: "pointer", fontWeight: isSelected ? 500 : 400, color: isSelected ? T.accent : T.textMuted, background: isSelected ? T.accentDim : "rgba(148,163,184,0.04)", border: `1px solid ${isSelected ? "rgba(6,182,212,0.25)" : T.border}`, transition: "all 130ms ease" }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Format */}
            <div>
              <label style={{ display: "block", fontFamily: T.sans, fontSize: "11px", color: T.textLabel, marginBottom: "6px" }}>Format</label>
              <SegmentedToggle groupId="export-fmt-pill"
                options={[
                  { value: "csv",   label: "CSV",   icon: "📄" },
                  { value: "json",  label: "JSON",  icon: "🗒️" },
                  { value: "excel", label: "Excel", icon: "📊" },
                ]}
                value={format} onChange={setFormat}
              />
            </div>

            <AnimatePresence><ErrorBanner msg={exportError} /></AnimatePresence>

            <PrimaryBtn onClick={handleExport} loading={exporting} style={{ alignSelf: "flex-start" }}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              Download {format.toUpperCase()} ({docCount} materials)
            </PrimaryBtn>

            <div style={{ fontFamily: T.sans, fontSize: "10.5px", color: T.textMuted, lineHeight: 1.6 }}>
              Export is recorded to workspace history. Excel requires <span style={{ fontFamily: T.mono }}>openpyxl</span> on the server.
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Workspace component
// ═══════════════════════════════════════════════════════════════════════════
export default function Workspace() {
  const [activeTab, setActiveTab]   = useState("searches");
  const [stats, setStats]           = useState({ saved_searches: 0, comparison_sets: 0, comparison_items: 0, exports: 0 });

  const headerRef = useRef(null);

  useEffect(() => {
    if (!headerRef.current) return;
    const els = headerRef.current.querySelectorAll(".gsap-item");
    gsap.fromTo(els, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out", stagger: 0.06, delay: 0.05 });
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/workspace/stats");
      if (res.ok) { const d = await res.json(); setStats(d); }
    } catch { /* silent */ }
  }, []);

  useEffect(() => { refreshStats(); }, [refreshStats]);

  return (
    <>
      <style>{`
        .workspace-input:focus { border-color: ${T.borderFocus} !important; box-shadow: 0 0 0 3px ${T.accentGlow}; outline: none; }
        .result-card-header:hover { background: rgba(148,163,184,0.04); }
        .ghost-btn:hover { background: rgba(148,163,184,0.06) !important; }
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
                <rect x="2" y="2" width="7" height="7" rx="1.5" stroke={T.accent} strokeWidth="1.5"/>
                <rect x="11" y="2" width="7" height="7" rx="1.5" stroke={T.accent} strokeWidth="1.5"/>
                <rect x="2" y="11" width="7" height="7" rx="1.5" stroke={T.accent} strokeWidth="1.5"/>
                <rect x="11" y="11" width="7" height="7" rx="1.5" stroke={T.accent} strokeWidth="1.5"/>
              </svg>
            </div>
            <h1 style={{ fontFamily: T.sans, fontSize: "17px", fontWeight: 600, color: T.textPrimary, margin: 0, letterSpacing: "-0.015em" }}>
              Experiment Workspace
            </h1>
          </div>
          <p className="gsap-item" style={{ fontFamily: T.sans, fontSize: "13px", color: T.textMuted, margin: 0, lineHeight: 1.6, maxWidth: "580px" }}>
            Save searches, build material comparison sets, and export datasets for downstream analysis.
          </p>
        </div>

        {/* ── Stats row ── */}
        <div className="gsap-item" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px", marginBottom: "20px" }}>
          <StatCard label="Saved Searches"   value={stats.saved_searches}   icon="💾" />
          <StatCard label="Comparison Sets"  value={stats.comparison_sets}  icon="🔬" />
          <StatCard label="Materials Tracked" value={stats.comparison_items} icon="⚗️" />
          <StatCard label="Exports"           value={stats.exports}          icon="📤" />
        </div>

        {/* ── Sub-tab selector ── */}
        <div className="gsap-item" style={{ marginBottom: "16px" }}>
          <SegmentedToggle
            groupId="workspace-tab-pill"
            options={[
              { value: "searches", label: "Saved Searches",   icon: "💾" },
              { value: "compare",  label: "Comparison Sets",  icon: "🔬" },
              { value: "export",   label: "Dataset Export",   icon: "📤" },
            ]}
            value={activeTab} onChange={setActiveTab}
          />
        </div>

        {/* ── Sub-tab content ── */}
        <AnimatePresence mode="wait">
          {activeTab === "searches" && (
            <motion.div key="searches" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
              <SavedSearchesTab stats={stats} onStatsRefresh={refreshStats} />
            </motion.div>
          )}
          {activeTab === "compare" && (
            <motion.div key="compare" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
              <ComparisonSetsTab onStatsRefresh={refreshStats} />
            </motion.div>
          )}
          {activeTab === "export" && (
            <motion.div key="export" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
              <DatasetExportTab />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}
