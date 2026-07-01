"""
FastAPI application — Materials Explorer.

Run:
    uvicorn api.main:app --reload --port 8000

The React frontend is served from api/static/dist/ when built.
In development the Vite dev server runs on :5173 with CORS proxy to :8000.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from api.dependencies import get_settings
from api.routers import crystal, correlation, predict, recommend, search, semantic, workspace
from search.service import build_materials_service

logger = logging.getLogger(__name__)

_STATIC_DIR = Path(__file__).parent / "static" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    if not settings.mp_api_key:
        logger.warning("No MP API key. Set MATERIALS_MP_API_KEY.")

    logger.info("Building MaterialsService…")
    try:
        app.state.service = build_materials_service(
            api_key=settings.mp_api_key,
            db_path=settings.db_path,
            model_dir=settings.model_dir,
            n_train=settings.n_train,
        )
        logger.info("MaterialsService ready.")
    except Exception:
        logger.exception("Failed to initialise MaterialsService.")
        app.state.service = None

    yield
    logger.info("Materials Explorer API shutting down.")


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="Materials Explorer API",
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    _V1 = "/api/v1"
    app.include_router(search.router,      prefix=_V1, tags=["Search"])
    app.include_router(semantic.router,    prefix=_V1, tags=["Semantic Search"])
    app.include_router(recommend.router,   prefix=_V1, tags=["Recommendations & Similar"])
    app.include_router(predict.router,     prefix=_V1, tags=["ML Predictions"])
    app.include_router(workspace.router,   prefix=_V1, tags=["Workspace"])
    app.include_router(crystal.router,     prefix=_V1, tags=["Crystal Similarity"])
    app.include_router(correlation.router, prefix=_V1, tags=["Property Correlation"])

    @app.get("/health", tags=["Health"])
    async def health() -> dict:
        svc_ok = getattr(app.state, "service", None) is not None
        return {"status": "ok" if svc_ok else "degraded", "service_ready": svc_ok}

    # ── Serve React SPA ────────────────────────────────────────────────────
    if _STATIC_DIR.exists():
        app.mount("/assets", StaticFiles(directory=_STATIC_DIR / "assets"), name="assets")

        @app.get("/", include_in_schema=False)
        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa_fallback(full_path: str = "") -> FileResponse:
            """Serve index.html for all non-API routes (React Router SPA)."""
            if full_path.startswith("api/"):
                from fastapi import HTTPException
                raise HTTPException(status_code=404)
            return FileResponse(_STATIC_DIR / "index.html")
    else:
        @app.get("/", include_in_schema=False)
        async def root():
            return {
                "message": "React frontend not built yet.",
                "instructions": "cd frontend && npm install && npm run build",
                "api_docs": "/api/docs",
            }

    return app


app = create_app()
