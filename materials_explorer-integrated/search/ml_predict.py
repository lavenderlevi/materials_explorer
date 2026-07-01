"""
ML Prediction module for Materials Explorer.

Three GradientBoostingRegressor models trained on Materials Project data:
  - band_gap               (eV)      — trained on summary endpoint
  - formation_energy_per_atom (eV/atom) — trained on summary endpoint
  - bulk_modulus           (GPa)     — trained on elasticity endpoint

Feature engineering
-------------------
ElementFeaturizer converts any chemical formula to an 11-dimensional
composition-fraction-weighted statistics vector using pymatgen:
  Z, X (electronegativity), atomic_radius, row, group  →  mean + std each
  + n_elements  =  11 features total.

Confidence intervals
--------------------
Three independently trained quantile GBRs (α = 0.10, 0.50, 0.90) per target.
Quantile crossing is corrected post-prediction:
    ci_low  = min(p10, p50)
    ci_high = max(p50, p90)

Model persistence: joblib files in ``model_dir`` (default: ``./models/``).
Training is triggered lazily on first predict() call when no saved model
exists on disk, provided an api_key is available.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import joblib
import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

FEATURE_NAMES: Final[list[str]] = [
    "Z_mean", "Z_std",
    "X_mean", "X_std",
    "radius_mean", "radius_std",
    "row_mean", "row_std",
    "group_mean", "group_std",
    "n_elements",
]
_N_FEATURES: Final[int] = len(FEATURE_NAMES)

TARGET_UNITS: Final[dict[str, str]] = {
    "band_gap": "eV",
    "formation_energy_per_atom": "eV/atom",
    "bulk_modulus": "GPa",
}
_TARGETS: Final[tuple[str, ...]] = tuple(TARGET_UNITS.keys())
_DEFAULT_N_TRAIN: Final[int] = 500


def _safe_float(val: object, default: float = 0.0) -> float:
    """Convert *val* to float, returning *default* on None or conversion failure."""
    if val is None:
        return default
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Feature engineering
# ---------------------------------------------------------------------------


class ElementFeaturizer:
    """Converts a chemical formula to a fixed-dim composition-stats feature vector.

    The 11 features are composition-fraction-weighted mean and standard
    deviation of five elemental properties (Z, X, atomic_radius, row, group)
    plus element count. This produces a stable, interpretable representation
    for any valid chemical formula without one-hot encoding or vocabulary limits.
    """

    _PROPS: Final[tuple[str, ...]] = ("Z", "X", "atomic_radius", "row", "group")

    def featurize(self, formula: str) -> np.ndarray:
        """Return an (11,) float32 feature vector for *formula*.

        Raises
        ------
        ValueError
            If *formula* cannot be parsed by pymatgen Composition.
        """
        from pymatgen.core import Composition  # lazy — already a project dep

        try:
            comp = Composition(formula)
        except Exception as exc:
            raise ValueError(f"Cannot parse formula {formula!r}: {exc}") from exc

        els = list(comp.elements)
        fracs = np.array(
            [comp.get_atomic_fraction(el) for el in els], dtype=np.float64
        )
        fracs /= fracs.sum()  # re-normalize against float rounding

        # Fallback for atomic_radius: prefer reported value, then calculated
        def _radius(el: object) -> float:
            r = _safe_float(getattr(el, "atomic_radius", None))
            return r if r > 0.0 else _safe_float(
                getattr(el, "atomic_radius_calculated", None), default=1.5
            )

        raw: list[np.ndarray] = [
            np.array([_safe_float(getattr(el, "Z", None)) for el in els]),
            np.array([_safe_float(getattr(el, "X", None)) for el in els]),
            np.array([_radius(el) for el in els]),
            np.array([_safe_float(getattr(el, "row", None)) for el in els]),
            np.array([_safe_float(getattr(el, "group", None)) for el in els]),
        ]

        feats: list[float] = []
        for vals in raw:
            mean = float(np.dot(fracs, vals))
            std = float(np.sqrt(np.clip(np.dot(fracs, (vals - mean) ** 2), 0.0, None)))
            feats.extend([mean, std])
        feats.append(float(len(els)))

        return np.array(feats, dtype=np.float32)


# ---------------------------------------------------------------------------
# Quantile GBR — wraps 3 sklearn models per target
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PredictionResult:
    """Prediction for one target property with 90% confidence interval."""
    target: str
    value: float            # p50 (median) prediction
    ci_low: float           # p10 lower bound
    ci_high: float          # p90 upper bound
    unit: str
    n_train: int
    r2_score: float


class QuantileGBR:
    """Three GradientBoostingRegressors at α = 0.10, 0.50, 0.90 for one target.

    Quantile crossing is corrected in predict() by clamping.
    The p50 model uses more estimators than p10/p90 for better point accuracy.
    """

    def __init__(self, target: str, n_estimators: int = 200) -> None:
        from sklearn.ensemble import GradientBoostingRegressor

        self.target = target
        self.n_train: int = 0
        self.r2: float = 0.0
        n_side = max(50, n_estimators // 3)
        self._models = {
            "p10": GradientBoostingRegressor(
                loss="quantile", alpha=0.10, n_estimators=n_side,
                max_depth=4, learning_rate=0.05, random_state=42,
            ),
            "p50": GradientBoostingRegressor(
                loss="quantile", alpha=0.50, n_estimators=n_estimators,
                max_depth=4, learning_rate=0.05, random_state=42,
            ),
            "p90": GradientBoostingRegressor(
                loss="quantile", alpha=0.90, n_estimators=n_side,
                max_depth=4, learning_rate=0.05, random_state=42,
            ),
        }

    def fit(self, X: np.ndarray, y: np.ndarray) -> "QuantileGBR":
        """Train on (X, y); compute held-out R² on 20% validation split."""
        from sklearn.metrics import r2_score
        from sklearn.model_selection import train_test_split

        X_tr, X_val, y_tr, y_val = train_test_split(
            X, y, test_size=0.20, random_state=42
        )
        for m in self._models.values():
            m.fit(X_tr, y_tr)
        self.r2 = float(r2_score(y_val, self._models["p50"].predict(X_val)))
        self.n_train = len(X_tr)
        logger.info("Trained %-32s n=%d R²=%.3f", self.target, self.n_train, self.r2)
        return self

    def predict(self, x: np.ndarray) -> tuple[float, float, float]:
        """Return (ci_low, value, ci_high) for a single sample *x* (shape: (F,))."""
        xr = x.reshape(1, -1)
        p10 = float(self._models["p10"].predict(xr)[0])
        p50 = float(self._models["p50"].predict(xr)[0])
        p90 = float(self._models["p90"].predict(xr)[0])
        # Correct potential quantile crossing from independently trained models.
        return min(p10, p50), p50, max(p50, p90)

    @property
    def feature_importances_(self) -> np.ndarray:
        return self._models["p50"].feature_importances_


# ---------------------------------------------------------------------------
# MLPredictor — orchestrates all three targets
# ---------------------------------------------------------------------------


class MLPredictor:
    """Manages training, inference, and persistence for all three ML models.

    Parameters
    ----------
    model_dir:
        Directory for joblib files. Created if absent.
    api_key:
        MP API key for training data fetch. Not required if models
        are already persisted on disk.
    n_train:
        Maximum training samples per model. Higher → better R², slower.
    """

    _FILENAME: Final[str] = "qgbr_{target}.joblib"

    def __init__(
        self,
        model_dir: Path = Path("models"),
        api_key: str | None = None,
        n_train: int = _DEFAULT_N_TRAIN,
    ) -> None:
        self._dir = Path(model_dir)
        self._api_key = api_key
        self._n_train = n_train
        self._models: dict[str, QuantileGBR] = {}
        self._dir.mkdir(parents=True, exist_ok=True)
        self._load_all()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def predict(self, formula: str) -> dict[str, PredictionResult | None]:
        """Predict all three targets for *formula*.

        Triggers lazy training if a model is missing and ``api_key`` is set.
        Returns ``None`` for a target if unavailable.
        """
        featurizer = ElementFeaturizer()
        try:
            feat = featurizer.featurize(formula)
        except ValueError as exc:
            logger.error("Featurization failed for %r: %s", formula, exc)
            return {t: None for t in _TARGETS}

        results: dict[str, PredictionResult | None] = {}
        for target in _TARGETS:
            if target not in self._models:
                if self._api_key:
                    try:
                        self._train_one(target)
                    except Exception:
                        logger.exception("Training failed for '%s'.", target)
                        results[target] = None
                        continue
                else:
                    results[target] = None
                    continue

            model = self._models[target]
            lo, p50, hi = model.predict(feat)
            results[target] = PredictionResult(
                target=target,
                value=round(p50, 4), ci_low=round(lo, 4), ci_high=round(hi, 4),
                unit=TARGET_UNITS[target], n_train=model.n_train,
                r2_score=round(model.r2, 4),
            )
        return results

    def model_status(self) -> dict[str, dict]:
        """Return ``{target: {trained, n_train, r2, file_exists}}`` for all targets."""
        status = {}
        for t in _TARGETS:
            if t in self._models:
                m = self._models[t]
                status[t] = {"trained": True, "n_train": m.n_train, "r2": round(m.r2, 3)}
            else:
                path = self._dir / self._FILENAME.format(target=t)
                status[t] = {"trained": False, "file_exists": path.exists()}
        return status

    def feature_importances(self, target: str) -> dict[str, float] | None:
        """Return ``{feature_name: importance}`` for *target*'s p50 model."""
        model = self._models.get(target)
        if model is None:
            return None
        return dict(zip(FEATURE_NAMES, model.feature_importances_.tolist()))

    def train_all(self) -> None:
        """Train all three models sequentially. Requires ``api_key``."""
        if not self._api_key:
            raise RuntimeError("api_key is required for training.")
        for target in _TARGETS:
            self._train_one(target)

    # ------------------------------------------------------------------
    # Training
    # ------------------------------------------------------------------

    def _train_one(self, target: str) -> None:
        logger.info("Fetching training data for '%s' (n≤%d)…", target, self._n_train)
        X, y = self._fetch_training_data(target)
        if len(X) < 20:
            raise RuntimeError(
                f"Only {len(X)} valid training samples for '{target}' — need ≥ 20."
            )
        model = QuantileGBR(target=target)
        model.fit(X, y)
        self._models[target] = model
        self._save(target, model)

    def _fetch_training_data(self, target: str) -> tuple[np.ndarray, np.ndarray]:
        from mp_api.client import MPRester  # noqa: PLC0415

        featurizer = ElementFeaturizer()
        X_list: list[np.ndarray] = []
        y_list: list[float] = []

        if target in ("band_gap", "formation_energy_per_atom"):
            with MPRester(self._api_key) as mpr:
                docs = mpr.materials.summary.search(
                    fields=["material_id", "formula_pretty", target],
                    energy_above_hull=(None, 0.5),   # near-stable — practical materials
                    nelements=(2, 5),                # binary–quinary compounds
                )
            for doc in docs:
                if len(X_list) >= self._n_train:
                    break
                val = getattr(doc, target, None)
                if val is None:
                    continue
                try:
                    X_list.append(featurizer.featurize(str(doc.formula_pretty)))
                    y_list.append(float(val))
                except ValueError:
                    continue

        else:  # bulk_modulus — elasticity endpoint
            with MPRester(self._api_key) as mpr:
                docs = mpr.materials.elasticity.search(
                    fields=["material_id", "formula_pretty", "bulk_modulus"],
                )
            for doc in docs:
                if len(X_list) >= self._n_train:
                    break
                bm_raw = getattr(doc, "bulk_modulus", None)
                if bm_raw is None:
                    continue
                bm = (bm_raw.get("vrh") if isinstance(bm_raw, dict)
                      else getattr(bm_raw, "vrh", None))
                if bm is None:
                    continue
                try:
                    X_list.append(featurizer.featurize(str(doc.formula_pretty)))
                    y_list.append(float(bm))
                except ValueError:
                    continue

        if not X_list:
            raise RuntimeError(f"No valid training samples found for target '{target}'.")
        return np.array(X_list, dtype=np.float32), np.array(y_list, dtype=np.float32)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _save(self, target: str, model: QuantileGBR) -> None:
        path = self._dir / self._FILENAME.format(target=target)
        joblib.dump(model, path)
        logger.info("Saved model '%s' → %s", target, path)

    def _load_all(self) -> None:
        for target in _TARGETS:
            path = self._dir / self._FILENAME.format(target=target)
            if path.exists():
                try:
                    self._models[target] = joblib.load(path)
                    logger.info("Loaded model '%s' from %s.", target, path)
                except Exception:
                    logger.exception("Failed to load model '%s' — will retrain.", target)