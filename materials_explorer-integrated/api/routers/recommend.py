"""
/recommend — Content-based material recommendation.
/similar   — Numeric feature-vector similarity search.

POST /api/v1/recommend — Score corpus by property requirements.
POST /api/v1/similar   — Find materials similar to a seed ID.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from api.converters import recommend_result_to_response, similar_result_to_response
from api.dependencies import get_service
from api.models import (
    RecommendRequest, RecommendResultResponse,
    SimilarRequest, SimilarResultResponse,
)
from search.recommender import CategoryRequirements, PropertyRequirement
from search.service import MaterialsService
from search.similarity import SimilarityMetric

router = APIRouter()


def _to_domain_req(r) -> PropertyRequirement:
    return PropertyRequirement(
        field=r.field, target=r.target,
        lo=r.lo, hi=r.hi, importance=r.importance,
    )


def _to_domain_cat(c) -> CategoryRequirements:
    return CategoryRequirements(
        stability_required=c.stability_required,
        require_dos=c.require_dos,
        require_band_structure=c.require_band_structure,
        require_elastic=c.require_elastic,
        require_phonon=c.require_phonon,
    )


@router.post(
    "/recommend",
    response_model=list[RecommendResultResponse],
    summary="Content-based material recommendation",
    description=(
        "Fetches a corpus restricted to the specified elements, then scores "
        "each material against the user-defined property requirements using "
        "exponential-decay scoring. Hard categorical constraints zero out "
        "violating materials rather than filtering them out."
    ),
)
async def recommend(
    req: RecommendRequest,
    service: MaterialsService = Depends(get_service),
) -> list[RecommendResultResponse]:
    domain_reqs = [_to_domain_req(r) for r in req.requirements]
    domain_cat = _to_domain_cat(req.categorical)

    results = service.recommend(
        requirements=domain_reqs,
        elements=req.elements,
        corpus_size=req.corpus_size,
        top_k=req.top_k,
        categorical=domain_cat,
    )
    if not results:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No materials found. Try different elements or broader requirements.",
        )
    return [recommend_result_to_response(r) for r in results]


@router.post(
    "/similar",
    response_model=list[SimilarResultResponse],
    summary="Similar materials by feature-vector distance",
    description=(
        "Given a seed material ID, fetches a corpus from the same element "
        "system and ranks candidates by MinMax-normalised cosine similarity "
        "over 7 numeric features. Returns per-feature match percentages "
        "for explainability."
    ),
)
async def find_similar(
    req: SimilarRequest,
    service: MaterialsService = Depends(get_service),
) -> list[SimilarResultResponse]:
    try:
        metric = SimilarityMetric(req.metric)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid metric '{req.metric}'. "
                   f"Choose: cosine, euclidean, weighted_cosine.",
        )
    results = service.find_similar(
        seed_id=req.seed_id.lower(),
        corpus_size=req.corpus_size,
        top_k=req.top_k,
        metric=metric,
        elements=req.elements or None,
    )
    if not results:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"Seed material '{req.seed_id}' not found or corpus is empty. "
                "Verify the ID and try a larger corpus_size."
            ),
        )
    return [similar_result_to_response(r) for r in results]