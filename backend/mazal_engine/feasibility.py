from __future__ import annotations

import math
from typing import Any

import numpy as np

from .dated_events import cash_path
from .debt import checked_cents


def funding_feasibility(
    starting_cash_cents: int,
    income_cents: list[int],
    required_cents: list[int],
    reserve_cents: int,
) -> dict[str, Any]:
    """Find disposable funding after every dated payment and verify integer cents."""
    if len(income_cents) != len(required_cents) or not income_cents:
        raise ValueError("Income and required-payment calendars must have the same nonzero length.")
    starting_cash_cents = checked_cents(starting_cash_cents, "Starting cash", signed=True)
    reserve_cents = checked_cents(reserve_cents, "Cash reserve")
    income_cents = [checked_cents(value, "Scheduled income") for value in income_cents]
    required_cents = [checked_cents(value, "Required payment") for value in required_cents]
    import cvxpy as cp

    before_income, balances = cash_path(starting_cash_cents, income_cents, required_cents)
    baseline_cash = np.asarray(balances, dtype=np.int64)
    minimum_gap = checked_cents(
        max(0, reserve_cents - min(starting_cash_cents, *before_income, *balances)), "Cash reserve gap"
    )
    if minimum_gap:
        return {
            "status": "infeasible",
            "reserveGapCents": minimum_gap,
            "availableCents": 0,
            "solver": "CLARABEL",
            "exactCentCheck": False,
            "allocationCents": [0] * len(income_cents),
            "note": "Dated payments cannot all be funded while preserving the reserve.",
        }
    amounts = cp.Variable(len(income_cents), nonneg=True)
    cash = (baseline_cash.astype(float) - reserve_cents) / 100 - cp.cumsum(amounts)
    cash_before_pay = (np.asarray(before_income, dtype=float) - reserve_cents) / 100 - cp.cumsum(amounts) + amounts
    problem = cp.Problem(cp.Maximize(cp.sum(amounts)), [cash >= 0, cash_before_pay >= 0])
    try:
        problem.solve(solver="CLARABEL")
    except cp.error.SolverError as error:
        return {
            "status": "solver_failed",
            "availableCents": None,
            "reserveGapCents": None,
            "exactCentCheck": False,
            "solver": "CLARABEL",
            "note": str(error),
        }
    if problem.status != cp.OPTIMAL or amounts.value is None:
        return {
            "status": "solver_failed",
            "availableCents": None,
            "reserveGapCents": None,
            "exactCentCheck": False,
            "solver": "CLARABEL",
            "note": str(problem.status),
        }
    if not np.all(np.isfinite(amounts.value)):
        return {
            "status": "solver_failed",
            "availableCents": None,
            "reserveGapCents": None,
            "exactCentCheck": False,
            "solver": "CLARABEL",
            "note": "The solver returned a nonfinite funding amount.",
        }
    allocations = [max(0, math.floor(float(value) * 100)) for value in amounts.value]
    cumulative = 0
    verified = []
    future_capacity = list(balances)
    capacity = balances[-1]
    for index in range(len(balances) - 1, -1, -1):
        future_capacity[index] = min(capacity, balances[index])
        capacity = min(capacity, before_income[index], balances[index])
    for capacity, amount in zip(future_capacity, allocations, strict=True):
        amount = min(amount, max(0, int(capacity) - reserve_cents - cumulative))
        cumulative += amount
        verified.append(amount)
    used = np.cumsum(verified)
    exact = all(
        int(balance) - int(used) >= reserve_cents
        for balance, used in zip(baseline_cash, used, strict=True)
    ) and all(balance - (int(used[index - 1]) if index else 0) >= reserve_cents
              for index, balance in enumerate(before_income))
    return {
        "status": "feasible",
        "availableCents": sum(verified),
        "reserveGapCents": 0,
        "allocationCents": verified,
        "exactCentCheck": exact,
        "solver": "CLARABEL",
        "note": "CVXPY checks dated cash feasibility; the simulator checks every candidate again in cents.",
    }
