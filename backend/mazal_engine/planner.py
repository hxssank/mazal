from __future__ import annotations

import math
import re
from copy import deepcopy
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from .dates import day_fraction, month_start, next_month, parse_date, pay_dates
from .debt import (
    checked_cents,
    checked_rate,
    debt_interest_parts,
    debt_repayment_kind,
    effective_debt_apr,
    js_round,
    payment_deferral,
    required_debt_payment_cents,
    td_planning_minimum_estimate,
    td_regular_minimum_estimate,
)
from .scenarios import daily_growth_factor
from .work_schedule import pay_by_date, temporary_schedule

MAX_INPUT_CENTS = 1_000_000_000_000


def _cents(value: Any, label: str, signed: bool = False) -> int:
    return checked_cents(value, label, signed, MAX_INPUT_CENTS)


def _split(amount: int, count: int, index: int) -> int:
    return amount // count + int(index < amount % count)


def _cumulative_split(amount: int, count: int, index: int) -> int:
    return amount // count * (index + 1) + min(index + 1, amount % count)


def _due_date(debt: dict[str, Any]) -> str | None:
    due = debt.get("minimumDueDate")
    return (
        None
        if due
        and debt.get("paymentsDeferred")
        and debt.get("repaymentStartDate")
        and due < debt["repaymentStartDate"]
        else due
    )


@dataclass
class _Debt:
    source: dict[str, Any]
    balance: float
    interest: float = 0
    paid: int = 0
    components: list[dict[str, Any]] | None = None


def _validated_debts(input: dict[str, Any]) -> list[_Debt]:
    values = input.get("debts")
    if not isinstance(values, list) or len(values) > 50:
        raise ValueError("Use at most 50 debts.")
    ids: set[str] = set()
    debts = []
    for original in values:
        if not isinstance(original, dict):
            raise ValueError("Every debt needs its own terms.")
        source = deepcopy(original)
        identity = source.get("id")
        if not isinstance(identity, str) or not identity or identity in ids:
            raise ValueError("Every debt needs a unique nonempty ID.")
        ids.add(identity)
        balance = _cents(source.get("balanceCents"), "Debt balance")
        if source.get("minimumCents") is not None:
            _cents(source["minimumCents"], "Monthly minimum")
        checked_rate(source.get("aprPercent"), "Debt APR", maximum=100)
        for field in ("minimumDueDate", "repaymentStartDate", "studyEndDate"):
            if source.get(field):
                parse_date(source[field], field)
        if source.get("repaymentKind") and source["repaymentKind"] not in (
            "fixed",
            "revolving",
            "interest_only",
            "one_off",
        ):
            raise ValueError("Choose a valid debt repayment kind.")
        components = source.get("components")
        if components is not None:
            if (
                not isinstance(components, list)
                or len(components) > 50
                or any(not isinstance(component, dict) for component in components)
            ):
                raise ValueError("Use at most 50 loan components, each with its own balance and APR.")
            for component in components:
                _cents(component.get("balanceCents"), "Component balance")
                checked_rate(component.get("aprPercent"), "Component APR", maximum=100)
            if sum(component["balanceCents"] for component in components) != balance:
                raise ValueError("Loan components must add up to its balance.")
        debts.append(_Debt(source, balance, components=deepcopy(components)))
    if input.get("selectedDebtId") is not None and input["selectedDebtId"] not in ids:
        raise ValueError("The selected debt must be in the plan.")
    return debts


def _initial_warnings(debts: list[_Debt]) -> list[str]:
    warnings = [
        f"Minimum payment for {debt.source['name']} is unknown. Add it before using this plan for payments."
        for debt in debts
        if debt.balance > 0 and debt.source.get("minimumCents") is None
    ]
    for debt in debts:
        if not debt.balance:
            continue
        source = debt.source
        name = source["name"]
        if source.get("minimumCents") == 0 and (not source.get("paymentsDeferred") or source.get("repaymentStartDate")):
            warnings.append(
                f"{name}: this scenario starts with a $0 minimum despite a remaining balance. Confirm future required payments before relying on the projected cash or investment allocation."
            )
        due = _due_date(source)
        if source.get("minimumDueDate") and not due:
            warnings.append(
                f"{name}: the recorded due date {source['minimumDueDate']} is before repayment resumes {source['repaymentStartDate']}. Confirm the first payment deadline after deferral."
            )
        if (
            not due
            and source.get("minimumCents")
            and (not source.get("paymentsDeferred") or source.get("repaymentStartDate"))
        ):
            warnings.append(
                f"{name}: payment due date is unknown. Monthly funding does not confirm on-time payment."
            )
        if due and source.get("repaymentKind") not in ("one_off", "fixed"):
            warnings.append(
                f"{name}: only the recorded due date is confirmed. Later months use estimated minimums; confirm each statement."
            )
        if source.get("repaymentKind") == "interest_only":
            warnings.append(
                f"{name}: after the recorded payment, monthly interest-only targets use the remaining balance and APR. Fees, rate changes and lender billing periods are not modeled."
            )
        if source.get("components") is not None:
            warnings.append(
                f"{name}: this scenario allocates payments proportionally between loan components. Confirm the lender's allocation before paying."
            )
        if source.get("paymentsDeferred"):
            notice = (
                f"required payments resume {source['repaymentStartDate']}"
                if source.get("repaymentStartDate")
                else f"study status needs review after {source['studyEndDate']}; later minimums are unknown"
                if source.get("studyEndDate")
                else "the deferral has no recorded end date; future required payments are unknown"
            )
            warnings.append(f"{name}: {notice}.")
    return warnings


