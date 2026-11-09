from __future__ import annotations

import calendar
import math
import re
import unicodedata
from copy import deepcopy
from datetime import timedelta
from typing import Any

from .dates import next_month, parse_date
from .debt import checked_cents, debt_overview, effective_debt_apr, js_round


def normalized_category(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value).strip().lower())


def add_cents(total: int, amount: int) -> int:
    total = checked_cents(total, "Money total", signed=True)
    amount = checked_cents(amount, "Money amount", signed=True)
    return checked_cents(total + amount, "Money total", signed=True)


def recorded_debt_payments_cents(
    snapshot: dict[str, Any], account: dict[str, Any], as_of: str, after: str | None = None,
) -> int:
    if after is not None:
        parse_date(after, "Statement date")
    paid = 0
    for transaction in snapshot.get("transactions", []):
        posted = transaction.get("postingDates", {}).get(account["id"], transaction.get("postingDate", transaction["date"]))
        if posted > as_of or after is not None and posted <= after:
            continue
        if transaction["kind"] == "debt_payment" and transaction.get("toAccountId") == account["id"]:
            paid = add_cents(paid, transaction["amountCents"])
        elif (
            transaction["kind"] == "adjustment"
            and transaction["accountId"] == account["id"]
            and (transaction.get("statementId") or transaction.get("importSources"))
            and normalized_category(transaction.get("category", "")) == "card payment"
        ):
            movement = transaction.get("balanceChanges", {}).get(account["id"])
            if movement is None and transaction.get("statementId"):
                movement = -abs(transaction["amountCents"])
            paid = add_cents(paid, -(movement or 0))
    return paid


def debt_payments_since_statement(snapshot: dict[str, Any], account: dict[str, Any], as_of: str) -> int:
    statement = (account.get("debtTerms") or {}).get("statementDate")
    if not statement:
        return 0
    return max(0, recorded_debt_payments_cents(snapshot, account, as_of, statement))


