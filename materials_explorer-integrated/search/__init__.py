"""
Materials Explorer — Search package.

Dependency order (no circular imports):
    models → parser → filters → ranking → cache → engine
    models → semantic
    models → similarity
    models → recommender
    models → ml_predict
    (none) → crystal
    models → correlation
    models → workspace
    all above → service  (composition root; imports from all)
"""

from .cache import CacheStore, CachedMPClient, SQLitePopularityFetcher
from .correlation import (
    CORRELATABLE_PROPERTIES, CorrelationAnalyzer,
    CorrelationResult, corpus_to_dataframe,
)
from .crystal import (
    CrystalFingerprinter, CrystalSimilarityEngine,
    CrystalSimilarityResult, StructureClient, StructureStore,
)
from .engine import SearchEngine
from .filters import FilterBuilder
from .ml_predict import (
    ElementFeaturizer, FEATURE_NAMES, MLPredictor,
    PredictionResult, QuantileGBR, TARGET_UNITS,
)
from .models import (
    CompletenessFlags, MaterialDocument, ParsedQuery, PropertyFilter,
    QueryIntent, RankedResult, ScoreBreakdown, SearchResponse, SUMMARY_FIELDS,
)
from .parser import IntentParser
from .ranking import NullPopularityFetcher, RankingEngine
from .recommender import (
    CategoryRequirements, PropertyRequirement, PropertyScore,
    RecommendationEngine, RecommendationResult, PROPERTY_META,
)
from .semantic import (
    EmbeddingStore, SemanticSearchEngine, SemanticResult,
    SentenceTransformerEmbedder, TFIDFEmbedder, build_material_description,
)
from .service import MaterialsService, ServiceProtocol, build_materials_service
from .similarity import (
    FeatureDiff, FeatureExtractor, SimilarMaterial,
    SimilarMaterialsEngine, SimilarityMetric,
)
from .workspace import (
    ComparisonItem, ComparisonSet, DatasetExporter,
    SavedSearch, WorkspaceManager, WorkspaceStore,
)

__all__: list[str] = [
    # cache
    "CacheStore", "CachedMPClient", "SQLitePopularityFetcher",
    # correlation
    "CORRELATABLE_PROPERTIES", "CorrelationAnalyzer",
    "CorrelationResult", "corpus_to_dataframe",
    # crystal
    "CrystalFingerprinter", "CrystalSimilarityEngine",
    "CrystalSimilarityResult", "StructureClient", "StructureStore",
    # engine
    "SearchEngine",
    # filters
    "FilterBuilder",
    # ml_predict
    "ElementFeaturizer", "FEATURE_NAMES", "MLPredictor",
    "PredictionResult", "QuantileGBR", "TARGET_UNITS",
    # models
    "CompletenessFlags", "MaterialDocument", "ParsedQuery", "PropertyFilter",
    "QueryIntent", "RankedResult", "ScoreBreakdown", "SearchResponse", "SUMMARY_FIELDS",
    # parser
    "IntentParser",
    # ranking
    "NullPopularityFetcher", "RankingEngine",
    # recommender
    "CategoryRequirements", "PropertyRequirement", "PropertyScore",
    "RecommendationEngine", "RecommendationResult", "PROPERTY_META",
    # semantic
    "EmbeddingStore", "SemanticSearchEngine", "SemanticResult",
    "SentenceTransformerEmbedder", "TFIDFEmbedder", "build_material_description",
    # service
    "MaterialsService", "ServiceProtocol", "build_materials_service",
    # similarity
    "FeatureDiff", "FeatureExtractor", "SimilarMaterial",
    "SimilarMaterialsEngine", "SimilarityMetric",
    # workspace
    "ComparisonItem", "ComparisonSet", "DatasetExporter",
    "SavedSearch", "WorkspaceManager", "WorkspaceStore",
]