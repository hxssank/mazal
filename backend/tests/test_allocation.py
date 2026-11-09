import copy
from datetime import date

import pytest
from scipy.optimize import OptimizeResult

from mazal_engine.allocation import _calendar, _prepare, _simulate, compare
from mazal_engine.planner import simulate_planner


def snapshot():
    return {
        "workspace": "live",
        "revision": 1,
        "entities": [{"id": "me", "kind": "personal"}],
        "accounts": [
            {"id": "cash", "entityId": "me", "name": "Cash", "type": "cash", "balanceCents": 100_000},
            {
                "id": "invest",
                "entityId": "me",
                "name": "Investments",
                "type": "investment",
                "balanceCents": 20_000,
            },
        ],
        "transactions": [],
        "obligations": [],
        "reserves": [],
        "assets": [],
        "positions": [],
        "expensePlanItems": [],
    }


def assumptions(**changes):
    return {
        "months": 2,
        "payCents": 100_000,
        "frequency": 26,
        "paydayAnchor": "2026-01-01",
        "monthlySpendingCents": 50_000,
        "reserveCents": 10_000,
        "annualReturnPercent": 0,
        **changes,
    }


@pytest.mark.parametrize("debt_count", [0, 1, 6])
def test_comparison_calculates_day_fractions_once_per_date(
    monkeypatch: pytest.MonkeyPatch, debt_count: int,
) -> None:
    from mazal_engine.dates import day_fraction

    calls: list[tuple[date, date]] = []

    def counted_fraction(start: date, end: date) -> float:
        calls.append((start, end))
        return day_fraction(start, end)

    monkeypatch.setattr("mazal_engine.allocation.day_fraction", counted_fraction)
    state = snapshot()
    state["accounts"].extend({
        "id": f"debt-{index}", "entityId": "me", "name": f"Debt {index}", "type": "debt",
        "balanceCents": 50_000,
        "debtTerms": {
            "interestStatus": "accruing", "aprPercent": 12.9, "rateConfirmed": True,
            "minimumPaymentCents": 1_000, "paymentDueDate": "2028-02-10", "statementDate": "2028-01-31",
        },
    } for index in range(debt_count))
    result = compare(state, "all", "2028-02-01", assumptions(
        paydayAnchor="2028-02-03", annualReturnPercent=7, unexpectedExpenseCents=10_000,
    ))
    assert result["status"] == "ready"
    assert len(result["policies"]) == 6
    assert all(len(policy["scenarios"]) == 5 for policy in result["policies"])
    if debt_count:
        assert len(calls) == len(set(calls)) == 60
        assert calls[0][0] == date(2028, 2, 1)
        assert calls[-1][1] == date(2028, 4, 1)
        assert all((end - start).days == 1 for start, end in calls)
        assert (date(2028, 2, 29), date(2028, 3, 1)) in calls
    else:
        assert calls == []


@pytest.mark.parametrize("rate", [-100, -30, 0, 7, 100])
def test_money_conservation_and_no_snapshot_mutation(rate):
    state = snapshot()
    original = copy.deepcopy(state)
    result = compare(state, "all", "2026-01-01", assumptions(annualReturnPercent=rate))
    assert state == original
    assert result["status"] == "ready"
    for policy in result["policies"]:
        assert policy["netWorthCents"] == (
            120_000
            + policy["totalIncomeCents"]
            - policy["totalSpendingCents"]
            + policy["investmentGrowthCents"]
        )
        assert policy["lowestCashCents"] >= 10_000
        assert policy["eligible"]
        assert sum(row["incomeCents"] for row in policy["weekly"]) == policy["totalIncomeCents"]
        assert sum(row["spendingCents"] for row in policy["monthly"]) == 100_000


def test_unknown_inputs_cannot_become_zero():
    result = compare(snapshot(), "all", "2026-01-01", {"months": 1})
    assert result["status"] == "needs_inputs"
    assert result["policies"] == []
    assert {item["field"] for item in result["missingInputs"]} >= {
        "payCents",
        "monthlySpendingCents",
        "reserveCents",
        "annualReturnPercent",
        "paydayAnchor",
    }


@pytest.mark.parametrize(("repayment_start", "expected_warning"), [
    (None, True), ("2026-02-01", True), ("2026-03-01", False),
])
def test_zero_minimum_scenarios_expose_future_payment_assumption(
    repayment_start: str | None, expected_warning: bool,
) -> None:
    state = snapshot()
    state["accounts"].append({
        "id": "loan", "name": "Loan", "entityId": "me", "type": "debt", "balanceCents": 100_000,
        "debtTerms": {"interestStatus": "interest_free", "minimumPaymentCents": 0,
                      **({"repaymentStatus": "in_study", "repaymentStartDate": repayment_start} if repayment_start else {})},
    })
    before = copy.deepcopy(state)
    result = compare(state, "all", "2026-01-01", assumptions())
    assert result["status"] == "ready"
    assert any("Loan has a balance with a recorded $0 payment" in warning for warning in result["warnings"]) is expected_warning
    assert state == before


