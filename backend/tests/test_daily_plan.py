from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest

from mazal_engine.daily_plan import daily_plan
from mazal_engine.debt import MAX_SAFE_CENTS


def fixture() -> dict[str, Any]:
    return {
        "entities": [{"id": "personal", "kind": "personal", "ownershipBps": 10000}],
        "accounts": [{"id": "cash", "entityId": "personal", "name": "Bank", "type": "cash", "balanceCents": 100_000, "reconciledAt": "2026-09-28"}],
        "transactions": [], "obligations": [], "reserves": [{"id": "reserve", "entityId": "personal", "amountCents": 10_000}],
        "roadmap": {"payAmountCents": 200_000, "payEveryDays": 14, "paydayAnchor": "2026-10-02", "monthlyEssentialsCents": 0},
    }


def bill(identifier: str = "phone", **changes: Any) -> dict[str, Any]:
    return {"id": identifier, "entityId": "personal", "name": "Phone", "amountCents": 5_000,
            "dueDate": "2026-10-01", "direction": "out", "recurrence": "once", "status": "planned",
            "accountId": "cash", "category": "Bills", **changes}


def debt(**terms: Any) -> dict[str, Any]:
    return {"id": "card", "entityId": "personal", "name": "Card", "type": "debt", "balanceCents": 90_000,
            "debtTerms": {"minimumPaymentCents": 10_000, "paymentDueDate": "2026-10-01", "statementDate": "2026-09-01", **terms}}


def plan(state: dict[str, Any], **draft: Any) -> dict[str, Any]:
    return daily_plan(state, "personal", "2026-09-28", draft)


def test_known_bills_before_pay_have_dated_cash_math_and_leave_source_untouched() -> None:
    state = fixture()
    state["obligations"] = [bill()]
    before = deepcopy(state)
    result = plan(state, days=7)
    assert result["status"] == "ready"
    assert result["nextPayday"] == {"date": "2026-10-02", "amountCents": 200_000}
    assert result["beforePayday"] == {"endDate": "2026-10-01", "knownIncomeCents": 0, "knownOutflowCents": 5_000, "cashAfterKnownCents": 85_000}
    assert result["cashAfterKnownCents"] == 285_000
    assert result["days"][3]["closingCashCents"] == 95_000
    assert result["days"][4]["closingCashCents"] == 295_000
    assert state == before


def test_closed_cash_accounts_do_not_satisfy_the_open_cash_account_requirement() -> None:
    state = fixture()
    state["accounts"][0].update(balanceCents=0, closedAt="2026-09-27")
    result = plan(state, days=7)
    assert result["status"] == "partial"
    assert result["cashCents"] == 0
    assert result["missingInputs"] == [{"field": "cashAccounts", "message": "Add an open cash account and confirm its balance.", "section": "accounts"}]


def test_closed_cash_account_does_not_need_reconciliation_when_an_open_cash_account_exists() -> None:
    state = fixture()
    state["accounts"].append({**state["accounts"][0], "id": "closed", "name": "Old bank", "balanceCents": 0, "closedAt": "2026-09-27", "reconciledAt": None})
    result = plan(state, days=7)
    assert result["status"] == "ready"
    assert result["cashCents"] == 100_000
    assert result["missingInputs"] == []


def test_today_pay_is_not_added_twice_to_saved_cash() -> None:
    state = fixture()
    state["roadmap"]["paydayAnchor"] = "2026-09-28"
    state["transactions"] = [{"id": "salary", "kind": "income", "date": "2026-09-28", "paydayDate": "2026-09-28", "accountId": "cash", "amountCents": 200_000}]
    result = plan(state, days=7)
    assert result["knownIncomeCents"] == 0
    assert result["nextPayday"]["date"] == "2026-10-12"
    assert result["events"][0]["includedInCashflow"] is False
    assert "already" in result["events"][0]["note"]


def test_before_next_pay_reserves_todays_bills_when_today_is_payday() -> None:
    state = fixture()
    state["roadmap"]["paydayAnchor"] = "2026-09-28"
    state["obligations"] = [bill(dueDate="2026-09-28", amountCents=25_000)]
    result = plan(state, days=30)
    assert result["nextPayday"]["date"] == "2026-10-12"
    assert result["beforePayday"]["endDate"] == "2026-10-11"
    assert result["beforePayday"]["knownIncomeCents"] == 0
    assert result["beforePayday"]["knownOutflowCents"] == 25_000
    assert result["beforePayday"]["cashAfterKnownCents"] == 65_000


