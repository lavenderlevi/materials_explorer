"""
/correlation — Property correlation analysis.

POST /api/v1/correlation — Pearson + Spearman matrices over a fetched corpus.
"""
from __future__ import annotations
import logging
import math
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from api.dependencies import get_service
from api.models import MaterialResponse
from api.converters import material_to_response
from search.correlation import CorrelationAnalyzer, CORRELATABLE_PROPERTIES, corpus_to_dataframe
from search.models import SUMMARY_FIELDS
from search.service import MaterialsService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/correlation")

VALID_PROPS = set(CORRELATABLE_PROPERTIES.keys())


class CorrelationRequest(BaseModel):
    elements: list[str] = Field(min_length=1)
    properties: list[str] = Field(min_length=2, max_length=7)
    stability_filter: bool = False
    corpus_size: int = Field(default=200, ge=20, le=500)
    method: str = Field(default="both", pattern="^(pearson|spearman|both)$")
    min_valid: int = Field(default=10, ge=3, le=200)


class MatrixResponse(BaseModel):
    properties: list[str]
    property_labels: list[str]
    pearson: list[list[float | None]]
    spearman: list[list[float | None]]
    p_values_pearson: list[list[float | None]]
    p_values_spearman: list[list[float | None]]
    n_pair_valid: dict[str, int]
    n_corpus: int


class CorpusRowResponse(BaseModel):
    material_id: str
    formula: str
    is_stable: bool
    band_gap: float | None
    density: float | None
    formation_energy_per_atom: float | None
    energy_above_hull: float | None
    volume: float | None
    nsites: float | None
    nelements: float | None


class CorrelationResponse(BaseModel):
    result: MatrixResponse
    rows: list[CorpusRowResponse]
    n_corpus: int


def _nan_to_none(v: float) -> float | None:
    """Convert NaN → None for JSON serialization."""
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


def _matrix_to_json(mat) -> list[list[float | None]]:
    return [[_nan_to_none(float(v)) for v in row] for row in mat]


@router.post(
    "",
    response_model=CorrelationResponse,
    summary="Pairwise property correlation analysis",
    description=(
        "Fetches a corpus filtered by elements, computes Pearson r and "
        "Spearman ρ for each selected property pair using pairwise deletion. "
        "Returns full NxN matrices plus raw corpus rows for scatter plots."
    ),
)
async def compute_correlation(
    req: CorrelationRequest,
    service: MaterialsService = Depends(get_service),
) -> CorrelationResponse:
    # Validate properties
    invalid = [p for p in req.properties if p not in VALID_PROPS]
    if invalid:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown properties: {invalid}. Valid: {list(VALID_PROPS)}",
        )

    # Fetch corpus
    filters: dict = {"elements": req.elements}
    if req.stability_filter:
        filters["energy_above_hull"] = (None, 0.0)
    corpus = service._client.search(fields=SUMMARY_FIELDS, **filters)[:req.corpus_size]
    if len(corpus) < 3:
        raise HTTPException(
            status_code=404,
            detail="Fewer than 3 materials found. Try different elements.",
        )

    # Compute
    df = corpus_to_dataframe(corpus)
    result = CorrelationAnalyzer().compute(df=df, properties=req.properties)

    # Build corpus rows for scatter matrix
    rows = []
    for _, row in df.iterrows():
        rows.append(CorpusRowResponse(
            material_id=row["material_id"],
            formula=row["formula"],
            is_stable=bool(row["is_stable"]),
            band_gap=_nan_to_none(row.get("band_gap")),
            density=_nan_to_none(row.get("density")),
            formation_energy_per_atom=_nan_to_none(row.get("formation_energy_per_atom")),
            energy_above_hull=_nan_to_none(row.get("energy_above_hull")),
            volume=_nan_to_none(row.get("volume")),
            nsites=_nan_to_none(row.get("nsites")),
            nelements=_nan_to_none(row.get("nelements")),
        ))

    matrix = MatrixResponse(
        properties=result.properties,
        property_labels=result.property_labels,
        pearson=_matrix_to_json(result.pearson),
        spearman=_matrix_to_json(result.spearman),
        p_values_pearson=_matrix_to_json(result.p_values_pearson),
        p_values_spearman=_matrix_to_json(result.p_values_spearman),
        n_pair_valid=result.n_pair_valid,
        n_corpus=result.n_corpus,
    )

    return CorrelationResponse(result=matrix, rows=rows, n_corpus=result.n_corpus)
