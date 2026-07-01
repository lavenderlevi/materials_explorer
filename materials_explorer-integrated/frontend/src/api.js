/**
 * api.js — Centralized API client for Materials Explorer.
 *
 * Maps frontend calls → FastAPI /api/v1/* endpoints.
 * All fetches go through this module so URL changes need only one edit.
 *
 * Base: /api/v1  (proxied to :8000 in dev via vite.config.js)
 */

const BASE = "/api/v1";

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Tab 1: Semantic Search ──────────────────────────────────────────────────
// POST /api/v1/semantic
export const semanticSearch = (payload) => post("/semantic", {
  query: payload.query,
  elements: payload.elements || [],
  corpus_size: payload.corpus_size || 80,
  stability_only: payload.stability_only || false,
  top_k: payload.top_k || 10,
});

// ── Tab 2: Recommendations ─────────────────────────────────────────────────
// POST /api/v1/recommend
export const recommend = (payload) => post("/recommend", {
  elements: payload.elements,
  requirements: payload.requirements,
  categorical: payload.categorical,
  corpus_size: payload.corpus_size || 100,
  top_k: payload.top_k || 10,
});

// ── Tab 3: Similar Materials ───────────────────────────────────────────────
// POST /api/v1/similar
export const findSimilar = (payload) => post("/similar", {
  seed_id: payload.seed_id,
  metric: payload.metric || "weighted_cosine",
  top_k: payload.top_k || 10,
  corpus_size: payload.corpus_size || 100,
  elements: payload.elements || [],
});

// Fetch single material for seed banner
export const getMaterial = (id) => get(`/materials/${id}`);

// ── Tab 4: ML Predictions ──────────────────────────────────────────────────
// POST /api/v1/predict
export const predict = (formula) => post("/predict", { formula });
// GET  /api/v1/predict/status
export const predictStatus = () => get("/predict/status");
// GET  /api/v1/predict/importance?target=band_gap
export const predictImportance = (target) => get(`/predict/importance?target=${target}`);

// ── Tab 5: Crystal Similarity ──────────────────────────────────────────────
// POST /api/v1/crystal/fingerprint
export const crystalFingerprint = (payload) => post("/crystal/fingerprint", payload);
// POST /api/v1/crystal/matcher
export const crystalMatcher = (payload) => post("/crystal/matcher", payload);
// GET  /api/v1/crystal/seed/{id}
export const crystalSeed = (id) => get(`/crystal/seed/${id}`);

// ── Tab 6: Property Correlation ────────────────────────────────────────────
// POST /api/v1/correlation
export const computeCorrelation = (payload) => post("/correlation", {
  elements: payload.elements,
  properties: payload.properties,
  stability_filter: payload.stability_filter || false,
  corpus_size: payload.corpus_size || 200,
  method: payload.method || "both",
  min_valid: payload.min_valid || 10,
});

// ── Tab 7: Workspace ───────────────────────────────────────────────────────
export const workspaceStats    = () => get("/workspace/stats");
export const listSearches      = () => get("/workspace/searches");
export const saveSearch        = (payload) => post("/workspace/searches", payload);
export const rerunSearch       = (id) => post(`/workspace/searches/${id}/run`, {});
export const deleteSearch      = (id) =>
  fetch(`${BASE}/workspace/searches/${id}`, { method: "DELETE" }).then(r => r.json());

export const listSets          = () => get("/workspace/sets");
export const createSet         = (payload) => post("/workspace/sets", payload);
export const addToSet          = (setId, materialId) =>
  post(`/workspace/sets/${setId}/items`, { material_id: materialId });
export const removeFromSet     = (setId, materialId) =>
  fetch(`${BASE}/workspace/sets/${setId}/items/${materialId}`, { method: "DELETE" }).then(r => r.json());
export const deleteSet         = (setId) =>
  fetch(`${BASE}/workspace/sets/${setId}`, { method: "DELETE" }).then(r => r.json());

export const exportSet         = async (setId, fmt, columns) => {
  const res = await fetch(`${BASE}/workspace/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ set_id: setId, fmt, columns: columns || null }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.blob();
};
