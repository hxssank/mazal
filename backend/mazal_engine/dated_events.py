from __future__ import annotations

from copy import deepcopy
from datetime import date, timedelta
from typing import Any

from .dates import next_month, parse_date
from .debt import checked_cents
from .summary import add_cents, normalized_category, upcoming


def cash_path(starting: int, income: list[int], required: list[int]) -> tuple[list[int], list[int]]:
    if len(income) != len(required):
        raise ValueError("Income and payment calendars must have the same length.")
    before, closing = [], []
    balance = checked_cents(starting, "Starting cash", signed=True)
    for deposit, payment in zip(income, required, strict=True):
        balance = add_cents(balance, -checked_cents(payment, "Required payment"))
        before.append(balance)
        balance = add_cents(balance, checked_cents(deposit, "Scheduled income"))
        closing.append(balance)
    return before, closing


def required_cash_buffer(income: list[int], required: list[int]) -> int:
    before, closing = cash_path(0, income, required)
    return max(0, -min([0, *before, *closing]))


def payday_receipt(snapshot: dict[str, Any], owner: str, when: str) -> dict[str, Any] | None:
    accounts = {row["id"] for row in snapshot.get("accounts", [])
                if row["entityId"] == owner and row["type"] == "cash"}
    corrected = {row.get("reversalOf") for row in snapshot.get("transactions", [])}
    return next((row for row in snapshot.get("transactions", [])
                 if row["kind"] == "income" and row["accountId"] in accounts
                 and row.get("paydayDate") == when and row["date"] <= when
                 and row["amountCents"] > 0 and row["id"] not in corrected), None)


