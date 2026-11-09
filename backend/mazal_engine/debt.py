from __future__ import annotations

import math
import re
from copy import deepcopy
from typing import Any

from .dates import parse_date

MAX_SAFE_CENTS = 9_007_199_254_740_991


def checked_cents(value: Any, label: str, signed: bool = False, maximum: int = MAX_SAFE_CENTS) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or abs(value) > maximum
        or not math.isfinite(value)
        or value != int(value)
        or (not signed and value < 0)
    ):
        raise ValueError(
            f"{label} must be {'' if signed else 'nonnegative '}whole cents within the supported range."
        )
    return int(value)


def js_round(value: float) -> int:
    if not math.isfinite(value):
        raise ValueError("The projected amount exceeds the supported range.")
    lower = math.floor(value)
    return lower + int(value - lower >= 0.5)


def checked_rate(value: Any, label: str = "APR", maximum: float = 1000, minimum: float = 0) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or value < minimum
        or value > maximum
        or not math.isfinite(value)
    ):
        raise ValueError(f"{label} must be between {minimum:g}% and {maximum:g}%.")
    return float(value)


def debt_interest_parts(account: dict[str, Any], confirmed: bool = False) -> list[dict[str, Any]] | None:
    terms = account.get("debtTerms")
    if not terms:
        return None
    components = terms.get("components")
    if components:
        if (
            len(components) != 2
            or any(part.get("balanceCents") is None for part in components)
            or sum(part["balanceCents"] for part in components) != account["balanceCents"]
        ):
            return None
        parts = []
        for part in components:
            if not part["balanceCents"]:
                continue
            rate = (
                0
                if part.get("interestStatus") == "interest_free"
                else part.get("aprPercent")
                if part.get("interestStatus") == "accruing" and (not confirmed or part.get("rateConfirmed"))
                else None
            )
            if rate is None:
                return None
            checked_cents(part["balanceCents"], "Component balance")
            checked_rate(rate)
            parts.append({"balanceCents": part["balanceCents"], "aprPercent": rate})
        return parts
    if terms.get("interestStatus") == "interest_free":
        return [{"balanceCents": account["balanceCents"], "aprPercent": 0}]
    if (
        terms.get("interestStatus") == "unknown"
        or terms.get("repaymentStatus") == "in_study"
        and not terms.get("interestStatus")
    ):
        return None
    rate = terms.get("aprPercent")
    if rate is None or confirmed and not terms.get("rateConfirmed"):
        return None
    checked_rate(rate)
    return [{"balanceCents": account["balanceCents"], "aprPercent": rate}]


def effective_debt_apr(account: dict[str, Any], confirmed: bool = False) -> float | None:
    parts = debt_interest_parts(account, confirmed)
    if parts is None:
        return None
    return (
        sum(part["balanceCents"] * part["aprPercent"] for part in parts) / account["balanceCents"]
        if account["balanceCents"] > 0
        else 0
    )


def debt_repayment_kind(account: dict[str, Any]) -> str:
    terms = account.get("debtTerms") or {}
    return terms.get("repaymentKind") or (
        "one_off" if account.get("type") == "payable" and terms.get("paymentDueDate") else "fixed"
    )


def payment_deferral(account: dict[str, Any], as_of: str) -> str:
    parse_date(as_of, "As-of date")
    terms = account.get("debtTerms") or {}
    if terms.get("repaymentStatus") != "in_study":
        return "repaying"
    if terms.get("repaymentStartDate"):
        return "deferred" if as_of < terms["repaymentStartDate"] else "repaying"
    if terms.get("studyEndDate") and as_of > terms["studyEndDate"]:
        return "review"
    return "deferred"


def debt_payment_status(account: dict[str, Any], as_of: str) -> str:
    if account["balanceCents"] <= 0:
        return "paid_off"
    return {"deferred": "in_study", "review": "needs_confirmation", "repaying": "repaying"}[
        payment_deferral(account, as_of)
    ]


def required_debt_payment_cents(account: dict[str, Any], as_of: str) -> int | None:
    status = payment_deferral(account, as_of)
    return (
        0
        if status == "deferred"
        else None
        if status == "review"
        else (account.get("debtTerms") or {}).get("minimumPaymentCents")
    )


