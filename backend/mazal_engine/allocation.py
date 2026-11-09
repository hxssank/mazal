from __future__ import annotations

import calendar
import copy
import math
from datetime import date, timedelta
from decimal import ROUND_FLOOR, Decimal
from typing import Any

import numpy as np
from scipy.optimize import minimize_scalar

from .dated_events import dated_spending, required_cash_buffer
from .dates import day_fraction, parse_date, pay_dates
from .debt import (
    debt_interest_parts,
    debt_repayment_kind,
    js_round,
    payment_deferral,
    required_debt_payment_cents,
)
from .feasibility import funding_feasibility
from .living_costs import living_allowances
from .scenarios import daily_growth_factor, growth_factors, scenario_day_index, scenario_definitions, setback
from .summary import debt_payments_since_statement, upcoming
from .work_schedule import pay_by_date, temporary_schedule


def _month_date(value: date, offset: int, day: int | None = None) -> date:
    index = value.year * 12 + value.month - 1 + offset
    year, month = divmod(index, 12)
    month += 1
    return date(year, month, min(day or value.day, calendar.monthrange(year, month)[1]))


def _cents(value: Any, label: str, nullable: bool = False) -> int | None:
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 10**12:
        raise ValueError(f"{label} must be nonnegative whole cents, at most 1 trillion.")
    return value


def _scope(snapshot: dict[str, Any], scope: str) -> set[str]:
    personal = {entity["id"] for entity in snapshot.get("entities", []) if entity["kind"] == "personal"}
    if scope != "all":
        if scope not in personal:
            raise ValueError("Allocation comparisons currently support personal accounts only.")
        return {scope}
    return personal


