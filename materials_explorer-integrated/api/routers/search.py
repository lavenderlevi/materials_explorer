"""
/search — Intent-based material search.

POST /api/v1/search            — Full ranked search pipeline.
GET  /api/v1/search?q=Silicon  — Convenience alias via query param.
GET  /api/v1/materials/{id}    — Direct material ID lookup.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from api.converters import material_to_response, search_response_to_api
from api.dependencies import get_service
from api.models import MaterialResponse, SearchAPIResponse, SearchRequest
from search.models import SUMMARY_FIELDS
from search.service import MaterialsService

router = APIRouter()


@router.post(
    "/search",
    response_model=SearchAPIResponse,
    summary="Full ranked search",
    description=(
        "Accepts a natural-language or structured query. "
        "IntentParser classifies the query and routes to the appropriate "
        "search strategy. Results are scored by the 5-component ranker."
    ),
)
async def search_post(
    req: SearchRequest,
    service: MaterialsService = Depends(get_service),
) -> SearchAPIResponse:
    resp = service.search(req.query)
    return search_response_to_api(resp)


@router.get(
    "/search",
    response_model=SearchAPIResponse,
    summary="Search (GET convenience alias)",
)
async def search_get(
    q: str = Query(min_length=1, max_length=500, description="Search query string."),
    top_k: int = Query(default=10, ge=1, le=50),
    service: MaterialsService = Depends(get_service),
) -> SearchAPIResponse:
    resp = service.search(q)
    if resp.results:
        resp = resp.model_copy(update={"results": resp.results[:top_k]})
    return search_response_to_api(resp)


@router.get(
    "/materials/{material_id}",
    response_model=MaterialResponse,
    summary="Direct material lookup by MP ID",
)
async def get_material(
    material_id: str,
    service: MaterialsService = Depends(get_service),
) -> MaterialResponse:
    """Fetch a single material by Materials Project ID (e.g. ``mp-149``)."""
    doc = service._client.get_by_id(material_id.lower(), fields=SUMMARY_FIELDS)
    if doc is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Material '{material_id}' not found in the Materials Project.",
        )
    return material_to_response(doc)