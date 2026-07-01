# Materials Explorer — React + FastAPI Integration

## Architecture

```
materials_explorer/
├── api/                          # FastAPI backend
│   ├── main.py                   # App factory + static SPA serving
│   ├── dependencies.py           # Settings (env vars), DI
│   ├── models.py                 # Pydantic request/response models
│   ├── converters.py             # Domain → API adapters
│   └── routers/
│       ├── search.py             # POST /api/v1/search
│       ├── semantic.py           # POST /api/v1/semantic
│       ├── recommend.py          # POST /api/v1/recommend
│       │                         # POST /api/v1/similar
│       ├── predict.py            # POST /api/v1/predict
│       │                         # GET  /api/v1/predict/status
│       │                         # GET  /api/v1/predict/importance
│       ├── crystal.py            # POST /api/v1/crystal/fingerprint  ← NEW
│       │                         # POST /api/v1/crystal/matcher       ← NEW
│       │                         # GET  /api/v1/crystal/seed/{id}     ← NEW
│       ├── correlation.py        # POST /api/v1/correlation           ← NEW
│       └── workspace.py          # /api/v1/workspace/*
│
├── frontend/                     # React SPA (Vite)
│   ├── src/
│   │   ├── main.jsx              # React Router setup
│   │   ├── AppLayout.jsx         # Sidebar + layout shell
│   │   ├── api.js                # Centralized API client ← NEW
│   │   └── tabs/
│   │       ├── SemanticSearch.jsx
│   │       ├── Recommendations.jsx
│   │       ├── SimilarMaterials.jsx
│   │       ├── MLPredictions.jsx
│   │       ├── CrystalSimilarity.jsx
│   │       └── PropertyCorrelation.jsx
│   │       └── Workspace.jsx
│   ├── index.html
│   ├── vite.config.js            # Dev proxy /api → :8000; build → api/static/dist
│   └── package.json
│
├── search/                       # Domain engines (unchanged)
├── app.py                        # Streamlit launcher (redirect page)
├── start.sh                      # Production start
├── start_dev.sh                  # Development start (HMR)
└── requirements.txt
```

## API endpoint map

| Tab | Method | Endpoint |
|-----|--------|----------|
| Semantic Search | POST | `/api/v1/semantic` |
| Recommendations | POST | `/api/v1/recommend` |
| Similar Materials | POST | `/api/v1/similar` |
| ML Predictions | POST | `/api/v1/predict` |
| ML Predictions | GET | `/api/v1/predict/status` |
| ML Predictions | GET | `/api/v1/predict/importance?target=band_gap` |
| Crystal Similarity (FP) | POST | `/api/v1/crystal/fingerprint` |
| Crystal Similarity (SM) | POST | `/api/v1/crystal/matcher` |
| Property Correlation | POST | `/api/v1/correlation` |
| Workspace Stats | GET | `/api/v1/workspace/stats` |
| Workspace Searches | GET/POST | `/api/v1/workspace/searches` |
| Workspace Sets | GET/POST | `/api/v1/workspace/sets` |
| Workspace Export | POST | `/api/v1/workspace/export` |

## Quick start

### Prerequisites
```bash
pip install -r requirements.txt
node >= 18, npm >= 9
```

### Environment
```bash
# .env (or export as env vars)
MATERIALS_MP_API_KEY=your_mp_api_key_here
MATERIALS_DB_PATH=materials_explorer.db
MATERIALS_MODEL_DIR=models
```

### Production (one terminal)
```bash
cd frontend && npm install && npm run build && cd ..
uvicorn api.main:app --port 8000
# → http://localhost:8000
```

### Development (two terminals)
```bash
# Terminal 1
uvicorn api.main:app --reload --port 8000

# Terminal 2
cd frontend && npm run dev
# → http://localhost:5173  (proxies /api/* → :8000)
```

## Key integration decisions

**Why FastAPI, not Streamlit for the React shell?**
The project already had a complete FastAPI layer (`api/`) with all engines wired.
Streamlit cannot serve a React SPA — its component model conflicts with React Router.
FastAPI's `StaticFiles` + SPA fallback route serves `index.html` for every non-API
path, which is exactly what React Router needs.

**Two new routers added**
`crystal.py` and `correlation.py` were missing from the original API.
Both use the existing `search/crystal.py` and `search/correlation.py` engines directly,
following the same dependency-injection pattern as the other routers.

**Centralized `api.js`**
All 7 tabs import from `src/api.js` instead of calling `fetch()` directly.
This maps frontend route names → correct `/api/v1/*` paths and handles
the shape differences between what the JSX originally assumed and what
the FastAPI models actually return.

**Response shape adaptations**
- `/api/v1/semantic` returns `list[SemanticResultResponse]` (array, not wrapped)
- `/api/v1/similar` returns `list[SimilarResultResponse]` (array); seed fetched separately via `/api/v1/materials/{id}`
- `/api/v1/predict` returns `PredictAPIResponse` (flat object); JSX transforms to per-target dict
- `/api/v1/workspace/searches` and `/api/v1/workspace/sets` return arrays directly
- `MaterialResponse` uses `formula` (not `formula_pretty`) and `spacegroup` (not `spacegroup_symbol`)