def _prepare(
    snapshot: dict[str, Any], scope: str, as_of: str, raw: dict[str, Any]
) -> tuple[dict[str, Any], list[dict[str, str]], list[str]]:
    owners = _scope(snapshot, scope)
    start = parse_date(as_of)
    roadmap = snapshot.get("roadmap") or {}
    assumptions = dict(raw)
    months = assumptions.setdefault("months", 60)
    if isinstance(months, bool) or not isinstance(months, int) or not 1 <= months <= 60:
        raise ValueError("Compare between 1 and 60 whole months.")
    assumptions.setdefault("payCents", roadmap.get("payAmountCents"))
    assumptions.setdefault("frequency", {7: 52, 14: 26}.get(roadmap.get("payEveryDays")))
    assumptions.setdefault("paydayAnchor", roadmap.get("paydayAnchor"))
    assumptions.setdefault("monthlySpendingCents", roadmap.get("monthlyEssentialsCents"))
    saved_reserve = roadmap.get("planningCashReserveCents")
    recorded_reserves = sum(reserve["amountCents"] for reserve in snapshot.get("reserves", []) if reserve["entityId"] in owners)
    assumptions.setdefault("reserveCents", max(saved_reserve, recorded_reserves) if saved_reserve is not None else None)
    assumptions.setdefault("annualReturnPercent", None)
    assumptions.setdefault("seed", 42)
    assumptions.setdefault("userInvestmentShare", 0.5)
    assumptions.setdefault("shockPercent", -30)
    assumptions.setdefault("shockMonth", min(3, months))
    missing = []
    if assumptions["frequency"] is None:
        missing.append(
            {
                "field": "frequency",
                "message": "Confirm whether regular pay is weekly, every two weeks, or monthly.",
            }
        )
    elif assumptions["frequency"] not in (12, 26, 52):
        raise ValueError("Pay frequency must be 12, 26 or 52.")
    if (
        isinstance(assumptions["seed"], bool)
        or not isinstance(assumptions["seed"], int)
        or not 0 <= assumptions["seed"] <= 2**32 - 1
    ):
        raise ValueError("Seed must be a whole number between 0 and 4294967295.")
    if (
        isinstance(assumptions["userInvestmentShare"], bool)
        or not isinstance(assumptions["userInvestmentShare"], int | float)
        or not 0 <= assumptions["userInvestmentShare"] <= 1
    ):
        raise ValueError("Your investment share must be between 0 and 1.")
    for field, label in (
        ("payCents", "Net pay per paycheck"),
        ("monthlySpendingCents", "Monthly living costs"),
        ("reserveCents", "Protected cash reserve"),
    ):
        value = _cents(assumptions[field], label, nullable=True)
        if value is None:
            missing.append(
                {"field": field, "message": f"Confirm {label.lower()}, including an explicit zero."}
            )
    if assumptions["paydayAnchor"] is None:
        missing.append({"field": "paydayAnchor", "message": "Confirm the first payday and frequency."})
    else:
        parse_date(assumptions["paydayAnchor"])
    rate = assumptions["annualReturnPercent"]
    if rate is None:
        missing.append(
            {"field": "annualReturnPercent", "message": "Enter an annual investment return assumption."}
        )
    elif (
        isinstance(rate, bool)
        or not isinstance(rate, int | float)
        or not math.isfinite(rate)
        or not -100 <= rate <= 100
    ):
        raise ValueError("Annual investment return must be between -100 and 100 percent.")
    accounts = [account for account in snapshot.get("accounts", []) if account["entityId"] in owners]
    reserves = sum(
        reserve["amountCents"] for reserve in snapshot.get("reserves", []) if reserve["entityId"] in owners
    )
    if roadmap.get("planningCashReserveCents") is not None:
        reserves = max(reserves, _cents(roadmap["planningCashReserveCents"], "Saved cash reserve"))
    if assumptions["reserveCents"] is not None and assumptions["reserveCents"] < reserves:
        missing.append(
            {
                "field": "reserveCents",
                "message": f"The reserve must cover CAD {reserves // 100:,}.{reserves % 100:02d} of recorded protected reserves.",
            }
        )
    end = _month_date(start, months)
    incoming = [
        item
        for item in upcoming(snapshot, "all", as_of, (end - start).days - 1)
        if item["entityId"] in owners and item["direction"] == "in"
    ]
    additional_ids = assumptions.get("additionalIncomeObligationIds")
    if additional_ids is None:
        if incoming:
            missing.append(
                {
                    "field": "additionalIncomeObligationIds",
                    "message": "Confirm which scheduled income entries are additional to your regular pay. The same paycheck cannot be counted twice.",
                }
            )
        additional_ids = []
    if (
        not isinstance(additional_ids, list)
        or any(not isinstance(value, str) for value in additional_ids)
        or len(set(additional_ids)) != len(additional_ids)
        or any(
            value
            not in {
                item["id"]
                for item in snapshot.get("obligations", [])
                if item["entityId"] in owners and item["direction"] == "in" and item["status"] != "cancelled"
            }
            for value in additional_ids
        )
    ):
        raise ValueError(
            "Additional income must identify distinct scheduled incoming entries in this personal plan."
        )
    assumptions["additionalIncomeObligationIds"] = additional_ids
    purchases = [item for item in snapshot.get("assetPurchases", []) if item["entityId"] in owners]
    first_dates = assumptions.get("purchaseFirstPaymentDates", {})
    if not isinstance(first_dates, dict) or any(
        value not in {item["id"] for item in purchases} for value in first_dates
    ):
        raise ValueError("Purchase payment dates must identify purchases in this personal plan.")
    first_dates = dict(first_dates)
    for item in purchases:
        if item["paidCents"] is None:
            missing.append(
                {
                    "field": f"assetPurchases.{item['id']}.paidCents",
                    "message": f"Confirm how much has been paid toward {item['name']} before allocating its remaining payments.",
                }
            )
            continue
        remaining = max(0, item["targetCents"] - item["paidCents"])
        if not remaining:
            continue
        if any(bill.get("assetPurchaseId") == item["id"] and bill["status"] != "cancelled"
               and (bill["status"] == "planned" or bill["recurrence"] != "once")
               for bill in snapshot.get("obligations", [])):
            continue
        if item["monthlyCents"] <= 0:
            missing.append(
                {
                    "field": f"assetPurchases.{item['id']}.monthlyCents",
                    "message": f"Confirm a positive monthly payment or a completed purchase for {item['name']}.",
                }
            )
            continue
        first = parse_date(first_dates.setdefault(item["id"], as_of), "First modeled purchase payment")
        if first < start:
            raise ValueError("First modeled purchase payments cannot precede the comparison date.")
    assumptions["purchaseFirstPaymentDates"] = first_dates
    income_changes = assumptions.get("incomeChanges")
    schedule = temporary_schedule(roadmap) if income_changes is None else None
    if income_changes is None:
        income_changes = []
        transition = roadmap.get("transitionDate") if roadmap.get("incomeTransitionPlanned") is not False else None
        if not schedule and transition and parse_date(transition) < end:
            future_income = roadmap.get("partTimeMonthlyIncomeCents")
            if future_income is None:
                missing.append(
                    {
                        "field": "incomeChanges",
                        "message": "Confirm take-home income after the recorded work or school transition.",
                    }
                )
            else:
                income_changes.append({"date": transition, "monthlyIncomeCents": future_income})
    if not isinstance(income_changes, list) or len(income_changes) > 60:
        raise ValueError("Use at most 60 dated income changes.")
    for event in income_changes:
        parse_date(event["date"])
        _cents(event["monthlyIncomeCents"], "Changed monthly income")
    assumptions["incomeChanges"] = sorted(income_changes, key=lambda event: event["date"])
    debts = [
        account
        for account in accounts
        if account["type"] in ("debt", "payable") and account["balanceCents"] > 0
    ]
    for debt in debts:
        terms = debt.get("debtTerms") or {}
        if debt_repayment_kind(debt) == "interest_only":
            missing.append(
                {
                    "field": f"accounts.{debt['id']}.repaymentKind",
                    "message": f"{debt['name']} requires changing interest-only payments. Allocation comparisons do not yet support that repayment rule; use its debt payoff scenario until it is supported.",
                }
            )
        repayment_start = terms.get("repaymentStartDate")
        if (
            terms.get("repaymentStatus") == "in_study"
            and repayment_start
            and repayment_start < end.isoformat()
            and terms.get("paymentDueDate")
            and terms["paymentDueDate"] < repayment_start
            and (terms.get("minimumPaymentCents") or 0) > 0
        ):
            missing.append(
                {
                    "field": f"accounts.{debt['id']}.paymentDueDate",
                    "message": f"Confirm the first payment deadline for {debt['name']} after repayment resumes on {repayment_start}.",
                }
            )
        elif (
            terms.get("paymentDueDate")
            and terms["paymentDueDate"] < as_of
            and (terms.get("minimumPaymentCents") or 0) > 0
            and payment_deferral(debt, as_of) != "deferred"
        ):
            missing.append(
                {
                    "field": f"accounts.{debt['id']}.paymentDueDate",
                    "message": f"Review the past payment deadline for {debt['name']}. Confirm what was paid and save the current minimum and next deadline.",
                }
            )
        if debt_interest_parts(debt, confirmed=True) is None:
            missing.append(
                {
                    "field": f"accounts.{debt['id']}.rate",
                    "message": f"Confirm interest terms for {debt['name']}.",
                }
            )
        if terms.get("repaymentStatus") == "in_study" and not terms.get("repaymentStartDate"):
            missing.append(
                {
                    "field": f"accounts.{debt['id']}.repaymentStartDate",
                    "message": f"Confirm when {debt['name']} resumes payments.",
                }
            )
        active = required_debt_payment_cents(debt, as_of)
        if active is None or (
            (terms.get("repaymentStartDate") or "9999") < end.isoformat()
            and terms.get("minimumPaymentCents") is None
        ):
            missing.append(
                {
                    "field": f"accounts.{debt['id']}.minimumPaymentCents",
                    "message": f"Confirm the required payment for {debt['name']}.",
                }
            )
        if (terms.get("minimumPaymentCents") or 0) > 0 and not terms.get("paymentDueDate"):
            missing.append(
                {
                    "field": f"accounts.{debt['id']}.paymentDueDate",
                    "message": f"Confirm a payment deadline for {debt['name']}.",
                }
            )
    for account in accounts:
        if account["type"] == "investment" and account["balanceCents"] < 0:
            missing.append(
                {
                    "field": f"accounts.{account['id']}.balanceCents",
                    "message": "Margin or short investment balances need a separate liability model.",
                }
            )
    if assumptions["monthlySpendingCents"] is not None:
        dates = [(start + timedelta(days=index)).isoformat() for index in range((end - start).days)]
        _allowance, unknown_payments = living_allowances(snapshot, owners, dates, assumptions["monthlySpendingCents"])
        missing.extend({"field": row["field"], "message": row["message"]} for row in unknown_payments)
    warnings = [
        "Returns are before tax, fees and inflation. Named stress cases have no assigned probabilities.",
        "Annual investment returns are effective rates compounded daily using Actual/365 Fixed. Contributions begin earning growth on the following day.",
        "This comparison allocates available cash and future income. Existing investments remain invested; asset sales and debt refinancing are excluded.",
        "Monthly living costs include scheduled spending obligations; obligations above that amount increase spending. Dated expense-plan items and purchase installments are additional costs.",
        "Only scheduled income explicitly selected as additional is added to the regular pay schedule.",
        "Income scheduled for today or earlier is excluded because it may already be in the saved cash balance.",
        "Bills and required debt payments are checked before same-day deposits. A later deposit does not remove an earlier funding gap.",
        "Future spending is modeled as cash outflow. New card borrowing and future card minimum formulas are excluded.",
        "Debt interest uses daily Actual/365 Fixed accrual, rounded cumulatively to cents. Confirm lender billing conventions.",
        "Weekly periods begin Monday. Partial weeks and months are labeled; timestamps use local calendar dates.",
        "Replacement paycheck counts use average income remaining after each stress event, less modeled spending and required payments. They exclude earlier earnings and do not predict a recovery date.",
    ]
    if schedule:
        warnings.append("Pay estimates scale full-time take-home pay by the workdays at reduced hours in each pay period.")
    for debt in debts:
        if (debt.get("debtTerms") or {}).get("minimumPaymentCents") == 0 and payment_deferral(debt, (end - timedelta(days=1)).isoformat()) != "deferred":
            warnings.append(f"{debt['name']} has a balance with a recorded $0 payment. This comparison carries $0 into future payment periods. Confirm future minimums before relying on the available cash or investment allocation.")
    family = assumptions.get("familyAssistance")
    if family is not None:
        if not isinstance(family, dict):
            raise ValueError("Family assistance needs explicit borrowing and repayment terms.")
        _cents(family.get("limitCents"), "Family borrowing limit")
        _cents(family.get("monthlyRepaymentCents"), "Monthly family repayment")
        available = parse_date(family.get("availableDate"), "Family borrowing availability")
        repay = parse_date(family.get("repaymentStartDate"), "First family repayment")
        if repay < available or family.get("monthlyRepaymentCents") == 0:
            raise ValueError(
                "Family repayments must start after availability with a positive monthly payment."
            )
        if family.get("interestFreeConfirmed") is not True:
            raise ValueError(
                "Confirm that optional family borrowing is interest-free before using this model."
            )
        warnings.append(
            "Family assistance is an optional interest-free loan, drawn only to cover unfunded required payments; repayments remain liabilities."
        )
    if any(
        asset["entityId"] in owners
        and asset.get("status") != "sold"
        and asset.get("estimatedValueCents") is None
        for asset in snapshot.get("assets", [])
    ):
        warnings.append("Physical assets without a resale estimate are excluded from projected net worth.")
    if any(purchase["entityId"] in owners for purchase in snapshot.get("assetPurchases", [])):
        warnings.append(
            "Purchase installments are additional cash outflows capped at the confirmed remaining cost. Their first modeled dates are explicit assumptions; the default is today, then monthly. Purchase payments and paid cost are not resale values, so purchase book equity is excluded from opening projected net worth unless a separate resale estimate is recorded."
        )
    if any((debt.get("debtTerms") or {}).get("components") for debt in debts):
        warnings.append(
            "Payments between debt components follow their balance shares; lender allocation may differ."
        )
    _spending, spending_missing = dated_spending(snapshot, owners, start, end, assumptions["purchaseFirstPaymentDates"])
    fields = {row["field"] for row in missing}
    missing.extend(row for row in spending_missing if row["field"] not in fields)
    assumptions["recordedReserveCents"] = reserves
    assumptions["spendingIncludesObligations"] = True
    return (
        {
            "owners": owners,
            "accounts": accounts,
            "debts": debts,
            "start": start,
            "end": end,
            "assumptions": assumptions,
            "workSchedule": schedule,
        },
        missing,
        warnings,
    )


def _accrue_parts(parts: list[dict[str, Any]], accrual: list[float], fraction: float) -> int:
    interest = 0
    for index, part in enumerate(parts):
        accrual[index] += part["balanceCents"] * part["aprPercent"] / 100 * fraction
        posted = js_round(accrual[index])
        accrual[index] -= posted
        part["balanceCents"] += posted
        interest += posted
    return interest


def _repay_parts(parts: list[dict[str, Any]], before: int, payment: int) -> None:
    if not before:
        return
    balance = remaining = before - payment
    for index, part in enumerate(parts):
        after = remaining if index == len(parts) - 1 else part["balanceCents"] * balance // before
        part["balanceCents"] = after
        remaining -= after


def _funding_minimums(debts: list[dict[str, Any]], day_fractions: list[float], minimums: np.ndarray) -> np.ndarray:
    capped = minimums.copy()
    for debt_index, debt in enumerate(debts):
        parts = copy.deepcopy(debt_interest_parts(debt, confirmed=True))
        accrual = [0.0] * len(parts)
        balance = debt["balanceCents"]
        for offset, fraction in enumerate(day_fractions):
            balance += _accrue_parts(parts, accrual, fraction)
            payment = min(balance, int(capped[offset, debt_index]))
            capped[offset, debt_index] = payment
            _repay_parts(parts, balance, payment)
            balance -= payment
    return capped


def _calendar(snapshot: dict[str, Any], prepared: dict[str, Any]) -> dict[str, Any]:
    start, end, owners = prepared["start"], prepared["end"], prepared["owners"]
    assumptions = prepared["assumptions"]
    days = [start + timedelta(days=index) for index in range((end - start).days)]
    dates = [day.isoformat() for day in days]
    index = {value: offset for offset, value in enumerate(dates)}
    payday_set = pay_dates(start + timedelta(days=1), end, parse_date(assumptions["paydayAnchor"]), assumptions["frequency"])
    schedule = prepared["workSchedule"]
    pay = (pay_by_date(assumptions["payCents"], payday_set, assumptions["frequency"],
                       parse_date(assumptions["paydayAnchor"]), schedule)
           if schedule else dict.fromkeys(payday_set, assumptions["payCents"]))
    for event in assumptions["incomeChanges"]:
        equivalent_pay = math.floor(event["monthlyIncomeCents"] * 12 / assumptions["frequency"] + 0.5)
        for value in payday_set:
            if value >= event["date"]:
                pay[value] = equivalent_pay
    income = np.array([pay.get(value, 0) for value in dates], dtype=np.int64)
    expenses = np.zeros(len(days), dtype=np.int64)
    for obligation in upcoming(snapshot, "all", start.isoformat(), len(days) - 1):
        if (obligation["entityId"] not in owners or obligation["direction"] != "in"
                or obligation["id"] not in assumptions["additionalIncomeObligationIds"]):
            continue
        occurrence = obligation["occurrenceDate"]
        if occurrence > start.isoformat():
            income[index[occurrence]] += obligation["amountCents"]
    spending, _missing = dated_spending(snapshot, owners, start, end, assumptions["purchaseFirstPaymentDates"])
    for event in spending:
        if event["includedInCashflow"]:
            expenses[index[max(event["date"], start.isoformat())]] += event["amountCents"]
    allowance, _unknown_payments = living_allowances(snapshot, owners, dates, assumptions["monthlySpendingCents"])
    for value, amount in allowance.items():
        expenses[index[value]] += amount
    debts = prepared["debts"]
    day_fractions = [day_fraction(day, day + timedelta(days=1)) for day in days] if debts else []
    minimums = np.zeros((len(days), len(debts)), dtype=np.int64)
    for debt_index, debt in enumerate(debts):
        terms = debt["debtTerms"]
        if not terms.get("paymentDueDate") or not terms.get("minimumPaymentCents"):
            continue
        anchor = parse_date(terms["paymentDueDate"])
        current_minimum = max(0, terms["minimumPaymentCents"] - debt_payments_since_statement(snapshot, debt, start.isoformat()))
        one_off = (
            terms.get("repaymentKind") == "one_off"
            or debt["type"] == "payable"
            and not terms.get("repaymentKind")
        )
        occurrence = anchor
        offset = 0
        if anchor < start and not one_off:
            offset = max(0, (start.year - anchor.year) * 12 + start.month - anchor.month)
            occurrence = _month_date(anchor, offset)
            if occurrence < start:
                offset += 1
                occurrence = _month_date(anchor, offset)
        while occurrence < end:
            active_date = max(occurrence, start)
            if payment_deferral(debt, active_date.isoformat()) == "repaying":
                minimums[index[active_date.isoformat()], debt_index] = current_minimum if occurrence == anchor else terms["minimumPaymentCents"]
            if one_off:
                break
            offset += 1
            occurrence = _month_date(anchor, offset)
    return {
        "days": days,
        "dates": dates,
        "dayFractions": day_fractions,
        "income": income,
        "expenses": expenses,
        "minimums": minimums,
        "fundingMinimums": _funding_minimums(debts, day_fractions, minimums),
        "paydays": payday_set,
        "payByDate": pay,
    }


