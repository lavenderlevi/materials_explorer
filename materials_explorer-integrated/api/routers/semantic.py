"""
/semantic — AI semantic search over a fetched corpus.

POST /api/v1/semantic — Embed query + corpus; return cosine-ranked results.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from api.converters import semantic_result_to_response
from api.dependencies import get_service
from api.models import SemanticResultResponse, SemanticSearchRequest
from search.service import MaterialsService

router = APIRouter()


@router.post(
    "/semantic",
    response_model=list[SemanticResultResponse],
    summary="Semantic material search",
    description=(
        "Fetches a corpus (filtered by element) then ranks materials "
        "by cosine similarity between their embedded description and the "
        "embedded query. Uses ``all-MiniLM-L6-v2`` (SentenceTransformer) "
        "when available; falls back to TF-IDF + SVD otherwise."
    ),
)
async def semantic_search(
    req: SemanticSearchRequest,
    service: MaterialsService = Depends(get_service),
) -> list[SemanticResultResponse]:
    if not req.elements:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="At least one element is required to bound the corpus size.",
        )
    results = service.semantic_search(
        query=req.query,
        elements=req.elements,
        top_k=req.top_k,
        corpus_size=req.corpus_size,
        stability_only=req.stability_only,
    )
    if not results:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No materials found. Try different elements or a larger corpus_size.",
        )
    return [semantic_result_to_response(r) for r in results]