@pytest.mark.parametrize("repayment_start", ["2026-01-20", "2026-01-31"])
def test_resuming_study_loan_requires_a_deadline_after_deferral(repayment_start: str) -> None:
    state = snapshot()
    loan = {
        "id": "study-loan", "entityId": "me", "name": "Study loan", "type": "debt",
        "balanceCents": 100_000,
        "debtTerms": {
            "interestStatus": "interest_free", "minimumPaymentCents": 10_000,
            "paymentDueDate": "2026-01-10", "repaymentStatus": "in_study",
            "repaymentStartDate": repayment_start,
        },
    }
    state["accounts"].append(loan)
    original = copy.deepcopy(state)
    result = compare(state, "all", "2026-01-01", assumptions(months=1))
    assert result["status"] == "needs_inputs"
    assert result["policies"] == []
    assert result["missingInputs"] == [{
        "field": "accounts.study-loan.paymentDueDate",
        "message": f"Confirm the first payment deadline for Study loan after repayment resumes on {repayment_start}.",
    }]
    assert state == original

    loan["debtTerms"]["paymentDueDate"] = repayment_start
    prepared, missing, _warnings = _prepare(state, "all", "2026-01-01", assumptions(months=1))
    assert not missing
    schedule = _calendar(state, prepared)
    assert int(schedule["minimums"].sum()) == 10_000
    assert schedule["minimums"][schedule["dates"].index(repayment_start), 0] == 10_000


@pytest.mark.parametrize("minimum, repayment_start", [(10_000, "2026-02-01"), (0, "2026-01-20")])
def test_study_loan_without_required_payments_in_the_comparison_needs_no_new_deadline(
    minimum: int, repayment_start: str,
) -> None:
    state = snapshot()
    state["accounts"].append({
        "id": "study-loan", "entityId": "me", "name": "Study loan", "type": "debt",
        "balanceCents": 100_000,
        "debtTerms": {
            "interestStatus": "interest_free", "minimumPaymentCents": minimum,
            "paymentDueDate": "2026-01-10", "repaymentStatus": "in_study",
            "repaymentStartDate": repayment_start,
        },
    })
    prepared, missing, _warnings = _prepare(state, "all", "2026-01-01", assumptions(months=1))
    assert not missing
    assert int(_calendar(state, prepared)["minimums"].sum()) == 0


def test_unfunded_expenses_remain_liabilities():
    state = snapshot()
    state["accounts"][0]["balanceCents"] = 0
    state["accounts"][1]["balanceCents"] = 0
    result = compare(state, "all", "2026-01-01", assumptions(payCents=0, reserveCents=0, months=1))
    for policy in result["policies"]:
        assert policy["netWorthCents"] == -50_000
        assert policy["endingUnfundedExpenseCents"] == 50_000
        assert policy["maxUnfundedCents"] == 50_000
        assert not policy["eligible"]
    assert result["bestPolicyId"] is None


def test_business_cash_cannot_fund_personal_plan():
    state = snapshot()
    state["entities"].append({"id": "biz", "kind": "business"})
    state["accounts"].append({"id": "biz_cash", "entityId": "biz", "type": "cash", "balanceCents": 1_000_000})
    result = compare(state, "all", "2026-01-01", assumptions())
    assert result["policies"][0]["openingNetWorthCents"] == 120_000
    with pytest.raises(ValueError, match="personal"):
        compare(state, "biz", "2026-01-01", assumptions())


def test_obligations_consume_spending_budget_without_double_counting():
    state = snapshot()
    state["obligations"] = [
        {
            "id": "bill",
            "entityId": "me",
            "accountId": "cash",
            "name": "Bill",
            "amountCents": 20_000,
            "dueDate": "2026-01-02",
            "recurrence": "monthly",
            "status": "planned",
            "direction": "out",
        }
    ]
    result = compare(state, "all", "2026-01-01", assumptions())
    assert result["policies"][0]["totalSpendingCents"] == 100_000


def test_debt_payoff_releases_funding_and_preserves_interest_conservation():
    state = snapshot()
    state["accounts"].append(
        {
            "id": "loan",
            "name": "Loan",
            "entityId": "me",
            "type": "debt",
            "balanceCents": 20_000,
            "debtTerms": {
                "aprPercent": 12,
                "rateConfirmed": True,
                "interestStatus": "accruing",
                "minimumPaymentCents": 1_000,
                "paymentDueDate": "2026-01-15",
            },
        }
    )
    result = compare(state, "all", "2026-01-01", assumptions())
    policy = next(policy for policy in result["policies"] if policy["id"] == "debt")
    assert policy["debtFreeDate"] == "2026-01-01"
    assert policy["totalInvestmentContributionsCents"] > 0
    assert policy["netWorthCents"] == (
        100_000 + policy["totalIncomeCents"] - policy["totalSpendingCents"] - policy["totalInterestCents"]
    )