def debt_payment_summary(accounts: list[dict[str, Any]], as_of: str) -> dict[str, int]:
    active = [
        account
        for account in accounts
        if account.get("type") in ("debt", "payable") and account["balanceCents"] > 0
    ]
    return {
        "recordedMinimumsCents": checked_cents(
            sum(required_debt_payment_cents(account, as_of) or 0 for account in active), "Recorded minimums"
        ),
        "unknownPayments": sum(required_debt_payment_cents(account, as_of) is None for account in active),
        "inStudyCount": sum(debt_payment_status(account, as_of) == "in_study" for account in active),
    }


def debt_overview(accounts: list[dict[str, Any]], as_of: str) -> dict[str, Any]:
    parse_date(as_of, "As-of date")
    rows = []
    for account in accounts:
        if account.get("type") not in ("debt", "payable"):
            continue
        balance = max(0, checked_cents(account["balanceCents"], "Balance", signed=True))
        parts = debt_interest_parts(account, True) if balance else []
        rows.append(
            {
                "account": deepcopy(account),
                "accountId": account["id"],
                "balanceCents": balance,
                "confirmedApr": effective_debt_apr(account, True),
                "monthlyInterestCents": None
                if parts is None
                else checked_cents(
                    sum(js_round(part["balanceCents"] * part["aprPercent"] / 1200) for part in parts),
                    "Monthly interest",
                ),
                "paymentStatus": debt_payment_status(account, as_of),
                "requiredPaymentCents": required_debt_payment_cents(account, as_of) if balance else 0,
                "dueDate": (account.get("debtTerms") or {}).get("paymentDueDate") if balance else None,
            }
        )
    active = [row for row in rows if row["balanceCents"] > 0]
    ranked = [
        row
        for row in active
        if row["paymentStatus"] != "in_study" and row["confirmedApr"] is not None and row["confirmedApr"] > 0
    ]
    return {
        "rows": rows,
        "debtCents": checked_cents(sum(row["balanceCents"] for row in rows), "Total debt"),
        "creditCents": checked_cents(
            sum(max(0, -row["account"]["balanceCents"]) for row in rows), "Account credits"
        ),
        "monthlyInterestCents": checked_cents(
            sum(row["monthlyInterestCents"] or 0 for row in active), "Monthly interest"
        ),
        "unknownInterestCount": sum(row["monthlyInterestCents"] is None for row in active),
        "deferredCents": sum(row["balanceCents"] for row in active if row["paymentStatus"] == "in_study"),
        "repayingCents": sum(row["balanceCents"] for row in active if row["paymentStatus"] == "repaying"),
        "highestRateAccountId": max(ranked, key=lambda row: row["confirmedApr"])["accountId"]
        if ranked
        else None,
        "largestBalanceAccountId": max(active, key=lambda row: row["balanceCents"])["accountId"]
        if active
        else None,
    }


def td_regular_minimum_estimate(account: dict[str, Any]) -> dict[str, Any] | None:
    terms = account.get("debtTerms") or {}
    if (
        account.get("type") != "debt"
        or not re.search(r"\bTD\b.*\blow\s+rate\b.*\bVisa\b", account.get("name", ""), re.IGNORECASE)
        or terms.get("repaymentStatus") == "in_study"
        or terms.get("components")
        or terms.get("repaymentKind") in ("one_off", "interest_only")
    ):
        return None
    balance = checked_cents(account["balanceCents"], "Balance", signed=True)
    if balance <= 0:
        return None
    rate = effective_debt_apr(account)
    if rate is None:
        return None
    interest = js_round(balance * rate / 1200)
    if interest + 1000 > MAX_SAFE_CENTS:
        return None
    return {
        "amountCents": min(balance, interest + 1000),
        "interestCents": interest,
        "balanceCents": balance,
        "aprPercent": rate,
    }


def td_planning_minimum_estimate(account: dict[str, Any], as_of: str) -> dict[str, Any] | None:
    terms = account.get("debtTerms") or {}
    if terms.get("minimumPaymentCents") is not None and (
        not terms.get("paymentDueDate") or terms["paymentDueDate"] >= as_of
    ):
        return None
    return td_regular_minimum_estimate(account)


