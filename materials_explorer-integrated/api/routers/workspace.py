"""
/workspace — Saved searches, comparison sets, and dataset export.

Saved Searches:
    GET    /workspace/searches                  — list all
    POST   /workspace/searches                  — run + save a search
    POST   /workspace/searches/{id}/run         — re-run a saved search
    DELETE /workspace/searches/{id}             — delete

Comparison Sets:
    GET    /workspace/sets                      — list all
    POST   /workspace/sets                      — create new set
    POST   /workspace/sets/{id}/items           — add material (fetched from MP)
    DELETE /workspace/sets/{id}/items/{mid}     — remove material
    DELETE /workspace/sets/{id}                 — delete set (cascade items)

Export:
    POST   /workspace/export                    — download CSV / JSON / Excel
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response

from api.converters import (
    cset_to_response,
    saved_search_to_response,
    search_response_to_api,
)
from api.dependencies import get_service
from api.models import (
    AddToSetRequest,
    ComparisonSetResponse,
    CreateSetRequest,
    ExportRequest,
    MessageResponse,
    SavedSearchResponse,
    SaveSearchRequest,
    SearchAPIResponse,
    WorkspaceStatsResponse,
)
from search.models import SUMMARY_FIELDS
from search.service import MaterialsService

router = APIRouter(prefix="/workspace")

_MIME: dict[str, str] = {
    "csv":   "text/csv",
    "json":  "application/json",
    "excel": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xlsx":  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
_EXT: dict[str, str] = {"csv": "csv", "json": "json", "excel": "xlsx", "xlsx": "xlsx"}


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------


@router.get("/stats", response_model=WorkspaceStatsResponse, summary="Workspace statistics")
async def workspace_stats(service: MaterialsService = Depends(get_service)) -> WorkspaceStatsResponse:
    return WorkspaceStatsResponse(**service.workspace.store.workspace_stats())


# ---------------------------------------------------------------------------
# Saved Searches
# ---------------------------------------------------------------------------


@router.get(
    "/searches",
    response_model=list[SavedSearchResponse],
    summary="List all saved searches",
)
async def list_saved_searches(
    service: MaterialsService = Depends(get_service),
) -> list[SavedSearchResponse]:
    return [saved_search_to_response(s) for s in service.workspace.store.get_saved_searches()]


@router.post(
    "/searches",
    response_model=SavedSearchResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Run a search and save it",
)
async def save_search(
    req: SaveSearchRequest,
    service: MaterialsService = Depends(get_service),
) -> SavedSearchResponse:
    """Execute the search, then persist it. Returns the saved search record."""
    resp = service.search(req.query)
    if not resp.results:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Search returned no results — not saved.",
        )
    result_ids = [r.material.material_id for r in resp.results]
    name = req.name or req.query[:50]
    sid = service.workspace.store.save_search(
        name=name, raw_query=req.query,
        parsed_query=resp.query, result_ids=result_ids,
    )
    saved = next(
        s for s in service.workspace.store.get_saved_searches() if s.id == sid
    )
    return saved_search_to_response(saved)


@router.post(
    "/searches/{search_id}/run",
    response_model=SearchAPIResponse,
    summary="Re-run a saved search",
)
async def rerun_saved_search(
    search_id: int,
    service: MaterialsService = Depends(get_service),
) -> SearchAPIResponse:
    """Re-execute the saved query and update last_run_at."""
    saved = next(
        (s for s in service.workspace.store.get_saved_searches() if s.id == search_id),
        None,
    )
    if saved is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail=f"Saved search {search_id} not found.")
    resp = service.search(saved.raw_query)
    service.workspace.store.update_last_run(search_id)
    return search_response_to_api(resp)


@router.delete(
    "/searches/{search_id}",
    response_model=MessageResponse,
    summary="Delete a saved search",
)
async def delete_saved_search(
    search_id: int,
    service: MaterialsService = Depends(get_service),
) -> MessageResponse:
    service.workspace.store.delete_saved_search(search_id)
    return MessageResponse(message=f"Saved search {search_id} deleted.")


# ---------------------------------------------------------------------------
# Comparison Sets
# ---------------------------------------------------------------------------


@router.get(
    "/sets",
    response_model=list[ComparisonSetResponse],
    summary="List all comparison sets",
)
async def list_comparison_sets(
    service: MaterialsService = Depends(get_service),
) -> list[ComparisonSetResponse]:
    return [cset_to_response(cs) for cs in service.workspace.store.get_comparison_sets()]


@router.post(
    "/sets",
    response_model=ComparisonSetResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new comparison set",
)
async def create_comparison_set(
    req: CreateSetRequest,
    service: MaterialsService = Depends(get_service),
) -> ComparisonSetResponse:
    sid = service.workspace.store.create_comparison_set(req.name, req.notes)
    cs = next(cs for cs in service.workspace.store.get_comparison_sets() if cs.id == sid)
    return cset_to_response(cs)


@router.post(
    "/sets/{set_id}/items",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Add a material to a comparison set",
)
async def add_to_set(
    set_id: int,
    req: AddToSetRequest,
    service: MaterialsService = Depends(get_service),
) -> MessageResponse:
    """Fetch material from MP API, then add to the comparison set."""
    doc = service._client.get_by_id(req.material_id.lower(), fields=SUMMARY_FIELDS)
    if doc is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Material '{req.material_id}' not found.",
        )
    added = service.workspace.store.add_to_set(set_id, doc)
    if not added:
        return MessageResponse(
            message=f"'{req.material_id}' is already in set {set_id}.",
            success=False,
        )
    return MessageResponse(message=f"Added '{req.material_id}' to set {set_id}.")


@router.delete(
    "/sets/{set_id}/items/{material_id}",
    response_model=MessageResponse,
    summary="Remove a material from a comparison set",
)
async def remove_from_set(
    set_id: int,
    material_id: str,
    service: MaterialsService = Depends(get_service),
) -> MessageResponse:
    service.workspace.store.remove_from_set(set_id, material_id.lower())
    return MessageResponse(message=f"Removed '{material_id}' from set {set_id}.")


@router.delete(
    "/sets/{set_id}",
    response_model=MessageResponse,
    summary="Delete a comparison set (cascade deletes all items)",
)
async def delete_comparison_set(
    set_id: int,
    service: MaterialsService = Depends(get_service),
) -> MessageResponse:
    service.workspace.store.delete_comparison_set(set_id)
    return MessageResponse(message=f"Comparison set {set_id} deleted.")


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


@router.post(
    "/export",
    summary="Export a comparison set to CSV / JSON / Excel",
    response_class=Response,
)
async def export_dataset(
    req: ExportRequest,
    service: MaterialsService = Depends(get_service),
) -> Response:
    """Serialize all materials in a comparison set to the requested format.

    Returns binary file data with appropriate Content-Type and
    Content-Disposition headers for direct browser download.
    """
    csets = service.workspace.store.get_comparison_sets()
    target = next((cs for cs in csets if cs.id == req.set_id), None)
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Comparison set {req.set_id} not found.",
        )
    docs = [item.document for item in target.items]
    if not docs:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Comparison set is empty — add materials before exporting.",
        )
    try:
        data = service.workspace.export(
            docs=docs, fmt=req.fmt,
            columns=req.columns,
            query_text=f"set:{target.name}",
        )
    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Excel export requires openpyxl: pip install openpyxl",
        )

    fmt = req.fmt.lower()
    filename = f"materials_{target.name.replace(' ', '_')}.{_EXT.get(fmt, fmt)}"
    return Response(
        content=data,
        media_type=_MIME.get(fmt, "application/octet-stream"),
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )