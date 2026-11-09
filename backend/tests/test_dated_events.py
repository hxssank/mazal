from __future__ import annotations

from copy import deepcopy
from datetime import date
from typing import Any

import pytest

from mazal_engine.allocation import _calendar, _prepare, _simulate, compare
from mazal_engine.daily_plan import daily_plan
from mazal_engine.dated_events import cash_path, dated_spending, required_cash_buffer
from mazal_engine.feasibility import funding_feasibility


def snapshot() -> dict[str, Any]:
    return {
        "entities": [{"id": "me", "kind": "personal"}],
        "accounts": [{"id": "cash", "entityId": "me", "name": "Bank", "type": "cash", "balanceCents": 10_000, "reconciledAt": "2026-01-01"}],
        "transactions": [], "obligations": [], "reserves": [], "expensePlanItems": [], "assetPurchases": [],
        "roadmap": {"payAmountCents": 200_000, "payEveryDays": 14, "paydayAnchor": "2026-01-02", "monthlyEssentialsCents": 0, "planningCashReserveCents": 0},
    }


def bill(**changes: Any) -> dict[str, Any]:
    return {"id": "bill", "entityId": "me", "name": "Payment", "amountCents": 10_000, "dueDate": "2026-01-02", "direction": "out", "recurrence": "once", "status": "planned", **changes}


def assumptions(**changes: Any) -> dict[str, Any]:
    return {"months": 1, "payCents": 200_000, "frequency": 26, "paydayAnchor": "2026-01-02", "monthlySpendingCents": 0, "reserveCents": 0, "annualReturnPercent": 0, **changes}