def _month_requirements(debts: list[_Debt], start: date, month: date, end: date) -> dict[str, dict[str, Any]]:
    result = {}
    month_text = month.strftime("%Y-%m")
    for debt in debts:
        source = debt.source
        known_due = _due_date(source)
        due = None
        if known_due and (
            known_due.startswith(month_text) or month == start and known_due < start.isoformat()
        ):
            due = known_due
        elif known_due and source.get("repaymentKind") == "fixed" and known_due < end.isoformat():
            day = min(int(known_due[8:]), (end - timedelta(days=1)).day)
            due = month.replace(day=day).isoformat()
        amount = (
            (source.get("minimumCents") if due else 0)
            if source.get("repaymentKind") == "one_off"
            else source.get("minimumCents")
        )
        if source.get("repaymentKind") == "interest_only" and (not known_due or due != known_due):
            parts = (
                debt.components
                if debt.components is not None
                else [{"balanceCents": debt.balance, "aprPercent": source["aprPercent"]}]
            )
            amount = js_round(sum(part["balanceCents"] * part["aprPercent"] / 1200 for part in parts))
        if known_due and known_due >= end.isoformat():
            amount = 0
        if source.get("paymentsDeferred"):
            if not source.get("repaymentStartDate"):
                amount = (
                    None
                    if source.get("studyEndDate")
                    and source["studyEndDate"] < (end - timedelta(days=1)).isoformat()
                    else 0
                )
                due = None
            elif source["repaymentStartDate"] >= end.isoformat():
                amount, due = 0, None
        result[source["id"]] = {
            "amount": None if amount is None else min(amount, js_round(debt.balance)),
            "dueDate": due,
            "shortfall": 0,
            "checked": False,
        }
    return result