def test_extra_income_is_not_assumed_distinct_from_saved_pay() -> None:
    state = fixture()
    state["obligations"] = [bill("pay", direction="in", amountCents=200_000, dueDate="2026-10-02")]
    result = plan(state, days=7)
    assert result["knownIncomeCents"] == 200_000
    assert result["status"] == "partial"
    assert any(row["field"].endswith("additionalIncome") for row in result["missingInputs"])
    assert next(row for row in result["events"] if row["sourceType"] == "obligation")["includedInCashflow"] is False


@pytest.mark.parametrize("additional", [True, False, None])
def test_known_income_is_usable_without_a_regular_pay_schedule(additional: bool | None) -> None:
    state = fixture()
    state["roadmap"] = {"monthlyEssentialsCents": 0}
    state["obligations"] = [bill("income", direction="in", amountCents=50_000,
                                  **({"additionalToPay": additional} if additional is not None else {}))]
    result = plan(state, days=7)
    assert result["knownIncomeCents"] == 50_000
    assert result["nextPayday"] is None
    assert next(row for row in result["events"] if row["sourceType"] == "obligation")["includedInCashflow"] is True
    fields = {row["field"] for row in result["missingInputs"]}
    assert fields >= {"payAmountCents", "paydayAnchor"}
    assert "obligations.income.additionalIncome" not in fields


def test_overdue_bill_stays_visible_and_is_reserved_once() -> None:
    state = fixture()
    state["obligations"] = [bill(dueDate="2026-09-01", recurrence="monthly")]
    result = plan(state, days=7)
    bills = [row for row in result["events"] if row["sourceType"] == "obligation"]
    assert [row["date"] for row in bills] == ["2026-09-01", "2026-10-01"]
    assert bills[0]["status"] == "overdue"
    assert bills[0]["effectiveDate"] == "2026-09-28"
    assert result["knownOutflowCents"] == 10_000


def test_paid_and_cancelled_bills_do_not_repeat_current_payment() -> None:
    state = fixture()
    state["obligations"] = [bill(status="paid", dueDate="2026-09-01", recurrence="monthly"), bill("cancel", status="cancelled")]
    result = plan(state, days=7)
    assert [(row["sourceId"], row["date"]) for row in result["events"] if row["sourceType"] == "obligation"] == [("phone", "2026-10-01")]
    assert result["knownOutflowCents"] == 5_000


def test_month_end_recurrence_keeps_original_day() -> None:
    state = fixture()
    state["obligations"] = [bill(dueDate="2026-01-31", recurrence="monthly", status="paid", recurrenceDay=31)]
    result = daily_plan(state, "personal", "2026-02-01", {"days": 60})
    assert [row["date"] for row in result["events"] if row["sourceType"] == "obligation"] == ["2026-02-28", "2026-03-31"]


def test_unknown_expense_and_purchase_dates_stay_unknown() -> None:
    state = fixture()
    state["expensePlanItems"] = [{"id": "repair", "entityId": "personal", "name": "Repair", "date": "2026-09-30", "amountCents": None}]
    state["assetPurchases"] = [{"id": "car", "entityId": "personal", "name": "Car", "targetCents": 100_000, "paidCents": 20_000, "monthlyCents": 10_000}]
    result = plan(state, days=7)
    assert result["knownOutflowCents"] == 0
    assert result["events"][0]["amountCents"] is None
    assert {row["field"] for row in result["missingInputs"]} == {"expensePlanItems.repair.amountCents", "assetPurchases.car.dueDate"}


def test_exact_expense_bill_overlap_is_excluded_and_needs_review() -> None:
    state = fixture()
    state["obligations"] = [bill()]
    state["expensePlanItems"] = [{"id": "plan-phone", "entityId": "personal", "name": " phone ", "date": "2026-10-01", "amountCents": 5_000}]
    result = plan(state, days=7)
    assert result["knownOutflowCents"] == 5_000
    assert next(row for row in result["events"] if row["sourceType"] == "expense")["includedInCashflow"] is False
    assert any(row["field"].endswith("overlap") for row in result["missingInputs"])


