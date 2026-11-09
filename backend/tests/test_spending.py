from copy import deepcopy
from datetime import date, timedelta
from pathlib import Path
from tempfile import gettempdir
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from mazal_engine.calendar import spending_calendar
from mazal_engine.debt import MAX_SAFE_CENTS
from mazal_engine.spending import _bayesian, _local_level, _weekly_history, analyze_spending


def covered_snapshot():
    start = date(2026, 1, 5)
    return {
        "entities": [{"id": "me", "kind": "personal"}],
        "accounts": [{"id": "cash", "entityId": "me", "type": "cash"}],
        "statements": [{"accountId": "cash", "periodStart": "2026-01-05", "periodEnd": "2026-04-26"}],
        "transactions": [
            {
                "id": str(index),
                "accountId": "cash",
                "kind": "expense",
                "date": (start + timedelta(days=index * 7)).isoformat(),
                "amountCents": 20_000,
            }
            for index in range(16)
        ],
    }


def covered_payable_snapshot() -> dict[str, Any]:
    state = covered_snapshot()
    state["accounts"][0]["name"] = "Cash"
    state["accounts"].append({"id": "supplier", "entityId": "me", "type": "payable", "name": "Supplier tab"})
    for row in state["transactions"]:
        row["amountCents"] = 10_000
    state["transactions"].extend(
        {**row, "id": f"payable-{row['id']}", "accountId": "supplier", "amountCents": 50_000}
        for row in list(state["transactions"])
    )
    state["importBatches"] = [{
        "status": "committed",
        "source": {"accountId": "supplier", "periodStart": "2026-01-05", "periodEnd": "2026-04-26"},
    }]
    return state


def test_payable_expenses_match_recorded_spending_and_calendar_totals() -> None:
    state = covered_payable_snapshot()
    before = deepcopy(state)
    weeks, _ = _weekly_history(state, "me", "2026-04-27")
    march = spending_calendar(state, "me", "2026-04-27", "2026-03")
    assert len(weeks) == 16
    assert {week["spendingCents"] for week in weeks} == {60_000}
    assert sum(week["spendingCents"] for week in weeks) == sum(row["amountCents"] for row in state["transactions"]) == 960_000
    assert march["coverage"]["status"] == "complete"
    assert march["data"]["totalCents"] == 300_000
    assert state == before


@pytest.mark.parametrize("coverage", ["absent", "staged", "gap"])
def test_payable_statement_gaps_prevent_complete_spending_history(coverage: str) -> None:
    state = covered_payable_snapshot()
    if coverage == "absent":
        state["importBatches"] = []
    elif coverage == "staged":
        state["importBatches"][0]["status"] = "staged"
    else:
        state["importBatches"][0]["source"]["periodEnd"] = "2026-04-25"
    result = analyze_spending(state, "me", "2026-04-27", {})
    assert result["status"] == "insufficient_history"
    assert result["completeWeeks"] == 0
    assert result["weeklyEstimateCents"] is None
    assert any("Supplier tab" in message for message in result["limitations"])


def test_statement_gaps_are_not_zero_spending_weeks():
    state = covered_snapshot()
    state["statements"] = []
    result = analyze_spending(state, "all", "2026-04-27", {})
    assert result["status"] == "insufficient_history"
    assert result["completeWeeks"] == 0
    assert result["weeklyEstimateCents"] is None


def test_staged_statements_cannot_establish_coverage():
    state = covered_snapshot()
    source = state.pop("statements")[0]
    state["importBatches"] = [{"status": "staged", "source": source}]
    assert analyze_spending(state, "all", "2026-04-27", {})["completeWeeks"] == 0


def test_failed_model_diagnostics_keep_median_baseline(monkeypatch):
    monkeypatch.setattr(
        "mazal_engine.spending._bayesian",
        lambda training, seed: (None, {"library": "PyMC", "converged": False, "limitation": "R-hat failed"}),
    )
    result = analyze_spending(covered_snapshot(), "all", "2026-04-27", {})
    assert result["status"] == "ready"
    assert result["selectedModel"] == "median"
    assert result["weeklyEstimateCents"] == 20_000
    assert result["validation"]["trainingWeeks"] == 12
    assert result["validation"]["holdoutWeeks"] == 4
    assert result["models"][-1]["holdoutMaeCents"] is None


def test_statsmodels_fit_returns_finite_forecast_or_visible_failure():
    values = np.array([20_000, 21_000, 19_000, 22_000, 20_500, 22_500, 21_000, 20_000] * 3)
    predictions, diagnostic = _local_level(values, 4)
    assert diagnostic["library"] == "statsmodels"
    assert predictions is None and not diagnostic["converged"] or np.all(np.isfinite(predictions))


