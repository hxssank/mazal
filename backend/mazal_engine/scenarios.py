from __future__ import annotations

from typing import Any

import numpy as np

from .dates import parse_date
from .debt import checked_cents, checked_rate


def daily_growth_factor(annual_return_percent: float) -> float:
    """Convert an effective annual return using Actual/365 Fixed for both projection models."""
    rate = checked_rate(annual_return_percent, "Annual return", minimum=-100, maximum=100)
    return (1 + rate / 100) ** (1 / 365)


def _shock_month(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 60:
        raise ValueError("Shock month must be a whole number between 1 and 60.")
    return value


def scenario_definitions(assumptions: dict[str, Any]) -> list[dict[str, Any]]:
    """Named stress cases have no probability attached to them."""
    shock = checked_rate(assumptions.get("shockPercent", -30), "Shock percent", minimum=-100, maximum=100)
    shock_month = _shock_month(assumptions.get("shockMonth", 3))
    amount = assumptions.get("unexpectedExpenseCents")
    result = [
        {"id": "base", "name": "Stated return", "shockPercent": 0, "shockMonth": shock_month},
        {
            "id": "decline",
            "name": f"{shock:g}% investment shock",
            "shockPercent": shock,
            "shockMonth": shock_month,
        },
        {"id": "rally", "name": "+20% investment shock", "shockPercent": 20, "shockMonth": shock_month},
        {
            "id": "total_loss",
            "name": "Total investment loss",
            "shockPercent": -100,
            "shockMonth": shock_month,
        },
        {
            "id": "late_pay",
            "name": "First paycheck delayed 14 days",
            "shockPercent": 0,
            "shockMonth": shock_month,
            "delayFirstPayDays": 14,
        },
    ]
    if amount is not None:
        amount = checked_cents(amount, "Unexpected expense")
        result.append(
            {
                "id": "expense",
                "name": "Unexpected expense",
                "shockPercent": 0,
                "shockMonth": shock_month,
                "unexpectedExpenseCents": amount,
            }
        )
    return result


def growth_factors(dates: list[str], annual_return_percent: float, scenario: dict[str, Any]) -> np.ndarray:
    """Apply a known assumption and one specified shock, without supplying a policy its future path."""
    daily_factor = daily_growth_factor(annual_return_percent)
    shock_percent = checked_rate(scenario["shockPercent"], "Shock percent", minimum=-100, maximum=100)
    shock_month = _shock_month(scenario["shockMonth"])
    factors = np.full(len(dates), daily_factor, dtype=float)
    if not dates:
        return factors
    shock_index = scenario_day_index(dates, shock_month)
    if shock_index is not None:
        factors[shock_index] *= 1 + shock_percent / 100
    return factors


def setback(loss_cents: int, replaceable_per_paycheck_cents: int) -> int | None:
    """Count full discretionary contributions needed to replace a loss, excluding market recovery."""
    loss_cents = checked_cents(loss_cents, "Loss", signed=True)
    replaceable_per_paycheck_cents = checked_cents(replaceable_per_paycheck_cents, "Replaceable contribution")
    if loss_cents <= 0:
        return 0
    if replaceable_per_paycheck_cents <= 0:
        return None
    return (loss_cents + replaceable_per_paycheck_cents - 1) // replaceable_per_paycheck_cents


def scenario_day_index(dates: list[str], shock_month: int) -> int | None:
    shock_month = _shock_month(shock_month)
    if not dates:
        return None
    parsed = [parse_date(value, "Scenario date") for value in dates]
    if any(previous >= current for previous, current in zip(parsed, parsed[1:], strict=False)):
        raise ValueError("Scenario dates must be distinct and increasing.")
    target = parsed[0].year * 12 + parsed[0].month - 1 + shock_month - 1
    return next(
        (index for index, value in enumerate(parsed) if value.year * 12 + value.month - 1 == target),
        None,
    )