def test_living_cost_budget_includes_bills_and_rounds_partial_month_to_cents() -> None:
    state = fixture()
    state["roadmap"]["monthlyEssentialsCents"] = 30_000
    state["obligations"] = [bill(amountCents=2_000, dueDate="2026-09-29")]
    result = plan(state, days=7)
    # Sep 28–30: 2,800 of the 28,000 monthly allowance; Oct 1–4: 3,871.
    assert result["livingCostsCents"] == 6_671
    assert result["knownOutflowCents"] == 8_671
    assert sum(row["outflowCents"] for row in result["days"]) == result["knownOutflowCents"]


def test_missing_living_costs_are_not_silently_zero() -> None:
    state = fixture()
    state["roadmap"]["monthlyEssentialsCents"] = None
    result = plan(state)
    assert result["status"] == "partial"
    assert any(row["field"] == "monthlyEssentialsCents" for row in result["missingInputs"])
    assert result["livingCostsCents"] == 0


def test_paid_off_and_deferred_debt_do_not_create_payments() -> None:
    state = fixture()
    state["accounts"].extend([{**debt(), "balanceCents": 0}, {**debt(repaymentStatus="in_study", repaymentStartDate="2027-01-01"), "id": "student"}])
    result = plan(state)
    assert not any(row["sourceType"] == "debt" for row in result["events"])
    assert not any(row["section"] == "debts" for row in result["missingInputs"])


@pytest.mark.parametrize(("days", "unknown_dates"), [
    (7, []), (34, []), (35, ["2026-11-01"]), (65, ["2026-11-01", "2026-12-01"]),
])
def test_zero_statement_minimum_does_not_confirm_future_payments(
    days: int, unknown_dates: list[str],
) -> None:
    state = fixture()
    state["accounts"].append(debt(minimumPaymentCents=0))
    before = deepcopy(state)
    result = plan(state, days=days)
    payments = [row for row in result["events"] if row["sourceType"] == "debt"]
    assert [row["date"] for row in payments] == unknown_dates
    assert all(row["amountCents"] is None and not row["includedInCashflow"] for row in payments)
    assert result["status"] == ("partial" if unknown_dates else "ready")
    assert [row["field"] for row in result["missingInputs"]] == (["debts.card.minimum"] if unknown_dates else [])
    assert any("Card has a balance with a recorded $0 payment" in warning for warning in result["warnings"])
    assert result["knownOutflowCents"] == 0
    assert state == before


@pytest.mark.parametrize(("due", "missing_field"), [(None, "dueDate"), ("2026-09-01", "statement")])
def test_zero_statement_minimum_still_requires_a_current_due_date(
    due: str | None, missing_field: str,
) -> None:
    state = fixture()
    state["accounts"].append(debt(minimumPaymentCents=0, paymentDueDate=due))
    result = plan(state, days=7)
    assert result["status"] == "partial"
    assert any(row["field"] == f"debts.card.{missing_field}" for row in result["missingInputs"])
    assert result["knownOutflowCents"] == 0


def test_zero_payment_during_confirmed_deferral_does_not_need_future_minimum_in_this_horizon() -> None:
    state = fixture()
    state["accounts"].append(debt(minimumPaymentCents=0, repaymentStatus="in_study", repaymentStartDate="2027-01-01"))
    result = plan(state, days=90)
    assert result["status"] == "ready"
    assert not any(row["sourceType"] == "debt" for row in result["events"])
    assert not any("recorded $0 payment" in warning for warning in result["warnings"])


@pytest.mark.parametrize("as_of", ["2026-10-14", "2026-10-15", "2026-10-16"])
@pytest.mark.parametrize("horizon", [7, 30])
def test_resuming_debt_requires_a_deadline_after_deferral(as_of: str, horizon: int) -> None:
    state = fixture()
    state["accounts"][0]["reconciledAt"] = as_of
    state["roadmap"].update(paydayAnchor="2026-10-30", planningCashReserveCents=0)
    state["reserves"] = []
    state["accounts"].append({
        **debt(repaymentKind="fixed", repaymentStatus="in_study", repaymentStartDate="2026-10-15", paymentDueDate="2026-10-01"),
        "balanceCents": 1_000_000,
    })
    before = deepcopy(state)
    result = daily_plan(state, "personal", as_of, {"days": horizon})
    assert result["status"] == "partial"
    assert result["missingInputs"] == [{
        "field": "debts.card.dueDate",
        "message": "Confirm the first payment deadline for Card after repayment resumes on 2026-10-15.",
        "section": "debts", "sourceId": "card",
    }]
    assert not any(row["sourceType"] == "debt" for row in result["events"])
    assert result["knownOutflowCents"] == 0
    if horizon == 7:
        assert result["cashAfterKnownCents"] == 100_000
    assert state == before