@pytest.mark.parametrize("paid_cents", [6_000, 10_000, 12_000])
def test_recorded_debt_payments_reduce_only_the_current_statement_minimum(paid_cents: int) -> None:
    state = snapshot()
    state["accounts"][0]["balanceCents"] = max(0, 10_000 - paid_cents)
    state["accounts"].append({
        "id": "card", "name": "Card", "entityId": "me", "type": "debt", "balanceCents": 90_000,
        "debtTerms": {"aprPercent": 0, "rateConfirmed": True, "minimumPaymentCents": 10_000,
                      "paymentDueDate": "2026-01-15", "statementDate": "2025-12-15"},
    })
    state["transactions"] = [{"id": "paid", "kind": "debt_payment", "date": "2025-12-20",
                               "accountId": "cash", "toAccountId": "card", "amountCents": paid_cents}]
    original = copy.deepcopy(state)
    inputs = assumptions(months=2, payCents=0, monthlySpendingCents=0, reserveCents=0)
    prepared, missing, _warnings = _prepare(state, "all", "2026-01-01", inputs)
    assert not missing
    calendar = _calendar(state, prepared)
    assert calendar["minimums"][calendar["dates"].index("2026-01-15"), 0] == max(0, 10_000 - paid_cents)
    assert calendar["minimums"][calendar["dates"].index("2026-02-15"), 0] == 10_000
    result = compare(state, "all", "2026-01-01", {**inputs, "months": 1})
    assert result["feasibility"]["status"] == "feasible"
    cash_policy = next(policy for policy in result["policies"] if policy["id"] == "cash")
    assert cash_policy["eligible"]
    assert state == original


@pytest.mark.parametrize("statement_date, expected_minimum", [("2025-12-15", 5_000), (None, 10_000)])
def test_minimum_credit_requires_statement_dates_and_net_posted_payment_evidence(
    statement_date: str | None, expected_minimum: int,
) -> None:
    state = snapshot()
    state["accounts"].append({
        "id": "card", "name": "Card", "entityId": "me", "type": "debt", "balanceCents": 90_000,
        "debtTerms": {"aprPercent": 0, "rateConfirmed": True, "minimumPaymentCents": 10_000,
                      "paymentDueDate": "2026-01-15", "statementDate": statement_date},
    })
    payment = {"kind": "adjustment", "accountId": "card", "category": "Card payment",
               "amountCents": 7_000, "importSources": [{"importId": "statement", "rowId": "paid"}]}
    state["transactions"] = [
        {**payment, "id": "paid", "date": "2025-12-14", "postingDates": {"card": "2025-12-20"},
         "balanceChanges": {"card": -7_000}},
        {**payment, "id": "reversed", "date": "2025-12-25", "amountCents": 2_000,
         "balanceChanges": {"card": 2_000}},
        {**payment, "id": "on-statement", "date": "2025-12-15", "balanceChanges": {"card": -7_000}},
        {**payment, "id": "not-yet-posted", "date": "2025-12-31", "postingDates": {"card": "2026-01-02"},
         "balanceChanges": {"card": -7_000}},
        {"id": "other-debt", "kind": "debt_payment", "date": "2025-12-20", "accountId": "cash",
         "toAccountId": "other", "amountCents": 10_000},
    ]
    prepared, missing, _warnings = _prepare(state, "all", "2026-01-01", assumptions())
    assert not missing
    calendar = _calendar(state, prepared)
    assert calendar["minimums"][calendar["dates"].index("2026-01-15"), 0] == expected_minimum
    assert calendar["minimums"][calendar["dates"].index("2026-02-15"), 0] == 10_000


def test_same_seed_and_same_policy_produce_same_outcomes():
    first = compare(snapshot(), "all", "2026-01-01", assumptions())
    second = compare(snapshot(), "all", "2026-01-01", assumptions())
    assert first == second
    mixed = next(policy for policy in first["policies"] if policy["id"] == "mixed")
    custom = next(policy for policy in first["policies"] if policy["id"] == "custom")
    assert mixed["netWorthCents"] == custom["netWorthCents"]
    assert mixed["weekly"] == custom["weekly"]


def test_stress_does_not_inform_policy_before_it_happens():
    result = compare(snapshot(), "all", "2026-01-01", assumptions(shockMonth=2))
    policy = next(policy for policy in result["policies"] if policy["id"] == "invest")
    shock = next(case for case in policy["scenarios"] if case["id"] == "total_loss")
    assert shock["lossVsBaseCents"] > 20_000
    assert shock["paychecksToReplace"] > 0


def test_checkpoints_label_partial_calendar_periods():
    result = compare(snapshot(), "all", "2026-01-14", assumptions(months=1))
    policy = result["policies"][0]
    assert policy["weekly"][0]["partial"]
    assert policy["weekly"][0]["startDate"] == "2026-01-14"
    assert policy["monthly"][0]["partial"]
    assert policy["monthly"][-1]["endDate"] == "2026-02-13"


@pytest.mark.parametrize(
    ("reserved", "formatted"), [(30_000, "300.00"), (250_000, "2,500.00"), (250_001, "2,500.01")]
)
def test_recorded_reserves_cannot_be_silently_removed(reserved: int, formatted: str) -> None:
    state = snapshot()
    state["reserves"] = [{"id": "protected", "entityId": "me", "amountCents": reserved}]
    result = compare(state, "all", "2026-01-01", assumptions(reserveCents=10_000))
    assert result["status"] == "needs_inputs"
    assert {
        "field": "reserveCents",
        "message": f"The reserve must cover CAD {formatted} of recorded protected reserves.",
    } in result["missingInputs"]


def test_recorded_income_transition_changes_future_paychecks():
    state = snapshot()
    state["roadmap"] = {"transitionDate": "2026-02-01", "partTimeMonthlyIncomeCents": 0}
    result = compare(state, "all", "2026-01-01", assumptions())
    months = result["policies"][0]["monthly"]
    assert months[0]["incomeCents"] == 200_000
    assert months[1]["incomeCents"] == 0


