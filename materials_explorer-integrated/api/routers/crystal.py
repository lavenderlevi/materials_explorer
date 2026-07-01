"""
/crystal  — Crystal structure similarity search.

POST /api/v1/crystal/fingerprint  — Fast 19-dim fingerprint cosine search.
POST /api/v1/crystal/matcher      — Exact pymatgen StructureMatcher search.
GET  /api/v1/crystal/seed/{id}    — Fetch seed material summary.
"""
from __future__ import annotations
import logging
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from api.converters import material_to_response
from api.dependencies import get_service, get_settings
from api.models import MaterialResponse
from search.models import SUMMARY_FIELDS
from search.service import MaterialsService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/crystal")


# ── Request models ────────────────────────────────────────────────────────────

class FingerprintRequest(BaseModel):
    seed_id: str = Field(min_length=1)
    top_k: int = Field(default=8, ge=1, le=30)
    elements: list[str] = Field(default_factory=list)
    corpus_size: int = Field(default=30, ge=5, le=80)
    stability_filter: bool = False


class MatcherRequest(BaseModel):
    seed_id: str = Field(min_length=1)
    top_k: int = Field(default=5, ge=1, le=20)
    elements: list[str] = Field(default_factory=list)
    corpus_ids: list[str] = Field(default_factory=list)
    max_corpus: int = Field(default=15, ge=5, le=30)
    ltol: float = Field(default=0.20, ge=0.01, le=0.50)
    stol: float = Field(default=0.30, ge=0.05, le=0.80)
    angle_tol: float = Field(default=5.0, ge=1.0, le=20.0)


# ── Response models ───────────────────────────────────────────────────────────

class CrystalResultResponse(BaseModel):
    material_id: str
    formula: str
    similarity_score: float
    rank: int
    crystal_system: str | None
    spacegroup: str | None
    search_mode: str


class CrystalSearchResponse(BaseModel):
    seed: MaterialResponse
    results: list[CrystalResultResponse]
    corpus_fetched: int
    corpus_total: int
    mode: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def _build_crystal_engine(settings):
    """Lazy-build CrystalSimilarityEngine (pymatgen optional dep)."""
    from search.crystal import StructureClient, StructureStore, CrystalSimilarityEngine
    store = StructureStore(db_path=settings.db_path)
    client = StructureClient(api_key=settings.mp_api_key, store=store)
    return CrystalSimilarityEngine(store=store), client


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get(
    "/seed/{material_id}",
    response_model=MaterialResponse,
    summary="Fetch seed material summary",
)
async def get_seed(
    material_id: str,
    service: MaterialsService = Depends(get_service),
) -> MaterialResponse:
    doc = service._client.get_by_id(material_id.lower(), fields=SUMMARY_FIELDS)
    if doc is None:
        raise HTTPException(status_code=404, detail=f"'{material_id}' not found.")
    return material_to_response(doc)


@router.post(
    "/fingerprint",
    response_model=CrystalSearchResponse,
    summary="Fast fingerprint-based crystal similarity",
)
async def crystal_fingerprint(
    req: FingerprintRequest,
    service: MaterialsService = Depends(get_service),
    settings=Depends(get_settings),
) -> CrystalSearchResponse:
    seed_doc = service._client.get_by_id(req.seed_id.lower(), fields=SUMMARY_FIELDS)
    if seed_doc is None:
        raise HTTPException(status_code=404, detail=f"Seed '{req.seed_id}' not found.")

    try:
        engine, struct_client = _build_crystal_engine(settings)
    except ImportError:
        raise HTTPException(status_code=503, detail="pymatgen not installed.")

    # Build corpus
    elements = req.elements or list(seed_doc.elements)
    filters: dict = {"elements": elements}
    if req.stability_filter:
        filters["energy_above_hull"] = (None, 0.0)
    corpus_docs = service._client.search(fields=SUMMARY_FIELDS, **filters)[:req.corpus_size]
    corpus_ids = [d.material_id for d in corpus_docs if d.material_id != req.seed_id.lower()]

    seed_struct = struct_client.get_structure(req.seed_id.lower())
    if seed_struct is None:
        raise HTTPException(status_code=404, detail=f"Structure for '{req.seed_id}' unavailable.")

    corpus_structs = struct_client.get_structures_batch(corpus_ids)
    results_raw = engine.fingerprint_search(
        seed=seed_struct, seed_id=req.seed_id.lower(),
        corpus=corpus_structs, top_k=req.top_k,
    )

    results = [
        CrystalResultResponse(
            material_id=r.material_id, formula=r.formula,
            similarity_score=r.similarity_score, rank=r.rank,
            crystal_system=r.crystal_system, spacegroup=r.spacegroup,
            search_mode="fingerprint",
        )
        for r in results_raw
    ]
    return CrystalSearchResponse(
        seed=material_to_response(seed_doc),
        results=results,
        corpus_fetched=len(corpus_structs),
        corpus_total=len(corpus_docs),
        mode="fingerprint",
    )


@router.post(
    "/matcher",
    response_model=CrystalSearchResponse,
    summary="Exact StructureMatcher crystal similarity",
)
async def crystal_matcher(
    req: MatcherRequest,
    service: MaterialsService = Depends(get_service),
    settings=Depends(get_settings),
) -> CrystalSearchResponse:
    seed_doc = service._client.get_by_id(req.seed_id.lower(), fields=SUMMARY_FIELDS)
    if seed_doc is None:
        raise HTTPException(status_code=404, detail=f"Seed '{req.seed_id}' not found.")

    try:
        engine, struct_client = _build_crystal_engine(settings)
    except ImportError:
        raise HTTPException(status_code=503, detail="pymatgen not installed.")

    if req.corpus_ids:
        corpus_ids = [i.lower() for i in req.corpus_ids if i.lower() != req.seed_id.lower()]
        corpus_total = len(corpus_ids)
    else:
        elements = req.elements or list(seed_doc.elements)
        corpus_docs = service._client.search(fields=SUMMARY_FIELDS, elements=elements)[:req.max_corpus]
        corpus_ids = [d.material_id for d in corpus_docs if d.material_id != req.seed_id.lower()]
        corpus_total = len(corpus_docs)

    seed_struct = struct_client.get_structure(req.seed_id.lower())
    if seed_struct is None:
        raise HTTPException(status_code=404, detail=f"Structure for '{req.seed_id}' unavailable.")

    corpus_structs = struct_client.get_structures_batch(corpus_ids[:req.max_corpus])

    results_raw = engine.matcher_search(
        seed=seed_struct, seed_id=req.seed_id.lower(),
        corpus=corpus_structs, top_k=req.top_k,
        ltol=req.ltol, stol=req.stol, angle_tol=req.angle_tol,
    )

    results = [
        CrystalResultResponse(
            material_id=r.material_id, formula=r.formula,
            similarity_score=r.similarity_score, rank=r.rank,
            crystal_system=r.crystal_system, spacegroup=r.spacegroup,
            search_mode="structure_matcher",
        )
        for r in results_raw
    ]
    return CrystalSearchResponse(
        seed=material_to_response(seed_doc),
        results=results,
        corpus_fetched=len(corpus_structs),
        corpus_total=corpus_total,
        mode="structure_matcher",
    )