@pytest.mark.parametrize("due_date", ["2026-10-15", "2026-10-20", "2026-10-21"])
def test_confirmed_post_deferral_deadline_is_used_without_inventing_an_earlier_payment(due_date: str) -> None:
    state = fixture()
    state["accounts"][0]["reconciledAt"] = "2026-10-14"
    state["roadmap"]["paydayAnchor"] = "2026-10-30"
    state["accounts"].append(debt(repaymentStatus="in_study", repaymentStartDate="2026-10-15", paymentDueDate=due_date))
    result = daily_plan(state, "personal", "2026-10-14", {"days": 7})
    assert result["status"] == "ready"
    assert result["missingInputs"] == []
    payments = [(row["date"], row["amountCents"]) for row in result["events"] if row["sourceType"] == "debt"]
    assert payments == ([(due_date, 10_000)] if due_date <= "2026-10-20" else [])


def test_debt_payment_after_statement_reduces_current_minimum_only() -> None:
    state = fixture()
    state["accounts"].append(debt())
    state["transactions"] = [{"id": "paid", "kind": "debt_payment", "date": "2026-09-20", "accountId": "cash", "toAccountId": "card", "amountCents": 6_000}]
    result = plan(state, days=60)
    payments = [row for row in result["events"] if row["sourceType"] == "debt"]
    assert [row["amountCents"] for row in payments] == [4_000, 10_000]
    assert payments[0]["isProjection"] is False
    assert payments[1]["isProjection"] is True


@pytest.mark.parametrize(("paid_cents", "balance_cents"), [(6_000, 90_000), (10_000, 90_000), (6_000, 4_000)])
@pytest.mark.parametrize("receipt_kind", ["manual", "statement", "import"])
@pytest.mark.parametrize("save_null_date", [False, True])
def test_payments_without_a_statement_date_require_review_without_reducing_the_minimum(
    paid_cents: int, balance_cents: int, receipt_kind: str, save_null_date: bool,
) -> None:
    state = fixture()
    card = debt(statementDate=None)
    card["balanceCents"] = balance_cents
    if not save_null_date:
        del card["debtTerms"]["statementDate"]
    state["accounts"].append(card)
    payment = {"id": "paid", "kind": "debt_payment", "date": "2026-09-20", "accountId": "cash", "toAccountId": "card", "amountCents": paid_cents}
    if receipt_kind != "manual":
        payment.update(kind="adjustment", accountId="card", toAccountId=None, category="  Card payment  ", date="2026-08-30", postingDate="2026-09-05")
        if receipt_kind == "statement":
            payment["statementId"] = "statement"
        else:
            payment.update(importSources=[{"importId": "statement", "rowId": "paid"}], balanceChanges={"card": -paid_cents}, postingDates={"card": "2026-09-20"})
    state["transactions"] = [payment]
    before = deepcopy(state)

    result = plan(state, days=7)

    assert result["status"] == "partial"
    assert result["missingInputs"] == [{
        "field": "debts.card.statementDate",
        "message": "Confirm the statement date and current minimum for Card. Without that date, recorded payment activity cannot be assigned to this payment period.",
        "section": "debts", "sourceId": "card",
    }]
    assert result["knownOutflowCents"] == min(10_000, balance_cents)
    event = next(row for row in result["events"] if row["sourceType"] == "debt")
    assert event["amountCents"] == min(10_000, balance_cents)
    assert event["note"] == "Recorded payment activity has not reduced this forecast because the statement date is missing."
    assert state == before

    card["debtTerms"]["statementDate"] = "2026-09-01"
    confirmed = plan(state, days=7)
    assert confirmed["status"] == "ready"
    assert confirmed["missingInputs"] == []
    assert confirmed["knownOutflowCents"] == min(10_000 - paid_cents, balance_cents)
    assert not any(row["sourceType"] == "debt" and row["amountCents"] == 0 for row in confirmed["events"])