def test_unknown_income_after_transition_blocks_comparison():
    state = snapshot()
    state["roadmap"] = {"transitionDate": "2026-02-01", "partTimeMonthlyIncomeCents": None}
    result = compare(state, "all", "2026-01-01", assumptions())
    assert result["status"] == "needs_inputs"
    assert any(item["field"] == "incomeChanges" for item in result["missingInputs"])


def test_interest_free_component_never_accrues_other_component_interest():
    state = snapshot()
    state["accounts"].append(
        {
            "id": "loan",
            "name": "Loan",
            "entityId": "me",
            "type": "debt",
            "balanceCents": 100_000,
            "debtTerms": {
                "aprPercent": None,
                "rateConfirmed": False,
                "minimumPaymentCents": 0,
                "paymentDueDate": None,
                "repaymentStartDate": None,
                "components": [
                    {
                        "id": "federal",
                        "balanceCents": 90_000,
                        "aprPercent": 0,
                        "rateConfirmed": True,
                        "interestStatus": "interest_free",
                    },
                    {
                        "id": "ontario",
                        "balanceCents": 10_000,
                        "aprPercent": 12,
                        "rateConfirmed": True,
                        "interestStatus": "accruing",
                    },
                ],
            },
        }
    )
    result = compare(state, "all", "2026-01-01", assumptions(months=1))
    policy = next(policy for policy in result["policies"] if policy["id"] == "cash")
    assert 100 <= policy["totalInterestCents"] <= 103


def test_family_help_adds_an_equal_liability_and_requires_repayment_terms():
    state = snapshot()
    for account in state["accounts"]:
        account["balanceCents"] = 0
    family = {
        "limitCents": 100_000,
        "availableDate": "2026-01-01",
        "repaymentStartDate": "2026-02-01",
        "monthlyRepaymentCents": 10_000,
        "interestFreeConfirmed": True,
    }
    result = compare(
        state, "all", "2026-01-01", assumptions(months=1, payCents=0, reserveCents=0, familyAssistance=family)
    )
    for policy in result["policies"]:
        assert policy["familyBorrowedCents"] == 50_000
        assert policy["familyBalanceCents"] == 50_000
        assert policy["netWorthCents"] == -50_000
        assert policy["maxUnfundedCents"] == 0
        assert policy["debtFreeDate"] is None
    del family["interestFreeConfirmed"]
    with pytest.raises(ValueError, match="interest-free"):
        compare(state, "all", "2026-01-01", assumptions(familyAssistance=family))


@pytest.mark.parametrize("balance", [10_000, 50_000])
def test_family_help_borrows_only_remaining_debt_and_stops_after_payoff(balance):
    state = snapshot()
    for account in state["accounts"]:
        account["balanceCents"] = 0
    state["accounts"].append(
        {
            "id": "loan",
            "entityId": "me",
            "name": "Loan",
            "type": "debt",
            "balanceCents": balance,
            "debtTerms": {
                "aprPercent": 0,
                "rateConfirmed": True,
                "minimumPaymentCents": 50_000,
                "paymentDueDate": "2026-01-01",
                "repaymentKind": "fixed",
            },
        }
    )
    result = compare(
        state,
        "all",
        "2026-01-01",
        assumptions(
            months=2,
            payCents=0,
            monthlySpendingCents=0,
            reserveCents=0,
            familyAssistance={
                "limitCents": 100_000,
                "availableDate": "2026-01-01",
                "repaymentStartDate": "2026-04-01",
                "monthlyRepaymentCents": 10_000,
                "interestFreeConfirmed": True,
            },
        ),
    )
    for policy in result["policies"]:
        assert policy["familyBorrowedCents"] == balance
        assert policy["familyBalanceCents"] == balance
        assert policy["totalInvestmentContributionsCents"] == 0
        assert policy["maxUnfundedCents"] == 0
        assert policy["netWorthCents"] == -balance


def test_late_income_does_not_erase_a_missed_debt_deadline():
    state = snapshot()
    for account in state["accounts"]:
        account["balanceCents"] = 0
    state["accounts"].append(
        {
            "id": "loan",
            "entityId": "me",
            "name": "Loan",
            "type": "debt",
            "balanceCents": 10_000,
            "debtTerms": {
                "interestStatus": "interest_free",
                "aprPercent": 0,
                "rateConfirmed": True,
                "minimumPaymentCents": 1_000,
                "paymentDueDate": "2026-01-15",
            },
        }
    )
    result = compare(
        state,
        "all",
        "2026-01-01",
        assumptions(
            months=1,
            payCents=5_000,
            frequency=12,
            paydayAnchor="2026-01-31",
            monthlySpendingCents=0,
            reserveCents=0,
        ),
    )
    cash = result["policies"][0]
    assert cash["maxUnfundedCents"] == 1_000
    assert cash["netWorthCents"] == -5_000
    assert cash["monthly"][0]["unfundedCents"] == 0
    assert not cash["eligible"]


def incoming_payday():
    return {
        "id": "scheduled-pay",
        "entityId": "me",
        "accountId": "cash",
        "name": "Payday",
        "amountCents": 100_000,
        "dueDate": "2026-01-01",
        "recurrence": "biweekly",
        "status": "planned",
        "direction": "in",
    }


