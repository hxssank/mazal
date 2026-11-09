from __future__ import annotations

import warnings
from typing import Any

import numpy as np


def fit_local_level(training: np.ndarray, count: int) -> tuple[np.ndarray | None, dict[str, Any]]:
    from statsmodels.tsa.statespace.structural import UnobservedComponents

    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            fitted = UnobservedComponents(training, level="local level").fit(disp=False, maxiter=100)
        prediction = np.asarray(fitted.forecast(count), dtype=float)
        converged = bool(fitted.mle_retvals.get("converged", False))
        diagnostic = {
            "library": "statsmodels",
            "model": "local_level",
            "converged": converged,
            "warnings": list(dict.fromkeys(str(item.message) for item in caught)),
            "aic": float(fitted.aic) if np.isfinite(fitted.aic) else None,
        }
        if not converged or not np.all(np.isfinite(prediction)):
            diagnostic["limitation"] = "The local-level fit did not converge to a finite forecast."
            return None, diagnostic
        return np.maximum(0, prediction), diagnostic
    except (ValueError, np.linalg.LinAlgError) as error:
        return None, {
            "library": "statsmodels",
            "model": "local_level",
            "converged": False,
            "limitation": str(error),
        }
