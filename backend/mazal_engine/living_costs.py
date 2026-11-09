from __future__ import annotations

import calendar
from typing import Any

from .dates import parse_date
from .debt import checked_cents
from .summary import add_cents, upcoming


def living_allowances(
    snapshot: dict[str, Any], owners: set[str], dates: list[str], monthly_cents: int,
) -> tuple[dict[str, int], list[dict[str, str]]]:
    checked_cents(monthly_cents, "Monthly living costs")
    if not dates:
        return {}, []
    months = dict.fromkeys(value[:7] for value in dates)
    obligations = [item for item in snapshot.get("obligations", [])
                   if item["entityId"] in owners and item["direction"] == "out" and not item.get("assetPurchaseId")]
    by_id = {item["id"]: item for item in obligations}
    sources = {f"Planned payment {item['id']}": item for item in obligations}
    corrected = {row.get("reversalOf") for row in snapshot.get("transactions", [])}
    paid_bills = []
    unknown = []
    for row in snapshot.get("transactions", []):
        payment = row.get("plannedPayment")
        item = by_id.get(payment.get("obligationId")) if isinstance(payment, dict) else sources.get(row.get("source"))
        if row["kind"] != "expense" or item is None or row["date"] > dates[0] or row.get("reversalOf") or row["id"] in corrected:
            continue
        if not isinstance(payment, dict) or payment.get("obligationId") != item["id"]:
            if row["date"][:7] in months:
                unknown.append({"field": f"transactions.{row['id']}.plannedPayment", "sourceId": item["id"],
                                "message": f"The recorded payment for {item['name']} has no original due date. It does not reduce this month's living allowance."})
            continue
        parse_date(payment.get("dueDate"), "Original payment due date")
        paid_bills.append({"id": item["id"], "date": payment["dueDate"], "amountCents": row["amountCents"]})
    paid_occurrences = {(row["id"], row["date"]) for row in paid_bills}
    budget_snapshot = {**snapshot, "obligations": [
        {**item, "status": "planned" if item["status"] == "paid" and (item["id"], item["dueDate"]) not in paid_occurrences else item["status"]}
        for item in obligations
    ]}
    result = {}
    for month in months:
        month_days = calendar.monthrange(int(month[:4]), int(month[5:]))[1]
        bills = 0
        for item in upcoming(budget_snapshot, "all", f"{month}-01", month_days - 1):
            if item["occurrenceDate"][:7] == month:
                bills = add_cents(bills, item["amountCents"])
        for row in paid_bills:
            if row["date"][:7] == month:
                bills = add_cents(bills, row["amountCents"])
        allowance = max(0, monthly_cents - bills)
        for value in dates:
            if value[:7] != month:
                continue
            day = int(value[-2:])
            cumulative = (allowance * day * 2 + month_days) // (2 * month_days)
            previous = (allowance * (day - 1) * 2 + month_days) // (2 * month_days)
            result[value] = cumulative - previous
    return result, unknown