@pytest.mark.parametrize("transactions", [
    [],
    [{"id": "other", "kind": "debt_payment", "date": "2026-09-20", "accountId": "cash", "toAccountId": "other-card", "amountCents": 10_000}],
    [{"id": "correction", "kind": "adjustment", "date": "2026-09-20", "accountId": "card", "category": "Balance correction", "amountCents": 10_000, "balanceChanges": {"card": -10_000}}],
    [{"id": "unconfirmed", "kind": "adjustment", "date": "2026-09-20", "accountId": "card", "category": "Card payment", "amountCents": 10_000, "balanceChanges": {"card": -10_000}}],
    [{"id": "future", "kind": "debt_payment", "date": "2026-09-20", "postingDate": "2026-09-21", "postingDates": {"card": "2026-09-29"}, "accountId": "cash", "toAccountId": "card", "amountCents": 10_000}],
    [{"id": "paid", "kind": "debt_payment", "date": "2026-09-20", "accountId": "cash", "toAccountId": "card", "amountCents": 10_000},
     {"id": "reversed", "kind": "debt_payment", "date": "2026-09-20", "accountId": "cash", "toAccountId": "card", "amountCents": -10_000, "reversalOf": "paid"}],
    [{"id": "paid", "kind": "adjustment", "date": "2026-09-20", "accountId": "card", "category": "Card payment", "amountCents": 10_000, "statementId": "statement", "balanceChanges": {"card": -10_000}},
     {"id": "returned", "kind": "adjustment", "date": "2026-09-21", "accountId": "card", "category": "Card payment", "amountCents": 10_000, "statementId": "statement", "balanceChanges": {"card": 10_000}}],
])
def test_unrelated_future_and_fully_reversed_payments_do_not_require_statement_allocation_review(
    transactions: list[dict[str, Any]],
) -> None:
    state = fixture()
    state["accounts"].extend([debt(statementDate=None), {**debt(minimumPaymentCents=0), "id": "other-card"}])
    state["transactions"] = transactions
    before = deepcopy(state)
    result = plan(state, days=7)
    assert result["status"] == "ready"
    assert result["missingInputs"] == []
    assert result["knownOutflowCents"] == 10_000
    assert next(row for row in result["events"] if row["sourceType"] == "debt")["note"] == "Recorded minimum. No statement date is saved."
    assert state == before


def test_negative_payment_activity_without_a_statement_date_is_not_treated_as_no_evidence() -> None:
    state = fixture()
    card = debt(statementDate=None)
    state["accounts"].append(card)
    state["transactions"] = [{"id": "returned", "kind": "adjustment", "date": "2026-09-20", "accountId": "card", "category": "Card payment", "amountCents": 10_000, "statementId": "statement", "balanceChanges": {"card": 10_000}}]
    result = plan(state, days=7)
    assert result["status"] == "partial"
    assert [row["field"] for row in result["missingInputs"]] == ["debts.card.statementDate"]
    assert result["knownOutflowCents"] == 10_000
    card["debtTerms"]["statementDate"] = "2026-09-01"
    confirmed = plan(state, days=7)
    assert confirmed["status"] == "ready"
    assert confirmed["knownOutflowCents"] == 10_000


@pytest.mark.parametrize("changes", [
    {"paymentDueDate": "2026-10-05"},
    {"minimumPaymentCents": 0},
    {"minimumPaymentCents": None},
    {"repaymentStatus": "in_study", "repaymentStartDate": "2027-01-01"},
])
def test_statement_allocation_review_applies_only_to_known_payments_in_the_plan(changes: dict[str, Any]) -> None:
    state = fixture()
    state["accounts"].append(debt(statementDate=None, **changes))
    state["transactions"] = [{"id": "paid", "kind": "debt_payment", "date": "2026-09-20", "accountId": "cash", "toAccountId": "card", "amountCents": 10_000}]
    result = plan(state, days=7)
    assert not any(row["field"] == "debts.card.statementDate" for row in result["missingInputs"])
    assert result["knownOutflowCents"] == 0


