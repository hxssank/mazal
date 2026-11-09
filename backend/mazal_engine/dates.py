from __future__ import annotations

import calendar
import re
from datetime import date, timedelta

import QuantLib as ql


def parse_date(value: str, label: str = "Date") -> date:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError(f"{label} must be a real date in YYYY-MM-DD format.")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{label} must be a real date in YYYY-MM-DD format.") from exc
    if not 1901 <= parsed.year <= 2199:
        raise ValueError(f"{label} must be between 1901 and 2199.")
    return parsed


def month_start(value: str) -> date:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}", value):
        raise ValueError("Start month must use YYYY-MM format.")
    return parse_date(f"{value}-01", "Start month")


def next_month(value: date, offset: int = 1) -> date:
    absolute_month = value.year * 12 + value.month - 1 + offset
    year, month = divmod(absolute_month, 12)
    return date(year, month + 1, 1)


def _ql_date(value: date) -> ql.Date:
    return ql.Date(value.day, value.month, value.year)


def day_fraction(start: date, end: date, convention: str = "Actual/365 Fixed") -> float:
    counters = {"Actual/365 Fixed": ql.Actual365Fixed, "Actual/360": ql.Actual360}
    if convention not in counters:
        raise ValueError("Choose an explicit supported day-count convention.")
    return float(counters[convention]().yearFraction(_ql_date(start), _ql_date(end)))


def pay_dates(start: date, end: date, anchor: date, frequency: int) -> set[str]:
    if isinstance(frequency, bool) or frequency not in (12, 26, 52):
        raise ValueError("Choose 12 monthly, 26 biweekly, or 52 weekly paychecks.")
    if end.year > 2199:
        raise ValueError("The projection must end before 2200.")
    if start >= end or anchor >= end:
        return set()
    if frequency == 12:
        first_month = max(start.replace(day=1), anchor.replace(day=1))
        first = first_month.replace(
            day=min(anchor.day, calendar.monthrange(first_month.year, first_month.month)[1])
        )
        if first < start:
            first_month = next_month(first_month)
            first = first_month.replace(
                day=min(anchor.day, calendar.monthrange(first_month.year, first_month.month)[1])
            )
        if first >= end:
            return set()
        # Advance from the original anchor so February never changes the saved day.
        month_offset = (first.year - anchor.year) * 12 + first.month - anchor.month
        result: set[str] = set()
        null_calendar = ql.NullCalendar()
        while True:
            current = null_calendar.advance(
                _ql_date(anchor), ql.Period(month_offset, ql.Months), ql.Unadjusted, False
            )
            observed = date(current.year(), current.month(), current.dayOfMonth())
            if observed >= end:
                return result
            if observed >= start and observed >= anchor:
                result.add(observed.isoformat())
            month_offset += 1
    interval = 14 if frequency == 26 else 7
    offset = max(0, ((start - anchor).days + interval - 1) // interval)
    first = anchor + timedelta(days=offset * interval)
    if first >= end:
        return set()
    schedule = ql.Schedule(
        _ql_date(first),
        _ql_date(end),
        ql.Period(interval, ql.Days),
        ql.NullCalendar(),
        ql.Unadjusted,
        ql.Unadjusted,
        ql.DateGeneration.Forward,
        False,
    )
    return {
        date(item.year(), item.month(), item.dayOfMonth()).isoformat()
        for item in schedule
        if _ql_date(start) <= item < _ql_date(end)
    }


def adjust_business_day(value: str, convention: str, calendar_name: str) -> str:
    calendars = {"Canada settlement": lambda: ql.Canada(ql.Canada.Settlement)}
    conventions = {"unadjusted": ql.Unadjusted, "following": ql.Following, "preceding": ql.Preceding}
    if calendar_name not in calendars or convention not in conventions:
        raise ValueError("Choose an explicit supported calendar and business-day convention.")
    adjusted = calendars[calendar_name]().adjust(_ql_date(parse_date(value)), conventions[convention])
    return date(adjusted.year(), adjusted.month(), adjusted.dayOfMonth()).isoformat()
