"""
Adapter functions: domain models → API response models.

One-way dependency: api/ → search/. No reverse imports.
Each converter is a pure function — no I/O, no side effects.
"""

from __future__ import annotations

from search.ml_predict import PredictionResult
from search.models import MaterialDocument, RankedResult, SearchResponse
from search.recommender import RecommendationResult
from search.semantic import SemanticResult
from search.similarity import SimilarMaterial
from search.workspace import ComparisonSet, SavedSearch

from .models import (
    CompletenessResponse,
    ComparisonItemResponse,
    ComparisonSetResponse,
    FeatureDiffResponse,
    MaterialResponse,
    PredictAPIResponse,
    PredictionDetailResponse,
    PropertyScoreResponse,
    RankedResultResponse,
    RecommendResultResponse,
    SavedSearchResponse,
    ScoreBreakdownResponse,
    SearchAPIResponse,
    SemanticResultResponse,
    SimilarResultResponse,
)


def material_to_response(doc: MaterialDocument) -> MaterialResponse:
    return MaterialResponse(
        material_id=doc.material_id,
        formula=doc.formula_pretty,
        band_gap=doc.band_gap,
        density=doc.density,
        formation_energy_per_atom=doc.formation_energy_per_atom,
        energy_above_hull=doc.energy_above_hull,
        volume=doc.volume,
        nsites=doc.nsites,
        crystal_system=doc.crystal_system,
        spacegroup=doc.spacegroup_symbol,
        is_stable=doc.is_stable,
        is_magnetic=doc.is_magnetic,
        elements=list(doc.elements),
        completeness=CompletenessResponse(
            has_dos=doc.completeness.has_dos,
            has_band_structure=doc.completeness.has_band_structure,
            has_elastic=doc.completeness.has_elastic,
            has_phonon=doc.completeness.has_phonon,
        ),
        mp_url=f"https://materialsproject.org/materials/{doc.material_id}",
    )


def ranked_result_to_response(r: RankedResult) -> RankedResultResponse:
    sb = r.score_breakdown
    return RankedResultResponse(
        material=material_to_response(r.material),
        score_breakdown=ScoreBreakdownResponse(
            stability=sb.stability, completeness=sb.completeness,
            exact_match=sb.exact_match, popularity=sb.popularity,
            application_relevance=sb.application_relevance, total=sb.total,
        ),
        total_score=r.total_score,
        rank=r.rank,
    )


def search_response_to_api(resp: SearchResponse) -> SearchAPIResponse:
    return SearchAPIResponse(
        query=resp.query.raw_query,
        intent=resp.query.intent.value,
        confidence=resp.query.confidence,
        results=[ranked_result_to_response(r) for r in resp.results],
        total_found=resp.total_found,
        cache_hit=resp.cache_hit,
        elapsed_ms=resp.elapsed_ms,
    )


def semantic_result_to_response(r: SemanticResult) -> SemanticResultResponse:
    return SemanticResultResponse(
        material=material_to_response(r.material),
        similarity_score=r.similarity_score,
        rank=r.rank,
        description=r.description,
    )


def recommend_result_to_response(r: RecommendationResult) -> RecommendResultResponse:
    return RecommendResultResponse(
        material=material_to_response(r.material),
        total_score=r.total_score,
        property_scores=[
            PropertyScoreResponse(
                field=ps.field, label=ps.label,
                material_value=ps.material_value,
                target=ps.target, raw_score=ps.raw_score,
                in_range=ps.in_range,
            )
            for ps in r.property_scores
        ],
        hard_constraints_met=r.hard_constraints_met,
        rank=r.rank,
    )


def predict_results_to_api(
    formula: str,
    preds: dict[str, PredictionResult | None],
) -> PredictAPIResponse:
    def _detail(p: PredictionResult | None) -> PredictionDetailResponse | None:
        if p is None:
            return None
        return PredictionDetailResponse(
            value=p.value, ci_low=p.ci_low, ci_high=p.ci_high,
            unit=p.unit, r2_score=p.r2_score, n_train=p.n_train,
        )

    return PredictAPIResponse(
        formula=formula,
        band_gap=_detail(preds.get("band_gap")),
        formation_energy_per_atom=_detail(preds.get("formation_energy_per_atom")),
        bulk_modulus=_detail(preds.get("bulk_modulus")),
    )


def similar_result_to_response(r: SimilarMaterial) -> SimilarResultResponse:
    return SimilarResultResponse(
        material=material_to_response(r.material),
        similarity_score=r.similarity_score,
        rank=r.rank,
        feature_diffs=[
            FeatureDiffResponse(
                feature=d.feature,
                seed_value=d.seed_value,
                candidate_value=d.candidate_value,
                match_pct=d.match_pct,
            )
            for d in r.feature_diffs
        ],
    )


def saved_search_to_response(s: SavedSearch) -> SavedSearchResponse:
    return SavedSearchResponse(
        id=s.id, name=s.name, raw_query=s.raw_query,
        intent=s.parsed_query.intent.value,
        confidence=s.parsed_query.confidence,
        result_count=s.result_count,
        created_at=s.created_at, last_run_at=s.last_run_at,
    )


def cset_to_response(cs: ComparisonSet) -> ComparisonSetResponse:
    return ComparisonSetResponse(
        id=cs.id, name=cs.name, notes=cs.notes,
        items=[
            ComparisonItemResponse(
                material_id=i.material_id,
                formula=i.formula,
                added_at=i.added_at,
            )
            for i in cs.items
        ],
        created_at=cs.created_at, updated_at=cs.updated_at,
    )