def test_statement_payment_and_reversal_use_posting_date_without_inventing_matches() -> None:
    state = fixture()
    state["accounts"].append(debt())
    state["transactions"] = [
        {"id": "paid", "kind": "adjustment", "date": "2026-08-30", "postingDate": "2026-09-05", "accountId": "card", "category": "Card payment", "amountCents": 7_000, "statementId": "statement", "balanceChanges": {"card": -7_000}},
        {"id": "reversed", "kind": "adjustment", "date": "2026-09-10", "accountId": "card", "category": "Card payment", "amountCents": 2_000, "statementId": "statement", "balanceChanges": {"card": 2_000}},
    ]
    result = plan(state, days=7)
    assert next(row for row in result["events"] if row["sourceType"] == "debt")["amountCents"] == 5_000


def test_stale_cash_and_debt_dates_need_confirmation() -> None:
    state = fixture()
    state["accounts"][0]["reconciledAt"] = "2026-08-01"
    state["accounts"].append(debt(paymentDueDate="2026-09-01"))
    result = plan(state, days=7)
    assert {row["field"] for row in result["missingInputs"]} >= {"accounts.cash.balance", "debts.card.statement"}
    assert result["events"][0]["status"] == "overdue"


@pytest.mark.parametrize("paid_cents", [0, 6_000, 10_000])
@pytest.mark.parametrize("horizon", [7, 30])
def test_stale_debt_deadline_needs_review_even_when_its_minimum_was_paid(paid_cents: int, horizon: int) -> None:
    state = fixture()
    state["accounts"][0]["reconciledAt"] = "2026-10-16"
    state["roadmap"]["paydayAnchor"] = "2026-10-30"
    state["accounts"].append(debt(paymentDueDate="2026-07-01", statementDate="2026-06-01"))
    if paid_cents:
        state["transactions"] = [{"id": "paid", "kind": "debt_payment", "date": "2026-06-20", "accountId": "cash", "toAccountId": "card", "amountCents": paid_cents}]
    before = deepcopy(state)

    result = daily_plan(state, "personal", "2026-10-16", {"days": horizon})

    assert result["status"] == "partial"
    assert result["missingInputs"] == [{
        "field": "debts.card.statement",
        "message": "Refresh Card's due date, last recorded as 2026-07-01. Confirm the current minimum and next payment date.",
        "section": "debts", "sourceId": "card",
    }]
    expected = []
    if paid_cents < 10_000:
        expected.append(("2026-07-01", "2026-10-16", 10_000 - paid_cents, False))
    if horizon == 30:
        expected.append(("2026-11-01", "2026-11-01", 10_000, True))
    payments = [row for row in result["events"] if row["sourceType"] == "debt"]
    assert [(row["date"], row["effectiveDate"], row["amountCents"], row["isProjection"]) for row in payments] == expected
    assert result["knownOutflowCents"] == sum(row[2] for row in expected)
    assert state == before


def test_same_day_bill_can_fall_short_before_pay_arrives() -> None:
    state = fixture()
    state["obligations"] = [bill(amountCents=95_000, dueDate="2026-10-02")]
    result = plan(state, days=7)
    assert result["lowestCashCents"] == 5_000
    assert result["lowestCashDate"] == "2026-10-02"
    assert result["firstShortfallDate"] == "2026-10-02"
    assert result["days"][4]["closingCashCents"] == 205_000


def test_income_transition_does_not_continue_old_pay() -> None:
    state = fixture()
    state["roadmap"].update(transitionDate="2026-10-01", partTimeMonthlyIncomeCents=100_000)
    result = plan(state, days=7)
    assert result["nextPayday"]["amountCents"] is None
    assert result["knownIncomeCents"] == 0
    assert any(row["field"] == "incomeChanges" for row in result["missingInputs"])


@pytest.mark.parametrize("days", [True, 0, 6, 91, 12.5, "30"])
def test_invalid_horizons_fail_without_partial_projection(days: Any) -> None:
    with pytest.raises(ValueError, match="between 7 and 90"):
        plan(fixture(), days=days)


def test_cash_overflow_is_rejected() -> None:
    state = fixture()
    state["accounts"][0]["balanceCents"] = MAX_SAFE_CENTS
    with pytest.raises(ValueError, match="supported range"):
        plan(state, days=7)


