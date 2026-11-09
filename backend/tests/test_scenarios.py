from datetime import date, timedelta

import numpy as np
import pytest

from mazal_engine.debt import MAX_SAFE_CENTS
from mazal_engine.scenarios import (
    daily_growth_factor,
    growth_factors,
    scenario_day_index,
    scenario_definitions,
    setback,
)


@pytest.mark.parametrize("rate", [-100, -30, 0, 12, 100])
def test_effective_annual_return_compounds_over_365_days(rate: float) -> None:
    dates = [(date(2027, 1, 1) + timedelta(days=index)).isoformat() for index in range(365)]
    factors = growth_factors(dates, rate, {"shockPercent": 0, "shockMonth": 3})
    assert float(np.prod(factors)) == pytest.approx(1 + rate / 100)
    assert daily_growth_factor(rate) ** 366 == pytest.approx((1 + rate / 100) ** (366 / 365))


def test_shock_happens_once_in_requested_month():
    dates = ["2026-01-31", "2026-02-01", "2026-02-02"]
    factors = growth_factors(dates, 0, {"shockPercent": -30, "shockMonth": 2})
    np.testing.assert_allclose(factors, [1, 0.7, 1])


def test_named_cases_never_invent_probabilities():
    cases = scenario_definitions({"shockMonth": 3})
    assert {case["id"] for case in cases} == {"base", "decline", "rally", "total_loss", "late_pay"}
    assert all("probability" not in case for case in cases)


def test_recovery_is_full_replaceable_paychecks_and_unknown_without_surplus():
    assert setback(20_001, 10_000) == 3
    assert setback(20_001, 0) is None
    assert setback(-100, 0) == 0


def test_replacement_paycheck_count_uses_exact_integer_division():
    assert setback(MAX_SAFE_CENTS, 1) == MAX_SAFE_CENTS
    assert setback(MAX_SAFE_CENTS, 3) == (MAX_SAFE_CENTS + 2) // 3
    assert setback(8_998_192_668_235_008, 4_499_096_334_117_503) == 3


@pytest.mark.parametrize("month", [True, False, 2.5, "2", 0, 61])
def test_fractional_or_coerced_shock_months_are_rejected(month):
    with pytest.raises(ValueError, match="whole number"):
        scenario_definitions({"shockMonth": month})
    with pytest.raises(ValueError, match="whole number"):
        scenario_day_index(["2026-01-01"], month)


@pytest.mark.parametrize("shock", [True, "-30", float("nan"), float("inf"), -100.1, 100.1])
def test_invalid_shock_rates_are_rejected(shock):
    with pytest.raises(ValueError, match="Shock percent"):
        scenario_definitions({"shockPercent": shock})
    with pytest.raises(ValueError, match="Shock percent"):
        growth_factors(["2026-01-01"], 0, {"shockPercent": shock, "shockMonth": 1})


@pytest.mark.parametrize("amount", [True, 0.5, -1, MAX_SAFE_CENTS + 1])
def test_invalid_unexpected_expense_is_rejected(amount):
    with pytest.raises(ValueError, match="whole cents"):
        scenario_definitions({"unexpectedExpenseCents": amount})


@pytest.mark.parametrize("rate", [True, "5", float("nan"), float("inf"), -101, 101])
def test_invalid_growth_rates_are_rejected(rate):
    with pytest.raises(ValueError, match="Annual return"):
        growth_factors(["2026-01-01"], rate, {"shockPercent": 0, "shockMonth": 1})


@pytest.mark.parametrize(
    "dates", [["2026-02-30"], ["2026-01-02", "2026-01-01"], ["2026-01-01", "2026-01-01"]]
)
def test_scenario_dates_must_be_valid_and_ordered(dates):
    with pytest.raises(ValueError):
        growth_factors(dates, 0, {"shockPercent": -30, "shockMonth": 1})


def test_shock_outside_horizon_does_not_modify_any_factor():
    np.testing.assert_array_equal(
        growth_factors(["2026-01-31"], 0, {"shockPercent": -100, "shockMonth": 2}), [1]
    )
    assert scenario_day_index(["2026-12-31", "2027-01-01"], 2) == 1


def test_total_loss_factors_remain_nonnegative():
    np.testing.assert_array_equal(
        growth_factors(["2026-01-01", "2026-01-02"], 0, {"shockPercent": -100, "shockMonth": 1}), [0, 1]
    )