def purchase(**changes):
    return {
        "id": "car",
        "entityId": "me",
        "name": "Car purchase",
        "payee": "Family",
        "targetCents": 100_000,
        "paidCents": 20_000,
        "monthlyCents": 30_000,
        "paidAsOf": "2026-01-01",
        **changes,
    }


def test_scheduled_income_requires_an_explicit_relationship_to_regular_pay():
    state = snapshot()
    state["obligations"] = [incoming_payday()]
    result = compare(state, "all", "2026-01-01", assumptions(months=1))
    assert result["status"] == "needs_inputs"
    assert result["policies"] == []
    assert any(item["field"] == "additionalIncomeObligationIds" for item in result["missingInputs"])
    covered = compare(state, "all", "2026-01-01", assumptions(months=1, additionalIncomeObligationIds=[]))
    assert covered["policies"][0]["totalIncomeCents"] == 200_000
    extra = compare(
        state, "all", "2026-01-01", assumptions(months=1, additionalIncomeObligationIds=["scheduled-pay"])
    )
    assert extra["policies"][0]["totalIncomeCents"] == 400_000
    with pytest.raises(ValueError, match="Additional income"):
        compare(state, "all", "2026-01-01", assumptions(additionalIncomeObligationIds=["missing"]))


@pytest.mark.parametrize("due_date", ["2025-12-31", "2026-01-01"])
def test_current_and_overdue_additional_income_cannot_increase_saved_cash(due_date: str) -> None:
    state = snapshot()
    state["obligations"] = [{**incoming_payday(), "dueDate": due_date, "recurrence": "once"}]
    inputs = assumptions(months=1, payCents=0, monthlySpendingCents=0,
                         additionalIncomeObligationIds=["scheduled-pay"])
    result = compare(state, "all", "2026-01-01", inputs)
    assert result["status"] == "ready"
    assert result["policies"][0]["totalIncomeCents"] == 0
    assert result["policies"][0]["netWorthCents"] == 120_000


@pytest.mark.parametrize("recurrence,anchor,as_of,paid_date,unpaid_date,months", [
    ("monthly", "2026-01-31", "2026-02-01", "2026-02-28", "2026-03-31", 2),
    ("biweekly", "2026-09-18", "2026-10-03", "2026-10-16", "2026-10-30", 1),
])
def test_additional_income_skips_received_occurrences_after_schedule_catch_up(
    recurrence: str, anchor: str, as_of: str, paid_date: str, unpaid_date: str, months: int,
) -> None:
    state = snapshot()
    state["obligations"] = [{**incoming_payday(), "dueDate": anchor, "recurrence": recurrence,
                             "amountCents": 10_000}]
    state["transactions"] = [{"id": "received", "kind": "income", "accountId": "cash",
                              "date": as_of, "amountCents": 10_000,
                              "plannedPayment": {"obligationId": "scheduled-pay", "dueDate": paid_date}}]
    original = copy.deepcopy(state)
    inputs = assumptions(months=months, payCents=0, monthlySpendingCents=0,
                         additionalIncomeObligationIds=["scheduled-pay"])
    prepared, missing, _warnings = _prepare(state, "all", as_of, inputs)
    assert not missing
    schedule = _calendar(state, prepared)
    assert [(day, int(amount)) for day, amount in zip(schedule["dates"], schedule["income"], strict=True)
            if amount] == [(unpaid_date, 10_000)]
    result = compare(state, "all", as_of, inputs)
    assert result["status"] == "ready"
    for policy in result["policies"]:
        assert policy["totalIncomeCents"] == 10_000
        assert policy["netWorthCents"] == 130_000
    assert state == original


def test_dated_one_off_costs_are_additional_to_the_living_budget():
    state = snapshot()
    state["expensePlanItems"] = [
        {"id": "laptop", "entityId": "me", "name": "Laptop", "amountCents": 80_000, "date": "2026-01-10"}
    ]
    result = compare(state, "all", "2026-01-01", assumptions(months=1, monthlySpendingCents=100_000))
    assert result["policies"][0]["totalSpendingCents"] == 180_000
    assert result["policies"][0]["netWorthCents"] == 120_000 + 200_000 - 180_000


def test_purchase_installments_are_capped_at_remaining_cost_and_do_not_create_resale_value():
    state = snapshot()
    state["assetPurchases"] = [purchase()]
    result = compare(state, "all", "2026-01-01", assumptions(months=4))
    policy = result["policies"][0]
    assert [month["spendingCents"] for month in policy["monthly"]] == [80_000, 80_000, 70_000, 50_000]
    assert policy["totalSpendingCents"] == 280_000
    assert policy["openingNetWorthCents"] == 120_000
    assert result["assumptions"]["purchaseFirstPaymentDates"] == {"car": "2026-01-01"}
    assert any("book equity is excluded" in text for text in result["warnings"])
    delayed = compare(
        state, "all", "2026-01-01", assumptions(months=4, purchaseFirstPaymentDates={"car": "2026-02-15"})
    )
    assert [month["spendingCents"] for month in delayed["policies"][0]["monthly"]] == [
        50_000,
        80_000,
        80_000,
        70_000,
    ]


