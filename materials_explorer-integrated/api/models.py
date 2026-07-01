"""
API-level Pydantic request and response models for Materials Explorer.

Intentionally decoupled from search/ domain models. Changes to internal
representations do not break the public API contract.
All field names follow JSON snake_case conventions.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Shared projections
# ---------------------------------------------------------------------------


class CompletenessResponse(BaseModel):
    has_dos: bool
    has_band_structure: bool
    has_elastic: bool
    has_phonon: bool


class MaterialResponse(BaseModel):
    material_id: str
    formula: str
    band_gap: float | None
    density: float | None
    formation_energy_per_atom: float | None
    energy_above_hull: float | None
    volume: float | None
    nsites: int | None
    crystal_system: str | None
    spacegroup: str | None
    is_stable: bool
    is_magnetic: bool
    elements: list[str]
    completeness: CompletenessResponse
    mp_url: str


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    top_k: int = Field(default=10, ge=1, le=50)


class ScoreBreakdownResponse(BaseModel):
    stability: float
    completeness: float
    exact_match: float
    popularity: float
    application_relevance: float
    total: float


class RankedResultResponse(BaseModel):
    material: MaterialResponse
    score_breakdown: ScoreBreakdownResponse
    total_score: float
    rank: int


class SearchAPIResponse(BaseModel):
    query: str
    intent: str
    confidence: float
    results: list[RankedResultResponse]
    total_found: int
    cache_hit: bool
    elapsed_ms: float


# ---------------------------------------------------------------------------
# Semantic Search
# ---------------------------------------------------------------------------


class SemanticSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    elements: list[str] = Field(
        default_factory=list,
        description="Corpus restricted to materials containing ALL of these elements.",
    )
    corpus_size: int = Field(default=80, ge=10, le=200)
    stability_only: bool = False
    top_k: int = Field(default=10, ge=1, le=50)


class SemanticResultResponse(BaseModel):
    material: MaterialResponse
    similarity_score: float
    rank: int
    description: str


# ---------------------------------------------------------------------------
# Recommendations
# ---------------------------------------------------------------------------


class PropertyRequirementRequest(BaseModel):
    field: str = Field(description="mp-api field name, e.g. 'band_gap', 'density'.")
    target: float
    lo: float | None = None
    hi: float | None = None
    importance: float = Field(default=5.0, ge=1.0, le=10.0)


class CategoryRequirementsRequest(BaseModel):
    stability_required: bool = False
    require_dos: bool = False
    require_band_structure: bool = False
    require_elastic: bool = False
    require_phonon: bool = False


class RecommendRequest(BaseModel):
    elements: list[str] = Field(min_length=1)
    requirements: list[PropertyRequirementRequest] = Field(min_length=1)
    categorical: CategoryRequirementsRequest = Field(
        default_factory=CategoryRequirementsRequest
    )
    corpus_size: int = Field(default=100, ge=20, le=500)
    top_k: int = Field(default=10, ge=1, le=50)


class PropertyScoreResponse(BaseModel):
    field: str
    label: str
    material_value: float | None
    target: float
    raw_score: float
    in_range: bool


class RecommendResultResponse(BaseModel):
    material: MaterialResponse
    total_score: float
    property_scores: list[PropertyScoreResponse]
    hard_constraints_met: bool
    rank: int


# ---------------------------------------------------------------------------
# ML Predictions
# ---------------------------------------------------------------------------


class PredictRequest(BaseModel):
    formula: str = Field(min_length=1, max_length=100)


class PredictionDetailResponse(BaseModel):
    value: float
    ci_low: float
    ci_high: float
    unit: str
    r2_score: float
    n_train: int


class PredictAPIResponse(BaseModel):
    formula: str
    band_gap: PredictionDetailResponse | None
    formation_energy_per_atom: PredictionDetailResponse | None
    bulk_modulus: PredictionDetailResponse | None


# ---------------------------------------------------------------------------
# Similar Materials
# ---------------------------------------------------------------------------


class SimilarRequest(BaseModel):
    seed_id: str = Field(min_length=1)
    elements: list[str] = Field(
        default_factory=list,
        description="Override element system for corpus. Defaults to seed's elements.",
    )
    corpus_size: int = Field(default=60, ge=10, le=200)
    top_k: int = Field(default=10, ge=1, le=30)
    metric: str = Field(default="weighted_cosine",
                        pattern="^(cosine|euclidean|weighted_cosine)$")


class FeatureDiffResponse(BaseModel):
    feature: str
    seed_value: float | None
    candidate_value: float | None
    match_pct: float


class SimilarResultResponse(BaseModel):
    material: MaterialResponse
    similarity_score: float
    rank: int
    feature_diffs: list[FeatureDiffResponse]


# ---------------------------------------------------------------------------
# Workspace
# ---------------------------------------------------------------------------


class SaveSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    name: str | None = Field(default=None, max_length=100)


class SavedSearchResponse(BaseModel):
    id: int
    name: str
    raw_query: str
    intent: str
    confidence: float
    result_count: int
    created_at: float
    last_run_at: float | None


class CreateSetRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    notes: str = Field(default="", max_length=500)


class AddToSetRequest(BaseModel):
    material_id: str = Field(min_length=1)


class ComparisonItemResponse(BaseModel):
    material_id: str
    formula: str
    added_at: float


class ComparisonSetResponse(BaseModel):
    id: int
    name: str
    notes: str
    items: list[ComparisonItemResponse]
    created_at: float
    updated_at: float


class ExportRequest(BaseModel):
    set_id: int
    fmt: str = Field(default="csv", pattern="^(csv|json|excel|xlsx)$")
    columns: list[str] | None = None


class MessageResponse(BaseModel):
    message: str
    success: bool = True


class WorkspaceStatsResponse(BaseModel):
    saved_searches: int
    comparison_sets: int
    comparison_items: int
    exports: int