def simulate_planner(input: dict[str, Any]) -> dict[str, Any]:
    start = month_start(input.get("startMonth"))
    anchor = parse_date(input.get("paydayAnchor"), "First payday")
    count = input.get("months")
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 60:
        raise ValueError("Choose 1 to 60 whole months.")
    frequency = input.get("frequency")
    if isinstance(frequency, bool) or frequency not in (12, 26, 52):
        raise ValueError("Choose 12 monthly, 26 biweekly, or 52 weekly paychecks.")
    if input.get("strategy") not in ("selected", "avalanche"):
        raise ValueError("Choose selected or avalanche debt repayment.")
    if input.get("surplusDestination") not in ("cash", "investments"):
        raise ValueError("Choose cash or investments for remaining income.")
    for key, label in (
        ("payCents", "Pay"),
        ("monthlyMomCents", "Monthly Mom payment"),
        ("monthlyDebtCents", "Monthly debt payment"),
        ("monthlySpendingCents", "Monthly spending"),
        ("startingInvestmentsCents", "Starting investments"),
        ("extraDebtCents", "Extra debt payment"),
    ):
        _cents(input.get(key), label)
    if input.get("momRemainingCents") is not None:
        _cents(input["momRemainingCents"], "Mom remaining")
    _cents(input.get("startingCashCents"), "Starting cash", signed=True)
    annual_return = checked_rate(
        input.get("annualReturnPercent"), "Annual investment return", minimum=-100, maximum=100
    )
    debts = _validated_debts(input)
    opening_debt = _cents(sum(debt.balance for debt in debts), "Combined debt")
    priority = sorted(
        debts,
        key=lambda debt: (
            0 if input["strategy"] == "selected" and debt.source["id"] == input.get("selectedDebtId") else 1,
            -debt.source["aprPercent"],
            debt.source["id"],
        ),
    )
    end = next_month(start, count)
    scheduled_dates = pay_dates(start, end, anchor, frequency)
    warnings = _initial_warnings(debts)
    investments = input["startingInvestmentsCents"]
    contributions = 0
    cash = input["startingCashCents"]
    cash_contributions = 0
    mom_remaining = input.get("momRemainingCents")
    mom_paid = 0
    paychecks: list[dict[str, Any]] = []
    milestones: list[dict[str, Any]] = []
    days: list[dict[str, Any]] = []
    months: list[dict[str, Any]] = []
    daily_fraction = day_fraction(start, start + timedelta(days=1))
    daily_return = daily_growth_factor(annual_return) - 1

    def snapshot(current: date, day_index: int, payday: dict[str, Any] | None = None) -> dict[str, Any]:
        balances = [
            {
                "id": debt.source["id"],
                "name": debt.source["name"],
                "balanceCents": checked_cents(js_round(debt.balance), "Projected debt"),
                "interestCents": checked_cents(js_round(debt.interest), "Projected interest", signed=True),
                "paymentCents": debt.paid,
            }
            for debt in debts
        ]
        total_debt = checked_cents(sum(item["balanceCents"] for item in balances), "Total debt")
        invested = checked_cents(js_round(investments), "Projected investments")
        point = {
            "date": current.isoformat(),
            "dayIndex": day_index,
            "paycheckNumber": len(paychecks),
            "momPaidCents": mom_paid,
            "momRemainingCents": mom_remaining,
            "debtCents": total_debt,
            "debts": balances,
            "investmentsCents": invested,
            "interestCents": checked_cents(
                sum(item["interestCents"] for item in balances), "Total interest", signed=True
            ),
            "cashCents": checked_cents(cash, "Projected cash", signed=True),
            "cashContributionsCents": cash_contributions,
            "investmentContributionsCents": contributions,
            "investmentGrowthCents": invested - input["startingInvestmentsCents"] - contributions,
            "progressCents": checked_cents(
                opening_debt
                - total_debt
                + mom_paid
                + cash_contributions
                + invested
                - input["startingInvestmentsCents"],
                "Progress",
                signed=True,
            ),
        }
        if payday is not None:
            point["payday"] = payday
        return point

    opening = snapshot(start - timedelta(days=1), -1)
    debt_free_date = opening["date"] if opening_debt == 0 else None
    day_index = 0
    current_month = start
    while current_month < end:
        month_end = next_month(current_month)
        month = current_month.strftime("%Y-%m")
        dates = sorted(value for value in scheduled_dates if value.startswith(month))
        payday_count = len(dates)
        month_opening = days[-1] if days else opening
        month_payments = {debt.source["id"]: 0 for debt in debts}
        requirements = _month_requirements(debts, start, current_month, month_end)
        unknown_count = sum(
            debt.balance > 0 and requirements[debt.source["id"]]["amount"] is None for debt in debts
        )
        month_paychecks: list[dict[str, Any]] = []
        base_debt_paid = 0
        targets = {
            "spendingCents": input["monthlySpendingCents"],
            "momCents": input["monthlyMomCents"],
            "debtCents": input["monthlyDebtCents"],
        }
        current = current_month
        while current < month_end:
            date_text = current.isoformat()
            for debt in debts:
                if debt.components is not None:
                    interest = 0.0
                    for part in debt.components:
                        value = part["balanceCents"] * part["aprPercent"] / 36500
                        part["balanceCents"] += value
                        interest += value
                else:
                    interest = debt.balance * debt.source["aprPercent"] / 100 / (1 / daily_fraction)
                debt.balance += interest
                debt.interest += interest
            investments += investments * daily_return
            payday = None
            if date_text in scheduled_dates:
                index = len(month_paychecks)
                installment = {key: _split(value, payday_count, index) for key, value in targets.items()}
                pay = _cents(input.get("payByDateCents", {}).get(date_text, input["payCents"]), "Pay")
                available = pay
                spending = min(available, installment["spendingCents"])
                available -= spending
                mom_needed = min(
                    installment["momCents"],
                    installment["momCents"] if mom_remaining is None else mom_remaining,
                )
                mom_payment = min(available, mom_needed)
                available -= mom_payment
                mom_paid += mom_payment
                if mom_remaining is not None:
                    was_owed = mom_remaining > 0
                    mom_remaining -= mom_payment
                    if was_owed and mom_remaining == 0:
                        milestones.append({"type": "mom_paid", "date": date_text, "name": "Mom paid off"})
                next_payday = dates[index + 1] if index + 1 < payday_count else month_end.isoformat()
                urgent = sum(
                    max(
                        0,
                        (requirements[debt.source["id"]]["amount"] or 0) - month_payments[debt.source["id"]],
                    )
                    for debt in debts
                    if requirements[debt.source["id"]]["dueDate"]
                    and requirements[debt.source["id"]]["dueDate"] < next_payday
                )
                debt_needed = min(
                    max(installment["debtCents"], urgent),
                    max(0, targets["debtCents"] - base_debt_paid),
                    sum(js_round(debt.balance) for debt in debts),
                )
                base_budget = min(available, debt_needed)
                extra_budget = min(
                    available - base_budget, _split(input["extraDebtCents"], payday_count, index)
                )
                debt_budget = base_budget + extra_budget
                debt_payments: dict[str, int] = {}

                def pay_debt(
                    debt: _Debt,
                    requested: int,
                    payment_date: str = date_text,
                    transfers: dict[str, int] = debt_payments,
                    monthly_transfers: dict[str, int] = month_payments,
                ) -> None:
                    nonlocal debt_budget
                    owed = js_round(debt.balance)
                    amount = min(debt_budget, requested, owed)
                    if amount <= 0:
                        return
                    if debt.components is not None:
                        for part in debt.components:
                            part["balanceCents"] = (
                                0
                                if amount == owed
                                else part["balanceCents"] * (debt.balance - amount) / debt.balance
                            )
                    if amount == owed:
                        debt.interest += owed - debt.balance
                        debt.balance = 0
                        milestones.append(
                            {
                                "type": "debt_paid",
                                "date": payment_date,
                                "debtId": debt.source["id"],
                                "name": debt.source["name"],
                            }
                        )
                    else:
                        debt.balance -= amount
                    debt.paid += amount
                    debt_budget -= amount
                    identity = debt.source["id"]
                    transfers[identity] = transfers.get(identity, 0) + amount
                    monthly_transfers[identity] += amount

                minimum_priority = sorted(
                    priority, key=lambda debt: requirements[debt.source["id"]]["dueDate"] or "9999"
                )
                for debt in minimum_priority:
                    requirement = requirements[debt.source["id"]]
                    if requirement["amount"] is None:
                        continue
                    timely = (
                        sum(pay_date <= requirement["dueDate"] for pay_date in dates)
                        if requirement["dueDate"]
                        else payday_count
                    )
                    due = (
                        requirement["amount"]
                        if requirement["dueDate"] and (timely == 0 or date_text >= requirement["dueDate"])
                        else _cumulative_split(requirement["amount"], timely or payday_count, index)
                    )
                    pay_debt(debt, max(0, due - month_payments[debt.source["id"]]))
                for debt in priority:
                    pay_debt(debt, debt_budget)
                debt_payment = base_budget + extra_budget - debt_budget
                base_debt_paid += min(base_budget, debt_payment)
                available -= debt_payment
                investment_payment = available if input["surplusDestination"] == "investments" else 0
                cash_payment = available if input["surplusDestination"] == "cash" else 0
                contributions += investment_payment
                investments += investment_payment
                cash_contributions += cash_payment
                cash += cash_payment
                shortfall = (
                    installment["spendingCents"]
                    - spending
                    + mom_needed
                    - mom_payment
                    + debt_needed
                    - min(debt_needed, debt_payment)
                )
                payday = {
                    "date": date_text,
                    "dayIndex": day_index,
                    "number": len(paychecks) + 1,
                    "month": month,
                    "payCents": pay,
                    "spendingCents": spending,
                    "momCents": mom_payment,
                    "debtCents": debt_payment,
                    "investCents": investment_payment,
                    "cashCents": cash_payment,
                    "extraDebtCents": max(0, debt_payment - base_budget),
                    "shortfallCents": shortfall,
                    "targets": installment,
                    "debtPayments": [
                        {"debtId": identity, "amountCents": amount}
                        for identity, amount in debt_payments.items()
                    ],
                }
                paychecks.append(payday)
                month_paychecks.append(payday)
            for debt in debts:
                requirement = requirements[debt.source["id"]]
                if (
                    not requirement["checked"]
                    and requirement["dueDate"]
                    and requirement["dueDate"] <= date_text
                ):
                    requirement["checked"] = True
                    paid_on_time = (
                        0 if requirement["dueDate"] < start.isoformat() else month_payments[debt.source["id"]]
                    )
                    requirement["shortfall"] = max(0, (requirement["amount"] or 0) - paid_on_time)
                    if requirement["shortfall"] > 0:
                        warnings.append(
                            f"{debt.source['name']}: {requirement['shortfall'] / 100:.2f} of the payment due {requirement['dueDate']} is not funded by that date. Later payments do not remove this missed deadline."
                        )
            point = snapshot(current, day_index, payday)
            if (
                debt_free_date is None
                and point["debtCents"] == 0
                and all(debt.balance == 0 for debt in debts)
            ):
                debt_free_date = date_text
            days.append(point)
            day_index += 1
            current += timedelta(days=1)
        last = days[-1]
        totals = {
            key: sum(paycheck[key] for paycheck in month_paychecks)
            for key in (
                "payCents",
                "spendingCents",
                "momCents",
                "debtCents",
                "investCents",
                "cashCents",
                "shortfallCents",
            )
        }
        minimum_shortfall = 0
        for index, debt in enumerate(debts):
            requirement = requirements[debt.source["id"]]
            if requirement["amount"] is None:
                continue
            if requirement["checked"]:
                minimum_shortfall += requirement["shortfall"]
            else:
                opening_balance = month_opening["debts"][index]["balanceCents"]
                month_interest = (
                    last["debts"][index]["interestCents"] - month_opening["debts"][index]["interestCents"]
                )
                required = min(requirement["amount"], opening_balance + month_interest)
                minimum_shortfall += max(0, required - month_payments[debt.source["id"]])
        opening_mom = month_opening["momRemainingCents"]
        shortfall = (
            max(0, targets["spendingCents"] - totals["spendingCents"])
            + max(
                0,
                min(targets["momCents"], targets["momCents"] if opening_mom is None else opening_mom)
                - totals["momCents"],
            )
            + max(
                0,
                min(
                    targets["debtCents"],
                    month_opening["debtCents"] + last["interestCents"] - month_opening["interestCents"],
                )
                - totals["debtCents"],
            )
        )
        months.append(
            {
                "month": month,
                "paydayCount": payday_count,
                "paycheckNumbers": [paycheck["number"] for paycheck in month_paychecks],
                "incomeCents": totals["payCents"],
                "spendingCents": totals["spendingCents"],
                "momCents": totals["momCents"],
                "debtCents": totals["debtCents"],
                "investCents": totals["investCents"],
                "cashCents": totals["cashCents"],
                "interestCents": last["interestCents"] - month_opening["interestCents"],
                "shortfallCents": shortfall,
                "minimumShortfallCents": minimum_shortfall,
                "unknownMinimumCount": unknown_count,
                "targets": targets,
                "end": last,
            }
        )
        current_month = month_end
    total_minimum_shortfall = sum(month["minimumShortfallCents"] for month in months)
    if total_minimum_shortfall > 0:
        warnings.append(
            "Some known minimum payments are not covered. Increase the debt budget or reduce other allocations."
        )
    if any(month["paydayCount"] == 0 for month in months):
        warnings.append("At least one month has no scheduled paycheck. Its targets remain unfunded.")
    return {
        "surplusDestination": input["surplusDestination"],
        "opening": opening,
        "days": days,
        "paychecks": paychecks,
        "months": months,
        "milestones": milestones,
        "debtFreeDate": debt_free_date,
        "warnings": warnings,
        "totalInterestCents": days[-1]["interestCents"],
        "totalShortfallCents": sum(month["shortfallCents"] for month in months),
        "totalMinimumShortfallCents": total_minimum_shortfall,
        "monthsWithUnknownMinimums": sum(month["unknownMinimumCount"] > 0 for month in months),
    }