def payoff(input: dict[str, Any]) -> dict[str, Any]:
    balance = checked_cents(input.get("balanceCents"), "Loan balance")
    payment = checked_cents(input.get("monthlyPaymentCents"), "Monthly payment")
    extra = checked_cents(input.get("extraPaymentCents", 0), "Extra monthly payment")
    months = input.get("maxMonths", 600)
    if isinstance(months, bool) or not isinstance(months, int) or not 1 <= months <= 1200:
        raise ValueError("Maximum months must be a whole number between 1 and 1,200.")
    empty = {"months": None, "totalInterestCents": None, "schedule": []}
    if balance == 0:
        return {"status": "paid_off", "months": 0, "totalInterestCents": 0, "schedule": []}
    if input.get("aprPercent") is None:
        return {"status": "needs_inputs", **empty}
    apr = checked_rate(input["aprPercent"])
    scheduled_payment = checked_cents(payment + extra, "Combined monthly payment")
    parts = deepcopy(input.get("components"))
    if parts is not None:
        if not isinstance(parts, list) or len(parts) > 50 or any(not isinstance(part, dict) for part in parts):
            raise ValueError("Use at most 50 loan components, each with its own balance and APR.")
        for part in parts:
            checked_cents(part.get("balanceCents"), "Component balance")
            checked_rate(part.get("aprPercent"), "Component APR")
        if sum(part["balanceCents"] for part in parts) != balance:
            raise ValueError(
                "Loan components must have valid balances and rates and add up to the loan balance."
            )
    kind = input.get("repaymentKind", "fixed")
    if kind not in ("fixed", "revolving", "interest_only", "one_off"):
        raise ValueError("Choose a valid debt repayment kind.")
    if kind == "interest_only" and extra == 0:
        return {"status": "interest_only", **empty}
    total_interest = 0
    schedule = []
    for month in range(1, months + 1):
        raw_interest = (
            sum(part["balanceCents"] * part["aprPercent"] / 1200 for part in parts)
            if parts is not None
            else balance * (apr / 1200)
        )
        interest = checked_cents(js_round(raw_interest), "Calculated interest")
        target_payment = (
            interest + extra
            if kind == "interest_only"
            else extra
            if kind == "one_off" and month > 1
            else scheduled_payment
        )
        if target_payment <= interest:
            return {
                "status": "below_interest",
                "months": None,
                "totalInterestCents": None,
                "schedule": schedule,
            }
        amount_due = checked_cents(balance + interest, "Balance plus interest")
        paid = min(target_payment, amount_due)
        balance = amount_due - paid
        if parts is not None:
            parts_due = sum(part["balanceCents"] * (1 + part["aprPercent"] / 1200) for part in parts)
            for part in parts:
                part["balanceCents"] = (
                    part["balanceCents"] * (1 + part["aprPercent"] / 1200) / parts_due * balance
                    if parts_due > 0
                    else 0
                )
        total_interest = checked_cents(total_interest + interest, "Total interest")
        schedule.append(
            {"month": month, "balanceCents": balance, "paymentCents": paid, "interestCents": interest}
        )
        if balance == 0:
            return {
                "status": "paid_off",
                "months": month,
                "totalInterestCents": total_interest,
                "schedule": schedule,
            }
    return {"status": "beyond_horizon", "months": None, "totalInterestCents": None, "schedule": schedule}


def compare_payoff(input: dict[str, Any], extra_payment_cents: int) -> dict[str, Any]:
    base = payoff(input)
    extra = payoff(
        {**input, "extraPaymentCents": checked_cents(extra_payment_cents, "Extra monthly payment")}
    )
    return {
        "base": base,
        "extra": extra,
        "savedInterest": base["totalInterestCents"] - extra["totalInterestCents"]
        if base["totalInterestCents"] is not None and extra["totalInterestCents"] is not None
        else None,
        "savedMonths": base["months"] - extra["months"]
        if base["months"] is not None and extra["months"] is not None
        else None,
    }