def spending(state: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    return dated_spending(state, {"me"}, date(2026, 1, 1), date(2026, 2, 1))


def test_daily_plan_feasibility_and_allocations_preserve_same_day_payment_gap() -> None:
    state = snapshot()
    state["obligations"] = [bill(amountCents=100_000)]
    prepared, missing, _warnings = _prepare(state, "all", "2026-01-01", assumptions())
    assert not missing
    schedule = _calendar(state, prepared)
    for share in (None, 0, 0.5, 1):
        result = _simulate(state, prepared, schedule, share, {"shockPercent": 0, "shockMonth": 1})
        assert result["eligible"] is False
        assert result["maxUnfundedCents"] == 90_000
        assert result["lowestCashCents"] == -90_000
        assert result["weekly"][0]["unfundedCents"] >= 0
    daily = daily_plan(state, "all", "2026-01-01", {"days": 30})
    assert daily["lowestCashCents"] == -90_000
    feasibility = funding_feasibility(10_000, [0, 200_000], [0, 100_000], 0)
    assert feasibility["status"] == "infeasible"
    assert feasibility["reserveGapCents"] == 90_000


def test_allocation_keeps_cash_for_bills_before_the_next_payday_deposit() -> None:
    state = snapshot()
    state["accounts"][0]["balanceCents"] = 100_000
    state["obligations"] = [bill(amountCents=90_000, dueDate="2026-01-08")]
    prepared, missing, _warnings = _prepare(state, "all", "2026-01-01", assumptions(paydayAnchor="2026-01-08", reserveCents=10_000))
    assert not missing
    result = _simulate(state, prepared, _calendar(state, prepared), 1, {"shockPercent": 0, "shockMonth": 1})
    assert result["eligible"]
    assert result["weekly"][0]["investmentCents"] == 0
    assert result["weekly"][0]["closingCashCents"] == 100_000
    assert result["lowestCashCents"] >= 10_000


def test_cash_buffer_checks_before_and_after_each_deposit() -> None:
    assert cash_path(100, [500, 0], [200, 50]) == ([-100, 350], [400, 350])
    assert required_cash_buffer([500, 0], [200, 50]) == 200
    assert required_cash_buffer([0, 500], [200, 50]) == 250


def test_closed_zero_cash_accounts_do_not_require_fresh_balance_confirmation() -> None:
    state = snapshot()
    state["accounts"].append({"id": "old", "entityId": "me", "name": "Closed bank", "type": "cash", "balanceCents": 0, "closedAt": "2025-01-01"})
    result = daily_plan(state, "all", "2026-01-01", {"days": 30})
    assert not any(row["sourceId"] == "old" for row in result["missingInputs"] if "sourceId" in row)
    assert result["cashCents"] == 10_000


def test_duplicate_expense_plan_has_one_shared_decision_and_does_not_mutate_records() -> None:
    state = snapshot()
    state["obligations"] = [bill()]
    state["expensePlanItems"] = [{"id": "plan", "entityId": "me", "name": "Payment", "date": "2026-01-02", "amountCents": 10_000}]
    before = deepcopy(state)
    daily = daily_plan(state, "all", "2026-01-01", {"days": 30})
    result = compare(state, "all", "2026-01-01", assumptions())
    assert daily["knownOutflowCents"] == 10_000
    assert result["status"] == "needs_inputs"
    assert result["policies"] == []
    assert [row["field"] for row in result["missingInputs"]] == ["expensePlanItems.plan.overlap"]
    assert state == before


@pytest.mark.parametrize("resolution", [{"obligationId": "bill"}, {"separatePaymentConfirmed": True}])
def test_explicit_link_or_separate_confirmation_resolves_duplicate(resolution: dict[str, Any]) -> None:
    state = snapshot()
    state["obligations"] = [bill()]
    state["expensePlanItems"] = [{"id": "plan", "entityId": "me", "name": "Payment", "date": "2026-01-02", "amountCents": 10_000, **resolution}]
    events, missing = spending(state)
    assert not missing
    total = sum(row["amountCents"] for row in events if row["includedInCashflow"])
    assert total == (20_000 if resolution.get("separatePaymentConfirmed") else 10_000)
    prepared, missing, _warnings = _prepare(state, "all", "2026-01-01", assumptions())
    assert not missing
    assert int(_calendar(state, prepared)["expenses"].sum()) == total


def test_recorded_expense_plan_requires_link_and_does_not_add_spending_twice() -> None:
    state = snapshot()
    state["transactions"] = [{"id": "spent", "kind": "expense", "accountId": "cash", "description": "Purchase", "date": "2026-01-01", "amountCents": 1_000}]
    item = {"id": "plan", "entityId": "me", "name": "Purchase", "date": "2026-01-01", "amountCents": 1_000}
    state["expensePlanItems"] = [item]
    events, missing = spending(state)
    assert missing[0]["field"] == "expensePlanItems.plan.recorded"
    assert not events[0]["includedInCashflow"]
    item["transactionId"] = "spent"
    events, missing = spending(state)
    assert not missing
    assert not events[0]["includedInCashflow"]
    state["transactions"].append({**state["transactions"][0], "id": "reverse", "amountCents": -1_000, "reversalOf": "spent"})
    _events, missing = spending(state)
    assert missing[0]["field"] == "expensePlanItems.plan.transactionId"


def test_linked_purchase_bill_replaces_auto_installments_and_caps_remaining_cost() -> None:
    state = snapshot()
    state["assetPurchases"] = [{"id": "car", "entityId": "me", "name": "Car", "targetCents": 100_000, "paidCents": 85_000, "monthlyCents": 10_000}]
    state["obligations"] = [bill(assetPurchaseId="car", recurrence="biweekly")]
    state["roadmap"]["monthlyEssentialsCents"] = 31_000
    daily = daily_plan(state, "all", "2026-01-01", {"days": 31})
    assert not any(row["section"] == "assets" for row in daily["missingInputs"])
    assert daily["knownOutflowCents"] == 46_000
    prepared, missing, _warnings = _prepare(state, "all", "2026-01-01", assumptions(monthlySpendingCents=31_000))
    assert not missing
    assert int(_calendar(state, prepared)["expenses"].sum()) == 46_000
    assert [row["amountCents"] for row in spending(state)[0]] == [10_000, 5_000, 0]


def test_linked_purchase_does_not_require_a_second_assumed_payment_schedule() -> None:
    state = snapshot()
    state["assetPurchases"] = [{"id": "car", "entityId": "me", "name": "Car", "targetCents": 10_000, "paidCents": 0, "monthlyCents": 0}]
    state["obligations"] = [bill(assetPurchaseId="car")]
    prepared, missing, _warnings = _prepare(state, "all", "2026-01-01", assumptions())
    assert not missing
    assert int(_calendar(state, prepared)["expenses"].sum()) == 10_000


def test_purchase_link_rejects_other_owner_and_missing_purchase() -> None:
    state = snapshot()
    state["obligations"] = [bill(assetPurchaseId="missing")]
    with pytest.raises(ValueError, match="purchase"):
        spending(state)


def test_today_payday_stays_unconfirmed_until_explicit_receipt_is_linked() -> None:
    state = snapshot()
    state["roadmap"]["paydayAnchor"] = "2026-01-01"
    state["transactions"] = [{"id": "income", "kind": "income", "accountId": "cash", "date": "2026-01-01", "amountCents": 200_000}]
    result = daily_plan(state, "all", "2026-01-01", {"days": 7})
    assert result["todayPayday"]["receiptStatus"] == "unconfirmed"
    assert any(row["field"] == "paydayReceipt" for row in result["missingInputs"])
    assert result["knownIncomeCents"] == 0
    state["transactions"][0]["paydayDate"] = "2026-01-01"
    result = daily_plan(state, "all", "2026-01-01", {"days": 7})
    assert result["todayPayday"] == {"date": "2026-01-01", "amountCents": 200_000, "receiptStatus": "recorded", "transactionId": "income"}
    assert not any(row["field"] == "paydayReceipt" for row in result["missingInputs"])
    assert result["knownIncomeCents"] == 0


def test_unlinked_purchase_bill_overlap_requires_link_instead_of_double_charge() -> None:
    state = snapshot()
    state["assetPurchases"] = [{"id": "car", "entityId": "me", "name": "Car", "targetCents": 10_000, "paidCents": 0, "monthlyCents": 10_000}]
    state["obligations"] = [bill(name="Car", dueDate="2026-01-01")]
    result = compare(state, "all", "2026-01-01", assumptions())
    assert result["status"] == "needs_inputs"
    assert result["missingInputs"][0]["field"] == "assetPurchases.car.billLink"
    state["obligations"][0]["assetPurchaseId"] = "car"
    prepared, missing, _warnings = _prepare(state, "all", "2026-01-01", assumptions())
    assert not missing
    assert int(_calendar(state, prepared)["expenses"].sum()) == 10_000


def test_imported_bill_receipt_preserves_monthly_allowance_via_relationship() -> None:
    state = snapshot()
    state["roadmap"]["monthlyEssentialsCents"] = 31_000
    state["obligations"] = [bill(dueDate="2026-02-01", recurrence="monthly")]
    state["transactions"] = [{"id": "receipt", "kind": "expense", "accountId": "cash", "date": "2026-01-01", "amountCents": 10_000,
                               "source": "Original statement.pdf", "plannedPayment": {"obligationId": "bill", "dueDate": "2026-01-01"}}]
    result = daily_plan(state, "all", "2026-01-01", {"days": 31})
    assert result["livingCostsCents"] == 21_000
    assert result["knownOutflowCents"] == 21_000


@pytest.mark.parametrize("planned_date", ["2025-12-31", ""])
@pytest.mark.parametrize("separate", [False, True])
def test_unresolved_past_or_undated_expense_plan_cannot_make_cash_plan_ready(
    planned_date: str, separate: bool,
) -> None:
    state = snapshot()
    state["expensePlanItems"] = [{"id": "purchase", "entityId": "me", "name": "Purchase",
                                  "date": planned_date, "amountCents": 50_000,
                                  "separatePaymentConfirmed": separate}]
    before = deepcopy(state)
    daily = daily_plan(state, "all", "2026-01-01", {"days": 7})
    comparison = compare(state, "all", "2026-01-01", assumptions())
    assert daily["status"] == "partial"
    assert daily["knownOutflowCents"] == 0
    assert [row["field"] for row in daily["missingInputs"]] == ["expensePlanItems.purchase.date"]
    expenses = [row for row in daily["events"] if row["sourceType"] == "expense"]
    if planned_date:
        assert expenses[0]["date"] == planned_date
        assert expenses[0]["effectiveDate"] == "2026-01-01"
        assert expenses[0]["status"] == "overdue"
        assert expenses[0]["includedInCashflow"] is False
    else:
        assert expenses == []
    assert comparison["status"] == "needs_inputs"
    assert comparison["policies"] == []
    assert [row["field"] for row in comparison["missingInputs"]] == ["expensePlanItems.purchase.date"]
    assert state == before


@pytest.mark.parametrize("planned_date", ["2025-12-31", ""])
@pytest.mark.parametrize("linked_source", ["transaction", "obligation"])
def test_linked_past_or_undated_expenses_use_the_recorded_source(
    planned_date: str, linked_source: str,
) -> None:
    state = snapshot()
    state["obligations"] = [bill()]
    state["transactions"] = [{"id": "paid", "kind": "expense", "accountId": "cash",
                               "date": "2025-12-31", "amountCents": 50_000}]
    state["expensePlanItems"] = [{"id": "purchase", "entityId": "me", "name": "Purchase",
                                  "date": planned_date, "amountCents": 50_000,
                                  f"{linked_source}Id": "paid" if linked_source == "transaction" else "bill"}]
    events, missing = spending(state)
    assert missing == []
    assert [row["sourceType"] for row in events] == ["obligation"]
    if linked_source == "transaction":
        state["transactions"].append({**state["transactions"][0], "id": "reversal", "amountCents": -50_000,
                                      "reversalOf": "paid"})
        assert spending(state)[1][0]["field"] == "expensePlanItems.purchase.transactionId"
    else:
        state["obligations"][0]["status"] = "cancelled"
        assert spending(state)[1][0]["field"] == "expensePlanItems.purchase.obligationId"


def test_undated_expense_with_unknown_amount_keeps_both_inputs_missing() -> None:
    state = snapshot()
    state["expensePlanItems"] = [{"id": "purchase", "entityId": "me", "name": "Purchase",
                                  "date": "", "amountCents": None}]
    assert {row["field"] for row in spending(state)[1]} == {
        "expensePlanItems.purchase.date", "expensePlanItems.purchase.amountCents",
    }