def _money_text(value: int | None) -> str:
    if value is None:
        return ""
    return f"{value // 100}.{value % 100:02d}".rstrip("0").rstrip(".")


def _parse_money(value: Any, label: str) -> int:
    if not isinstance(value, str) or not re.fullmatch(r"\d+(?:\.\d{1,2})?", value.strip()):
        raise ValueError(f"{label} must be a nonnegative amount with at most two decimal places.")
    whole, _, fraction = value.strip().partition(".")
    return checked_cents(int(whole) * 100 + int(fraction.ljust(2, "0")), label, maximum=100_000_000_000_000)


def planner_defaults(snapshot: dict[str, Any], owner_id: str, as_of: str) -> dict[str, Any]:
    current = parse_date(as_of, "As-of date")
    accounts = [
        account
        for account in snapshot.get("accounts", [])
        if account.get("entityId") == owner_id and account.get("type") in ("debt", "payable")
    ]
    priority = [account for account in accounts if payment_deferral(account, as_of) != "deferred"]
    personal = (
        next((owner for owner in snapshot.get("entities", []) if owner.get("id") == owner_id), {}).get("kind")
        == "personal"
    )
    roadmap = (snapshot.get("roadmap") or {}) if personal else {}
    purchase = next(
        (
            item
            for item in snapshot.get("assetPurchases", [])
            if item.get("entityId") == owner_id and re.search("mom", item.get("payee", ""), re.IGNORECASE)
        ),
        None,
    )
    start = current if current.day == 1 else next_month(current)
    selected = next(
        (
            account
            for account in priority
            if account["id"] == roadmap.get("loanAccountId") and account["balanceCents"] > 0
        ),
        None,
    ) or next((account for account in priority if account["balanceCents"] > 0), None)
    debts = {}
    for account in accounts:
        if account["balanceCents"] <= 0:
            debts[account["id"]] = {"balance": "0", "apr": "", "minimum": "0", "included": False}
            continue
        rate = effective_debt_apr(account)
        status = payment_deferral(account, as_of)
        terms = account.get("debtTerms") or {}
        expired = (
            status == "repaying"
            and debt_repayment_kind(account) != "one_off"
            and terms.get("paymentDueDate")
            and terms["paymentDueDate"] < as_of
        )
        estimate = td_planning_minimum_estimate(account, as_of) if status == "repaying" else None
        minimum = (
            _money_text(estimate["amountCents"])
            if estimate
            else ""
            if expired
            else _money_text(terms.get("minimumPaymentCents"))
            if terms.get("repaymentStatus") == "in_study" and terms.get("repaymentStartDate")
            else "0"
            if status == "deferred"
            else ""
            if status == "review"
            else _money_text(required_debt_payment_cents(account, as_of))
        )
        debt = {
            "balance": _money_text(account["balanceCents"]),
            "apr": "" if rate is None else str(rate).removesuffix(".0"),
            "minimum": minimum,
            "included": status == "repaying" and rate is not None,
        }
        if estimate or td_regular_minimum_estimate(account):
            debt["minimumMode"] = "td_estimate" if estimate else "manual"
        debts[account["id"]] = debt
    return {
        "pay": _money_text(roadmap.get("payAmountCents")),
        "mom": _money_text(
            purchase.get("monthlyCents")
            if purchase and purchase.get("monthlyCents") is not None
            else roadmap.get("monthlyFamilyPaymentCents")
        ),
        "debt": _money_text(roadmap.get("monthlyDebtMinimumsCents")),
        "living": _money_text(roadmap.get("monthlyEssentialsCents")),
        "firstPayday": roadmap.get("paydayAnchor") or "",
        "startMonth": start.strftime("%Y-%m"),
        "months": "12",
        "frequency": "26"
        if roadmap.get("payEveryDays") == 14
        else "52"
        if roadmap.get("payEveryDays") == 7
        else "",
        "investmentReturn": "0",
        "extraDebt": "0",
        "surplusDestination": "cash",
        "selectedDebtId": selected["id"] if selected else "",
        "debts": debts,
    }


