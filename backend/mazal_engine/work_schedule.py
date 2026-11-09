from __future__ import annotations

import calendar
from datetime import date, timedelta
from fractions import Fraction
from typing import Any

from .dates import next_month, parse_date


def temporary_schedule(roadmap: dict[str, Any]) -> dict[str, Any] | None:
    schedule = roadmap.get("temporaryWorkSchedule")
    if not schedule or roadmap.get("incomeTransitionPlanned") is False:
        return None
    return {**schedule, "startDate": roadmap["transitionDate"]}


def estimated_pay(base: int, payday: date, interval: int, schedule: dict[str, Any]) -> int:
    end = payday - timedelta(days=schedule["payPeriodEndLagDays"])
    start = end - timedelta(days=interval - 1)
    change = parse_date(schedule["startDate"], "Part-time start")
    resume = parse_date(schedule["returnDate"], "Return to full time")
    if end < change or start >= resume:
        return base
    days = [start + timedelta(days=i) for i in range(interval)]
    workdays = [day for day in days if day.weekday() < 5] or days
    part_time_days = sum(change <= day < resume for day in workdays)
    ratio = Fraction(str(schedule["weeklyHours"])) / Fraction(str(schedule["fullTimeWeeklyHours"]))
    weighted = base * (len(workdays) - part_time_days + part_time_days * ratio) / len(workdays)
    return int(weighted + Fraction(1, 2))


def pay_by_date(
    base: int, paydays: set[str], frequency: int, anchor: date, schedule: dict[str, Any],
) -> dict[str, int]:
    result = {}
    for value in sorted(paydays):
        payday = parse_date(value)
        if frequency == 12:
            previous = next_month(payday, -1)
            previous = previous.replace(day=min(anchor.day, calendar.monthrange(previous.year, previous.month)[1]))
            interval = (payday - previous).days
        else:
            interval = 14 if frequency == 26 else 7
        result[value] = estimated_pay(base, payday, interval, schedule)
    return result
