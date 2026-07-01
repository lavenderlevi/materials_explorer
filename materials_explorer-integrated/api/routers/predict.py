"""
/predict — ML property prediction from chemical formula.
/predict/status — Model training status and feature importances.

POST /api/v1/predict            — Predict band_gap, formation_energy, bulk_modulus.
GET  /api/v1/predict/status     — Model R², n_train, and training status.
GET  /api/v1/predict/importance — Feature importances for a target model.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from api.converters import predict_results_to_api
from api.dependencies import get_service
from api.models import PredictAPIResponse, PredictRequest
from search.ml_predict import FEATURE_NAMES, TARGET_UNITS, ElementFeaturizer
from search.service import MaterialsService

router = APIRouter()


@router.post(
    "/predict",
    response_model=PredictAPIResponse,
    summary="Predict material properties from formula",
    description=(
        "Runs three quantile Gradient Boosting Regressors (p10/p50/p90) to "
        "predict band gap (eV), formation energy (eV/atom), and bulk modulus (GPa). "
        "Returns 90% confidence intervals. Models must be trained before use — "
        "check /predict/status."
    ),
)
async def predict(
    req: PredictRequest,
    service: MaterialsService = Depends(get_service),
) -> PredictAPIResponse:
    # Validate formula before calling the potentially slow ML pipeline.
    try:
        ElementFeaturizer().featurize(req.formula)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid chemical formula '{req.formula}': {exc}",
        )

    preds = service.predict(req.formula)
    if all(v is None for v in preds.values()):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "No ML models are trained. "
                "Train models via the Streamlit UI (Page 4) or directly via "
                "MLPredictor.train_all() with a valid API key."
            ),
        )
    return predict_results_to_api(req.formula, preds)


@router.get(
    "/predict/status",
    summary="ML model training status",
)
async def predict_status(
    service: MaterialsService = Depends(get_service),
) -> dict:
    """Return training status, R², and n_train for all three models."""
    return {
        "targets": service._ml.model_status(),
        "feature_names": FEATURE_NAMES,
        "target_units": TARGET_UNITS,
    }


@router.get(
    "/predict/importance",
    summary="Feature importances for a trained model",
)
async def predict_importance(
    target: str = Query(
        description="One of: band_gap, formation_energy_per_atom, bulk_modulus"
    ),
    service: MaterialsService = Depends(get_service),
) -> dict:
    """Return ``{feature_name: importance}`` for the p50 model of *target*."""
    if target not in TARGET_UNITS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown target '{target}'. Choose: {list(TARGET_UNITS)}.",
        )
    imp = service._ml.feature_importances(target)
    if imp is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Model for '{target}' is not trained yet.",
        )
    return {"target": target, "importances": imp}