def planner_td_minimum_estimate(account: dict[str, Any], draft: dict[str, Any]) -> dict[str, Any] | None:
    apr = draft.get("apr", "")
    if not isinstance(apr, str) or not re.fullmatch(r"\d*\.?\d+", apr.strip()):
        return None
    try:
        rate = float(apr)
        return td_regular_minimum_estimate(
            {
                **account,
                "balanceCents": _parse_money(draft.get("balance"), "Balance"),
                "debtTerms": {
                    **(account.get("debtTerms") or {}),
                    "aprPercent": rate,
                    "interestStatus": "interest_free" if rate == 0 else "accruing",
                    "minimumPaymentCents": None,
                    "rateConfirmed": False,
                },
            }
        )
    except ValueError:
        return None


def planner_debt_projection(accounts: list[dict[str, Any]], values: dict[str, Any]) -> dict[str, Any]:
    debts = []
    fixed_debt = 0
    credit = 0
    fixed_names = []
    for account in accounts:
        if account["balanceCents"] <= 0:
            credit += -account["balanceCents"]
            continue
        draft = values[account["id"]]
        balance = _parse_money(draft.get("balance"), f"{account['name']} balance")
        if not balance:
            continue
        if not draft.get("included"):
            fixed_debt += balance
            fixed_names.append(account["name"])
            continue
        terms = account.get("debtTerms") or {}
        components = (
            debt_interest_parts({**account, "balanceCents": balance}) if terms.get("components") else None
        )
        if terms.get("components") and components is None:
            raise ValueError(
                f"Confirm both component balances and interest terms for {account['name']}. They must add up to the loan balance."
            )
        apr = draft.get("apr", "")
        if not apr.strip() and components is None:
            raise ValueError(f"Enter the APR for {account['name']}. Use 0 only for interest-free debt.")
        kind = debt_repayment_kind(account)
        estimate = (
            planner_td_minimum_estimate(account, draft) if draft.get("minimumMode") == "td_estimate" else None
        )
        if draft.get("minimumMode") == "td_estimate" and not estimate:
            raise ValueError(f"Enter a valid balance and APR for the {account['name']} minimum estimate.")
        minimum = draft.get("minimum", "")
        deferred_minimum = terms.get("repaymentStatus") == "in_study" and terms.get("repaymentStartDate")
        if not estimate and not minimum.strip() and kind != "interest_only" and not deferred_minimum:
            payment_name = "lump-sum payment" if kind == "one_off" else "monthly minimum"
            raise ValueError(
                f"Enter the {payment_name} for {account['name']}. A blank amount is unknown, not zero."
            )
        debt = {
            "id": account["id"],
            "name": account["name"],
            "balanceCents": balance,
            "aprPercent": effective_debt_apr({**account, "balanceCents": balance})
            if components is not None
            else float(apr),
            "minimumCents": estimate["amountCents"]
            if estimate
            else _parse_money(minimum, "Minimum payment")
            if minimum.strip()
            else None,
            "repaymentKind": kind,
        }
        if not estimate and terms.get("paymentDueDate"):
            debt["minimumDueDate"] = terms["paymentDueDate"]
        if components is not None:
            debt["components"] = components
        if terms.get("repaymentStatus") == "in_study":
            debt.update(
                {
                    "paymentsDeferred": True,
                    "repaymentStartDate": terms.get("repaymentStartDate"),
                    "studyEndDate": terms.get("studyEndDate"),
                }
            )
        debts.append(debt)
    return {
        "debts": debts,
        "fixedDebtCents": checked_cents(fixed_debt, "Excluded debt"),
        "fixedNames": fixed_names,
        "creditBalanceCents": checked_cents(credit, "Account credits"),
    }