def _fixed_assets(snapshot: dict[str, Any], prepared: dict[str, Any]) -> int:
    owners = prepared["owners"]
    accounts = prepared["accounts"]
    total = sum(account["balanceCents"] for account in accounts if account["type"] == "receivable")
    total -= sum(
        account["balanceCents"]
        for account in accounts
        if account["type"] in ("debt", "payable") and account["balanceCents"] < 0
    )
    for asset in snapshot.get("assets", []):
        if (
            asset["entityId"] in owners
            and asset["status"] != "sold"
            and asset["estimatedValueCents"] is not None
        ):
            total += max(0, asset["estimatedValueCents"] - asset["feesCents"])
    for item in snapshot.get("moneyOwed", []):
        if item["entityId"] in owners and not any(account["id"] == item["id"] for account in accounts):
            total += max(0, item["amountCents"] - sum(payment["amountCents"] for payment in item["payments"]))
    return total


def _checkpoints(rows: list[dict[str, Any]], monthly: bool = False) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        current = parse_date(row["date"])
        key = (
            current.isoformat()[:7] if monthly else (current - timedelta(days=current.weekday())).isoformat()
        )
        groups.setdefault(key, []).append(row)
    result = []
    for key, period in groups.items():
        start, end = parse_date(period[0]["date"]), parse_date(period[-1]["date"])
        expected = calendar.monthrange(start.year, start.month)[1] if monthly else 7
        checkpoint = {
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "partial": len(period) != expected,
            "openingCashCents": period[0]["openingCashCents"],
            "closingCashCents": period[-1]["cashCents"],
            "debtCents": period[-1]["debtCents"],
            "investmentsCents": period[-1]["investmentsCents"],
            "netWorthCents": period[-1]["netWorthCents"],
            "unfundedCents": period[-1]["unfundedCents"],
            "maxUnfundedCents": max(max(row["unfundedCents"], row.get("beforeIncomeUnfundedCents", 0)) for row in period),
        }
        for name in (
            "incomeCents",
            "spendingCents",
            "requiredDebtCents",
            "extraDebtCents",
            "investmentCents",
            "interestCents",
        ):
            checkpoint[name] = sum(row[name] for row in period)
        if monthly:
            checkpoint["month"] = key
        result.append(checkpoint)
    return result


