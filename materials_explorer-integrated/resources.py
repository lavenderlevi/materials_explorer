"""
Shared Streamlit @st.cache_resource initializers for Materials Explorer.

All pages import from this module. Resources are created once per process
and shared across pages and reruns without re-initialization.

API key resolution order:
    1. st.secrets["mp_api_key"]       (secrets.toml — production)
    2. MP_API_KEY env var              (Docker / CI)
    3. st.session_state["mp_api_key"] (sidebar input — dev / demo)
"""

from __future__ import annotations

import os
from pathlib import Path

import streamlit as st

from search import (
    CacheStore, CachedMPClient, FilterBuilder,
    RankingEngine, SearchEngine, SQLitePopularityFetcher,
)
from search.semantic import EmbeddingStore, SemanticSearchEngine
from search.similarity import SimilarMaterialsEngine, SimilarityMetric


def get_api_key() -> str | None:
    """Return the resolved MP API key, or None if not configured."""
    if "mp_api_key" in st.secrets:
        return str(st.secrets["mp_api_key"])
    env = os.environ.get("MP_API_KEY", "").strip()
    if env:
        return env
    return st.session_state.get("mp_api_key")


def render_api_key_sidebar() -> None:
    """Render a minimal API key widget in the sidebar for every page."""
    with st.sidebar:
        st.header("⚗️ Materials Explorer")
        if not get_api_key():
            key_input = st.text_input(
                "🔑 Materials Project API Key", type="password",
                placeholder="Enter your MP API key…",
                help="Free key at https://materialsproject.org",
                key="_sidebar_api_key",
            )
            if key_input:
                st.session_state["mp_api_key"] = key_input.strip()
                st.rerun()
        else:
            st.success("✅ API key configured")
            if st.button("Clear key", key="_clear_key"):
                st.session_state.pop("mp_api_key", None)
                st.rerun()


@st.cache_resource
def get_cache_store() -> CacheStore:
    """One CacheStore per process. L1 memory cache survives across reruns."""
    db = Path(os.environ.get("MATERIALS_DB_PATH", "materials_explorer.db"))
    return CacheStore(db)


@st.cache_resource
def get_mp_client(api_key: str) -> CachedMPClient:
    """CachedMPClient singleton per API key."""
    return CachedMPClient(api_key=api_key, cache_store=get_cache_store())


@st.cache_resource
def get_search_engine(api_key: str) -> SearchEngine:
    """Full search pipeline singleton per API key."""
    store = get_cache_store()
    client = get_mp_client(api_key)
    fetcher = SQLitePopularityFetcher(cache_store=store)
    ranker = RankingEngine(popularity_fetcher=fetcher)
    return SearchEngine(
        client=client, ranking_engine=ranker, filter_builder=FilterBuilder()
    )


@st.cache_resource
def get_semantic_engine() -> SemanticSearchEngine:
    """SemanticSearchEngine singleton — embedder model held in memory."""
    db = Path(os.environ.get("MATERIALS_DB_PATH", "materials_explorer.db"))
    return SemanticSearchEngine(store=EmbeddingStore(db_path=db), db_path=db)


def get_similarity_engine(
    metric: SimilarityMetric = SimilarityMetric.WEIGHTED_COSINE,
) -> SimilarMaterialsEngine:
    """SimilarMaterialsEngine — new instance per search (corpus-fitted)."""
    return SimilarMaterialsEngine(metric=metric)


@st.cache_resource
def get_ml_predictor(api_key: str | None = None):
    """MLPredictor singleton. Loads persisted joblib models on startup."""
    from search.ml_predict import MLPredictor  # noqa: PLC0415
    return MLPredictor(
        model_dir=Path(os.environ.get("MATERIALS_MODEL_DIR", "models")),
        api_key=api_key, n_train=500,
    )


@st.cache_resource
def get_structure_store():
    """StructureStore singleton — SQLite tables for Structure JSON + fingerprints."""
    from search.crystal import StructureStore  # noqa: PLC0415
    db = Path(os.environ.get("MATERIALS_DB_PATH", "materials_explorer.db"))
    return StructureStore(db_path=db)


@st.cache_resource
def get_structure_client(api_key: str):
    """StructureClient singleton per API key."""
    from search.crystal import StructureClient  # noqa: PLC0415
    return StructureClient(api_key=api_key, store=get_structure_store())


@st.cache_resource
def get_crystal_engine():
    """CrystalSimilarityEngine singleton. Shares the process-wide StructureStore."""
    from search.crystal import CrystalSimilarityEngine  # noqa: PLC0415
    return CrystalSimilarityEngine(store=get_structure_store())


@st.cache_resource
def get_workspace_manager():
    """WorkspaceManager singleton — one SQLite store per process.

    WorkspaceStore uses the same DB file as all other stores. Cached so the
    thread-local connection pool is warm across page navigations and reruns.
    """
    from search.workspace import WorkspaceManager  # noqa: PLC0415
    db = Path(os.environ.get("MATERIALS_DB_PATH", "materials_explorer.db"))
    return WorkspaceManager(db_path=db)