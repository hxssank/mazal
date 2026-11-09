from __future__ import annotations

from datetime import timedelta
from typing import Any

import numpy as np

from .allocation import _scope
from .dates import parse_date
from .spending_bayesian import fit_bayesian as _bayesian
from .spending_frequentist import fit_local_level as _local_level
from .summary import add_cents


def _weekly_history(
    snapshot: dict[str, Any], scope: str, as_of: str
) -> tuple[list[dict[str, Any]], list[str]]:
    owners = _scope(snapshot, scope)
    accounts = {
        account["id"]: account
        for account in snapshot.get("accounts", [])
        if account["entityId"] in owners and account["type"] in ("cash", "debt", "payable")
    }
    if not accounts:
        return [], ["No personal cash, debt or payable accounts are available for spending coverage."]
    sources = [
        (statement["accountId"], statement["periodStart"], statement["periodEnd"])
        for statement in snapshot.get("statements", [])
        if statement["accountId"] in accounts
    ]
    for batch in snapshot.get("importBatches", []):
        source = batch["source"]
        if batch["status"] == "committed" and source["accountId"] in accounts:
            sources.append((source["accountId"], source["periodStart"], source["periodEnd"]))
    day = parse_date(as_of)
    final_monday = day - timedelta(days=day.weekday())
    end = final_monday - timedelta(days=1)
    weeks = []
    coverage_limitation = None
    transactions = [
        row
        for row in snapshot.get("transactions", [])
        if row["accountId"] in accounts and row["kind"] == "expense"
    ]
    for offset in range(104):
        week_end = end - timedelta(days=offset * 7)
        week_start = week_end - timedelta(days=6)
        uncovered = []
        for account_id in accounts:
            for day_offset in range(7):
                value = (week_start + timedelta(days=day_offset)).isoformat()
                closed = accounts[account_id].get("closedAt")
                if closed and value > closed:
                    continue
                if not any(
                    owner == account_id and lower <= value <= upper for owner, lower, upper in sources
                ):
                    uncovered.append(accounts[account_id].get("name", account_id))
                    break
        if uncovered:
            coverage_limitation = (
                f"Statement coverage is incomplete for {week_start.isoformat()} to {week_end.isoformat()}: "
                f"{', '.join(uncovered)}."
            )
            break
        lower, upper = week_start.isoformat(), week_end.isoformat()
        spending = 0
        for row in transactions:
            if lower <= row["date"] <= upper:
                spending = add_cents(spending, row["amountCents"])
        weeks.append(
            {
                "startDate": lower,
                "endDate": upper,
                "spendingCents": spending,
            }
        )
    return list(reversed(weeks)), [
        "Coverage requires committed statements for every personal cash, debt and payable account through its recorded closing date.",
        "Only recorded expenses count. Transfers, card payments and staged rows are excluded.",
        "The forecast describes covered net spending. Unrecorded cash purchases remain outside the estimate.",
        *([coverage_limitation] if coverage_limitation else []),
    ]


def analyze_spending(
    snapshot: dict[str, Any], scope: str, as_of: str, assumptions: dict[str, Any]
) -> dict[str, Any]:
    """Validate spending models on complete past weeks, without changing a financial record."""
    weeks, limitations = _weekly_history(snapshot, scope, as_of)
    seed = assumptions.get("seed", 42)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2**32 - 1:
        raise ValueError("Seed must be a whole number between 0 and 4294967295.")
    result: dict[str, Any] = {
        "status": "insufficient_history",
        "completeWeeks": len(weeks),
        "minimumWeeks": 12,
        "weeklyHistory": weeks,
        "limitations": limitations,
        "selectedModel": None,
        "weeklyEstimateCents": None,
        "models": [],
    }
    if len(weeks) < 12:
        result["limitations"].append(
            "At least 12 consecutive complete weeks immediately before this week are required."
        )
        return result
    history = np.asarray([week["spendingCents"] for week in weeks], dtype=float)
    holdout_count = max(4, len(history) // 4)
    training, holdout = history[:-holdout_count], history[-holdout_count:]
    baseline = max(0, float(np.median(training)))
    baseline_error = float(np.mean(np.abs(holdout - baseline)))
    errors = {"median": baseline_error}
    result["models"].append({"id": "median", "holdoutMaeCents": round(baseline_error), "converged": True})
    predictions, frequentist = _local_level(training, holdout_count)
    frequentist["id"] = "local_level"
    if predictions is not None:
        errors["local_level"] = float(np.mean(np.abs(holdout - predictions)))
    frequentist["holdoutMaeCents"] = None if predictions is None else round(errors["local_level"])
    result["models"].append(frequentist)
    samples, bayesian = _bayesian(training, seed)
    bayesian["id"] = "bayesian"
    if samples is not None:
        errors["bayesian"] = float(np.mean(np.abs(holdout - np.median(samples))))
    bayesian["holdoutMaeCents"] = None if samples is None else round(errors["bayesian"])
    if samples is not None:
        bayesian["holdoutPredictiveIntervalCents"] = [
            round(float(value)) for value in np.quantile(samples, [0.05, 0.95])
        ]
    result["models"].append(bayesian)
    selected = "median"
    best_error = baseline_error
    for model in result["models"][1:]:
        error = errors.get(model["id"])
        if (
            model.get("converged")
            and error is not None
            and error <= baseline_error * 0.95
            and error < best_error
        ):
            selected, best_error = model["id"], error
    estimate = max(0, round(float(np.median(history))))
    if selected == "local_level":
        future, refit = _local_level(history, 1)
        result["refitDiagnostics"] = refit
        if future is None:
            selected = "median"
        else:
            estimate = round(float(future[0]))
    elif selected == "bayesian":
        future, refit = _bayesian(history, seed)
        result["refitDiagnostics"] = refit
        if future is None:
            selected = "median"
        else:
            estimate = round(float(np.median(future)))
            result["weeklyPredictiveIntervalCents"] = [
                round(float(value)) for value in np.quantile(future, [0.05, 0.95])
            ]
    result.update(
        {
            "status": "ready",
            "selectedModel": selected,
            "weeklyEstimateCents": estimate,
            "validation": {
                "method": "chronological_holdout",
                "trainingWeeks": len(training),
                "holdoutWeeks": len(holdout),
                "trainingEnd": weeks[-holdout_count - 1]["endDate"],
                "holdoutStart": weeks[-holdout_count]["startDate"],
                "selectionRule": (
                    "Choose the lowest-error converged model that reduces median-baseline MAE by at least 5%."
                ),
            },
        }
    )
    result["limitations"].extend(
        [
            "Validation uses the current recorded history, not a reconstruction of records available at each past date.",
            "The models do not include seasonal effects, planned purchases, or future changes in income.",
            "Refunds reduce recorded weekly spending. Forecast spending is floored at zero.",
            "This estimate is not applied automatically. Confirm a monthly spending assumption before allocation.",
        ]
    )
    return result
