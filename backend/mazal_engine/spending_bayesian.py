from __future__ import annotations

from typing import Any

import numpy as np


def fit_bayesian(training: np.ndarray, seed: int) -> tuple[np.ndarray | None, dict[str, Any]]:
    import arviz as az
    import pymc as pm

    center = float(np.median(training))
    scale = max(100.0, float(np.std(training)), abs(center) / 2)
    diagnostic: dict[str, Any] = {
        "library": "PyMC",
        "model": "student_t_location_scale",
        "seed": seed,
        "prior": {
            "mu": {"distribution": "Normal", "meanCents": center, "sigmaCents": scale * 2},
            "sigma": {"distribution": "HalfNormal", "sigmaCents": scale},
            "nu": 4,
        },
        "priorNote": "Prior scales use training data only. This is an empirical Bayes spending model.",
        "chains": 4,
        "drawsPerChain": 400,
        "tunePerChain": 400,
    }
    try:
        with pm.Model():
            mu = pm.Normal("mu", mu=center, sigma=scale * 2)
            sigma = pm.HalfNormal("sigma", sigma=scale)
            pm.StudentT("spending", nu=4, mu=mu, sigma=sigma, observed=training)
            trace = pm.sample(
                draws=400,
                tune=400,
                chains=4,
                cores=1,
                random_seed=seed,
                target_accept=0.9,
                progressbar=False,
                compute_convergence_checks=True,
            )
        summary = az.summary(trace, var_names=["mu", "sigma"], round_to="none")
        r_hats = np.asarray(summary["r_hat"], dtype=float)
        effective_samples = np.asarray(summary["ess_bulk"], dtype=float)
        r_hat = float(np.max(r_hats))
        ess = float(np.min(effective_samples))
        divergences = int(trace.sample_stats["diverging"].sum())
        diagnostic.update(
            {
                "maxRHat": r_hat if np.isfinite(r_hat) else None,
                "minEffectiveSampleSize": ess if np.isfinite(ess) else None,
                "divergences": divergences,
                "converged": bool(
                    np.isfinite(r_hat)
                    and np.isfinite(ess)
                    and r_hat <= 1.01
                    and ess >= 400
                    and divergences == 0
                ),
            }
        )
        if not diagnostic["converged"]:
            diagnostic["limitation"] = "Posterior diagnostics failed. Use an editable spending assumption."
            return None, diagnostic
        rng = np.random.default_rng(seed)
        means = trace.posterior["mu"].values.reshape(-1)
        scales = trace.posterior["sigma"].values.reshape(-1)
        samples = means + scales * rng.standard_t(4, means.size)
        if not np.all(np.isfinite(samples)):
            diagnostic.update({"converged": False, "limitation": "Posterior predictions were not finite."})
            return None, diagnostic
        return np.maximum(0, samples), diagnostic
    except (ValueError, RuntimeError, np.linalg.LinAlgError) as error:
        diagnostic.update({"converged": False, "limitation": str(error)})
        return None, diagnostic