def dated_spending(
    snapshot: dict[str, Any], owners: set[str], start: date, end: date,
    purchase_first_dates: dict[str, str] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Resolve saved spending once, retaining source links and unresolved overlaps."""
    as_of = start.isoformat()
    purchases = {row["id"]: row for row in snapshot.get("assetPurchases", []) if row["entityId"] in owners}
    obligations = {row["id"]: row for row in snapshot.get("obligations", []) if row["entityId"] in owners}
    accounts = {row["id"]: row for row in snapshot.get("accounts", [])}
    transactions = {row["id"]: row for row in snapshot.get("transactions", [])}
    corrected = {row.get("reversalOf") for row in transactions.values()}
    missing: list[dict[str, str]] = []
    events: list[dict[str, Any]] = []
    linked: set[str] = set()
    remaining = {identity: None if row["paidCents"] is None else max(0, row["targetCents"] - row["paidCents"])
                 for identity, row in purchases.items()}

    def need(field: str, message: str, section: str, source_id: str) -> None:
        if not any(item["field"] == field for item in missing):
            missing.append({"field": field, "message": message, "section": section, "sourceId": source_id})

    for obligation in obligations.values():
        identity = obligation.get("assetPurchaseId")
        if identity is None or obligation["status"] == "cancelled":
            continue
        purchase = purchases.get(identity)
        if purchase is None or purchase["entityId"] != obligation["entityId"] or obligation["direction"] != "out":
            raise ValueError("A purchase payment must link to a purchase belonging to the bill's owner.")
        if obligation["status"] == "planned" or obligation["recurrence"] != "once":
            linked.add(identity)

    for row in upcoming(snapshot, "all", as_of, (end - start).days - 1):
        if row["entityId"] not in owners or row["direction"] != "out":
            continue
        original = obligations[row["id"]]
        amount = row["amountCents"]
        identity = row.get("assetPurchaseId")
        if identity:
            left = remaining[identity]
            amount = None if left is None else min(amount, left)
            if left is not None:
                remaining[identity] -= amount
        events.append({"sourceType": "obligation", "sourceId": row["id"], "entityId": row["entityId"],
                       "name": row["name"], "date": row["occurrenceDate"], "amountCents": amount,
                       "accountId": row.get("accountId") or None,
                       "isProjection": row["occurrenceDate"] != original["dueDate"],
                       "includedInCashflow": amount is not None,
                       "assetPurchaseId": identity,
                       "note": "Linked purchase payment, capped at the confirmed remaining cost." if identity
                       else "Repeats your saved schedule." if row["occurrenceDate"] != original["dueDate"]
                       else "Recorded bill."})

    bill_keys = {(row["entityId"], row["date"], normalized_category(row["name"]), row["amountCents"])
                 for row in events if row["sourceType"] == "obligation"}
    recorded_keys = {(accounts[row["accountId"]]["entityId"], row["date"],
                      normalized_category(row.get("description", "")), row["amountCents"])
                     for row in transactions.values() if row["kind"] == "expense"
                     and row["accountId"] in accounts and row["date"] <= as_of
                     and row["amountCents"] > 0 and row["id"] not in corrected}
    for item in snapshot.get("expensePlanItems", []):
        if item["entityId"] not in owners or item["date"] >= end.isoformat():
            continue
        amount = item["amountCents"]
        obligation_id, transaction_id = item.get("obligationId"), item.get("transactionId")
        if obligation_id and transaction_id:
            raise ValueError("Link an expense plan to a bill or a recorded expense, not both.")
        explicit = bool(obligation_id or transaction_id)
        if obligation_id:
            bill = obligations.get(obligation_id)
            if bill is None or bill["entityId"] != item["entityId"] or bill["direction"] != "out":
                raise ValueError("An expense plan must link to an outgoing bill belonging to its owner.")
            if bill["status"] == "cancelled":
                need(f"expensePlanItems.{item['id']}.obligationId", f"The bill linked to {item['name']} is cancelled. Review this expense plan.", "expenses", item["id"])
        if transaction_id:
            recorded = transactions.get(transaction_id)
            if (recorded is None or recorded["kind"] != "expense" or recorded["amountCents"] <= 0
                    or accounts.get(recorded["accountId"], {}).get("entityId") != item["entityId"]):
                raise ValueError("An expense plan must link to a recorded expense belonging to its owner.")
            if transaction_id in corrected:
                need(f"expensePlanItems.{item['id']}.transactionId", f"The recorded expense linked to {item['name']} was corrected. Review its replacement.", "expenses", item["id"])
        if not item["date"]:
            if not explicit:
                need(f"expensePlanItems.{item['id']}.date", f"Set a date for {item['name']} or link its bill or recorded expense. Undated plans are excluded from cash forecasts.", "expenses", item["id"])
                if amount is None:
                    need(f"expensePlanItems.{item['id']}.amountCents", f"Add the cost of {item['name']}.", "expenses", item["id"])
            continue
        if item["date"] < as_of:
            if not explicit:
                need(f"expensePlanItems.{item['id']}.date", f"Review {item['name']}, planned for {item['date']}. Link its recorded expense, choose a new date, or remove the plan.", "expenses", item["id"])
                events.append({"sourceType": "expense", "sourceId": item["id"], "entityId": item["entityId"],
                               "name": item["name"], "date": item["date"], "amountCents": amount, "accountId": None,
                               "isProjection": False, "includedInCashflow": False, "assetPurchaseId": None,
                               "note": "The planned date has passed. Excluded until you confirm whether it was paid or reschedule it."})
            continue
        separate = item.get("separatePaymentConfirmed") is True
        key = (item["entityId"], item["date"], normalized_category(item["name"]), amount)
        overlap = not explicit and not separate and key in bill_keys
        recorded_match = not explicit and not separate and key in recorded_keys
        if amount is None and not explicit:
            need(f"expensePlanItems.{item['id']}.amountCents", f"Add the cost of {item['name']} on {item['date']}.", "expenses", item["id"])
        if recorded_match:
            need(f"expensePlanItems.{item['id']}.recorded", f"{item['name']} matches a recorded expense today. Link the record or confirm a separate purchase.", "expenses", item["id"])
        if overlap:
            need(f"expensePlanItems.{item['id']}.overlap", f"{item['name']} has the same date and amount as a bill. Link the bill or confirm a separate cost.", "expenses", item["id"])
        note = "Linked to a recorded expense; already included in the saved balance." if transaction_id else (
            "Linked to a bill; the bill supplies its payment schedule." if obligation_id else
            "Possible duplicate; excluded until you link it or confirm a separate cost." if overlap or recorded_match else
            "Dated expense-plan item, additional to monthly living costs.")
        events.append({"sourceType": "expense", "sourceId": item["id"], "entityId": item["entityId"],
                       "name": item["name"], "date": item["date"], "amountCents": amount, "accountId": None,
                       "isProjection": False, "includedInCashflow": amount is not None and not (explicit or overlap or recorded_match),
                       "assetPurchaseId": None, "note": note})

    for identity, item in purchases.items():
        if item["paidCents"] is None:
            need(f"assetPurchases.{identity}.paidCents", f"Confirm how much has been paid toward {item['name']}.", "assets", identity)
            continue
        left = max(0, item["targetCents"] - item["paidCents"])
        if not left or identity in linked:
            continue
        if purchase_first_dates is None or identity not in purchase_first_dates:
            need(f"assetPurchases.{identity}.dueDate", f"Link dated payments for {item['name']} to bills. Its purchase record has no payment dates, so installments are excluded.", "assets", identity)
            continue
        if item["monthlyCents"] <= 0:
            need(f"assetPurchases.{identity}.monthlyCents", f"Confirm a positive monthly payment for {item['name']}.", "assets", identity)
            continue
        anchor = parse_date(purchase_first_dates[identity], "First modeled purchase payment")
        if anchor < start:
            raise ValueError("First modeled purchase payments cannot precede the comparison date.")
        offset = 0
        while left:
            month = next_month(anchor, offset)
            month_end = next_month(month) - timedelta(days=1)
            when = month.replace(day=min(anchor.day, month_end.day))
            if when >= end:
                break
            amount = min(left, item["monthlyCents"])
            overlap = (item["entityId"], when.isoformat(), normalized_category(item["name"]), amount) in bill_keys
            if overlap:
                need(f"assetPurchases.{identity}.billLink", f"{item['name']} matches a bill on {when.isoformat()}. Link the bill to the purchase before comparing payments.", "assets", identity)
            events.append({"sourceType": "purchase", "sourceId": identity, "entityId": item["entityId"],
                           "name": item["name"], "date": when.isoformat(), "amountCents": amount,
                           "accountId": None, "isProjection": True, "includedInCashflow": not overlap,
                           "assetPurchaseId": identity, "note": "Possible duplicate bill; link the purchase before using this installment." if overlap else "Assumed purchase installment, capped at the remaining cost."})
            left -= amount
            offset += 1
    return sorted(deepcopy(events), key=lambda row: (row["date"], row["sourceType"], row["sourceId"])), missing