def test_saved_cash_floor_keeps_named_reserves_and_explicit_zero() -> None:
    state = fixture()
    state["roadmap"]["planningCashReserveCents"] = 50_000
    assert plan(state, days=7)["protectedCents"] == 50_000
    state["roadmap"]["planningCashReserveCents"] = 0
    assert plan(state, days=7)["protectedCents"] == 10_000
    state["reserves"] = []
    result = plan(state, days=7)
    assert result["protectedCents"] == 0
    assert not any(row["field"] == "reserves" for row in result["missingInputs"])
    state["roadmap"]["planningCashReserveCents"] = None
    assert any(row["field"] == "reserves" for row in plan(state, days=7)["missingInputs"])


def test_all_scope_does_not_subtract_business_bills_from_personal_living_budget() -> None:
    state = fixture()
    state["entities"].append({"id": "business", "kind": "business", "ownershipBps": 5000})
    state["roadmap"]["monthlyEssentialsCents"] = 30_000
    state["obligations"] = [bill(entityId="business", amountCents=10_000, dueDate="2026-09-29")]
    result = daily_plan(state, "all", "2026-09-28", {"days": 7})
    assert result["livingCostsCents"] == 6_871
    assert result["knownOutflowCents"] == 16_871


def test_living_allowance_and_before_pay_cash_are_independent_of_horizon() -> None:
    state = fixture()
    state["roadmap"].update(monthlyEssentialsCents=300_000, paydayAnchor="2026-10-06")
    state["obligations"] = [bill(amountCents=150_000, dueDate="2026-10-01", recurrence="monthly")]
    short = daily_plan(state, "personal", "2026-10-01", {"days": 7})
    long = daily_plan(state, "personal", "2026-10-01", {"days": 90})
    assert short["days"] == long["days"][:7]
    assert short["beforePayday"] == long["beforePayday"]
    # A paid bill still occupies its part of the month's living budget.
    state["obligations"][0]["status"] = "paid"
    paid = daily_plan(state, "personal", "2026-10-01", {"days": 7})
    assert paid["livingCostsCents"] == short["livingCostsCents"]
    assert short["knownOutflowCents"] - paid["knownOutflowCents"] == 150_000


def test_overdue_prior_month_bill_is_additional_to_current_month_allowance() -> None:
    state = fixture()
    state["roadmap"]["monthlyEssentialsCents"] = 300_000
    state["obligations"] = [bill(amountCents=150_000, dueDate="2026-09-01")]
    result = daily_plan(state, "personal", "2026-10-01", {"days": 31})
    assert result["livingCostsCents"] == 300_000
    assert result["knownOutflowCents"] == 450_000


def test_explicit_additional_income_is_counted_and_confirmed_regular_pay_is_not() -> None:
    state = fixture()
    state["obligations"] = [bill("extra", name="Side work", direction="in", additionalToPay=True, amountCents=20_000),
                            bill("salary", name="Salary", direction="in", additionalToPay=False, amountCents=200_000)]
    result = plan(state, days=7)
    assert result["knownIncomeCents"] == 220_000
    assert not any(row["field"].endswith("additionalIncome") for row in result["missingInputs"])


def test_unplanned_default_transition_does_not_block_saved_pay() -> None:
    state = fixture()
    state["roadmap"].update(transitionDate="2026-09-28", incomeTransitionPlanned=False)
    result = plan(state, days=7)
    assert result["knownIncomeCents"] == 200_000
    assert not any(row["field"] == "incomeChanges" for row in result["missingInputs"])


def test_interest_only_minimums_do_not_reduce_principal_and_stop_early() -> None:
    state = fixture()
    state["accounts"].append({**debt(repaymentKind="interest_only", minimumPaymentCents=5_000, paymentDueDate="2026-09-28"), "balanceCents": 10_000})
    result = plan(state, days=90)
    payments = [row for row in result["events"] if row["sourceType"] == "debt"]
    assert [row["date"] for row in payments] == ["2026-09-28", "2026-10-28", "2026-11-28"]
    assert [row["amountCents"] for row in payments] == [5_000, 5_000, 5_000]


