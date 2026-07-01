"""
Property Correlation Explorer for Materials Explorer.

Computes Pearson r and Spearman ρ between numeric material properties over
a corpus of MaterialDocuments.

Pairwise deletion strategy
--------------------------
For each property pair (A, B), only materials with non-None values for BOTH
A and B are used. This maximises statistical power per pair without discarding
any material from the corpus (list-wise deletion would eliminate most rows
when several properties are selected simultaneously).

New dependency: scipy>=1.13 (for pearsonr, spearmanr with p-values).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Final

import numpy as np
import pandas as pd

from .models import MaterialDocument

logger = logging.getLogger(__name__)

CORRELATABLE_PROPERTIES: Final[dict[str, str]] = {
    "band_gap":                  "Band Gap (eV)",
    "density":                   "Density (g/cm³)",
    "formation_energy_per_atom": "Formation Energy (eV/atom)",
    "energy_above_hull":         "E above Hull (eV/atom)",
    "volume":                    "Volume (Å³)",
    "nsites":                    "N Sites",
    "nelements":                 "N Elements",
}

_PROP_KEYS: Final[tuple[str, ...]] = tuple(CORRELATABLE_PROPERTIES.keys())


def corpus_to_dataframe(docs: list[MaterialDocument]) -> pd.DataFrame:
    """Convert a MaterialDocument corpus to a pandas DataFrame.

    Numeric fields map directly to columns; None → NaN.
    Boolean flags (is_stable, is_magnetic) are encoded as 0/1 integers
    and available for grouping but excluded from CORRELATABLE_PROPERTIES.
    """
    rows = []
    for doc in docs:
        row: dict = {
            "material_id": doc.material_id,
            "formula": doc.formula_pretty,
            "is_stable": int(doc.is_stable),
            "is_magnetic": int(doc.is_magnetic),
        }
        for prop in _PROP_KEYS:
            val = getattr(doc, prop, None)
            row[prop] = float(val) if val is not None else float("nan")
        rows.append(row)
    return pd.DataFrame(rows)


@dataclass
class CorrelationResult:
    """Complete Pearson + Spearman correlation analysis for a property set.

    All matrices have shape (N, N) where N = len(properties).
    NaN entries indicate insufficient valid pairs (< 3) for that pair.
    """

    properties: list[str]
    property_labels: list[str]         # Display labels (e.g. "Band Gap (eV)")
    pearson: np.ndarray                # (N, N) Pearson r
    spearman: np.ndarray               # (N, N) Spearman ρ
    p_values_pearson: np.ndarray       # (N, N) two-tailed p-values
    p_values_spearman: np.ndarray      # (N, N) two-tailed p-values
    n_pair_valid: dict[str, int]       # "prop_a|prop_b" → pairwise valid count
    n_corpus: int                      # total materials in the corpus DataFrame

    def strongest_pairs(
        self,
        method: str = "pearson",
        n: int = 15,
        min_valid: int = 5,
    ) -> list[dict]:
        """Return the top-n property pairs ranked by |r| for *method*.

        Parameters
        ----------
        method : "pearson" | "spearman"
        n : maximum pairs to return
        min_valid : exclude pairs with fewer than *min_valid* valid samples
        """
        matrix = self.pearson if method == "pearson" else self.spearman
        p_mat = self.p_values_pearson if method == "pearson" else self.p_values_spearman
        k = len(self.properties)
        pairs: list[dict] = []

        for i in range(k):
            for j in range(i + 1, k):
                pi, pj = self.properties[i], self.properties[j]
                nv = self.n_pair_valid.get(f"{pi}|{pj}", 0)
                if nv < min_valid:
                    continue
                r = float(matrix[i, j])
                if np.isnan(r):
                    continue
                p = float(p_mat[i, j])
                pairs.append({
                    "prop_a": pi,   "label_a": self.property_labels[i],
                    "prop_b": pj,   "label_b": self.property_labels[j],
                    "r": round(r, 4),
                    "p_value": round(p, 6),
                    "n_valid": nv,
                    "abs_r": abs(r),
                    "significant": p < 0.05,
                })

        pairs.sort(key=lambda x: x["abs_r"], reverse=True)
        return pairs[:n]


class CorrelationAnalyzer:
    """Computes Pearson + Spearman correlations over a MaterialDocument corpus.

    All computation is stateless — create one instance and call compute()
    repeatedly with different DataFrames or property sets without side effects.
    """

    def compute(
        self,
        df: pd.DataFrame,
        properties: list[str],
    ) -> CorrelationResult:
        """Compute full correlation matrices for *properties* over *df*.

        Parameters
        ----------
        df : DataFrame produced by ``corpus_to_dataframe``.
        properties : list of keys from CORRELATABLE_PROPERTIES to analyse.
        """
        from scipy import stats  # noqa: PLC0415

        sub = df[properties]
        n = len(properties)
        pearson_mat = np.full((n, n), np.nan, dtype=np.float64)
        spearman_mat = np.full((n, n), np.nan, dtype=np.float64)
        p_pearson = np.ones((n, n), dtype=np.float64)
        p_spearman = np.ones((n, n), dtype=np.float64)
        n_pair_valid: dict[str, int] = {}

        for i in range(n):
            pearson_mat[i, i] = 1.0
            spearman_mat[i, i] = 1.0
            p_pearson[i, i] = 0.0
            p_spearman[i, i] = 0.0

            for j in range(i + 1, n):
                pi, pj = properties[i], properties[j]
                valid = sub[[pi, pj]].dropna()
                nv = len(valid)
                n_pair_valid[f"{pi}|{pj}"] = nv
                n_pair_valid[f"{pj}|{pi}"] = nv

                if nv < 3:
                    logger.debug("(%s, %s): only %d valid samples — skipped.", pi, pj, nv)
                    continue

                x = valid[pi].to_numpy(dtype=np.float64)
                y = valid[pj].to_numpy(dtype=np.float64)

                try:
                    r_p, p_p = stats.pearsonr(x, y)
                    pearson_mat[i, j] = pearson_mat[j, i] = float(r_p)
                    p_pearson[i, j] = p_pearson[j, i] = float(p_p)
                except Exception:
                    logger.debug("pearsonr failed for (%s, %s).", pi, pj)

                try:
                    r_s, p_s = stats.spearmanr(x, y)
                    spearman_mat[i, j] = spearman_mat[j, i] = float(r_s)
                    p_spearman[i, j] = p_spearman[j, i] = float(p_s)
                except Exception:
                    logger.debug("spearmanr failed for (%s, %s).", pi, pj)

        labels = [CORRELATABLE_PROPERTIES.get(p, p) for p in properties]
        return CorrelationResult(
            properties=properties,
            property_labels=labels,
            pearson=pearson_mat,
            spearman=spearman_mat,
            p_values_pearson=p_pearson,
            p_values_spearman=p_spearman,
            n_pair_valid=n_pair_valid,
            n_corpus=len(df),
        )