def test_unknown_purchase_progress_or_payment_schedule_blocks_allocation():
    for changes, field in [({"paidCents": None}, "paidCents"), ({"monthlyCents": 0}, "monthlyCents")]:
        state = snapshot()
        state["assetPurchases"] = [purchase(**changes)]
        result = compare(state, "all", "2026-01-01", assumptions())
        assert result["status"] == "needs_inputs"
        assert any(item["field"] == f"assetPurchases.car.{field}" for item in result["missingInputs"])
    state["assetPurchases"] = [purchase(paidCents=100_000, monthlyCents=0)]
    assert compare(state, "all", "2026-01-01", assumptions())["status"] == "ready"


def test_stale_required_debt_dates_cannot_be_skipped_as_already_paid():
    state = snapshot()
    state["accounts"].append(
        {
            "id": "debt",
            "entityId": "me",
            "type": "debt",
            "name": "Loan",
            "balanceCents": 100_000,
            "debtTerms": {
                "aprPercent": 0,
                "rateConfirmed": True,
                "minimumPaymentCents": 10_000,
                "paymentDueDate": "2025-12-15",
                "repaymentKind": "fixed",
            },
        }
    )
    result = compare(state, "all", "2026-01-01", assumptions())
    assert result["status"] == "needs_inputs"
    assert any(item["field"] == "accounts.debt.paymentDueDate" for item in result["missingInputs"])
    assert result["policies"] == []


def test_interest_only_contracts_do_not_silently_become_fixed_minimum_loans():
    state = snapshot()
    state["accounts"].append(
        {
            "id": "loc",
            "entityId": "me",
            "type": "debt",
            "name": "Credit line",
            "balanceCents": 100_000,
            "debtTerms": {
                "aprPercent": 12,
                "rateConfirmed": True,
                "minimumPaymentCents": 1_000,
                "paymentDueDate": "2026-01-15",
                "repaymentKind": "interest_only",
            },
        }
    )
    result = compare(state, "all", "2026-01-01", assumptions())
    assert result["status"] == "needs_inputs"
    assert any(item["field"] == "accounts.loc.repaymentKind" for item in result["missingInputs"])
    assert result["policies"] == []


def test_an_unknown_pay_frequency_does_not_become_monthly_pay():
    values = assumptions()
    del values["frequency"]
    result = compare(snapshot(), "all", "2026-01-01", values)
    assert result["status"] == "needs_inputs"
    assert any(item["field"] == "frequency" for item in result["missingInputs"])
    assert result["policies"] == []


def test_next_payday_deposit_cannot_remove_an_earlier_same_day_bill_gap():
    state = snapshot()
    state["accounts"][0]["balanceCents"] = 10_000
    state["accounts"][1]["balanceCents"] = 0
    state["expensePlanItems"] = [
        {"id": "bill", "entityId": "me", "name": "Bill", "amountCents": 20_000, "date": "2026-01-15"}
    ]
    result = compare(
        state,
        "all",
        "2026-01-01",
        assumptions(months=1, payCents=10_000, monthlySpendingCents=0, reserveCents=0),
    )
    for policy in result["policies"]:
        assert not policy["eligible"]
        assert policy["maxUnfundedCents"] == 10_000
        assert policy["netWorthCents"] == 10_000
    invested = next(policy for policy in result["policies"] if policy["id"] == "invest")
    assert invested["weekly"][0]["investmentCents"] == 0


@pytest.mark.parametrize("apr", [0, 12])
def test_feasibility_stops_reserving_minimums_after_modeled_payoff(apr):
    state = snapshot()
    state["accounts"][0]["balanceCents"] = 1_050
    state["accounts"][1]["balanceCents"] = 0
    state["accounts"].append(
        {
            "id": "loan",
            "name": "Loan",
            "entityId": "me",
            "type": "debt",
            "balanceCents": 1_000,
            "debtTerms": {
                "aprPercent": apr,
                "rateConfirmed": True,
                "minimumPaymentCents": 1_050,
                "paymentDueDate": "2026-01-15",
                "repaymentKind": "fixed",
            },
        }
    )
    result = compare(
        state,
        "all",
        "2026-01-01",
        assumptions(months=2, payCents=0, monthlySpendingCents=0, reserveCents=0),
    )
    cash = result["policies"][0]
    assert cash["eligible"]
    assert cash["debtFreeDate"] == "2026-01-15"
    assert result["feasibility"]["status"] == "feasible"
    assert result["feasibility"]["exactCentCheck"]
    assert cash["netWorthCents"] == 50 - cash["totalInterestCents"]


def test_fractional_investment_growth_accumulates_before_reporting_whole_cents():
    state = snapshot()
    state["accounts"][0]["balanceCents"] = 0
    state["accounts"][1]["balanceCents"] = 100
    result = compare(
        state,
        "all",
        "2026-01-01",
        assumptions(months=12, payCents=0, monthlySpendingCents=0, reserveCents=0, annualReturnPercent=100),
    )
    for policy in result["policies"]:
        assert policy["netWorthCents"] == 200
        assert policy["investmentGrowthCents"] == 100
        assert policy["totalInvestmentContributionsCents"] == 0
        assert next(case for case in policy["scenarios"] if case["id"] == "total_loss")["netWorthCents"] == 0