def test_pymc_records_priors_and_convergence_diagnostics(monkeypatch):
    monkeypatch.setenv("PYTENSOR_FLAGS", f"base_compiledir={Path(gettempdir()) / 'mazal-engine-pytensor'}")
    values = np.array([20_000, 21_000, 19_000, 22_000, 20_500, 22_500, 21_000, 20_000] * 3)
    samples, diagnostic = _bayesian(values, 42)
    assert diagnostic["library"] == "PyMC"
    assert diagnostic["prior"]["nu"] == 4
    assert diagnostic["chains"] == 4
    assert "maxRHat" in diagnostic or "limitation" in diagnostic
    assert diagnostic["converged"]
    assert len(samples) == 1600
    repeated_samples, repeated_diagnostic = _bayesian(values, 42)
    np.testing.assert_array_equal(samples, repeated_samples)
    assert repeated_diagnostic == diagnostic


def test_selects_lowest_error_model_that_beats_the_baseline(monkeypatch: pytest.MonkeyPatch) -> None:
    state = covered_snapshot()
    for row in state["transactions"][-4:]:
        row["amountCents"] = 22_000
    monkeypatch.setattr(
        "mazal_engine.spending._local_level",
        lambda training, count: (np.full(count, 20_200), {"converged": True}),
    )
    monkeypatch.setattr(
        "mazal_engine.spending._bayesian",
        lambda training, seed: (
            np.full(100, 20_220 if len(training) == 12 else 23_000),
            {"converged": True},
        ),
    )
    result = analyze_spending(state, "all", "2026-04-27", {})
    assert result["models"][1]["holdoutMaeCents"] == 1800
    assert result["models"][2]["holdoutMaeCents"] == 1780
    assert result["selectedModel"] == "bayesian"
    assert result["weeklyEstimateCents"] == 23_000


@pytest.mark.parametrize("prediction", [20_001.0, 20_001.01])
def test_selection_uses_unrounded_error_and_accepts_five_percent_improvement(
    monkeypatch: pytest.MonkeyPatch, prediction: float
) -> None:
    state = covered_snapshot()
    for row in state["transactions"][-4:]:
        row["amountCents"] = 20_020
    monkeypatch.setattr(
        "mazal_engine.spending._local_level",
        lambda training, count: (np.full(count, prediction), {"converged": True}),
    )
    monkeypatch.setattr("mazal_engine.spending._bayesian", lambda *_: (None, {"converged": False}))
    result = analyze_spending(state, "all", "2026-04-27", {})
    assert result["models"][1]["holdoutMaeCents"] == 19
    assert result["selectedModel"] == "local_level"


def test_failed_refit_returns_full_history_median(monkeypatch: pytest.MonkeyPatch) -> None:
    state = covered_snapshot()
    for row in state["transactions"][-4:]:
        row["amountCents"] = 22_000
    monkeypatch.setattr(
        "mazal_engine.spending._local_level",
        lambda training, count: (
            (np.full(count, 22_000), {"converged": True})
            if len(training) == 12
            else (None, {"converged": False, "limitation": "Refit failed."})
        ),
    )
    monkeypatch.setattr("mazal_engine.spending._bayesian", lambda *_: (None, {"converged": False}))
    result = analyze_spending(state, "all", "2026-04-27", {})
    assert result["selectedModel"] == "median"
    assert result["weeklyEstimateCents"] == 20_000
    assert result["refitDiagnostics"]["limitation"] == "Refit failed."


def test_models_train_before_holdout_and_ignore_current_or_future_weeks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = covered_snapshot()
    for index, row in enumerate(state["transactions"]):
        row["amountCents"] = 10_000 + index * 1000
    state["transactions"].extend(
        {"id": day, "accountId": "cash", "kind": "expense", "date": day, "amountCents": 1_000_000}
        for day in ("2026-04-27", "2026-05-04")
    )
    training_sets = []

    def failed_model(training: np.ndarray, _: int) -> tuple[None, dict[str, Any]]:
        training_sets.append(training.copy())
        return None, {"converged": False}

    monkeypatch.setattr("mazal_engine.spending._local_level", failed_model)
    monkeypatch.setattr("mazal_engine.spending._bayesian", failed_model)
    before = deepcopy(state)
    result = analyze_spending(state, "all", "2026-04-29", {})
    assert state == before
    assert result["completeWeeks"] == 16
    assert len(training_sets) == 2
    for training in training_sets:
        np.testing.assert_array_equal(training, np.arange(10_000, 22_000, 1000))
    assert result["validation"]["trainingEnd"] == "2026-03-29"
    assert result["validation"]["holdoutStart"] == "2026-03-30"


