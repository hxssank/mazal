from datetime import date

import pytest

from mazal_engine.dates import adjust_business_day, day_fraction, month_start, parse_date, pay_dates


def test_monthly_paydays_preserve_month_end_anchor() -> None:
    assert sorted(pay_dates(date(2027, 1, 1), date(2027, 4, 1), date(2027, 1, 31), 12)) == [
        "2027-01-31",
        "2027-02-28",
        "2027-03-31",
    ]
    assert sorted(pay_dates(date(2028, 1, 1), date(2028, 4, 1), date(2028, 1, 31), 12)) == [
        "2028-01-31",
        "2028-02-29",
        "2028-03-31",
    ]
    assert sorted(pay_dates(date(2027, 2, 1), date(2027, 4, 1), date(2027, 1, 30), 12)) == [
        "2027-02-28",
        "2027-03-30",
    ]


def test_biweekly_schedule_is_unadjusted_and_does_not_invent_income() -> None:
    assert sorted(pay_dates(date(2026, 10, 1), date(2026, 11, 1), date(2026, 10, 1), 26)) == [
        "2026-10-01",
        "2026-10-15",
        "2026-10-29",
    ]
    assert sorted(pay_dates(date(2026, 10, 1), date(2026, 11, 1), date(2026, 9, 17), 26)) == [
        "2026-10-01",
        "2026-10-15",
        "2026-10-29",
    ]
    assert pay_dates(date(2026, 10, 1), date(2026, 11, 1), date(2026, 11, 1), 26) == set()
    assert "2026-12-25" in pay_dates(date(2026, 12, 1), date(2027, 1, 1), date(2026, 12, 25), 52)


def test_explicit_day_count_and_holiday_adjustment() -> None:
    assert day_fraction(date(2028, 2, 1), date(2028, 3, 1)) == 29 / 365
    assert day_fraction(date(2028, 2, 1), date(2028, 3, 1), "Actual/360") == 29 / 360
    assert adjust_business_day("2026-12-25", "following", "Canada settlement") == "2026-12-29"
    assert adjust_business_day("2026-12-25", "unadjusted", "Canada settlement") == "2026-12-25"
    with pytest.raises(ValueError, match="convention"):
        day_fraction(date(2028, 2, 1), date(2028, 3, 1), "guess")


@pytest.mark.parametrize("value", ["2026-02-30", "2026-1-01", "not-a-date", "2200-01-01", "1900-01-01"])
def test_invalid_dates_fail_before_projection(value: str) -> None:
    with pytest.raises(ValueError):
        parse_date(value)


def test_month_validation() -> None:
    assert month_start("2026-10") == date(2026, 10, 1)
    with pytest.raises(ValueError):
        month_start("2026-13")


def test_unsupported_horizon_fails_even_without_a_payday() -> None:
    with pytest.raises(ValueError, match="before 2200"):
        pay_dates(date(2199, 12, 1), date(2200, 1, 1), date(2200, 1, 1), 26)