@pytest.mark.parametrize("year", [2027, 2028])
def test_planner_and_comparison_reconcile_dated_contributions_and_compound_growth(year: int) -> None:
    state = snapshot()
    state["accounts"][0]["balanceCents"] = 0
    state["accounts"][1]["balanceCents"] = 100_000
    first_payday = f"{year}-01-31"
    inputs = assumptions(
        months=12, payCents=10_001, frequency=12, paydayAnchor=first_payday,
        monthlySpendingCents=0, reserveCents=0, annualReturnPercent=12,
    )
    prepared, missing, _warnings = _prepare(state, "all", f"{year}-01-01", inputs)
    assert not missing
    schedule = _calendar(state, prepared)
    comparison = _simulate(state, prepared, schedule, 1, {"shockPercent": 0, "shockMonth": 3})
    planner = simulate_planner({
        "startMonth": f"{year}-01", "months": 12, "payCents": 10_001, "frequency": 12,
        "paydayAnchor": first_payday, "monthlyMomCents": 0, "momRemainingCents": 0,
        "monthlyDebtCents": 0, "monthlySpendingCents": 0, "debts": [], "startingCashCents": 0,
        "startingInvestmentsCents": 100_000, "surplusDestination": "investments",
        "annualReturnPercent": 12, "extraDebtCents": 0, "strategy": "avalanche", "selectedDebtId": None,
    })
    end = date(year + 1, 1, 1)
    expected = 100_000 * 1.12 ** ((end - date(year, 1, 1)).days / 365)
    expected += sum(
        10_001 * 1.12 ** (((end - date.fromisoformat(payday)).days - 1) / 365)
        for payday in schedule["paydays"]
    )
    assert comparison["netWorthCents"] == round(expected)
    assert planner["days"][-1]["investmentsCents"] == round(expected)
    assert comparison["investmentGrowthCents"] == planner["days"][-1]["investmentGrowthCents"]
    assert comparison["totalInvestmentContributionsCents"] == 120_012


def test_ninety_percent_investment_split_does_not_drop_a_debt_payment_cent() -> None:
    state = snapshot()
    state["accounts"][0]["balanceCents"] = 10
    state["accounts"][1]["balanceCents"] = 0
    state["accounts"].append({
        "id": "loan", "name": "Loan", "entityId": "me", "type": "debt", "balanceCents": 10,
        "debtTerms": {"aprPercent": 0, "rateConfirmed": True, "minimumPaymentCents": 0},
    })
    inputs = assumptions(months=1, payCents=0, monthlySpendingCents=0, reserveCents=0)
    prepared, missing, _warnings = _prepare(state, "all", "2026-01-01", inputs)
    assert not missing
    result = _simulate(state, prepared, _calendar(state, prepared), 0.9, {"shockPercent": 0, "shockMonth": 1})
    assert result["totalInvestmentContributionsCents"] == 9
    assert result["monthly"][0]["extraDebtCents"] == 1
    assert result["monthly"][0]["debtCents"] == 9
    assert result["netWorthCents"] == 0


def test_past_income_transition_applies_to_every_future_payday():
    state = snapshot()
    state["roadmap"] = {"transitionDate": "2025-12-01", "partTimeMonthlyIncomeCents": 26_000}
    result = compare(state, "all", "2026-01-01", assumptions(months=1))
    assert result["policies"][0]["totalIncomeCents"] == 24_000
    state["roadmap"]["partTimeMonthlyIncomeCents"] = None
    blocked = compare(state, "all", "2026-01-01", assumptions(months=1))
    assert blocked["status"] == "needs_inputs"
    assert any(item["field"] == "incomeChanges" for item in blocked["missingInputs"])


@pytest.mark.parametrize("changes", [{"seed": True}, {"userInvestmentShare": True}])
def test_boolean_assumptions_do_not_become_numbers(changes):
    with pytest.raises(ValueError):
        compare(snapshot(), "all", "2026-01-01", assumptions(**changes))


def test_setback_cannot_use_pay_earned_before_the_loss_to_replace_it():
    state = snapshot()
    state["roadmap"] = {"transitionDate": "2026-02-01", "partTimeMonthlyIncomeCents": 0}
    result = compare(
        state,
        "all",
        "2026-01-01",
        assumptions(months=2, shockMonth=2, monthlySpendingCents=0, reserveCents=0),
    )
    invested = next(policy for policy in result["policies"] if policy["id"] == "invest")
    loss = next(case for case in invested["scenarios"] if case["id"] == "total_loss")
    assert loss["lossVsBaseCents"] == 320_000
    assert loss["paychecksToReplace"] is None


@pytest.mark.parametrize(
    ("success", "solver_status", "expected_warning"),
    [
        (
            False,
            1,
            "The allocation search hit its iteration limit. The comparison uses the best tested split.",
        ),
        (
            False,
            2,
            "The allocation search stopped without convergence. The comparison uses the best tested split.",
        ),
        (True, 0, None),
    ],
)
def test_search_stopping_reason_is_visible_in_comparison_warnings(
    monkeypatch: pytest.MonkeyPatch, success: bool, solver_status: int, expected_warning: str | None
) -> None:
    def search(objective, *, bounds, method, options):
        assert bounds == (0, 1)
        assert method == "bounded"
        assert options == {"maxiter": 12, "xatol": 0.005}
        return OptimizeResult(x=0.5, success=success, status=solver_status)

    monkeypatch.setattr("mazal_engine.allocation.minimize_scalar", search)
    result = compare(snapshot(), "all", "2026-01-01", assumptions())
    search_warnings = [
        warning for warning in result["warnings"] if warning.startswith("The allocation search")
    ]
    assert search_warnings == ([expected_warning] if expected_warning else [])
    assert result["search"]["converged"] == success
    assert len(result["policies"]) == 6


