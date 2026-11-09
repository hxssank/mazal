import cvxpy as cp
import numpy as np
import pytest

from mazal_engine.debt import MAX_SAFE_CENTS
from mazal_engine.feasibility import funding_feasibility


def test_solver_preserves_every_dated_reserve_after_rounding():
    result = funding_feasibility(10_000, [0, 10_001, 0], [8_000, 0, 1_000], 2_000)
    assert result["status"] == "feasible"
    assert result["exactCentCheck"]
    assert result["allocationCents"][0] == 0
    assert 8_995 <= result["availableCents"] <= 9_001


def test_future_income_cannot_pay_a_bill_before_it_arrives():
    result = funding_feasibility(0, [0, 100_000], [10_000, 0], 0)
    assert result["status"] == "infeasible"
    assert result["reserveGapCents"] == 10_000
    assert not result["exactCentCheck"]


def test_opening_reserve_gap_is_not_hidden_by_first_day_income():
    result = funding_feasibility(100, [10000], [0], 200)
    assert result["status"] == "infeasible"
    assert result["reserveGapCents"] == 100


@pytest.mark.parametrize(
    "starting,income,required,reserve",
    [
        (0.5, [0], [0], 0),
        (True, [0], [0], 0),
        (0, [0.5], [0], 0),
        (0, [True], [0], 0),
        (0, [0], [-1], 0),
        (0, [0], [False], 0),
        (0, [0], [0], 0.1),
        (0, [0], [0], True),
        (MAX_SAFE_CENTS, [1], [0], 0),
        (0, [MAX_SAFE_CENTS + 1], [0], 0),
    ],
)
def test_invalid_money_never_reaches_numpy_or_solver(starting, income, required, reserve):
    with pytest.raises(ValueError, match="whole cents"):
        funding_feasibility(starting, income, required, reserve)


def test_solver_rounding_is_repaired_against_every_future_cash_constraint(monkeypatch):
    def solve(problem, **kwargs):
        problem.variables()[0].value = np.array([10.0, 0.0])
        problem._status = cp.OPTIMAL

    monkeypatch.setattr(cp.Problem, "solve", solve)
    result = funding_feasibility(1000, [0, 0], [0, 900], 0)
    assert result["allocationCents"] == [100, 0]
    assert result["availableCents"] == 100
    assert result["exactCentCheck"] is True


def test_solver_failure_does_not_return_a_funding_amount(monkeypatch):
    def solve(problem, **kwargs):
        raise cp.error.SolverError("Synthetic solver failure")

    monkeypatch.setattr(cp.Problem, "solve", solve)
    result = funding_feasibility(1000, [0], [0], 0)
    assert result["status"] == "solver_failed"
    assert result["availableCents"] is None
    assert result["exactCentCheck"] is False
