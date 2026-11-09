from __future__ import annotations

import calendar
from datetime import date, timedelta
from typing import Any
from urllib.parse import quote

from .dated_events import cash_path, dated_spending, payday_receipt
from .dates import next_month, parse_date
from .debt import checked_cents, debt_repayment_kind, payment_deferral, required_debt_payment_cents
from .living_costs import living_allowances
from .summary import add_cents, debt_payments_since_statement, recorded_debt_payments_cents, upcoming
from .work_schedule import estimated_pay, temporary_schedule


def _total(values: list[int]) -> int:
    total = 0
    for value in values:
        total = add_cents(total, value)
    return total


def daily_plan(snapshot: dict[str, Any], scope: str, as_of: str, draft: dict[str, Any]) -> dict[str, Any]:
    start = parse_date(as_of, "Plan start")
    horizon = draft.get("days", 30)
    if set(draft) - {"days"} or isinstance(horizon, bool) or not isinstance(horizon, int) or not 7 <= horizon <= 90:
        raise ValueError("Choose a plan between 7 and 90 whole days.")
    end = start + timedelta(days=horizon - 1)
    parse_date(end.isoformat(), "Plan end")
    owners = {entity["id"] for entity in snapshot["entities"] if scope == "all" or entity["id"] == scope}
    personal = next((entity for entity in snapshot["entities"] if entity["kind"] == "personal"), None)
    accounts = [account for account in snapshot["accounts"] if account["entityId"] in owners]
    cash_accounts = [account for account in accounts if account["type"] == "cash"]
    cash = _total([account["balanceCents"] for account in cash_accounts])
    roadmap = snapshot.get("roadmap") or {}
    reserve_floor = roadmap.get("planningCashReserveCents") if personal and personal["id"] in owners else None
    if reserve_floor is not None:
        reserve_floor = checked_cents(reserve_floor, "Protected cash reserve")
    reserves = [row for row in snapshot.get("reserves", []) if row["entityId"] in owners]
    recorded_reserves = _total([checked_cents(row["amountCents"], "Protected reserve") for row in reserves])
    protected = max(recorded_reserves, reserve_floor or 0)
    missing: list[dict[str, str]] = []
    events: list[dict[str, Any]] = []
    warnings = [
        "Cash starts from saved balances. This is a dated plan, not a bank balance or permission to spend.",
        "Scheduled spending is held aside even when charged to a card. Debt payments also use cash.",
        "A past due date means the record needs review; it does not prove a payment was missed.",
    ]

    def need(field: str, message: str, section: str, source_id: str | None = None) -> None:
        if any(row["field"] == field for row in missing):
            return
        missing.append({"field": field, "message": message, "section": section, **({"sourceId": source_id} if source_id else {})})

    def add_event(
        source_type: str, source_id: str, owner: str, name: str, when: str, direction: str,
        amount: int | None, *, account_id: str | None = None, projection: bool = False,
        included: bool = True, note: str = "",
    ) -> dict[str, Any]:
        parse_date(when)
        if amount is not None:
            amount = checked_cents(amount, "Scheduled amount")
        row = {
            "id": f"{source_type}:{quote(source_id, safe='')}:{when}", "sourceType": source_type,
            "sourceId": source_id, "entityId": owner, "name": name, "date": when,
            "effectiveDate": max(as_of, when), "direction": direction, "amountCents": amount,
            "status": "overdue" if when < as_of else "today" if when == as_of else "upcoming",
            "isProjection": projection, "includedInCashflow": included and amount is not None,
            "accountId": account_id, "note": note,
        }
        events.append(row)
        return row

    if not any(not account.get("closedAt") for account in cash_accounts):
        need("cashAccounts", "Add an open cash account and confirm its balance.", "accounts")
    for account in cash_accounts:
        if account.get("closedAt") and account["balanceCents"] == 0:
            continue
        dates = [value for value in (
            account.get("reconciledAt"), (account.get("reconciliation") or {}).get("date"),
            (account.get("evidence") or {}).get("asOf"),
        ) if value]
        confirmed = max(dates) if dates else None
        if confirmed is None or confirmed > as_of or (start - parse_date(confirmed)).days > 7:
            note = f" Last confirmed {confirmed}." if confirmed else " No balance confirmation date is saved."
            need(f"accounts.{account['id']}.balance", f"Check {account['name']} before relying on the cash plan.{note}", "accounts", account["id"])
    if not recorded_reserves and reserve_floor is None:
        need("reserves", "Confirm how much cash to protect. No reserve is recorded.", "reserve")
    if len(owners) > 1:
        warnings.append("This view adds full account balances across owners. Money may need a transfer before an individual account can pay a bill.")
    elif len(cash_accounts) > 1:
        warnings.append("Cash is combined across accounts. Check the account linked to each bill; this plan does not confirm that account has enough money.")

    next_payday = None
    today_payday = None
    regular_pay = personal is not None and personal["id"] in owners
    pay_schedule_configured = False
    if regular_pay:
        amount = roadmap.get("payAmountCents")
        if amount is not None:
            amount = checked_cents(amount, "Take-home pay")
        else:
            need("payAmountCents", "Confirm take-home pay per paycheck.", "pay")
        interval = roadmap.get("payEveryDays")
        anchor_text = roadmap.get("paydayAnchor")
        if not anchor_text or isinstance(interval, bool) or not isinstance(interval, int) or not 1 <= interval <= 366:
            need("paydayAnchor", "Save a confirmed payday and pay frequency.", "pay")
        else:
            anchor = parse_date(anchor_text, "Payday")
            pay_schedule_configured = True
            offset = max(0, ((start - anchor).days + interval - 1) // interval)
            when = anchor + timedelta(days=offset * interval)
            schedule = temporary_schedule(roadmap)
            transition = roadmap.get("transitionDate") if roadmap.get("incomeTransitionPlanned") is not False and not schedule else None

            def payday_amount(day: date) -> int | None:
                if schedule and amount is not None:
                    return estimated_pay(amount, day, interval, schedule)
                return None if transition and day.isoformat() >= transition else amount

            # Today's scheduled deposit may already be part of the opening account balance.
            if when == start:
                receipt = payday_receipt(snapshot, personal["id"], as_of)
                today_amount = payday_amount(start) if schedule else amount
                today_payday = {"date": as_of, "amountCents": today_amount,
                               "receiptStatus": "recorded" if receipt else "unconfirmed",
                               **({"transactionId": receipt["id"]} if receipt else {})}
                if receipt is None:
                    need("paydayReceipt", "Payday is today. Confirm its bank receipt or link a recorded income before relying on the cash balance.", "pay", personal["id"])
                add_event("payday", personal["id"], personal["id"], "Payday", as_of, "in", today_amount,
                          projection=receipt is None, included=False,
                          note="Today's pay is recorded and already included in saved cash." if receipt else
                          "Today's pay receipt is unconfirmed. It is excluded until its bank receipt is recorded.")
                when += timedelta(days=interval)
            next_payday = {"date": when.isoformat(), "amountCents": payday_amount(when)}
            changed_income = roadmap.get("partTimeMonthlyIncomeCents")
            if transition:
                parse_date(transition, "Income change")
            if transition and transition <= end.isoformat():
                need("incomeChanges", "Review take-home pay after the saved work or school transition. Later paychecks are excluded until the new pay schedule is confirmed.", "pay")
            while when <= end:
                when_text = when.isoformat()
                changed = bool(transition and when_text >= transition)
                current_amount = payday_amount(when)
                note = "Based on your saved pay schedule."
                if changed:
                    note = "Pay after the saved income transition needs confirmation."
                elif schedule and current_amount != amount:
                    note = "Estimated from full-time take-home pay and the share of workdays at reduced hours."
                add_event("payday", personal["id"], personal["id"], "Payday", when_text, "in", current_amount,
                          projection=True, note=note)
                when += timedelta(days=interval)
            if changed_income is not None and transition and transition <= end.isoformat():
                warnings.append("A monthly income after the transition is saved, but it does not confirm the amount or date of each deposit.")

    original_bills = {row["id"]: row for row in snapshot.get("obligations", [])}
    for row in upcoming(snapshot, scope, as_of, horizon - 1):
        original = original_bills[row["id"]]
        date_text = row["occurrenceDate"]
        projected = date_text != original["dueDate"]
        included = True
        note = "Repeats your saved schedule." if projected else "Recorded bill or income."
        if row["direction"] != "in":
            continue
        if row["direction"] == "in":
            if pay_schedule_configured and row["entityId"] == personal["id"] and row.get("additionalToPay") is not True:
                included = False
                note = "Excluded from cash totals until confirmed as additional to regular pay."
                if row.get("additionalToPay") is None:
                    need(f"obligations.{row['id']}.additionalIncome", f"Check whether {row['name']} is extra income or the paycheck already on your schedule.", "pay", row["id"])
                else:
                    note = "Already included in the regular pay schedule; excluded here to avoid counting twice."
            elif date_text <= as_of:
                included = False
                note = "Past or current income is excluded because it may already be in the cash balance."
                need(f"obligations.{row['id']}.received", f"Confirm whether {row['name']} was received.", "pay", row["id"])
        elif date_text < as_of:
            note = "Still marked planned. Held aside today until you record or cancel this payment."
            need(f"obligations.{row['id']}.status", f"Review {row['name']}, still planned for {date_text}.", "expenses", row["id"])
        add_event("obligation", row["id"], row["entityId"], row["name"], date_text, row["direction"], row["amountCents"],
                  account_id=row.get("accountId") or None, projection=projected, included=included, note=note)

    spending, spending_missing = dated_spending(snapshot, owners, start, end + timedelta(days=1))
    for row in spending_missing:
        need(row["field"], row["message"], row["section"], row["sourceId"])
    for row in spending:
        when = row["date"]
        note = row["note"]
        if row["sourceType"] == "obligation" and when < as_of and row["amountCents"]:
            note = "Still marked planned. Held aside today until you record or cancel this payment."
            need(f"obligations.{row['sourceId']}.status", f"Review {row['name']}, still planned for {when}.", "expenses", row["sourceId"])
        add_event(row["sourceType"], row["sourceId"], row["entityId"], row["name"], when, "out", row["amountCents"],
                  account_id=row["accountId"], projection=row["isProjection"], included=row["includedInCashflow"], note=note)

    for account in accounts:
        if account["type"] not in ("debt", "payable") or account["balanceCents"] <= 0:
            continue
        terms = account.get("debtTerms") or {}
        status = payment_deferral(account, end.isoformat())
        if status == "deferred":
            continue
        minimum = required_debt_payment_cents(account, end.isoformat())
        if minimum is None:
            need(f"debts.{account['id']}.minimum", f"Confirm the required payment for {account['name']}.", "debts", account["id"])
        elif minimum == 0:
            warnings.append(f"{account['name']} has a balance with a recorded $0 payment. This confirms only the current payment period; future required payments need confirmation.")
        anchor_text = terms.get("paymentDueDate")
        if not anchor_text:
            need(f"debts.{account['id']}.dueDate", f"Add the next payment date for {account['name']}.", "debts", account["id"])
            continue
        repayment_start = terms.get("repaymentStartDate")
        if terms.get("repaymentStatus") == "in_study" and repayment_start and anchor_text < repayment_start:
            need(f"debts.{account['id']}.dueDate", f"Confirm the first payment deadline for {account['name']} after repayment resumes on {repayment_start}.", "debts", account["id"])
            continue
        anchor = parse_date(anchor_text, "Debt due date")
        if anchor < start and payment_deferral(account, anchor_text) == "repaying":
            need(f"debts.{account['id']}.statement", f"Refresh {account['name']}'s due date, last recorded as {anchor_text}. Confirm the current minimum and next payment date.", "debts", account["id"])
        statement_date = terms.get("statementDate")
        payment_period_unknown = (
            not statement_date and minimum is not None and minimum > 0 and anchor <= end
            and payment_deferral(account, anchor_text) == "repaying"
            and recorded_debt_payments_cents(snapshot, account, as_of) != 0
        )
        if payment_period_unknown:
            need(f"debts.{account['id']}.statementDate", f"Confirm the statement date and current minimum for {account['name']}. Without that date, recorded payment activity cannot be assigned to this payment period.", "debts", account["id"])
        current_minimum = None if minimum is None else max(0, checked_cents(minimum, "Debt minimum") - debt_payments_since_statement(snapshot, account, as_of))
        one_off = debt_repayment_kind(account) == "one_off"
        offset = 0
        while True:
            month = next_month(anchor, offset)
            when = anchor if offset == 0 else month.replace(day=min(anchor.day, calendar.monthrange(month.year, month.month)[1]))
            if when > end:
                break
            when_text = when.isoformat()
            if offset == 0 or when >= start:
                amount = current_minimum if offset == 0 else None if minimum == 0 else minimum
                if payment_deferral(account, when_text) == "repaying" and amount != 0:
                    if offset > 0 and minimum == 0:
                        need(f"debts.{account['id']}.minimum", f"Confirm future payments for {account['name']}. Its recorded $0 payment applies only to the current payment period; later payments are excluded from cash totals.", "debts", account["id"])
                    payment = None if amount is None else amount if debt_repayment_kind(account) == "interest_only" else min(account["balanceCents"], amount)
                    note = "Recorded minimum, less payments recorded after the statement date." if offset == 0 else "Repeats the recorded minimum until a payoff is recorded. Future interest and payoff timing are not modeled here."
                    if offset > 0 and minimum == 0:
                        note = "Future required payment is unknown. The recorded $0 applies only to the current payment period."
                    if offset == 0 and not statement_date:
                        note = "Recorded payment activity has not reduced this forecast because the statement date is missing." if payment_period_unknown else "Recorded minimum. No statement date is saved."
                    add_event("debt", account["id"], account["entityId"], account["name"], when_text, "out", payment,
                              account_id=account["id"], projection=offset > 0, note=note)
            if one_off:
                break
            offset = max(offset + 1, (start.year - anchor.year) * 12 + start.month - anchor.month)

    events.sort(key=lambda row: (row["date"], row["direction"] == "in", row["name"], row["id"]))
    monthly = roadmap.get("monthlyEssentialsCents") if regular_pay else None
    if monthly is None:
        need("monthlyEssentialsCents", "Confirm monthly living costs. Undated groceries, transport and other spending are excluded.", "expenses")
    else:
        checked_cents(monthly, "Monthly living costs")
        warnings.append("Monthly living costs include scheduled bills. Only the remaining allowance is spread across days. Dated expense-plan items and debt payments are additional.")
    days = [{"date": (start + timedelta(days=index)).isoformat(), "incomeCents": 0, "outflowCents": 0,
             "livingCostsCents": 0, "closingCashCents": 0, "afterProtectedCents": 0, "eventIds": []} for index in range(horizon)]
    by_date = {row["date"]: row for row in days}
    for event in events:
        row = by_date[event["effectiveDate"]]
        row["eventIds"].append(event["id"])
        if event["includedInCashflow"]:
            key = "incomeCents" if event["direction"] == "in" else "outflowCents"
            row[key] = add_cents(row[key], event["amountCents"])
    if monthly is not None:
        allowance, unknown_payments = living_allowances(snapshot, {personal["id"]}, list(by_date), monthly)
        for row in unknown_payments:
            need(row["field"], row["message"], "expenses", row["sourceId"])
        for row in days:
            row["livingCostsCents"] = allowance[row["date"]]
            row["outflowCents"] = add_cents(row["outflowCents"], row["livingCostsCents"])
    balance = cash
    lowest = cash
    lowest_date = as_of
    first_shortfall = as_of if cash < protected else None
    before_balances, closing_balances = cash_path(cash, [row["incomeCents"] for row in days], [row["outflowCents"] for row in days])
    for row, before_income, balance in zip(days, before_balances, closing_balances, strict=True):
        if before_income < protected and first_shortfall is None:
            first_shortfall = row["date"]
        if before_income < lowest:
            lowest, lowest_date = before_income, row["date"]
        row["closingCashCents"] = balance
        row["afterProtectedCents"] = add_cents(balance, -protected)
    warnings.append("Cash low points assume bills leave before a deposit on the same day. Confirm bank timing when a payday and a bill coincide.")
    before = [row for row in days if next_payday is None or row["date"] < next_payday["date"]]
    before_income = _total([row["incomeCents"] for row in before])
    before_outflow = _total([row["outflowCents"] for row in before])
    return {
        "asOf": as_of, "endDate": end.isoformat(), "horizonDays": horizon, "status": "partial" if missing else "ready",
        "cashCents": cash, "protectedCents": protected, "cashAfterKnownCents": add_cents(balance, -protected),
        "knownIncomeCents": _total([row["incomeCents"] for row in days]), "knownOutflowCents": _total([row["outflowCents"] for row in days]),
        "livingCostsCents": _total([row["livingCostsCents"] for row in days]), "lowestCashCents": lowest,
        "lowestCashDate": lowest_date, "firstShortfallDate": first_shortfall, "nextPayday": next_payday, "todayPayday": today_payday,
        "beforePayday": {"endDate": before[-1]["date"] if before else as_of, "knownIncomeCents": before_income,
                         "knownOutflowCents": before_outflow, "cashAfterKnownCents": add_cents(add_cents(add_cents(cash, before_income), -before_outflow), -protected)},
        "events": events, "days": days, "missingInputs": missing, "warnings": warnings,
    }