def test_coverage_requires_every_personal_spending_account_and_every_day() -> None:
    state = covered_snapshot()
    state["statements"] = [
        {"accountId": "cash", "periodStart": "2026-01-05", "periodEnd": "2026-04-12"},
        {"accountId": "cash", "periodStart": "2026-04-14", "periodEnd": "2026-04-26"},
    ]
    weeks, _ = _weekly_history(state, "all", "2026-04-27")
    assert len(weeks) == 1
    state["entities"].append({"id": "business", "kind": "business"})
    state["accounts"].append({"id": "business", "entityId": "business", "type": "cash"})
    assert len(_weekly_history(state, "all", "2026-04-27")[0]) == 1
    state["accounts"].append({"id": "card", "entityId": "me", "type": "debt", "name": "Personal card"})
    weeks, limitations = _weekly_history(state, "all", "2026-04-27")
    assert weeks == []
    assert limitations[-1] == (
        "Statement coverage is incomplete for 2026-04-20 to 2026-04-26: Personal card."
    )


@pytest.mark.parametrize("account_type", ["cash", "payable"])
def test_closed_accounts_need_coverage_only_through_their_closing_date(account_type: str) -> None:
    state = covered_snapshot()
    state["accounts"].append({"id": "old", "entityId": "me", "type": account_type, "name": "Old account", "closedAt": "2026-01-01"})
    assert len(_weekly_history(state, "all", "2026-04-27")[0]) == 16
    state["accounts"][-1]["closedAt"] = "2026-04-22"
    state["statements"].append({"accountId": "old", "periodStart": "2026-01-05", "periodEnd": "2026-04-22"})
    state["transactions"].append({"id": "old-expense", "accountId": "old", "kind": "expense", "date": "2026-04-21", "amountCents": 1500})
    weeks, _ = _weekly_history(state, "all", "2026-04-27")
    assert len(weeks) == 16
    assert weeks[-1]["spendingCents"] == 21500
    state["statements"][-1]["periodEnd"] = "2026-04-21"
    assert _weekly_history(state, "all", "2026-04-27")[0] == []
    state["accounts"][-1]["closedAt"] = None
    assert _weekly_history(state, "all", "2026-04-27")[0] == []


def test_covered_history_counts_refunds_but_not_transfers_or_debt_payments() -> None:
    state = covered_snapshot()
    source = state.pop("statements")[0]
    state["importBatches"] = [{"status": "committed", "source": source}]
    state["transactions"].extend(
        {"id": kind, "accountId": "cash", "kind": kind, "date": "2026-04-24", "amountCents": amount}
        for kind, amount in (("expense", -1000), ("transfer", 100_000), ("debt_payment", 50_000))
    )
    weeks, _ = _weekly_history(state, "all", "2026-04-27")
    assert weeks[-1]["spendingCents"] == 19_000


def test_weekly_spending_rejects_cent_overflow() -> None:
    state = covered_snapshot()
    state["transactions"].append(
        {
            "id": "overflow",
            "accountId": "cash",
            "kind": "expense",
            "date": "2026-04-24",
            "amountCents": MAX_SAFE_CENTS,
        }
    )
    with pytest.raises(ValueError, match="supported range"):
        _weekly_history(state, "all", "2026-04-27")


@pytest.mark.parametrize("seed", [True, -1, 2**32, 1.5])
def test_spending_seed_rejects_invalid_values(seed: Any) -> None:
    with pytest.raises(ValueError, match="Seed"):
        analyze_spending(covered_snapshot(), "all", "2026-04-27", {"seed": seed})


@pytest.mark.parametrize(
    ("r_hats", "effective_samples"),
    [
        ([1.0, 1.014], [500, 500]),
        ([1.0, np.nan], [500, 500]),
        ([1.0, 1.0], [500, 399.9]),
        ([1.0, 1.0], [500, np.nan]),
    ],
)
def test_pymc_diagnostics_use_unrounded_values_and_reject_missing_checks(
    monkeypatch: pytest.MonkeyPatch, r_hats: list[float], effective_samples: list[float]
) -> None:
    import arviz as az
    import pymc as pm

    monkeypatch.setattr(
        pm, "sample", lambda **_: SimpleNamespace(sample_stats={"diverging": np.zeros((4, 400))})
    )

    def diagnostics(*_args: Any, **kwargs: Any) -> dict[str, list[float]]:
        assert kwargs["round_to"] == "none"
        return {"r_hat": r_hats, "ess_bulk": effective_samples}

    monkeypatch.setattr(az, "summary", diagnostics)
    samples, diagnostic = _bayesian(np.asarray([20_000, 21_000] * 8), 42)
    assert samples is None
    assert not diagnostic["converged"]
    assert "Posterior diagnostics failed" in diagnostic["limitation"]
