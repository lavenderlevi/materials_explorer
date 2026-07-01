"""
Service layer for Materials Explorer — FastAPI integration.

MaterialsService is the single point of coupling between the HTTP layer
(api/) and all domain engines (search/). It owns one CachedMPClient and
uses it to fetch corpora internally, keeping routers parameter-only.

build_materials_service() is the composition root: called once in the
FastAPI lifespan handler and stored in app.state.service.

ServiceProtocol is @runtime_checkable so test doubles are validated at
test time via isinstance() without any explicit inheritance.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Protocol, runtime_checkable

from .cache import CachedMPClient, CacheStore, SQLitePopularityFetcher
from .engine import SearchEngine
from .filters import FilterBuilder
from .ml_predict import MLPredictor, PredictionResult
from .models import MaterialDocument, SearchResponse, SUMMARY_FIELDS
from .parser import IntentParser
from .ranking import RankingEngine
from .recommender import (
    CategoryRequirements,
    PropertyRequirement,
    RecommendationEngine,
    RecommendationResult,
)
from .semantic import EmbeddingStore, SemanticSearchEngine, SemanticResult
from .similarity import SimilarMaterial, SimilarMaterialsEngine, SimilarityMetric
from .workspace import WorkspaceManager

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class ServiceProtocol(Protocol):
    """Abstract interface over all Materials Explorer domain engines."""

    def search(self, query: str) -> SearchResponse: ...

    def semantic_search(
        self, query: str, elements: list[str], top_k: int,
        corpus_size: int, stability_only: bool,
    ) -> list[SemanticResult]: ...

    def recommend(
        self, requirements: list[PropertyRequirement], elements: list[str],
        corpus_size: int, top_k: int, categorical: CategoryRequirements | None,
    ) -> list[RecommendationResult]: ...

    def predict(self, formula: str) -> dict[str, PredictionResult | None]: ...

    def find_similar(
        self, seed_id: str, corpus_size: int, top_k: int,
        metric: SimilarityMetric, elements: list[str] | None,
    ) -> list[SimilarMaterial]: ...

    @property
    def workspace(self) -> WorkspaceManager: ...


# ---------------------------------------------------------------------------
# Concrete service
# ---------------------------------------------------------------------------


class MaterialsService:
    """Concrete ServiceProtocol implementation.

    All engines injected at construction. Owns the MP client so it handles
    all corpus fetching internally — routers pass only clean parameters.
    """

    def __init__(
        self,
        mp_client: CachedMPClient,
        search_engine: SearchEngine,
        semantic_engine: SemanticSearchEngine,
        ml_predictor: MLPredictor,
        workspace_manager: WorkspaceManager,
    ) -> None:
        self._client = mp_client
        self._search_engine = search_engine
        self._semantic = semantic_engine
        self._ml = ml_predictor
        self._workspace = workspace_manager
        self._parser = IntentParser()

    @property
    def workspace(self) -> WorkspaceManager:
        return self._workspace

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    def search(self, query: str) -> SearchResponse:
        """Parse *query* and run the full ranked search pipeline."""
        return self._search_engine.search(self._parser.parse(query))

    # ------------------------------------------------------------------
    # Semantic
    # ------------------------------------------------------------------

    def semantic_search(
        self,
        query: str,
        elements: list[str],
        top_k: int = 10,
        corpus_size: int = 80,
        stability_only: bool = False,
    ) -> list[SemanticResult]:
        """Fetch corpus by element filter and rank by embedding similarity."""
        if not elements:
            logger.warning("semantic_search: no element filter — refusing full-DB fetch.")
            return []
        filters: dict = {"elements": elements}
        if stability_only:
            filters["energy_above_hull"] = (None, 0.0)
        corpus = self._client.search(fields=SUMMARY_FIELDS, **filters)[:corpus_size]
        if not corpus:
            return []
        return self._semantic.search(query=query, corpus=corpus, top_k=top_k)

    # ------------------------------------------------------------------
    # Recommend
    # ------------------------------------------------------------------

    def recommend(
        self,
        requirements: list[PropertyRequirement],
        elements: list[str],
        corpus_size: int = 100,
        top_k: int = 10,
        categorical: CategoryRequirements | None = None,
    ) -> list[RecommendationResult]:
        """Fetch corpus and rank by property requirement matching."""
        if not elements:
            logger.warning("recommend: no element filter — refusing full-DB fetch.")
            return []
        corpus = self._client.search(
            fields=SUMMARY_FIELDS, elements=elements
        )[:corpus_size]
        if not corpus:
            return []
        engine = RecommendationEngine(requirements=requirements, categorical=categorical)
        return engine.recommend(corpus=corpus, top_k=top_k)

    # ------------------------------------------------------------------
    # Predict
    # ------------------------------------------------------------------

    def predict(self, formula: str) -> dict[str, PredictionResult | None]:
        """Run quantile GBR inference for all three target properties."""
        return self._ml.predict(formula)

    # ------------------------------------------------------------------
    # Similar
    # ------------------------------------------------------------------

    def find_similar(
        self,
        seed_id: str,
        corpus_size: int = 60,
        top_k: int = 10,
        metric: SimilarityMetric = SimilarityMetric.WEIGHTED_COSINE,
        elements: list[str] | None = None,
    ) -> list[SimilarMaterial]:
        """Fetch seed + element-system corpus and rank by feature similarity."""
        seed = self._client.get_by_id(seed_id, fields=SUMMARY_FIELDS)
        if seed is None:
            logger.warning("find_similar: seed '%s' not found.", seed_id)
            return []
        search_elements = elements or list(seed.elements)
        corpus = self._client.search(
            fields=SUMMARY_FIELDS, elements=search_elements
        )[:corpus_size]
        return SimilarMaterialsEngine(metric=metric).find_similar(
            seed=seed, corpus=corpus, top_k=top_k
        )


# ---------------------------------------------------------------------------
# Composition root
# ---------------------------------------------------------------------------


def build_materials_service(
    api_key: str,
    db_path: str | Path = "materials_explorer.db",
    model_dir: str | Path = "models",
    n_train: int = 500,
) -> MaterialsService:
    """Wire all dependencies and return a ready-to-use MaterialsService.

    Called once during the FastAPI lifespan startup handler.
    The returned instance is stored in ``app.state.service``.
    """
    db = Path(db_path)
    store = CacheStore(db_path=db)
    client = CachedMPClient(api_key=api_key, cache_store=store)
    fetcher = SQLitePopularityFetcher(cache_store=store)
    ranker = RankingEngine(popularity_fetcher=fetcher)
    search_engine = SearchEngine(
        client=client, ranking_engine=ranker, filter_builder=FilterBuilder()
    )
    semantic_engine = SemanticSearchEngine(
        store=EmbeddingStore(db_path=db), db_path=db
    )
    ml_predictor = MLPredictor(
        model_dir=Path(model_dir), api_key=api_key, n_train=n_train
    )
    workspace_manager = WorkspaceManager(db_path=db)

    return MaterialsService(
        mp_client=client,
        search_engine=search_engine,
        semantic_engine=semantic_engine,
        ml_predictor=ml_predictor,
        workspace_manager=workspace_manager,
    )