def project(snapshot: dict[str, Any], scope: str, as_of: str, draft: dict[str, Any]) -> dict[str, Any]:
    derived: dict[str, Any] = {
        "startingCash": 0,
        "startingInvestments": 0,
        "momRemaining": None,
        "normalPaychecks": 2,
        "normalRemainder": None,
        "unallocatedCents": 0,
        "normalLabel": "2-paycheck month",
        "thirdPayMonths": [],
        "interestSaved": 0,
        "contributionsDelayed": 0,
        "baselinePayoff": None,
        "fasterPayoff": None,
        "earlierDays": None,
        "rate": None,
        "dayInterest": 0,
        "totalPayCents": 0,
        "selectedDebtEarlyPaymentSavingsCents": None,
    }
    response: dict[str, Any] = {
        "input": None,
        "result": None,
        "baseline": None,
        "faster": None,
        "fixedDebt": 0,
        "accountCredit": 0,
        "fixedNames": [],
        "error": "",
        "points": [],
        "derived": derived,
        "defaults": {},
        "draft": {},
    }
    try:
        parse_date(as_of, "As-of date")
        owner = next(
            (
                entity
                for entity in snapshot.get("entities", [])
                if (entity.get("kind") == "personal" if scope == "all" else entity.get("id") == scope)
            ),
            None,
        )
        if owner is None:
            raise ValueError("Choose an existing owner before projecting a plan.")
        owner_id = owner["id"]
        defaults = planner_defaults(snapshot, owner_id, as_of)
        if not isinstance(draft, dict):
            raise ValueError("The planner draft must contain named fields.")
        for field in (
            "pay",
            "mom",
            "debt",
            "living",
            "firstPayday",
            "startMonth",
            "months",
            "frequency",
            "investmentReturn",
            "extraDebt",
            "selectedDebtId",
            "surplusDestination",
        ):
            if field in draft and (not isinstance(draft[field], str) or len(draft[field]) > 100):
                raise ValueError(f"The planner {field} field must be text with at most 100 characters.")
        if "debts" in draft and not isinstance(draft["debts"], dict):
            raise ValueError("Scenario debts must be indexed by account ID.")
        for value in draft.get("debts", {}).values():
            if not isinstance(value, dict):
                raise ValueError("Each scenario debt needs its own fields.")
            for field in ("balance", "apr", "minimum"):
                if field in value and (not isinstance(value[field], str) or len(value[field]) > 100):
                    raise ValueError(f"Scenario {field} must be text with at most 100 characters.")
            if "included" in value and not isinstance(value["included"], bool):
                raise ValueError("Choose whether the scenario includes each debt.")
            if "minimumMode" in value and value["minimumMode"] not in ("manual", "td_estimate"):
                raise ValueError("Choose a manual or estimated scenario minimum.")
        values = {**defaults, **deepcopy(draft)}
        values["debts"] = {
            identity: {**debt, **(draft.get("debts") or {}).get(identity, {})}
            for identity, debt in defaults["debts"].items()
        }
        response.update({"defaults": defaults, "draft": values})
        owner_accounts = [
            account for account in snapshot.get("accounts", []) if account.get("entityId") == owner_id
        ]
        accounts = [account for account in owner_accounts if account.get("type") in ("debt", "payable")]
        starting_cash = checked_cents(
            sum(account["balanceCents"] for account in owner_accounts if account.get("type") == "cash"),
            "Starting cash",
            signed=True,
        )
        starting_investments = checked_cents(
            sum(account["balanceCents"] for account in owner_accounts if account.get("type") == "investment"),
            "Starting investments",
        )
        purchase = next(
            (
                item
                for item in snapshot.get("assetPurchases", [])
                if item.get("entityId") == owner_id and re.search("mom", item.get("payee", ""), re.IGNORECASE)
            ),
            None,
        )
        mom_remaining = (
            max(0, purchase["targetCents"] - purchase["paidCents"])
            if purchase and purchase.get("paidCents") is not None
            else None
        )
        derived.update(
            {
                "startingCash": starting_cash,
                "startingInvestments": starting_investments,
                "momRemaining": mom_remaining,
            }
        )
        response["fixedNames"] = [
            account["name"]
            for account in accounts
            if account["balanceCents"] > 0 and not values["debts"][account["id"]].get("included")
        ]
        debt_projection = planner_debt_projection(accounts, values["debts"])
        if not values.get("frequency"):
            raise ValueError("Choose your pay schedule.")
        if not values.get("firstPayday"):
            raise ValueError("Enter a confirmed paycheck date.")
        modeled = debt_projection["debts"]
        selected_id = (
            values.get("selectedDebtId")
            if any(item["id"] == values.get("selectedDebtId") for item in modeled)
            else modeled[0]["id"]
            if modeled
            else None
        )
        projection_start = month_start(values["startMonth"])
        recorded_as_of = parse_date(as_of)
        if projection_start < recorded_as_of:
            raise ValueError("Choose a full month starting on or after the saved balance date. Earlier activity is already included in current balances.")
        months_value = float(values["months"])
        frequency_value = float(values["frequency"])
        if (
            not math.isfinite(months_value)
            or not months_value.is_integer()
            or not math.isfinite(frequency_value)
            or not frequency_value.is_integer()
        ):
            raise ValueError("Use a whole number for plan length and pay frequency.")
        input = {
            "startMonth": values["startMonth"],
            "months": int(months_value),
            "payCents": _parse_money(values["pay"], "Take-home pay"),
            "frequency": int(frequency_value),
            "paydayAnchor": values["firstPayday"],
            "monthlyMomCents": _parse_money(values["mom"], "Mom payment"),
            "momRemainingCents": mom_remaining,
            "monthlyDebtCents": _parse_money(values["debt"], "Debt payment"),
            "monthlySpendingCents": _parse_money(values["living"], "Living costs"),
            "debts": modeled,
            "startingCashCents": starting_cash,
            "surplusDestination": values["surplusDestination"],
            "startingInvestmentsCents": starting_investments,
            "annualReturnPercent": float(values["investmentReturn"])
            if values["investmentReturn"].strip()
            else math.nan,
            "extraDebtCents": _parse_money(values["extraDebt"], "Extra debt payment"),
            "strategy": "selected",
            "selectedDebtId": selected_id,
        }
        timing_warnings = ["This monthly scenario allocates paycheck budgets. Use the dated cash plan to check whether each bill is funded before its deadline."]
        if projection_start == recorded_as_of and as_of in pay_dates(recorded_as_of, recorded_as_of + timedelta(days=1), parse_date(input["paydayAnchor"]), input["frequency"]):
            following = next_month(recorded_as_of) if input["frequency"] == 12 else recorded_as_of + timedelta(days=14 if input["frequency"] == 26 else 7)
            input["paydayAnchor"] = following.isoformat()
            timing_warnings.append("Today's scheduled paycheck is excluded because current cash may already include it. Confirm its receipt in the dated cash plan.")
        schedule = temporary_schedule(snapshot.get("roadmap") or {}) if owner["kind"] == "personal" else None
        if schedule:
            anchor = parse_date(input["paydayAnchor"])
            paydays = pay_dates(projection_start, next_month(projection_start, input["months"]), anchor, input["frequency"])
            input["payByDateCents"] = pay_by_date(input["payCents"], paydays, input["frequency"], anchor, schedule)
            timing_warnings.append("Pay estimates scale the full-time paycheck by the workdays at reduced hours in each pay period.")
        result = simulate_planner(input)
        baseline = (
            simulate_planner({**input, "extraDebtCents": 0}) if input["extraDebtCents"] else deepcopy(result)
        )
        faster = simulate_planner({**input, "extraDebtCents": 10000})
        for simulation in (result, baseline, faster):
            simulation["warnings"].extend(timing_warnings)
        fixed_debt = debt_projection["fixedDebtCents"]
        account_credit = debt_projection["creditBalanceCents"]
        points = []
        for index, day in enumerate([result["opening"], *result["days"]]):
            day["totalDebtCents"] = day["debtCents"] + fixed_debt
            day["debtReducedCents"] = result["opening"]["debtCents"] - day["debtCents"]
            points.append(
                {
                    "month": index,
                    "cashCents": day["cashCents"],
                    "businessCents": 0,
                    "investmentsCents": day["investmentsCents"],
                    "debtCents": day["totalDebtCents"],
                    "selectedDebtCents": day["debtCents"],
                    "netWorthCents": checked_cents(
                        day["cashCents"] + day["investmentsCents"] + account_credit - day["totalDebtCents"],
                        "Projected net worth",
                        signed=True,
                    ),
                    "interestCents": day["interestCents"],
                    "investmentChangeCents": day["investmentGrowthCents"],
                    "debtPaymentCents": day.get("payday", {}).get("debtCents", 0),
                    "redirectedDebtCents": 0,
                }
            )
        for month in result["months"]:
            month["debtReducedCents"] = month["debtCents"] - month["interestCents"]
        normal = 4 if input["frequency"] == 52 else 1 if input["frequency"] == 12 else 2
        income = input["payCents"] * normal
        if schedule:
            income = result["months"][0]["incomeCents"]
        remainder = income - input["monthlyMomCents"] - input["monthlyDebtCents"]
        surplus_field = (
            "cashContributionsCents"
            if input["surplusDestination"] == "cash"
            else "investmentContributionsCents"
        )
        baseline_payoff = next(
            (
                item
                for item in baseline["milestones"]
                if item["type"] == "debt_paid" and item.get("debtId") == selected_id
            ),
            None,
        )
        faster_payoff = next(
            (
                item
                for item in faster["milestones"]
                if item["type"] == "debt_paid" and item.get("debtId") == selected_id
            ),
            None,
        )
        rate = next((debt["aprPercent"] for debt in modeled if debt["id"] == selected_id), None)
        derived.update(
            {
                "normalPaychecks": normal,
                "normalRemainder": remainder,
                "unallocatedCents": max(0, remainder - input["monthlySpendingCents"]),
                "normalLabel": f"{normal}-paycheck month",
                "thirdPayMonths": [month for month in result["months"] if month["paydayCount"] > normal],
                "interestSaved": baseline["totalInterestCents"] - faster["totalInterestCents"],
                "contributionsDelayed": baseline["days"][-1][surplus_field]
                - faster["days"][-1][surplus_field],
                "baselinePayoff": baseline_payoff,
                "fasterPayoff": faster_payoff,
                "earlierDays": (parse_date(baseline_payoff["date"]) - parse_date(faster_payoff["date"])).days
                if baseline_payoff and faster_payoff
                else None,
                "rate": rate,
                "dayInterest": js_round(
                    sum(debt["balanceCents"] * debt["aprPercent"] / 36500 for debt in modeled)
                ),
                "totalPayCents": sum(pay["payCents"] for pay in result["paychecks"]),
                "selectedDebtEarlyPaymentSavingsCents": js_round(50000 * rate / 100 * 14 / 365)
                if rate is not None
                else None,
            }
        )
        response.update(
            {
                "input": input,
                "result": result,
                "baseline": baseline,
                "faster": faster,
                "fixedDebt": fixed_debt,
                "accountCredit": account_credit,
                "fixedNames": debt_projection["fixedNames"],
                "points": points,
            }
        )
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        response["error"] = str(exc) or "Check the amounts in your draft."
    return response