def weighted_cents(amount: int, ownership_bps: int) -> int:
    amount = checked_cents(amount, "Money amount", signed=True)
    ownership_bps = checked_cents(ownership_bps, "Ownership basis points", maximum=10000)
    return ((abs(amount) * ownership_bps + 5000) // 10000) * (-1 if amount < 0 else 1)


def upcoming(snapshot: dict[str, Any], scope: str, as_of: str, days: int = 90) -> list[dict[str, Any]]:
    start = parse_date(as_of, "As-of date")
    if isinstance(days, bool) or not isinstance(days, int) or not 0 <= days <= 3660:
        raise ValueError("Choose a forecast period between 0 and 3,660 whole days.")
    end = start + timedelta(days=days)
    result = []
    paid_occurrences = {
        (payment["obligationId"], payment["dueDate"])
        for transaction in snapshot.get("transactions", [])
        if isinstance(payment := transaction.get("plannedPayment"), dict)
    }
    for obligation in snapshot.get("obligations", []):
        if obligation["status"] == "cancelled" or scope != "all" and obligation["entityId"] != scope:
            continue
        anchor = parse_date(obligation["dueDate"], "Obligation date")
        if anchor > end:
            continue
        if obligation["status"] == "planned" and (obligation["id"], obligation["dueDate"]) not in paid_occurrences:
            result.append({**deepcopy(obligation), "occurrenceDate": obligation["dueDate"]})
        recurrence = obligation["recurrence"]
        if recurrence == "once":
            continue
        if recurrence not in ("monthly", "biweekly"):
            raise ValueError("Choose a supported obligation recurrence.")
        offset = max(
            1,
            (start.year - anchor.year) * 12 + start.month - anchor.month
            if recurrence == "monthly"
            else (start - anchor).days // 14,
        )
        while True:
            if recurrence == "monthly":
                month = next_month(anchor, offset)
                recurrence_day = obligation.get("recurrenceDay") or anchor.day
                occurrence = month.replace(
                    day=min(recurrence_day, calendar.monthrange(month.year, month.month)[1])
                )
            else:
                occurrence = anchor + timedelta(days=offset * 14)
            if occurrence > end:
                break
            if occurrence >= start and (obligation["id"], occurrence.isoformat()) not in paid_occurrences:
                result.append(
                    {
                        **deepcopy(obligation),
                        "dueDate": occurrence.isoformat(),
                        "occurrenceDate": occurrence.isoformat(),
                        "status": "planned",
                    }
                )
            offset += 1
    return sorted(result, key=lambda row: (row["dueDate"], row["name"], row["id"]))


def recorded_summary(snapshot: dict[str, Any], scope: str, as_of: str) -> dict[str, int]:
    parse_date(as_of, "As-of date")
    entities = {owner["id"]: owner for owner in snapshot.get("entities", [])}
    personal_ids = {owner["id"] for owner in entities.values() if owner["kind"] == "personal"}

    def included(owner: str) -> bool:
        return scope == "all" or owner == scope

    def weighted(amount: int, owner: str) -> int:
        return (
            weighted_cents(amount, entities.get(owner, {}).get("ownershipBps", 0))
            if scope == "all"
            else amount
        )

    result = dict.fromkeys(
        (
            "assetsCents",
            "liabilitiesCents",
            "netWorthCents",
            "cashCents",
            "investmentsCents",
            "receivablesCents",
            "physicalAssetsCents",
            "purchaseEquityCents",
            "availableCents",
            "reservedCents",
            "committedCents",
            "incomeCents",
            "expensesCents",
            "personalAvailableCents",
        ),
        0,
    )

    def add(field: str, amount: int) -> None:
        result[field] = add_cents(result[field], amount)

    accounts = {account["id"]: account for account in snapshot.get("accounts", [])}
    for account in accounts.values():
        owner = account["entityId"]
        kind = account["type"]
        balance = checked_cents(account["balanceCents"], "Account balance", signed=True)
        if owner in personal_ids and kind == "cash":
            add("personalAvailableCents", balance)
        if not included(owner):
            continue
        balance = weighted(balance, owner)
        add("liabilitiesCents" if kind in ("debt", "payable") else "assetsCents", balance)
        field = {"cash": "cashCents", "investment": "investmentsCents", "receivable": "receivablesCents"}.get(
            kind
        )
        if field:
            add(field, balance)
    for tab in snapshot.get("moneyOwed", []):
        existing = accounts.get(tab["id"])
        if not included(tab["entityId"]) or (
            existing and existing["entityId"] == tab["entityId"] and existing["type"] == "receivable"
        ):
            continue
        remaining = checked_cents(tab["amountCents"], "Amount owed")
        for payment in tab.get("payments", []):
            remaining = add_cents(remaining, -checked_cents(payment["amountCents"], "Receivable payment"))
        remaining = weighted(remaining, tab["entityId"])
        add("receivablesCents", remaining)
        add("assetsCents", remaining)
    purchases = snapshot.get("assetPurchases", [])
    for purchase in purchases:
        if included(purchase["entityId"]) and purchase.get("paidCents") is not None:
            equity = weighted(purchase["paidCents"], purchase["entityId"])
            add("purchaseEquityCents", equity)
            add("assetsCents", equity)
    for asset in snapshot.get("assets", []):
        if (
            not included(asset["entityId"])
            or asset["status"] == "sold"
            or asset.get("estimatedValueCents") is None
            or any(
                purchase["id"] == asset["id"] and purchase["entityId"] == asset["entityId"]
                for purchase in purchases
            )
        ):
            continue
        estimate = add_cents(asset["estimatedValueCents"], -asset["feesCents"])
        value = weighted(max(0, estimate), asset["entityId"])
        add("physicalAssetsCents", value)
        add("assetsCents", value)
    for reserve in snapshot.get("reserves", []):
        if reserve["entityId"] in personal_ids:
            add("personalAvailableCents", -reserve["amountCents"])
        if included(reserve["entityId"]):
            add("reservedCents", weighted(reserve["amountCents"], reserve["entityId"]))
    purchase_balances = {
        purchase["id"]: None if purchase["paidCents"] is None else max(0, purchase["targetCents"] - purchase["paidCents"])
        for purchase in purchases
    }
    for obligation in upcoming(snapshot, "all", as_of, 30):
        if obligation["direction"] != "out":
            continue
        amount = obligation["amountCents"]
        purchase_id = obligation.get("assetPurchaseId")
        if purchase_id in purchase_balances:
            remaining = purchase_balances[purchase_id]
            if remaining is None:
                continue
            amount = min(amount, remaining)
            purchase_balances[purchase_id] -= amount
        if obligation["entityId"] in personal_ids:
            add("personalAvailableCents", -amount)
        if included(obligation["entityId"]):
            add("committedCents", weighted(amount, obligation["entityId"]))
    for transaction in snapshot.get("transactions", []):
        if transaction["date"][:7] != as_of[:7] or transaction["date"] > as_of:
            continue
        account = accounts.get(transaction["accountId"])
        if not account or not included(account["entityId"]):
            continue
        field = {"income": "incomeCents", "expense": "expensesCents"}.get(transaction["kind"])
        if field:
            add(field, weighted(transaction["amountCents"], account["entityId"]))
    result["netWorthCents"] = add_cents(result["assetsCents"], -result["liabilitiesCents"])
    result["availableCents"] = (
        result["personalAvailableCents"]
        if scope == "all"
        else add_cents(add_cents(result["cashCents"], -result["reservedCents"]), -result["committedCents"])
    )
    return result


def _annual_saved(account: dict[str, Any] | None, principal: int) -> int | None:
    if account is None:
        return None
    rate = effective_debt_apr(account, True)
    return (
        None
        if rate is None
        else checked_cents(
            js_round(min(max(0, principal), max(0, account["balanceCents"])) * rate / 100),
            "Annual interest saved",
        )
    )


def summary(snapshot: dict[str, Any], scope: str, as_of: str) -> dict[str, Any]:
    totals = recorded_summary(snapshot, scope, as_of)
    accounts = [
        account for account in snapshot.get("accounts", []) if scope == "all" or account["entityId"] == scope
    ]
    overview = debt_overview(accounts, as_of)
    by_id = {row["accountId"]: row for row in overview["rows"]}
    priority = by_id.get(overview["highestRateAccountId"])
    largest = by_id.get(overview["largestBalanceAccountId"])
    reduction = (
        min(100000, priority["balanceCents"], largest["balanceCents"] if largest else 100000)
        if priority
        else 0
    )
    investment_accounts = {account["id"]: account for account in accounts if account["type"] == "investment"}
    positions = [
        position for position in snapshot.get("positions", []) if position["accountId"] in investment_accounts
    ]
    positioned_ids = {position["accountId"] for position in positions}
    entities = {owner["id"]: owner for owner in snapshot.get("entities", [])}
    breakdown: dict[str, Any] = {"solValueCents": 0, "otherValueCents": 0, "positions": {}}
    for account in investment_accounts.values():
        value = (
            weighted_cents(
                account["balanceCents"], entities.get(account["entityId"], {}).get("ownershipBps", 0)
            )
            if scope == "all"
            else account["balanceCents"]
        )
        field = "solValueCents" if account["id"] in positioned_ids else "otherValueCents"
        breakdown[field] = add_cents(breakdown[field], value)
    for position in positions:
        liquid = float(position["liquidSol"] or 0)
        staked = float(position["stakedSol"] or 0)
        total = liquid + staked
        if not math.isfinite(total) or liquid < 0 or staked < 0:
            raise ValueError("Enter finite, nonnegative SOL quantities.")
        breakdown["positions"][position["id"]] = {
            "totalSol": total,
            "stakedPercent": staked / total * 100 if total else 0,
            "valueLessCostCents": add_cents(
                investment_accounts[position["accountId"]]["balanceCents"], -position["costBasisCents"]
            ),
        }
    paid = reversed_cents = 0
    for transaction in snapshot.get("transactions", []):
        if transaction["date"][:7] != as_of[:7] or transaction["date"] > as_of:
            continue
        if transaction["kind"] == "debt_payment" and transaction.get("toAccountId") in by_id:
            paid = add_cents(paid, transaction["amountCents"])
        elif (
            transaction["kind"] == "adjustment"
            and transaction["accountId"] in by_id
            and (transaction.get("statementId") or transaction.get("importSources"))
        ):
            if normalized_category(transaction.get("category", "")) != "card payment":
                continue
            movement = transaction.get("balanceChanges", {}).get(transaction["accountId"])
            if movement is None:
                movement = -abs(transaction["amountCents"]) if transaction.get("statementId") else 0
            if movement < 0:
                paid = add_cents(paid, transaction["amountCents"])
            elif movement > 0:
                reversed_cents = add_cents(reversed_cents, transaction["amountCents"])
    return {
        "summary": totals,
        "trackedAssetsCents": add_cents(
            add_cents(totals["receivablesCents"], totals["physicalAssetsCents"]),
            totals["purchaseEquityCents"],
        ),
        "debtOverview": overview,
        "investmentBreakdown": breakdown,
        "debtPaymentSummary": {"paidThisMonthCents": paid, "reversedThisMonthCents": reversed_cents},
        "priorityComparison": {
            "reductionCents": reduction,
            "priorityAnnualSavedCents": _annual_saved(priority["account"] if priority else None, reduction),
            "largestAnnualSavedCents": _annual_saved(largest["account"] if largest else None, reduction),
        },
    }