def _simulate(
    snapshot: dict[str, Any],
    prepared: dict[str, Any],
    schedule: dict[str, Any],
    share: float | None,
    scenario: dict[str, Any],
    detailed: bool = True,
) -> dict[str, Any]:
    assumptions = prepared["assumptions"]
    dates, days = schedule["dates"], schedule["days"]
    day_fractions = schedule["dayFractions"]
    income = schedule["income"].copy()
    if scenario.get("delayFirstPayDays"):
        first = next((offset for offset, value in enumerate(dates) if value in schedule["paydays"]), None)
        if first is not None:
            # The stress shifts only the known paycheck, not another incoming obligation on that day.
            amount = schedule["payByDate"][dates[first]]
            income[first] -= amount
            target = first + scenario["delayFirstPayDays"]
            if target < len(income):
                income[target] += amount
    expenses = schedule["expenses"].copy()
    if scenario.get("unexpectedExpenseCents"):
        event_index = scenario_day_index(dates, scenario["shockMonth"])
        if event_index is not None:
            expenses[event_index] += scenario["unexpectedExpenseCents"]
    factors = growth_factors(dates, assumptions["annualReturnPercent"], scenario)
    daily_factor = daily_growth_factor(assumptions["annualReturnPercent"])
    debt_sources = prepared["debts"]
    balances = [debt["balanceCents"] for debt in debt_sources]
    parts = [copy.deepcopy(debt_interest_parts(debt, confirmed=True)) for debt in debt_sources]
    accrual = [[0.0] * len(debt_parts) for debt_parts in parts]
    past_due = [0] * len(balances)
    cash = sum(account["balanceCents"] for account in prepared["accounts"] if account["type"] == "cash")
    investments = sum(
        account["balanceCents"] for account in prepared["accounts"] if account["type"] == "investment"
    )
    investment_value = float(investments)
    fixed_assets = _fixed_assets(snapshot, prepared)
    unpaid = max(0, -cash)
    cash = max(0, cash)
    initial_net_worth = cash + investments + fixed_assets - sum(balances) - unpaid
    total_interest = total_contributions = total_income = total_expenses = 0
    total_investment_growth = shock_loss = 0
    shock_index = scenario_day_index(dates, scenario["shockMonth"])
    replacement_start = (
        next((offset for offset, value in enumerate(dates) if value in schedule["paydays"]), len(dates))
        if scenario.get("delayFirstPayDays")
        else shock_index
        if shock_index is not None
        else len(dates)
    )
    replacement_income = replacement_expenses = replacement_required = replacement_paychecks = 0
    minimum_cash = cash - unpaid
    maximum_unfunded = unpaid
    maximum_reserve_gap = max(0, assumptions["reserveCents"] - cash)
    debt_free = prepared["start"].isoformat() if not any(balances) else None
    family = assumptions.get("familyAssistance")
    family_balance = family_due = family_drawn = 0
    rows = []
    allocation_dates = sorted(
        {0} | {index for index, value in enumerate(dates) if value in schedule["paydays"]}
    )
    # The policy knows scheduled bills and paydays, never the scenario's future shocks or delayed income.
    next_allocation = {
        offset: next((other for other in allocation_dates if other > offset), len(dates))
        for offset in allocation_dates
    }

    def pay_debt(debt_index: int, amount: int) -> int:
        payment = min(max(0, amount), balances[debt_index])
        before = balances[debt_index]
        _repay_parts(parts[debt_index], before, payment)
        balances[debt_index] -= payment
        return payment

    for offset, current in enumerate(days):
        opening_cash = cash
        interest_today = 0
        for debt_index, debt_parts in enumerate(parts):
            posted = _accrue_parts(debt_parts, accrual[debt_index], day_fractions[offset])
            balances[debt_index] += posted
            interest_today += posted
        total_interest += interest_today
        before_growth = investments
        before_value = investment_value
        investment_value *= factors[offset]
        investments = js_round(investment_value)
        total_investment_growth += investments - before_growth
        if offset == shock_index and scenario["shockPercent"] < 0:
            growth_only = js_round(before_value * daily_factor)
            shock_loss = max(0, growth_only - investments)
        if family:
            first_repayment = parse_date(family["repaymentStartDate"])
            repay_date = current.replace(
                day=min(first_repayment.day, calendar.monthrange(current.year, current.month)[1])
            )
            if current >= first_repayment and current == repay_date:
                family_due = min(family_balance, family_due + family["monthlyRepaymentCents"])
            required_debt = sum(
                min(balance, past_due[debt_index] + int(schedule["minimums"][offset, debt_index]))
                for debt_index, balance in enumerate(balances)
            )
            needs = unpaid + int(expenses[offset]) + required_debt
            if current.isoformat() >= family["availableDate"] and current < first_repayment:
                draw = min(max(0, needs - cash), max(0, family["limitCents"] - family_drawn))
                cash += draw
                family_balance += draw
                family_drawn += draw
        spending = int(expenses[offset])
        total_expenses += spending
        unpaid += spending
        for debt_index in range(len(balances)):
            past_due[debt_index] = min(
                balances[debt_index], past_due[debt_index] + int(schedule["minimums"][offset, debt_index])
            )

        def settle_required() -> int:
            nonlocal cash, unpaid, family_balance, family_due
            paid_spending = min(cash, unpaid)
            cash -= paid_spending
            unpaid -= paid_spending
            paid_debt = 0
            for debt_index in range(len(balances)):
                payment = pay_debt(debt_index, min(cash, past_due[debt_index]))
                past_due[debt_index] -= payment
                cash -= payment
                paid_debt += payment
            family_payment = min(cash, family_due)
            family_balance -= family_payment
            family_due -= family_payment
            cash -= family_payment
            return paid_debt + family_payment

        required = settle_required()
        before_income_unfunded = unpaid + sum(past_due) + family_due
        before_income_cash = cash - before_income_unfunded
        minimum_cash = min(minimum_cash, before_income_cash)
        maximum_unfunded = max(maximum_unfunded, before_income_unfunded)
        maximum_reserve_gap = max(maximum_reserve_gap, assumptions["reserveCents"] - before_income_cash)
        cash += int(income[offset])
        total_income += int(income[offset])
        required += settle_required()
        if offset >= replacement_start:
            replacement_income += int(income[offset])
            replacement_expenses += spending
            replacement_required += required
            replacement_paychecks += dates[offset] in schedule["paydays"]
        extra = contribution = 0
        if offset in next_allocation and not unpaid and not any(past_due) and not family_due:
            until = next_allocation[offset]
            future_income = schedule["income"][offset + 1 : until + 1]
            future_required = schedule["expenses"][offset + 1 : until + 1].copy()
            for debt_index, balance in enumerate(balances):
                if balance:
                    future_required += schedule["fundingMinimums"][offset + 1 : until + 1, debt_index]
            if family and family_balance:
                left = family_balance
                first_repayment = parse_date(family["repaymentStartDate"])
                for future_index, future_day in enumerate(days[offset + 1 : until + 1]):
                    repayment_day = min(
                        first_repayment.day, calendar.monthrange(future_day.year, future_day.month)[1]
                    )
                    if future_day >= first_repayment and future_day.day == repayment_day:
                        due = min(left, family["monthlyRepaymentCents"])
                        future_required[future_index] += due
                        left -= due
            buffer = required_cash_buffer(future_income.tolist(), future_required.tolist())
            available = max(0, cash - assumptions["reserveCents"] - buffer)
            if share is not None:
                extra_target = int(
                    (Decimal(available) * (1 - Decimal(str(share)))).to_integral_value(rounding=ROUND_FLOOR)
                )
                ranking = sorted(
                    range(len(balances)),
                    key=lambda item: (
                        -sum(part["balanceCents"] * part["aprPercent"] for part in parts[item])
                        / max(1, balances[item])
                    ),
                )
                for debt_index in ranking:
                    amount = pay_debt(debt_index, extra_target - extra)
                    cash -= amount
                    extra += amount
                contribution = available - extra
                cash -= contribution
                investments += contribution
                investment_value += contribution
                total_contributions += contribution
        debt = sum(balances) + family_balance
        unfunded = unpaid + sum(past_due) + family_due
        minimum_cash = min(minimum_cash, cash)
        maximum_unfunded = max(maximum_unfunded, unfunded)
        maximum_reserve_gap = max(maximum_reserve_gap, assumptions["reserveCents"] - cash)
        net_worth = cash + investments + fixed_assets - debt - unpaid
        if max(abs(net_worth), cash, investments, debt, unpaid) > 9_007_199_254_740_991:
            raise ValueError("Projection amounts exceed the supported exact-cent range.")
        if debt:
            debt_free = None
        elif debt_free is None:
            debt_free = current.isoformat()
        if detailed:
            rows.append(
                {
                    "date": dates[offset],
                    "openingCashCents": opening_cash,
                    "cashCents": cash,
                    "incomeCents": int(income[offset]),
                    "spendingCents": spending,
                    "requiredDebtCents": required,
                    "extraDebtCents": extra,
                    "investmentCents": contribution,
                    "interestCents": interest_today,
                    "debtCents": debt,
                    "investmentsCents": investments,
                    "netWorthCents": net_worth,
                    "unfundedCents": unfunded,
                    "beforeIncomeUnfundedCents": before_income_unfunded,
                }
            )
    free_per_pay = (
        max(0, (replacement_income - replacement_expenses - replacement_required) // replacement_paychecks)
        if replacement_paychecks
        else 0
    )
    return {
        "netWorthCents": net_worth,
        "openingNetWorthCents": initial_net_worth,
        "totalInvestmentContributionsCents": total_contributions,
        "totalInterestCents": total_interest,
        "investmentGrowthCents": total_investment_growth,
        "shockLossCents": shock_loss,
        "totalIncomeCents": total_income,
        "totalSpendingCents": total_expenses,
        "lowestCashCents": minimum_cash,
        "maxUnfundedCents": maximum_unfunded,
        "endingUnfundedExpenseCents": unpaid,
        "reserveGapCents": maximum_reserve_gap,
        "familyBorrowedCents": family_drawn,
        "familyBalanceCents": family_balance,
        "debtFreeDate": debt_free,
        "eligible": maximum_unfunded == 0 and maximum_reserve_gap == 0,
        "replaceablePerPaycheckCents": free_per_pay,
        "weekly": _checkpoints(rows) if detailed else [],
        "monthly": _checkpoints(rows, monthly=True) if detailed else [],
    }


def readiness(snapshot: dict[str, Any], scope: str, as_of: str, assumptions: dict[str, Any]) -> dict[str, Any]:
    _prepared, missing, warnings = _prepare(snapshot, scope, as_of, assumptions)
    return {"ready": not missing, "missingInputs": missing, "warnings": warnings}


def compare(snapshot: dict[str, Any], scope: str, as_of: str, assumptions: dict[str, Any]) -> dict[str, Any]:
    """Compare explicit funding rules on one immutable personal snapshot."""
    prepared, missing, warnings = _prepare(snapshot, scope, as_of, assumptions)
    scenario_cases = scenario_definitions(prepared["assumptions"])
    if prepared["assumptions"]["shockMonth"] > prepared["assumptions"]["months"]:
        raise ValueError("The shock month must fall inside the comparison horizon.")
    result: dict[str, Any] = {
        "status": "needs_inputs" if missing else "ready",
        "missingInputs": missing,
        "warnings": warnings,
        "assumptions": prepared["assumptions"],
        "policies": [],
        "bestPolicyId": None,
        "feasibility": None,
        "comparisonNote": "Best tested base-case policy under your stated return and cash constraints. Stress cases are not probabilities or a risk-approved recommendation.",
        "spendingAnalysis": None,
    }
    if missing:
        return result
    schedule = _calendar(snapshot, prepared)
    near_days = min(90, len(schedule["dates"]))
    starting_cash = sum(
        account["balanceCents"] for account in prepared["accounts"] if account["type"] == "cash"
    )
    required = schedule["expenses"] + np.sum(schedule["fundingMinimums"], axis=1)
    result["feasibility"] = funding_feasibility(
        starting_cash,
        schedule["income"][:near_days].tolist(),
        required[:near_days].tolist(),
        prepared["assumptions"]["reserveCents"],
    )
    cache: dict[float, dict[str, Any]] = {}

    def evaluate(share: float) -> dict[str, Any]:
        value = round(float(share), 5)
        if value not in cache:
            cache[value] = _simulate(snapshot, prepared, schedule, value, scenario_cases[0], detailed=False)
        return cache[value]

    def objective(share: float) -> float:
        candidate = evaluate(share)
        return (
            -candidate["netWorthCents"] + (candidate["maxUnfundedCents"] + candidate["reserveGapCents"]) * 100
        )

    rng = np.random.default_rng(prepared["assumptions"]["seed"])
    for share in np.concatenate((np.linspace(0, 1, 9), rng.uniform(0, 1, 4))):
        evaluate(float(share))
    optimization = minimize_scalar(
        objective, bounds=(0, 1), method="bounded", options={"maxiter": 12, "xatol": 0.005}
    )
    evaluate(float(optimization.x))
    chosen = min(cache, key=objective)
    policies = [
        ("cash", "Hold surplus cash", None),
        ("debt", "Debt first, then invest", 0.0),
        ("invest", "Invest surplus", 1.0),
        ("mixed", "Split debt and investing", 0.5),
        ("custom", "Your allocation", prepared["assumptions"]["userInvestmentShare"]),
        ("searched", "Best searched split", chosen),
    ]
    for policy_id, name, share in policies:
        policy = _simulate(snapshot, prepared, schedule, share, scenario_cases[0])
        policy.update({"id": policy_id, "name": name, "investmentShare": share, "scenarios": []})
        for scenario in scenario_cases[1:]:
            simulated = _simulate(snapshot, prepared, schedule, share, scenario, detailed=False)
            loss = policy["netWorthCents"] - simulated["netWorthCents"]
            policy["scenarios"].append(
                {
                    "id": scenario["id"],
                    "name": scenario["name"],
                    "netWorthCents": simulated["netWorthCents"],
                    "lossVsBaseCents": loss,
                    "shockLossCents": simulated["shockLossCents"],
                    "investmentGrowthCents": simulated["investmentGrowthCents"],
                    "maxUnfundedCents": simulated["maxUnfundedCents"],
                    "reserveGapCents": simulated["reserveGapCents"],
                    "paychecksToReplace": setback(loss, simulated["replaceablePerPaycheckCents"]),
                }
            )
        result["policies"].append(policy)
    eligible = [policy for policy in result["policies"] if policy["eligible"]]
    if eligible:
        result["bestPolicyId"] = max(eligible, key=lambda policy: policy["netWorthCents"])["id"]
    result["search"] = {
        "method": "SciPy bounded scalar search plus seeded grid candidates",
        "candidateCount": len(cache),
        "seed": prepared["assumptions"]["seed"],
        "converged": bool(optimization.success),
        "objective": "base_case_terminal_net_worth",
    }
    if not optimization.success:
        reason = (
            "hit its iteration limit" if optimization.get("status") == 1 else "stopped without convergence"
        )
        result["warnings"].append(
            f"The allocation search {reason}. The comparison uses the best tested split."
        )
    cash_benchmark = result["policies"][0]["netWorthCents"]
    cash_scenarios = {case["id"]: case for case in result["policies"][0]["scenarios"]}
    for policy in result["policies"]:
        policy["differenceVsCashCents"] = policy["netWorthCents"] - cash_benchmark
        for case in policy["scenarios"]:
            case["differenceVsCashCents"] = (
                case["netWorthCents"] - cash_scenarios[case["id"]]["netWorthCents"]
            )
    return result