def test_matching_expense_today_is_not_counted_again_without_review() -> None:
    state = fixture()
    state["expensePlanItems"] = [{"id": "repair", "entityId": "personal", "name": "Repair", "date": "2026-09-28", "amountCents": 10_000}]
    state["transactions"] = [{"id": "paid", "kind": "expense", "accountId": "cash", "description": "Repair", "date": "2026-09-28", "amountCents": 10_000}]
    result = plan(state, days=7)
    assert result["knownOutflowCents"] == 0
    assert any(row["field"] == "expensePlanItems.repair.recorded" for row in result["missingInputs"])


def test_paid_recurring_bill_keeps_monthly_allowance_when_its_due_date_rolls_forward() -> None:
    state = fixture()
    state["roadmap"]["monthlyEssentialsCents"] = 300_000
    state["obligations"] = [bill(amountCents=150_000, dueDate="2026-10-01", recurrence="monthly")]
    unpaid = daily_plan(state, "personal", "2026-10-01", {"days": 7})
    state["obligations"][0]["dueDate"] = "2026-11-01"
    state["transactions"] = [{"id": "paid", "kind": "expense", "accountId": "cash", "description": "Phone", "date": "2026-10-01", "amountCents": 150_000, "source": "Planned payment phone", "plannedPayment": {"obligationId": "phone", "dueDate": "2026-10-01"}}]
    paid = daily_plan(state, "personal", "2026-10-01", {"days": 7})
    assert paid["livingCostsCents"] == unpaid["livingCostsCents"]
    assert paid["knownOutflowCents"] == unpaid["knownOutflowCents"] - 150_000


@pytest.mark.parametrize("days", [7, 35])
def test_earlier_unpaid_bill_does_not_reforecast_paid_occurrence_or_reduce_allowance_twice(days: int) -> None:
    state = fixture()
    state["accounts"][0]["balanceCents"] = 450_000
    state["reserves"] = []
    state["roadmap"].update(payAmountCents=0, planningCashReserveCents=0, monthlyEssentialsCents=300_000)
    state["obligations"] = [bill(amountCents=150_000, dueDate="2026-09-20", recurrence="monthly")]
    state["transactions"] = [{"id": "october-paid", "kind": "expense", "accountId": "cash", "date": "2026-10-15",
                              "amountCents": 150_000, "plannedPayment": {"obligationId": "phone", "dueDate": "2026-10-20"}}]
    before = deepcopy(state)
    result = daily_plan(state, "personal", "2026-10-16", {"days": days})
    assert [row["date"] for row in result["events"] if row["sourceType"] == "obligation"] == ["2026-09-20"]
    assert result["livingCostsCents"] > 0
    advanced = deepcopy(state)
    advanced["obligations"][0]["dueDate"] = "2026-11-20"
    without_arrear = daily_plan(advanced, "personal", "2026-10-16", {"days": days})
    assert result["livingCostsCents"] == without_arrear["livingCostsCents"]
    assert result["knownOutflowCents"] == without_arrear["knownOutflowCents"] + 150_000
    assert result["cashAfterKnownCents"] == without_arrear["cashAfterKnownCents"] - 150_000
    assert state == before


def test_paydays_follow_work_periods_across_both_temporary_hours_boundaries() -> None:
    state = fixture()
    state["roadmap"].update(
        payAmountCents=150_000, paydayAnchor="2026-10-29", transitionDate="2027-01-01",
        temporaryWorkSchedule={"weeklyHours": 20, "fullTimeWeeklyHours": 37.5,
                               "returnDate": "2027-05-01", "payPeriodEndLagDays": 12},
    )
    january = daily_plan(state, "personal", "2027-01-06", {"days": 30})
    checks = {row["date"]: row["amountCents"] for row in january["events"] if row["sourceType"] == "payday"}
    assert checks == {"2027-01-07": 150_000, "2027-01-21": 108_000, "2027-02-04": 80_000}
    assert "incomeChanges" not in {row["field"] for row in january["missingInputs"]}
    may = daily_plan(state, "personal", "2027-05-13", {"days": 30})
    assert may["todayPayday"]["amountCents"] == 80_000
    assert may["nextPayday"] == {"date": "2027-05-27", "amountCents": 150_000}
    assert not next(row for row in may["events"] if row["date"] == "2027-05-13")["includedInCashflow"]