def test_saved_planning_reserve_is_the_default_and_cannot_reduce_named_reserves():
    state = snapshot()
    state["roadmap"] = {"planningCashReserveCents": 50_000, "incomeTransitionPlanned": False, "transitionDate": "2026-01-01"}
    state["reserves"] = [{"id": "rent", "entityId": "me", "amountCents": 70_000}]
    raw = assumptions()
    del raw["reserveCents"]
    prepared, missing, _warnings = _prepare(state, "all", "2026-01-01", raw)
    assert not missing
    assert prepared["assumptions"]["reserveCents"] == 70_000
    _, missing, _warnings = _prepare(state, "all", "2026-01-01", assumptions(reserveCents=60_000))
    assert any(row["field"] == "reserveCents" for row in missing)
    state["reserves"] = []
    _, missing, _warnings = _prepare(state, "all", "2026-01-01", assumptions(reserveCents=40_000))
    assert any(row["field"] == "reserveCents" for row in missing)


def test_recorded_cash_does_not_receive_todays_regular_pay_a_second_time():
    state = snapshot()
    state["accounts"] = [{"id": "cash", "entityId": "me", "name": "Cash", "type": "cash", "balanceCents": 300_000}]
    result = compare(state, "me", "2026-09-28", assumptions(months=1, payCents=200_000,
                     paydayAnchor="2026-09-28", monthlySpendingCents=0, reserveCents=0))
    assert result["status"] == "ready"
    assert all(policy["totalIncomeCents"] == 400_000 for policy in result["policies"])
    assert all(policy["netWorthCents"] == 700_000 for policy in result["policies"])


def test_paid_current_month_bill_has_the_same_remaining_allowance_as_daily_plan():
    from mazal_engine.daily_plan import daily_plan

    state = snapshot()
    state["roadmap"] = {"monthlyEssentialsCents": 300_000}
    state["obligations"] = [{"id": "rent", "entityId": "me", "name": "Rent", "amountCents": 150_000,
                             "dueDate": "2026-11-01", "direction": "out", "recurrence": "monthly", "status": "planned"}]
    state["transactions"] = [{"id": "paid", "accountId": "cash", "kind": "expense", "date": "2026-10-01",
                              "amountCents": 150_000, "source": "Planned payment rent",
                              "plannedPayment": {"obligationId": "rent", "dueDate": "2026-10-01"}}]
    prepared, missing, _warnings = _prepare(state, "me", "2026-10-02", assumptions(months=1,
                                            paydayAnchor="2026-10-03", monthlySpendingCents=300_000))
    assert not missing
    schedule = _calendar(state, prepared)
    remaining = sum(int(schedule["expenses"][index]) for index, value in enumerate(schedule["dates"]) if value < "2026-11-01")
    daily = daily_plan(state, "me", "2026-10-02", {"days": 30})
    assert remaining == daily["livingCostsCents"] == 145_161


def test_legacy_bill_payment_without_occurrence_date_blocks_definitive_allocations():
    state = snapshot()
    state["obligations"] = [{"id": "rent", "entityId": "me", "name": "Rent", "amountCents": 150_000,
                             "dueDate": "2026-11-01", "direction": "out", "recurrence": "monthly", "status": "planned"}]
    state["transactions"] = [{"id": "paid", "accountId": "cash", "kind": "expense", "date": "2026-10-01",
                              "amountCents": 150_000, "source": "Planned payment rent"}]
    result = compare(state, "me", "2026-10-02", assumptions(months=1, paydayAnchor="2026-10-03"))
    assert result["status"] == "needs_inputs"
    assert result["policies"] == []
    assert any(row["field"] == "transactions.paid.plannedPayment" for row in result["missingInputs"])


def test_work_schedule_applies_to_allocation_and_explicit_income_changes_override_it() -> None:
    state = snapshot()
    state["roadmap"] = {
        "transitionDate": "2027-01-01",
        "temporaryWorkSchedule": {"weeklyHours": 20, "fullTimeWeeklyHours": 37.5,
                                  "returnDate": "2027-05-01", "payPeriodEndLagDays": 12},
    }
    inputs = assumptions(months=5, payCents=150_000, paydayAnchor="2026-10-29")
    prepared, missing, _warnings = _prepare(state, "me", "2027-01-01", inputs)
    assert not missing
    schedule = _calendar(state, prepared)
    amounts = dict(zip(schedule["dates"], schedule["income"], strict=True))
    assert [amounts[key] for key in ("2027-01-07", "2027-01-21", "2027-05-13", "2027-05-27")] == [
        150_000, 108_000, 80_000, 150_000,
    ]
    prepared, missing, _warnings = _prepare(state, "me", "2027-01-01", {**inputs, "incomeChanges": []})
    assert not missing
    schedule = _calendar(state, prepared)
    assert set(schedule["income"]) == {0, 150_000}
